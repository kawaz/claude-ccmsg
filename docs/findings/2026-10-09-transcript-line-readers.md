# Claude Code の transcript の行を読む箇所の棚卸し (DR-0038 の次の段の材料)

- Date: 2026-10-09

DR-0038 §1・§3 の「Claude Code の transcript の jsonl の行をスキーマで読む」段の設計材料。本番コードが行をどこでどう読んでいるか、実機の行の形、失敗の扱い、テストの組み立て箇所をまとめる。

## 判明した事実

- transcript の行を読む本番コードは daemon に 12 か所、webui に 2 か所、protocol の共有関数が 1 つ (`queuedCommandPrompt`)。CLI は行を読まない。hooks/session-start.ts は stdin の `transcript_path` を受け取るだけで行は読まない
- どの箇所も、読めない行はその行だけ扱いを落として全体は止めない。throw する箇所は無い。daemon は捨てる、webui は BrokenLine / MetaLine / `unknown-segment` で raw を見せる
- 実機の形とコードの期待はほぼ合っている。スキーマ設計で必ず扱う形は次の 4 つ
  - `toolUseResult` は object のほかに string (エラー文) がある (1549 行中 45 行)
  - `parentUuid` は null がある (セッション先頭の attachment 行、subagent の先頭 user 行)
  - `queue-operation` は `uuid` / `parentUuid` / `cwd` / `isSidechain` を持たない
  - metadata 系の行 (custom-title、ai-title、agent-name、last-prompt、mode、permission-mode、atis-latch、cost-state、旧版の file-history-snapshot) は `timestamp` も `uuid` も持たない
- `toolUseResult` の形は同じ行の中では決まらない。前の行の tool_use の `name` で決まる (daemon の pendingToolUse、webui の resolveToolResults で突き合わせている)
- 外から来た値を名前で引く書き方 (DR-0038 §6 と同種) が transcript の読み取りに残っている (§「判断が要る点」5)
- テストは共通の行 fixture を持たず、各テストファイルが手で行を組み立てている (webui の transcript-model.test.ts だけで約 120 件)

## 実用的な示唆 / ベストプラクティス

### 分割案の所感

1 本の大きな union だけにすると、uuid や cwd だけを読む走査まで関係ない field の不正で行ごと失敗し、全行で全体の検証コストを払う。逆に用途ごとにばらばらにスキーマを書くと同じ形を何度も書く。部品を 1 回だけ書いて組み立てる形を勧める。

- **共通の頭**: `RowHead` の entries (`type`、`uuid?`、`parentUuid?: string | null`、`timestamp?`、`cwd?`、`isSidechain?`) を 1 回だけ定義する
- **行**: `TranscriptRow` を `type` の variant にする (user / assistant / attachment / queue-operation / system / custom-title)。それ以外の type をどう受けるかは判断が要る (下の 2)
- **部品**: ContentBlock (`type` の variant)、Message、Origin、Attachment (`attachment.type` の variant)、ToolUse (`name` の variant)、道具ごとの ToolResult、JsonValue
- **安い走査用の投影**: fork-origin、virtual-sessions、transcript.ts、navigation、session-search の先頭部分は、RowHead の entries から組んだ looseObject で読む。同じ部品から組むので形を 2 回書かない
- **形はすべて loose**: DR-0038 §3 のとおり知らない field は通す
- 置き場は `packages/protocol` (daemon と webui が同じスキーマを使う)

### 判断が要る点

