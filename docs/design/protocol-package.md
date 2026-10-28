# protocol-package: packages/protocol の構成

## コンテキスト

`packages/protocol` は、daemon・CLI・webui・hooks module が共有する「外から来る JSON の形」の置き場。プロセスをまたいで読み書きされる形 (wire の依頼・返事・push、サイドカーの依頼・返事、Claude Code の transcript やファイル、hook の stdin、ccmsg 自身が書いて別のプロセスが読むファイル) はここにスキーマとして置き、読む側も書く側も同じスキーマを使う。1 つのパッケージだけが読む形 (daemon の設定ファイル、webui の localStorage 等) はそのパッケージに置く ([DR-0038](../decisions/DR-0038-json-is-parsed-by-schema.md) §3)。あわせて、両端が同じ値を使う必要のある定数・パス・小さな文法 (検索クエリ等) もここに置く。

この文書は README の「ディレクトリ構成」の `protocol/` を補足する。ファイル単位の詳細は各ファイルの冒頭コメントが正本。

## 詳細

### ファイルの系統

`src/index.ts` はすべてのファイルを re-export し、利用側は `@ccmsg/protocol` から import する。hooks module (`hooks/` の `register.ts` とそれが import するファイル) だけは bundle に入れるものを絞るため、サブパス `@ccmsg/protocol/parse`、`@ccmsg/protocol/sidecar`、`@ccmsg/protocol/address` から import する。`index.ts` 自身は系統をまたぐ定数 (`ADMIN_ID`、各種の上限値・既定値、`ErrorCode`) と `Identity` の型を持つ。

#### 部品

| ファイル | 何の形か | 誰が使うか |
|---|---|---|
| `parse.ts` | 境界の読み方そのもの。`parseWith` (唯一 `unknown` を受ける関数)、`Parsed<T>` / `ParseFailure`、`Output<S>` (スキーマの出力を深く readonly にした型)、`jsonText(S)` / `JsonTextSchema` (JSON テキストを形ごと読む)、`otherThan` (未知の種類を受ける判別値)、`errorText` (`catch` の値を文字列に) | 全スキーマと全境界 |
| `json-value.ts` | 任意の JSON 値 (`JsonValueSchema` / `JsonObjectSchema`、型 `JsonValue` / `JsonObject`)。中身がその場で決まらない値 (道具の input、未知の種類の残りの field) に使う | transcript 系のスキーマ、表示側 |

#### wire (daemon と client の間、[DR-0003](../decisions/DR-0003-wire-protocol.md))

1 行 1 JSON。client が依頼を書き、daemon が返事と push を書く。依頼は `op` で判別する variant で、op ごとのスキーマは話題別のファイルに分かれ、`request.ts` / `response.ts` が 1 つにまとめる。

| ファイル | 何の形か | 誰が読むか |
|---|---|---|
| `request.ts` | 依頼 1 行。`RequestBodySchema` (`op` の variant)、`RequestEnvelopeSchema` (`request_id`)、`Request` / `RequestOp` / `REQUEST_OPS`、行を読む `readRequest`、別世代の hello を見分ける `isOtherGenerationHello` | daemon |
| `request-rooms.ts` | room のログを読む依頼 (room は読み取り専用、[DR-0036](../decisions/DR-0036-retire-rooms-for-p2p.md) §2): `read` `room_history` `rooms` | daemon |
| `request-sessions.ts` | セッションの依頼: `hello` (世代ごとの形) `subscribe` `peers` `notify` `say` `say_read` `send_message` `peer_list` `dir_tree` `session_launch` `session_launcher_config` `session_kill` `session_restart` `session_rename` `user_prompt` `user_message` `request_override` `turn_abort` `sidecar_reply` `sidecar_hello` `session_facts` `session_env` `session_search` `fork_origin` `session_dump_file` `agents` `session_status` `session_status_subscribe` `session_status_unsubscribe` `session_errors` | daemon |
| `request-files.ts` | ファイルの依頼: `fs_list` `fs_read` `fs_read_external` `fs_list_workspace` `fs_read_workspace` `fs_write` `fs_create` `fs_delete` `fs_edit` `fs_stat_batch` `fs_find` `sandbox_grant` `sandbox_revoke` | daemon |
| `request-transcripts.ts` | transcript の依頼: `transcript_read` `transcript_subscribe` `transcript_unsubscribe` `client_trace` | daemon |
| `request-host.ts` | daemon とホストの依頼: `ping` `shutdown` `translate` `llm_usage` `llm_stats` `llm_status` `llm_keepalive_pause` `claude_update` | daemon |
| `response.ts` | 返事。`RESPONSE_SCHEMAS` (op → その op の成功の返事のスキーマ)、`ErrorResponseSchema` (`ok: false`)、`ResponseOf<Op>` / `ReplyOf<Op>` | CLI、webui (`frame.ts` 経由) |
| `response-rooms.ts` / `response-sessions.ts` / `response-files.ts` / `response-transcripts.ts` / `response-host.ts` | 上の依頼ファイルと同じ話題分けの、op ごとの成功の返事 | CLI、webui |
| `session-status.ts` | daemon が transcript と周辺のファイルから畳み、hooks module の事実を重ねたセッションの状態 (`SessionStatusSnapshotSchema`、TODO・workflow・background・context 使用量・agent tree・外部ファイル・API エラー)。`session_status` 系の返事と `ev: "session_status"` の push の中身 | webui (daemon が組み立てる) |
| `stream-event.ts` | 依頼なしに daemon が subscribe した接続へ送る push (`ev` の variant、`StreamEventSchema`) | CLI、webui |
| `frame.ts` | daemon が書いた 1 行を読む `readDaemonFrame`。push と返事のどちらかを判別し、返事は op を知る依頼側が `reply(op)` でその op のスキーマで読む (行は op を名乗らないため) | CLI、webui |

依頼の op と返事の対応は `RESPONSE_SCHEMAS` が正本。同じ形を返す op は同じスキーマを指す (`fs_read_external` / `fs_read_workspace` → `fs_read` の返事、`fs_list_workspace` → `fs_list` の返事、`session_status_subscribe` → `session_status` の返事)。

#### サイドカー ([DR-0035](../decisions/DR-0035-user-input-via-composer-fill.md) §3)

| ファイル | 何の形か | 誰が読むか |
|---|---|---|
| `sidecar.ts` | daemon がセッションのサイドカー socket に書く依頼 (`SidecarRequestSchema`、`op` は `describe` と `prompt.send` と `session.facts` と `agent.append` と `request.override` と `turn.abort`) と、hooks module の返事 (`SidecarReplySchema`、op ごとの result は `sidecarReplySchema(result)`)。依頼を読む `readSidecarRequest`。run id の形 (`SidecarRunIdSchema`) と引き方 (`sidecarRunId`)。hooks module が Claude Code から読んだセッションの事実 (`SessionFactsSchema`、`session.facts` の result と `session_facts` の中身) | 依頼は hooks module、返事は hooks module (daemon の `POST /op` で渡す、DR-0046)。run id は hooks module が引き、CLI (`ccmsg sidecar`) と daemon (`sidecar_hello`) が読む。セッションの事実は hooks module が書き (daemon の `POST /op` の `session_facts`、DR-0046)、daemon が読む |
| `peer-tools.ts` | ccmsg の tool (`send` / `say` / `peers`、[DR-0039](../decisions/DR-0039-all-mods-and-typed-tools.md) §3) の名前と入力 (`launch` は名前だけで、入力は `launch.ts`)、hooks module が daemon に頼む `send_message` / `peer_list` の欄 (`POST /op`、DR-0046)、その返事 | hooks module、CLI、daemon |
| `peer-tools-text.ts` | tool の結果として model が読む文面と、transcript の読み手 (webui、dump) が `send` の結果を読み戻す処理。書く形と読む形を 1 か所で定義する | hooks module、daemon、webui |
| `request-override.ts` | webui からセッションの main thread の request の model / effort を上書きする形 ([DR-0041](../decisions/DR-0041-request-model-effort-override.md)): `RequestOverrideSchema` (launch と同じ語彙)、変更 (`RequestOverridePatchSchema`、merge patch) とその対象 (`RequestOverrideTargetSchema`、`session` / `once`)、上書きが request に載せる値 (`RequestOverrideStateSchema`、facts と push が運ぶ)、`patchOverride` / `overrideInForce` / `overrideModel` | daemon、webui、hooks module |
| `launch.ts` | セッションの起動 ([DR-0018](../decisions/DR-0018-session-launcher.md) §3) の入力 (`LaunchInputSchema`、`type` で 4 つに分かれる variant)、起動コマンドが標準入力で読む形 (`LaunchCommandInputSchema`)、`session_launch` の返事 (`SessionLaunchResponseSchema`)、hooks module が `ccmsg sidecar launch` に標準入力で渡す形とその出力 (`LaunchInputTextSchema` / `SessionLaunchResponseTextSchema`) | daemon、webui、hooks module (tool `launch`)、CLI |