1. **`toolUseResult` の型の付け方**。案は 2 つ。(a) JSON 値として持ち、tool_use と突き合わせる所で道具ごとのスキーマに通す。(b) 全道具の形の union にする。ただし道具が違っても同じ key が出る (TaskCreate の `task{id, subject}` と、別の道具の `task{task_id, …}`) ので key では判別できない。どちらでも string の場合を型に入れる
2. **知らない種類の扱い**。CC が増やす `type`、ブロック、`attachment.type`、道具名を失敗にするか Other として受けるか。webui は今は表示し、daemon は無視している。valibot の `variant` は知らない判別値で失敗するので、Other を作るなら判別値を「既知の literal 以外の string」に絞る必要がある。絞らないと、既知の type で形が壊れた行が Other に吸われる
3. **そのまま表示する値の型**。webui の `tool-use.input`、`unknown-segment.raw`、protocol の `pushNotificationText(name, input: unknown)` は中身を決めずに JSON を表示するか後で見る。`v.lazy` で再帰する JsonValue のスキーマと型を protocol に置くのが自然
4. **既知の type で形が違う行の表示が変わる**。webui は今は `o.message as Record` のキャストで空の turn として出す。スキーマで失敗させると BrokenLine (失敗の要約つき) になる。この変化を受け入れるか
5. **名前で引く書き方を残さない**。
   - daemon/src/session-status.ts の `ATTACHMENT_PATH_FIELD[type]` → `attachment[fieldName]`
   - webui の `ATTACHMENT_PATH_FIELDS` のループ (`a[name]`)
   - `stringField(obj, ...names)` (webui の parseSpecialTool、daemon の session-dump.ts、workflow-drilldown.ts)
   - webui の `imageResult` の `dims[name]`
   - `ATTACHMENT_SPECS[type]` はふつうの object literal なので、`attachment.type` が `"constructor"` だと `Object` が spec として呼ばれ、attachment 自身の `trailing` / `fields` / `file` がそのまま採用される (コードからの推論、実機での再現はしていない)。harness が書く値なので危険度は低いが、DR-0038 §6 の不具合と同じ種類
6. **途中で切れた断片の読み直し**。webui の `tryParseTruncatedCcmsgMessage` は壊れた入力を部分ごとに救う処理で、DR-0038 §6 の「失敗した入力を部分ごとに読み直して細かく分類しない」とぶつかる。本文に埋め込まれた ccmsg event を扱う段で決める
7. **既定値への読み替え**。session-status の `subject ?? "(unknown)"`、`status ?? "pending"`、`tokenValue` (負の値や非数を 0 にする)、`"" → undefined`、webui の `"?"` / `""` / `null`。fold で前の状態と merge する分と、純粋な既定値 (スキーマの `v.optional(schema, default)` へ移すもの) を分ける
8. **偽物の行を組み立てている**。webui の parseTranscriptObject の queued_command 分岐は偽の user 行を組み立てて `classifyUserMessage` に渡す。型付きにするなら組み立ても型に従わせる
9. **session-dump の timestamp 必須**。`parseTranscript` は `timestamp` の無い行を捨てる (metadata 系は全部落ちる)。スキーマ化後も同じ切り方にするか
10. **テストの組み立て**。手組みの fixture は `parentUuid` / `isSidechain` / `uuid` を省いたものが多い。行のスキーマを必須寄りにすると大量に壊れる。共通の行ビルダーを protocol か testkit に作るか
11. **性能は未計測**。daemon は文字列の前段フィルタでパースする行を絞っているが、webui は全行、session-dump はファイル全体を同期でパースする。巨大な tool_result 行を looseObject で読むコストは測っていない

## 検証の詳細

### 1. 本番コードの読み取り箇所と、使う field・期待する型

daemon:

| 箇所 | 読み方 | 扱う type | 使う field と期待する型 |
|---|---|---|---|
| daemon/src/transcript.ts `extractEntryTimestamp` | `JSON.parse(..) as {timestamp?: unknown}` | 全行 | `timestamp: string` |
| daemon/src/session-status.ts `foldLine` (`PREFILTER` を通った行だけ) → `foldAssistant` / `foldContextUsage` | `unknown` を `isRecord` / `stringValue` / `tokenValue` で辿る | assistant | `isSidechain: boolean`、`timestamp: string`、`effort: string` (トップレベル)、`isApiErrorMessage: boolean`、`message.model: string`、`message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens}: number`、`message.content[]` の `tool_use{id: string, name: string, input: object}` |
| 〃 `foldExternalFile` / `isTrackedToolUse` / `applyTodoUpdate` ほか | 同上 | assistant の `tool_use.input` | Read / Write / Edit / MultiEdit `file_path`、NotebookEdit `notebook_path`、Bash `run_in_background: boolean` と `description`、Agent `description` / `subagent_type` / `name`、SendMessage `to`、TaskCreate `subject`、TaskUpdate `taskId` / `status` / `owner` / `subject` / `addBlockedBy: string[]` / `addBlocks: string[]`、TaskStop `task_id`、Monitor `description` |
| 〃 `foldUser` / `applyToolResult` | 同上 | user | `message.content`: string (teammate relay の `Another Claude session sent a message:` + `<teammate-message>`、`<bash-stdout>` の persisted-output) または `tool_result{tool_use_id: string, is_error: boolean}` の配列。`toolUseResult: object` を道具名で読み分け: `status`、`isAsync`、`agentId`、`name`、`agent_type`、`color`、`success`、`task{id, subject}`、`taskId`、`workflowName`、`summary`、`runId`、`backgroundTaskId`、`task_type`。`timestamp` |
| 〃 `foldNotification` | 同上 | queue-operation | `operation === "enqueue"`、`content: string` (`<task-notification>` の `<task-id>` / `<status>`)、`timestamp` |
| 〃 `foldAttachment` | 同上 | attachment | `attachment.type`。task_reminder は `content[]{id, subject, status, owner, blockedBy: string[], blocks: string[]}`、edited_text_file / file は `filename: string` |
| 〃 `collectAgentToolUseIds` | 同上 | assistant | `message.content[]` の `tool_use` で `name === "Agent"` の `id` |
| 〃 `classifyApiErrorRow` (session-errors.ts と共有) | 同上 | assistant | `type`、`isSidechain`、`isApiErrorMessage`、`message.model`、`message.content` (string または text ブロックの配列)、`timestamp` |
| daemon/src/session-errors.ts `foldLine` | typeof object の確認後 `as Record<string, unknown>` (配列も通る) | assistant | 上の `classifyApiErrorRow` と同じ |
| daemon/src/session-user-input.ts `foldLine` → `classifyUserInputRow` | `isRecord` | user、attachment | `isSidechain`、`timestamp` (空でない string)、`type`、`origin.kind`、`promptSource`、`message.content: string` |
| packages/protocol/src/ccmsg-direct-transcript.ts `queuedCommandPrompt` (daemon と webui が使う) | `as` によるキャスト 2 つ | attachment | `attachment.type === "queued_command"`、`attachment.prompt: string`、`attachment.origin.kind` (`"peer"` か無し) |
| daemon/src/session-search.ts `launchContextFromRow` | `isRecord` | assistant | `type`、`isSidechain`、`message.model`、`effort` |
| 〃 `scanCandidateFile` の `inspect` (先頭部分) | `isRecord` | 全行 | `cwd` (絶対パスの string)、`timestamp` (`Date.parse`)、`type === "custom-title"`、`customTitle: string` |
| 〃 `forEachSearchableMessage` / `userText` | `isRecord` | user、assistant、queue-operation | `timestamp`、`type`、`isMeta`、`message.content` (string または text ブロック)、`operation`、`content`。本文中 `<event>` の入れ子 JSON (`type`、`msg`、`from`、`ts`) |
| daemon/src/fork-origin.ts `rowUuid` | `isRecord` | 全行 | `uuid` (空でない string) |
| daemon/src/virtual-sessions.ts `scanTranscriptCwd` | `isRecord` | 全行 | `cwd` (絶対パスの string) |
| daemon/src/session-dump.ts `parseTranscript` (ファイル全体を同期で読む) と後続の fold | `record()` (中に `as`) | 全行。`timestamp: string` の無い行は捨てる | `uuid`、`type`、`promptSource`、`isMeta`、`operation`、`content`、`message.content` のブロック: text / thinking{thinking} / tool_use{id, name, input} / tool_result{tool_use_id, is_error, content: string または配列} |
| 〃 | 〃 | tool_use.input | Bash `command`、CronCreate / CronDelete `id` / `cron` / `prompt` / `recurring`、Agent `description` / `name` / `prompt` / `subagent_type` / `model` / `run_in_background`、SendMessage `to` / `message` / `summary` / `type`。tool_result の本文の入れ子 JSON (`{ok, room, mid}`、`{type: "msg", r, mid}`) |

webui:

| 箇所 | 読み方 | 扱う type | 使う field と期待する型 |
|---|---|---|---|
| webui/src/client/transcript-model.ts `parseTranscriptLine` → `parseTranscriptObject` / `classifyUserMessage` / `classifyAssistantMessage` / `summarizeMeta` | 手書きの判定。`o.message as Record<string, unknown> \| undefined` | 全行 | `timestamp`、`uuid`、`parentUuid` (string または null)、`type`、`isMeta`、`isSidechain`、`promptSource`、`origin.kind`、`isApiErrorMessage`、`operation`、`content`、`subtype`、`cwd` |
| 〃 `parseSegments` / `imageResult` | 〃 | message.content | text{text}、thinking{thinking}、redacted_thinking、tool_use{name, id, input}、tool_result{tool_use_id, is_error, content: string または配列 (`image{source{data, media_type}}` を含む)}。`toolUseResult.file{content, base64, type, dimensions{displayWidth, displayHeight}}` |
| 〃 `parseSpecialTool` | 〃 | tool_use.input | `file_path` / `path`、`command`、`description`、`run_in_background`、`offset`、`limit`、`content`、`old_string`、`new_string`、`to` / `recipient`、`summary`、`message` / `content` / `prompt`、`type`、`name`、`subagent_type`、`model` |
| 〃 `attachmentDetail` / `ATTACHMENT_SPECS` | 〃 | attachment | hook_success / hook_additional_context は `hookName`、`hookEvent`、`command`、`exitCode`、`durationMs`、`stdout`、`stderr`。edited_text_file は `filename`、`snippet`。file は `filename`、`content.file{content, startLine}`。それ以外は `filename` / `file_path` / `filePath` / `path` / `displayPath` を順に引く |
| webui/src/client/navigation.ts `transcriptContainsUuid` | `as {uuid?: unknown}` | 全行 | `uuid` |

行そのものではない周辺の読み取り (DR-0038 §3 では別の形):

- agent の meta.json: daemon/src/session-status.ts `readJson`、daemon/src/agent-transcripts.ts、daemon/src/session-dump.ts
- workflow の state json と journal.jsonl: daemon/src/workflow-drilldown.ts
- 本文に埋め込まれた入れ子 JSON: webui/src/client/transcript-model.ts の `tryParseCcmsgMessage` / `extractCcmsgMessages` (ccmsg event)、`parsePeerRelay` (idle_notification)、protocol の `classifyCcmsgSendResult`
- 生の JSON の整形表示: webui/src/client/raw-view-mode.ts (field は読まない)

### 2. type ごとにどの箇所が扱うか

| type | 扱う箇所 |
|---|---|
| assistant | session-status (context / api error / tool_use / Agent id)、session-errors、session-search (launch context / 検索)、session-dump、webui |
| user | session-status (tool_result / relay / persisted-output)、session-user-input、session-search (検索)、session-dump、webui |
| queue-operation | session-status (task-notification)、session-search (検索)、session-dump、webui (enqueue を turn に、他は meta) |
| attachment | session-status (task_reminder / file 系)、session-user-input と session-dump と webui (queued_command)、webui (表示) |
| system | webui (`summarizeMeta` で `subtype` を表示) |
| custom-title | session-search (`customTitle`)、webui (meta) |
| その他の metadata 系 | webui (meta)。daemon の全行走査 (uuid / cwd / timestamp) は field が無いので素通り |

### 3. 読めない行の扱い

| 箇所 | JSON が壊れている | object でない / 形が違う |
|---|---|---|
| daemon の fold (session-status、session-errors、session-user-input、session-search、fork-origin、virtual-sessions) | その行を捨てる | 捨てる。field ごとに見て合わない所は読み飛ばす |
| daemon/src/transcript.ts `extractEntryTimestamp`、webui/src/client/navigation.ts | 捨てる | `null` の行は TypeError を catch して結果的に捨てている |
| daemon/src/session-errors.ts | 捨てる | 配列も object として通る |
| daemon/src/session-dump.ts | 捨てる | `timestamp: string` の無い行を捨てる |
| webui `parseTranscriptLine` | BrokenLine (raw と error 文) | object でなければ BrokenLine。知らない type は MetaLine、知らないブロックは `unknown-segment` (raw を JSON 表示)。既知の type で形が違うと、キャストで空の segments の turn になる |

既定値への読み替え: session-status は `subject ?? "(unknown)"`、`status ?? "pending"`、`tokenValue` (負・非数を 0)、`stringValue(..) || undefined` (`""` を無しに)。webui は `"?"`、`""`、`null`。

### 4. 実機の行の形

サンプル (3 カテゴリ):

| カテゴリ | 内容 |
|---|---|
| 本体の最近の transcript | `~/.claude-personal/projects` の過去 3 日の本体 13 本、CC 2.1.288〜2.1.295、約 1.4 万行 |
| subagent の transcript | 過去 30 日の `subagents/*.jsonl` から 20 本 |
| 旧版 | 150 日より前の 1 本、CC 2.1.87 |