hooks module は実行時に import できないので、これらのファイルは valibot と、同じ制約を守る protocol のファイル (`parse.ts` 等) 以外を import せず、bundle して使う。

#### Claude Code 由来のファイル・コマンド出力

どれも Claude Code の形で、ccmsg は使う field だけを定義する。

| ファイル | 何の形か | 誰が読むか |
|---|---|---|
| `transcript-row.ts` | transcript の 1 行 (`TranscriptRowSchema`、`type` の variant + Other)。行の一部だけを見る投影 (`TranscriptRowHeadSchema`、uuid / cwd / timestamp の `*LineSchema`) | daemon、webui |
| `transcript-content.ts` | message の content ブロック (`ContentBlockSchema`)、tool_result の中のブロック、道具ごとの tool_use の input (`ToolUseSchema`、`name` の variant + Other)、tool_use からファイルパスを取る投影 | daemon、webui |
| `transcript-attachment.ts` | `attachment` 行の中身 (`AttachmentSchema`、`type` の variant + Other) と turn の出どころ (`OriginSchema`) | daemon、webui |
| `transcript-tool-result.ts` | 行の `toolUseResult` を、呼んだ道具ごとに読むスキーマ (Agent / SendMessage / Task* / Monitor / Bash / Read 等) | daemon、webui |
| `agent-meta.ts` | spawn された agent の `subagents/agent-<agentId>.meta.json` | daemon |
| `session-files.ts` | Claude Code の `sessions/<pid>.json` (`ClaudeSessionFileSchema`)。同じファイルに ccmsg 自身の `sessions/<sid>.json` (下の表) も置いている | CLI、daemon |
| `workflow-run.ts` | workflow run の状態ファイル `workflows/<runId>.json` と、実行中の `journal.jsonl` の行 | daemon |

#### ccmsg 自身のファイルと HTTP の形

ccmsg が書いて別のプロセスが読む形。両端が ccmsg なので、Claude Code 由来の形と違い使う field だけに絞らない。

| ファイル | 何の形か | 誰が読むか |
|---|---|---|
| `storage-event.ts` | room の jsonl の 1 行 (`StorageEventSchema`、`type` の variant: member / leave / msg / next / prev / title / archive / kind / say / say_read)。room のログは読み取り専用で、同じ event が `room_history` の返事に入る | daemon、webui (`room_history` の返事として) |
| `session-files.ts` | `ccmsg sidecar begin` が書く `<state dir>/sessions/<sid>.json` (`SessionStateFileSchema`) | CLI |
| `allowed-origins.ts` | `<config dir>/allowed-origins.json` | CLI (`ccmsg origins`)、daemon |
| `say-dictionary.ts` | `<config dir>/say-dictionary.tsv` の行 (`word<TAB>読み`) と、発声の前の置換 ([DR-0045](../decisions/DR-0045-say-speaks-in-tool-shown-from-transcript.md) §6)。人が手で書くファイルなので JSON でなく TSV。行の読み・同梱の辞書との重ね合わせ・置換は純関数で、ファイルの読み込みと発声は daemon | daemon (say の tool_use と許可依頼の音声) |
| `attachment-upload.ts` | `POST /attachment` の返事 (multipart HTTP で、wire の返事ではない) | webui |
| `paths.ts` | state / config / data の各ディレクトリの解決 (`resolvePaths` 等) と、サイドカー socket の名前 (`<sid>.<run id>.sock`) の組み立て | CLI、daemon |

#### その他

| ファイル | 何か | 誰が使うか |
|---|---|---|
| `version.ts` | `VERSION` (root の package.json の版)、`PROTOCOL_VERSION`、`UNANNOUNCED_PROTOCOL_VERSION` | CLI、daemon、webui |
| `version-compare.ts` | `compareVersions` (daemon の版の食い違いの判定) | CLI、webui |
| `config-migration.ts` | data dir に残った設定ファイルを config dir へ移す起動時の処理 | CLI、daemon |
| `search-query.ts` | transcript 検索窓のクエリ文法 | daemon、webui |
| `file-search-query.ts` | Files ペインのパス検索 (`fs_find`) のクエリ文法。daemon の探索と client の照合が同じ解釈をするために共有する | daemon、webui |
| `ccmsg-address.ts` | 封筒の `from` が送り主を書く `ccmsg:` の接頭辞 (`DIRECT_ADDRESS_PREFIX`、[DR-0039](../decisions/DR-0039-all-mods-and-typed-tools.md) §3) と、session id の形 (`isSessionIdShape`) | CLI、daemon |
| `ccmsg-direct-transcript.ts` | transcript に現れる ccmsg の直送 (配送された封筒、`send` の tool の呼び出し、agent の `ccmsg post` / `reply` / `notify` の Bash 呼び出しとその結果、PushNotification) の認識と、daemon が書く封筒の描画。書く形と読み戻す形を 1 か所で定義する | daemon、webui |

### 読み方の規則 (全系統共通)

- 形はスキーマで 1 度だけ書き、型はそこから導く (`Output<typeof Schema>`)。同じ形を手書きの interface でもう 1 度書かない。スキーマはモジュールの最上位で 1 度だけ組み立てる
- 外から来た値は受け取ったその場で `parseWith(Schema, input)` に通す。テキストなら `jsonText(Schema)` で JSON と形を 1 段で読む。結果は `Parsed<T>` で、失敗は throw でなく値 (`{ ok: false, failure }`)。失敗をどう扱うか (拒否して理由を返す、その行だけ捨てる、劣化表示) は境界ごとに決める
- object の読み方は形の持ち主で決まる
  - Claude Code の形 (transcript、meta.json、`claude agents`、`sessions/<pid>.json`、workflow、hook の stdin): `v.looseObject` で使う field だけを定義し、残りは通す。必須にするのは、その種類が実機で必ず持つ field だけ
  - ccmsg 自身の wire とファイル: `v.object`。宣言した field は型どおりでなければ失敗、宣言していない field は出力から落とす (拒否はしない)。両端は同じホストで一緒に変わり、別世代の client は hello の `protocol` で弾くため ([DR-0002](../decisions/DR-0002-daemon-supervision.md) §4、`request.ts` の冒頭コメント)
  - `v.strictObject` は、知らない field があること自体が送り手の誤りになる所だけ (サイドカーの `describe` の空の args 等)