必要に応じて過去 30 日 (1320 本) / 120 日の範囲で特定の形を grep した。

type ごとの行数 (本体 13 本): assistant 3237、user 2171、queue-operation 1461、attachment 1181、system 1167、last-prompt 676、permission-mode / mode / atis-latch 各 665、agent-name 494、custom-title 493、ai-title 285、cost-state 15。JSON でない行・object でない行は 0。

| type | トップレベル key | 補足 |
|---|---|---|
| assistant | 常に: `uuid`、`parentUuid`、`timestamp`、`isSidechain`、`message`、`cwd`、`sessionId`、`version`。ほぼ常に: `requestId`、`effort` (12/3237 で欠落、synthetic の行)。時々: `isApiErrorMessage`、`error`、`apiErrorStatus`、`slug`、`requestedModel`、`perTurnEffort`、`wireToolInputs` など | `message.content` は観測した全行で配列。ブロックは text 890 / thinking 798 / tool_use 1549。`message.model` に `<synthetic>` 9 件 (いずれも `isApiErrorMessage: boolean`)。`message.usage` は入れ子の object (`cache_creation`、`server_tool_use`、`iterations` など) を含む |
| user | 常に: `uuid`、`parentUuid`、`timestamp`、`isSidechain`、`message`。時々: `toolUseResult`、`isMeta` (true のみ、false は観測されない)、`origin`、`promptSource`、`promptId`、`sourceToolAssistantUUID`、`permissionMode` | `toolUseResult`: object 1504 / string 45 / 無し。配列は 30 日分で 0。`message.content`: string または配列 (text 3 / tool_result 1549) |
| attachment | `uuid`、`parentUuid` (null 13 件)、`timestamp`、`cwd`、`attachment`、`isSidechain`。時々: `rendered`、`renderedRole`、`renderedInHumanTurn` | `attachment.type` 19 種: deferred_tools_record 599、hook_success 157、queued_command 133、edited_text_file 73、hook_additional_context 61、prompt_snapshot 30、date、instructions、skill_listing、model、environment、agent_listing_delta、session_context、language、plan_mode_exit、auto_mode、mcp_instructions_delta、deferred_tools_delta、async_hook_response |
| queue-operation | `sessionId`、`timestamp`、`operation`。時々: `content`、`reason`、`commandUuid`、`deliveryId` | `uuid` / `parentUuid` / `cwd` / `isSidechain` が無い。operation: enqueue 731 (content あり) / dequeue 504 (content 無し) / remove 225 / popAll 1 |
| system | `uuid`、`parentUuid`、`timestamp`、`subtype`、`cwd`、`isSidechain`。subtype により `level`、`isMeta`、`content` など | subtype: stop_hook_summary 581、turn_duration 559、local_command 26、informational 1 |
| custom-title / ai-title / agent-name / last-prompt / mode / permission-mode / atis-latch / cost-state | `sessionId`、`type` と各自の 1〜2 field (`customTitle`、`aiTitle`、`agentName`、`lastPrompt` + `leafUuid` など) | `timestamp` も `uuid` も無い。旧版には file-history-snapshot もある |

値の分布:

| field | 観測値 |
|---|---|
| `promptSource` (user) | 無し 1589、system 500、typed 79、sdk 2、queued 1 |
| `origin.kind` (user) | peer 392 (key の組み合わせ 6 通り)、task-notification 108、human 80 |
| `promptSource` × `origin` | system は peer (isMeta true) か task-notification、typed / queued は human、sdk は origin 無し |
| `tool_result.content` | string 1390 / 配列 159 |
| `tool_result.is_error` | boolean 944 / 無し 605 |
| `queued_command` の attachment | `origin` は観測した全行で object、`prompt` は string |
| `file` の attachment (30 日で 2 行) | key は `content`、`displayPath`、`filename`、`type`。`content` は `{file, type}` |
| `task_reminder` (30 日で 4 行) | key は `content`、`itemCount`、`type`。`content` は 4 行とも空配列。項目の形は実機で未確認 |

道具ごとの `toolUseResult` (コードが読む field との一致):