- 種類が増えていく variant (transcript の行・ブロック・attachment・道具、workflow の entry) は、最後の option の判別値を `otherThan(既知の名前)` にして未知の種類を Other として受ける。既知の種類で形が壊れた値は失敗にし、Other に吸わせない。既知か Other かは `isKnown*` (`isKnownTranscriptRow`、`isKnownContentBlock`、`isKnownToolUse`、`isKnownAttachment` 等) で分ける
- 読んだ値は不変 (`Output<S>` は深く readonly)。書き換えず、要るものは新しく組み立てる。値を任意の名前で引かない
- `as` (`as const` を除く)・`any`・非 null の主張 `!` は使わない ([DR-0038](../decisions/DR-0038-json-is-parsed-by-schema.md) §5)。`unknown` が出るのは `parseWith` の引数と `catch` の束縛だけ

### 新しい形を足す時

1. 置き場: 2 つ以上のパッケージ (hooks module を含む) が読み書きするなら protocol、1 つのパッケージだけが読むならそのパッケージ
2. ファイル: 既存の系統に入るならそのファイルへ。wire の op なら話題の `request-*.ts` と `response-*.ts` に足し、`request.ts` の op の一覧と `response.ts` の `RESPONSE_SCHEMAS` に登録する (`RESPONSE_SCHEMAS` は全 op を持つことを型で検査している)
3. object の種類: 形の持ち主が Claude Code など他のプログラムなら `looseObject`、ccmsg なら `object`、未知の field を誤りとして弾く必要がある時だけ `strictObject`
4. Other を受けるか: 他のプログラムが種類を増やしていく variant なら Other を受け (`otherThan` + `isKnown*`)、ccmsg が種類を決める variant なら受けない (未知の種類は失敗)
5. hooks module が読む形なら、valibot と protocol の他のスキーマ以外を import しない (bundle できるように)

### id の語彙

room のログ (`StorageEvent`) の `from` / `to` / member の `id` は、人か agent かを接頭辞で分ける ([DR-0006](../decisions/DR-0006-id-scheme-v2.md))。Unix の UID ではない。room は読み取り専用で ([DR-0036](../decisions/DR-0036-retire-rooms-for-p2p.md) §2)、この語彙はログと、過去の transcript に残る room のメッセージを読むためにある。

- `u1` (`ADMIN_ID`): User (kawaz)。admin で、全 room に member 行なしで暗黙に居る
- `u2` 以降: guest (room ごとの member 行に `role: "guest"`)
- `a1`, `a2`, …: room の agent member。room に入った順

## 制約 / 前提

- valibot 1.x を使う ([DR-0038](../decisions/DR-0038-json-is-parsed-by-schema.md) §2)。`Output<S>` を深い readonly にしているのは、valibot の `v.readonly()` が 1 段しか効かず variant の option に pipe を付けられないため
- スキーマのファイルは valibot と互いのファイル以外を import しない。hooks module (`hooks/`) が bundle して使えるようにするため。例外は node の API を使う `paths.ts` / `config-migration.ts` と、package.json を読む `version.ts` で、これらは hooks module からは使わない
- wire は同じホストの daemon と client が一緒に変わる前提 ([DR-0002](../decisions/DR-0002-daemon-supervision.md) §4)。世代の違いは hello の `protocol` で 1 度だけ判定する

## 関連

- [README-ja.md](../../README-ja.md) — ディレクトリ構成
- [DR-0038](../decisions/DR-0038-json-is-parsed-by-schema.md) — スキーマで読む規則、置き場 (§3)、型の水準 (§5)、不変 (§6)
- [DR-0003](../decisions/DR-0003-wire-protocol.md) — wire protocol と storage event
- [DR-0035](../decisions/DR-0035-user-input-via-composer-fill.md) — サイドカーと hooks module
- [DR-0036](../decisions/DR-0036-retire-rooms-for-p2p.md) — room の廃止