| 道具 | 観測した key | コードの期待との一致 |
|---|---|---|
| Agent (非同期) | `agentId`、`isAsync`、`status`、`description`、`prompt`、`outputFile`、`resolvedModel` など | 一致 |
| teammate spawn | `status`、`name`、`color`、`agent_type`、`agentId`、`team_name` など | 一致 |
| SendMessage | `success`、`message`、`msg_id`、`pin` など | 一致 |
| Bash (background) | `backgroundTaskId`、`stdout`、`stderr`、`interrupted` など | 一致 |
| Monitor | `taskId`、`timeoutMs`、`persistent` | 一致 |
| Workflow | `runId`、`scriptPath`、`status`、`summary`、`taskId`、`taskType`、`transcriptDir`、`workflowName` | 一致 |
| TaskUpdate | `success`、`taskId`、`updatedFields`、時々 `statusChange` / `error` | 一致 |
| TaskCreate | `task{id, subject}` 69 件、`task{id, subject, description, status, blocks, blockedBy}` 17 件 | 一致 (`id`、`subject` は常にある) |
| 別の道具 (結果に `retrieval_status`) | `task{task_id, description, status, output, exitCode, task_type}` | key `task` が TaskCreate と重なる。コードは道具名で分けているので誤読は無い |

subagent の transcript:

- 全行が `isSidechain: true` で、トップレベルに `agentId: string` がある
- 先頭行は 5 本とも `type: "user"`、`parentUuid: null`、`message.content: string`
- `promptSource` 無しで `origin.kind: "peer"` の user 行が 2 件ある。webui の `classifyUserMessage` は `promptSource === "system"` のときだけ origin を見るので、この行は本文の prefix で分類される

旧版 (CC 2.1.87):

- user 18 行が `origin{kind: "task-notification"}` を持ち、`promptSource` を持たない。`classifyUserMessage` は本文の `<task-notification>` prefix で同じ分類に落とす
- queue-operation と file-history-snapshot は `uuid` を持たない

考察: コードの期待と食い違う形は見つからなかった。各箇所は `isRecord` / `typeof` で外れた形を読み飛ばすので、上の 4 つの形 (string の `toolUseResult`、null の `parentUuid`、uuid の無い queue-operation、timestamp の無い metadata 系) は今は暗黙に扱えている。スキーマにするときは型に明示する必要がある。

### 5. テストで transcript の行を組み立てている箇所

| ファイル | ヘルパ / 件数の目安 |
|---|---|
| packages/webui/test/transcript-model.test.ts | 行の literal 約 120 件、ParsedLine のヘルパ `userText` / `userToolResult` / `assistantThinking` / `assistantToolUse` / `assistantText` / `bashUse` / `metaLine`、`queuedAttachmentRow` / `queuedEnqueueRow` |
| packages/daemon/test/session-status.test.ts | `toolUse`、`toolResult`、`assistantUsage`、`teammateRelay`、`taskNotification`、`taskReminder`、`todoCreate`、`todoUpdate`、`monitorStart`、`editedTextFileRow`、`mentionedFileRow`、`userTextRow`、`persistedOutputRow`、`apiErrorRow` (literal 約 26 件) |
| packages/daemon/test/session-user-input.test.ts | `typedPromptLine`、`ccmsgDeliveryLine`、`ccmsgReadResultLine`、`teammateRelayLine`、`assistantLine`、`directDeliveryLine`、`queuedAttachmentRow`、`queuedEnqueueRow` |
| packages/daemon/test/session-dump.test.ts | `row(timestamp, type, content, extra)`、`queuedAttachmentRow`、`queuedEnqueueRow` |
| packages/daemon/test/session-search.test.ts | `user`、`agent`、`ccmsg` |
| packages/daemon/test/session-errors.test.ts、packages/daemon/test/network-wake-integration.test.ts | `apiErrorLine`、`assistantLine` |
| packages/daemon/test/fork-origin.test.ts | `row(sid, uuid, extra)` |
| packages/daemon/test/fs-access.test.ts | `externalAttachmentRow` |
| packages/daemon/test/virtual-sessions.test.ts | literal 6 件 |
| packages/webui/test/timeline-auto-open.test.ts、incremental-cross-line.test.ts、fold-tree.test.ts | literal 5〜6 件ずつ (`parsedEntry(offset, raw)` など) |
| packages/protocol/test/ccmsg-direct-transcript.test.ts、packages/cli/test/cli.test.ts、packages/cli/test/direct-send.test.ts | literal 2〜4 件ずつ |

`packages/testkit` に transcript の共通 fixture は無い。
