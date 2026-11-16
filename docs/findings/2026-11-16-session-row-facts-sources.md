# SESSIONS の行の情報 (経過時間・model/effort・最終プロンプト時刻・名前・既読) の供給元と、daemon の再起動での振る舞い

kawaz 2026-11-16 の指摘 (「一度でもリストしないとモデル表示されない」「アイドル時間が daemon の再起動でリセットされている」) を受けて、サイドバー SESSIONS の 1 行に出る情報と kawaz が挙げた 5 種類の情報 (idle、model/effort、最終プロンプト時刻、セッション名、say / permit の既読) が、今の実装でどこから来て、daemon の再起動でどうなるかを、コードと隔離 daemon での再現で確かめた。設計の提案は含めない。

## 判明した事実

### 1. 経過時間 (`last_activity_at`)

- 決めるのは daemon だけ。`SessionEntry.lastActivityAt` (`packages/daemon/src/server.ts:327-331`) を、`handleOneRequest` の末尾 (`server.ts:2193-2200`) で「role が session の接続が出した request が 1 つ終わるたび」に `nowIso()` で上書きする。元になるのは daemon が request を受けた時刻で、transcript の timestamp ではない
- request には module の `POST /op` (`packages/daemon/src/op-http.ts`、hello は `role: "session"`、`op-http.ts:258`) も含まれる。module は transcript の行が会話に入るたび `transcript_push` を送る (`hooks/transcript-push.ts:73`) ので、module のあるセッションでは「daemon が生きている間の、最後に行が push された時刻」にほぼ一致する。CLI の `ccmsg` の実行、sidecar の hello / `sidecar_hello`、`session_facts` も上書きする
- 値は daemon のメモリにだけあり、ディスクに書かない。daemon を再起動すると `sessions` が空から始まり、agents の poll で登録し直したエントリには `lastActivityAt` が無い (`server.ts:955`、`syncSessionsFromAgents` `server.ts:1216-1262`)。webui の行は `last_activity_at` が無いと経過時間を描かない (`packages/webui/src/client/components/SessionList.tsx:177-179`, `:294`)
- 再起動の後、module のあるセッションは sidecar が名乗り直す (`packages/cli/src/sidecar.ts:154`, `:194-221`、間隔 250ms〜5s) ので、その hello の時刻が `last_activity_at` になる。行の経過時間は「再起動 (= sidecar の名乗り直し) からの時間」になる (再現で観測)。module の無いセッションは何かの request が来るまで経過時間が消えたまま (再現で観測)
- `ev:"peers"` の push は `last_activity_at` の変化だけでは出ない (`peersCompareKey` `server.ts:1626-1657` がこの field を比較から外す、`maybeBroadcastPeers` `server.ts:1959-1975`)。webui の値は、他の field が変わった push、接続時の `peers` op (`packages/webui/src/client/ws.ts:731`)、サイドバーの ↻ (`Sidebar.tsx:38-52`) の時点のものに留まる (再現で、daemon 側が 17 秒進んでも webui は古い値のままなのを観測)
- transcript の最後の timestamp を読んで `last_activity_at` に使う経路は無い。末尾を読む道具は 7 にある (どれも model/effort を取るためのもの)

### 2. model / effort

- 行の model/effort は `resolveModelEffort` (`SessionList.tsx:604-620`) が `formatSessionModelEffort` (`packages/webui/src/client/session-status-view.ts:241-252`) に 3 つの候補を優先順で渡し、model を持つ最初の候補だけを使う
  - (1) `sessionStatuses.get(sid)?.context` — `session_status_subscribe` の snapshot。model と effort の両方を持つ
  - (2) `llmRequests.get(sid)?.model` — gateway の `ev:"llm_requests"`。model だけ (effort は無い)
  - (3) 呼び出し側の凍結値 — ピンの行だけが渡す (`SessionList.tsx:487`)。SESSIONS の行 (`:660`) は渡さない
- (1) は今開いているセッションだけ。`SessionView` は `active` で、tab が timeline / status / files で、transcript がある間だけ subscribe し (`packages/webui/src/client/components/SessionView.tsx:246`, `:267-306`)、cleanup で unsubscribe して store から消す (`store.ts:1484-1489`)。「一度開けば出る」のではなく「開いている間だけ出る」。別のセッションへ移ると前の行から消える (再現で観測)
- (2) は prompt cache の窓が開いている間だけ (`LlmRequestCache.snapshot` が窓の閉じた series を捨てる、`packages/daemon/src/llm-events.ts:233-245`)。webui は main の series だけ持つ (`store.ts:1241-1251`)。窓が閉じたセッション、gateway を通らないセッションは出ない
- daemon は subscribe されていないセッションの model/effort を既に持っている場合がある。ただし webui 全体へ push する event に載せていない
  - module の facts (`SessionFacts.model` / `.effort`、`packages/protocol/src/sidecar.ts:204-220`) を `SessionFactsStore` (`packages/daemon/src/session-facts.ts`) に sid ごとに持つ。sidecar が名乗るたびに daemon が `session.facts` を聞き直す (`server.ts:1017-1037`, `:3267`) ので、再起動の後も module のあるセッションは揃う。使い道は session_status の `context.engine` / effort への重ね (`packages/daemon/src/session-status.ts:2005-2027`) と、agents の行への `turn` だけ (`agentsWithModule` `server.ts:1147-1160`)。agents の行に model/effort は載せない
  - live なセッション (module の run が名乗っている) は transcript relay の fold (`sessionStatusFold` `session-status.ts:1911-1963`) が `store.folds` に context を持つが、push は subscriber のいる sid だけ (`pushSnapshot` `session-status.ts:2118-2142`)
  - agents の行 (`<config dir>/sessions/<pid>.json`) に model/effort の field は無い (`packages/protocol/src/session-files.ts:21-55`)
- transcript で「最終時点の model / effort」が取れる行 (実物の jsonl で確認、CC 2.1.278 / 2.1.316 / 2.1.325 の 3 本)
  - `type: "assistant"` の行の `message.model` (例 `claude-fable-5-2`) と、行の直下の `effort` (例 `low`、`message` の下ではない)。`isSidechain: true` (subagent) と `message.model === "<synthetic>"` (CC が書いたエラー) は除く。3 本とも assistant 行のほぼ全部に `effort` があった (1 本で 272 行中 1 行だけ無し)。CC 2.1.211 以前は `effort` を書かない (`session-status.ts:378-381` の注記)
  - CC 2.1.316 / 2.1.325 の 2 本には `type: "api-request"` の行もあり、`params.model` (起動の短い名前、例 `fable`) と `params.output_config.effort` を持つ。ccmsg はこの行の種類を読んでいない (`packages/protocol/src/transcript-row.ts:179-186` の既知の種類に無い)

### 3. 最終プロンプト時刻

- 既にある。daemon の `PeerInfo.last_user_input_at` (`packages/protocol/src/response-sessions.ts:175-188`) で、fold は `packages/daemon/src/session-user-input.ts` (`classifyUserInputRow` `:120`、`sessionUserInputFold` `:198`)。`ev:"peers"` に載り (`withUserInput` `server.ts:1425-1428`)、比較キーにも入る (`server.ts:1654-1656`) ので変化すると push される。webui は並び順 (`utils.ts:309-332`、sort key `prompt`) に使うだけで、行には描かない
- 判定の決まり (`classifyUserInputRow`): 含める側だけで書いてある
  - `type: "user"` か `"attachment"` で、`isSidechain` でなく、`timestamp` がある行
  - `origin.kind === "human"` (promptSource が `typed` / `queued` / `sdk` のどれでも) は人の入力
  - `<command-name>` を含み `<command-args>` が空でない slash command は人の入力
  - `promptSource === "system"` の行のうち、ccmsg の `from: "u1"` の msg event か、`ccmsg-from="user"` の直接配送を含むものは人の入力
  - queued_command の attachment は中の prompt を同じ決まりで判定
  - 最大値を取る (後ろに古い turn が差し込まれても戻らない)
- webui の `classifyUserMessage` (`packages/webui/src/client/transcript-model.ts:1701-1760`) は TL の表示用に全種類へ名前を付ける別の分類 (`isCompactSummary` → compact-summary、`promptSource: "system"` + `origin.kind` で task-notification / peer-message、tool_result、interrupt marker、skill preamble、文字列の接頭辞 …)。daemon の fold とは独立で、slash command の args の決まりだけ両者で合わせてある (`session-user-input.ts:58-69`)
- この値が出るのは fold のあるセッション (module の run が名乗っている live なセッション) だけ。module の無いセッションは transcript に人の prompt があっても値が無い (再現で観測)。再起動の後は sidecar の名乗り直しで relay が live になり、transcript を先頭から読み直して元の値に戻る (再現で観測、後から書かれた task-notification の行より前の人の prompt の時刻が選ばれた)
- 実物 40 本の `type: "user"` 行の見分けに使える field の組 (検証の詳細の表): `origin.kind` (`human` / `peer` / `task-notification` / `plugin`)、`promptSource` (`typed` / `queued` / `system` / `sdk`)、`isMeta`、`isCompactSummary`、content が tool_result の配列か。`origin` も `isMeta` も無い文字列の行のうち 509 行は「Another Claude session sent a message:」で始まる peer の中継で、`origin` だけでは人の入力と区別できない (今の fold は `origin.kind === "human"` を要求するので数えない)

### 4. セッション名

- 行のタイトルは `sessionRowTitle` (`packages/webui/src/client/utils.ts:707-709`) = `row.agent?.name` → cwd の末尾 → sid の先頭 8 文字。`agent.name` は agents の行、つまり CC の `<config dir>/sessions/<pid>.json` の `name` (`packages/daemon/src/agents.ts:113-152`)。peers の `name` も同じ所から (`sessionNamesOf` `server.ts:1472-1478`、`withName` `:1464-1467`)
- 再起動の直後でも、プロセスが動いていて `sessions/<pid>.json` に `name` があれば、最初の poll (起動時すぐ、以後 5 秒ごと + `sessions/` の watch、`agents.ts:25-35`, `:285`) で名前が出る。開いていないセッションでも出る (再現で観測)。transcript は読まない
- rename は組み込みの `/rename` だけが書ける (DR-0047 §1)。CC は `sessions/<pid>.json` の `name` を書き換え、transcript に `type: "custom-title"` (`customTitle`、`sessionId`、timestamp 無し) と `type: "agent-name"` (`agentName`、`sessionId`) の 2 行を残す。この 2 行は rename の時だけでなく何度も書き足される (実物で 153 回・14 回、全部同じ値が並び、rename の後は新しい値に変わる)。最後の `custom-title` が最新の名前
- daemon の Session Search の `title` (DR-0021、`session-search.ts:425-492`) は先頭側の窓で最初に見つけた `custom-title` を使う。rename したセッションでは古い名前になる (コードの記述。実物で rename 前後の 2 値が並ぶファイルを確認したが、Session Search 自体は走らせていない)

### 5. say (🔔) と permit (🔐) の既読

- 未読そのものは保存しない。daemon が transcript から say / permit の呼び出しを見つけ (live なセッションは relay の fold、そうでないセッションは tab が開いた時の session_status の一回読み、`server.ts:580-605`)、「既読の id の集合」と `since` (それより前は全部既読扱い) を引いて未読を決める
- 既読の id は daemon のディスクにある。`<stateDir>/say-read.json` (`{ since, read: { <sid>: [tool_use id...] } }`、`packages/daemon/src/say-unread.ts:42-50`) と `<stateDir>/permit-state.json` (`{ since, read, granted, applied }`、`packages/daemon/src/permit-state.ts:59-67`)。stateDir の既定は `${XDG_STATE_HOME:-~/.local/state}/ccmsg` (`packages/protocol/src/paths.ts:5`)。sid ごとに分けて持つ。実機の既定の state dir に 2 つともある
- webui で既読にすると、`say_read { ids }` / `permit_read { ids, granted? }` (`packages/protocol/src/request-sessions.ts:147-151`, `:193-200`) を送る。daemon はファイルに書いてから答え、`ev:"say_unread"` / `ev:"permit_state"` を全 user subscriber に push する (`server.ts:2593-2632`)。webui は既読を localStorage に持たない
- 再起動をまたいで残る。ただし起動時に `pruneNotificationState` (`server.ts:1744-1770`) が、そのとき動いていないセッションの既読の id を捨てる
- 再起動の後、未読が分かるのは live なセッション (module の run が名乗り直して relay が先頭から読む) と、tab が開いたセッションだけ。module が無く誰も開いていないセッションの未読は数えられない (コードの記述。再現では say / permit を作っていない)
- ファイルが無いときは `since` を起動の時刻にしてメモリだけで始め、最初に既読を書くまでファイルを作らない (`say-unread.ts:144-155`)。隔離 daemon を 3 回起動して、ファイルが作られないことを観測

### 6. daemon が知らないセッションを初めて知る場所と、そこでやること

- daemon は `claude agents --json` を実行しない。同じ内容の `<config dir>/sessions/<pid>.json` を直接読む (`pollAgents` / `pollOne` `agents.ts:113-152`、`readSessionsDir` `session-runs.ts`)。コメントの一部 (`server.ts:1731`) は `claude agents --json` と書いている
- 起動時 (`server.ts:4313-4345`)
  - `pruneNotificationState` (既読の掃除)
  - `startAgentsPoller`: 最初の round をすぐ、以後 5 秒ごと (`CCMSG_AGENTS_POLL_MS`) と `sessions/` の変化で
- poll の round ごと
  - `syncSessionsFromAgents` (`server.ts:1216-1262`): 知らない sid を、cwd の realpath、repo/ws の導出、transcript の場所の探索 (`adoptTranscriptPath`)、config dir で `registerSession` する。`connectedAt` = 今。`lastActivityAt` は付けない。名前を `sessionNames` に取る
  - `maybeBroadcastAgents` (`server.ts:1166-1180`)、`resolvePendingTranscripts` (transcript がまだ無かった sid の再探索)、`forgetUnlistedHellos`、`sidecarRuns.reconcile`
- hello (CLI / module、`registerSession` `server.ts:882-983`): 知らない sid なら同じくエントリを作る (`connectedAt` = 今)。hello の request 自体で `lastActivityAt` が付く
- `sidecar_hello` (`server.ts:3238-3270`): run を登録し、`refreshReadiness` → `syncLiveRelays` でそのセッションを live にして transcript を先頭から読む catch-up を始める (`transcript-relay.ts:404-428`)。fold は 5 つ (session status、API error、最終ユーザ入力、say の未読、permit、`server.ts:580-592`)。続けて `session.facts` を module に聞き (`askSessionFacts`)、session override を送り直す
- 接続中の webui 全部 (user role の subscriber) に push する event (`packages/protocol/src/stream-event.ts`)
  - `ev:"peers"` `{ peers: PeerInfo[] }` (`:145`): 全セッションの一覧の全体。比較キーが変わった時だけ
  - `ev:"agents"` `{ agents: AgentInfo[], polled_at }` (`:133`): agents の行の全体 (+ module の terminal と `turn`)
  - `ev:"say_unread"` `{ says }` (`:40`)、`ev:"agent_says"` (`:65`)、`ev:"permit_state"` `{ unread, granted, applied }` (`:78`): いつも全体
  - `ev:"llm_requests"` (`:260`)、`ev:"session_errors"` (`:279`)、`ev:"request_overrides"` (`:105`)
  - `ev:"session_status"` (`:268`) は subscribe した sid の subscriber にだけ届き、全体には届かない

### 7. transcript を末尾から読む既存の道具

- `readSessionLaunchContext(file)` (`packages/daemon/src/session-search.ts:288-366`): 末尾 64 KiB、無ければ 256 KiB を読み、後ろから最初の main の assistant 行の `message.model` と `effort` を返す。使い道は Session Search の hit と、resume の model/effort (`session-runs-as.ts:16-29`)。キャッシュは無い
- `readAgentEngine` (`session-status.ts:1229-1283`): subagent の transcript の末尾 128 KiB から同じものを読む。mtime/size のキャッシュ付き (`createMtimeCache`)
- 実物 3 本 (9.4 MB / 3.4 MB / 0.38 MB) で `readSessionLaunchContext` は 2.6ms / 0.5ms / 1.2ms で model と effort を返した。比べると、全体を読んで全行 JSON.parse すると 17.7ms / 5.8ms / 0.7ms
- timestamp だけ、`custom-title` だけ、人の prompt だけを末尾から探す関数は無い。relay の catch-up と、`last_user_input_at` / say / permit の fold、session_status の一回読みは先頭から全部読む

### 今の実装とデータでは取れない・取りにくいもの

- idle を「最後の timestamp 付きの行」から取る: transcript の最後の行が timestamp を持つとは限らない。実物 3 本の最後の行は `system` (turn_duration) / `queue-operation` / `cost-state` (timestamp 無し) で、`custom-title` / `agent-name` / `last-prompt` / `mode` / `permission-mode` 等の metadata 行は timestamp を持たず末尾近くに繰り返し書かれる。末尾から timestamp のある行まで遡る必要がある
- 最終プロンプト時刻: 人の prompt (`origin.kind === "human"`) は会話の途中にあり、末尾の窓に入るとは限らない。今の値は先頭からの fold で、module の無いセッションには無い。`type: "last-prompt"` の行 (`lastPrompt` 文字列、`leafUuid`) は末尾近くにあるが timestamp を持たない
- model/effort: subscribe していないセッションは、gateway の窓が開いている間の model だけ。effort は subscribe 以外の経路で webui に届かない

## 実用的な示唆 / ベストプラクティス

- 隔離 daemon で agents の行を出すには、`CCMSG_CLAUDE_CONFIG_DIRS` に一時ベースの中の fixture の config dir を渡し、`sessions/<pid>.json` の `pid` を自分で立てた生きているプロセス (`sleep`) にすれば足りる。実セッションに触らずに SESSIONS の行を作れる
- fixture の assistant 行の `usage` に `cache_read_input_tokens` を入れないと、session status の fold の prefilter (`session-status.ts:106`) を通らず context が null になる
- `ccmsg sidecar --sid <fixture sid> --run <id> --started-at <ms>` を動かすと、module 無しでもそのセッションを live にでき、relay の catch-up と `last_user_input_at` の fold を観測できる

## 検証の詳細

### 環境

- 作業コピー: v0.271.0 (main の `8026e0d2`) の jj workspace
- 隔離 daemon: `HOME` / `CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` を一時ベースの中に、`CCMSG_HTTP_BIND=127.0.0.1:18642`、`CCMSG_NETWORK_WATCH=off`、`CCMSG_CLAUDE_CONFIG_DIRS=<ベース>/fx/cfg`
- 実の `claude` は起動していない。fixture の config dir に、生きている `sleep` 2 つを pid にした `sessions/<pid>.json` と、手で書いた jsonl 2 本を置いた
  - A: 最初の turn を `claude-opus-5` / effort `high`、最後の turn を `claude-fable-5-2` / `low`。最後の人の prompt は約 3 時間前、その後に task-notification の行。`custom-title` を古い名前 → 新しい名前の順に書き、`sessions/<pid>.json` の `name` は新しい名前
  - B: `claude-opus-5` / `max`、約 5 時間前
- webui は `playwright-cli` の headless で開き、行の DOM (`.session-idle`、`.session-model`、`li` の title の `last activity:`) を読んだ。CLI の `peers` (user role) で daemon 側の値を読んだ

### 観測

| 時点 | A の daemon 側 | A の行 | B の行 |
|---|---|---|---|
| 起動直後、何も開いていない | `connected_at` = 起動時刻、`last_activity_at` 無し、`last_user_input_at` 無し | 名前は新しい名前、経過時間なし、model なし | 名前あり、経過時間なし、model なし |
| CLI を A の sid で 1 回実行 | `last_activity_at` = その時刻 | 経過時間 10s、model なし | 同上 |
| A を開く (TL) | 同上 | `fable/low` (hover `model claude-fable-5-2 / effort low`) | model なし |
| B に移る | 同上 | model が消える | `opus/max` |
| daemon を再起動 (sidecar 無し) | `connected_at` = 再起動時刻、`last_activity_at` 無し | 経過時間が消える | 開いたまま `opus/max` |
| A の sidecar を動かす | `last_activity_at` = 名乗った時刻、`last_user_input_at` = 最後の人の prompt の時刻 (後の task-notification ではない)、`input_readiness` = `no_terminal` | 経過時間 7s、model なし (live でも subscribe していない) | 同上 |
| daemon をもう一度再起動 (sidecar あり) | sidecar が 3 秒で名乗り直し、`last_activity_at` = その時刻、`last_user_input_at` は同じ値に戻る | 経過時間は再起動から数える | 同上 |
| CLI を A の sid でもう 1 回 | `last_activity_at` が 17 秒進む | webui の `last activity:` は前の値のまま (push されない) | — |

- B は module も sidecar も無いので、transcript に人の prompt があっても最後まで `last_user_input_at` が付かなかった
- 再起動の間、webui は WebSocket の再接続を繰り返し (console に接続拒否 4 件 × 2 回)、再接続後に一覧を取り直した
- `say-read.json` / `permit-state.json` は隔離 state dir に最後まで作られなかった (既読にしていないため)

### 実物の transcript の field (読むだけ、field 名と値の形のみ)

3 本 (`~/.claude-personal/projects/` の、書き換え時刻が新しい順の 3 / 40 / 200 番目):

| | 9.4 MB | 3.4 MB | 0.38 MB |
|---|---|---|---|
| CC の版 | 2.1.325 | 2.1.316 | 2.1.278 |
| assistant 行 (effort あり / 無し) | 638 / 0 | 271 / 1 | 1 / 0 |
| `custom-title` 行 (異なる値) | 153 (1) | 14 (2) | 0 |
| `agent-name` 行 | 153 | 14 | 0 |
| `last-prompt` 行 | 153 | 56 | 2 |
| `api-request` 行 | 360 | 34 | 0 |
| `origin.kind: "human"` の行 | 36 | 19 | 0 |
| 最後の行の type | system | queue-operation | cost-state |
| `readSessionLaunchContext` | 2.6ms、fable-5-2 / low | 0.5ms、fable-5-1 / low | 1.2ms、opus-5 / low |
| 全体を読んで全行 parse | 17.7ms | 5.8ms | 0.7ms |

metadata 行の形: `custom-title` = `{ type, customTitle, sessionId }`、`agent-name` = `{ type, agentName, sessionId }`、`last-prompt` = `{ type, lastPrompt?, leafUuid, sessionId }`、`mode` / `permission-mode` / `atis-latch` も同じく `sessionId` だけで timestamp を持たない。`api-request` = `{ type, sessionId, id, timestamp, version, querySource, params: { model, output_config: { effort }, thinking, max_tokens, betas, context_management }, ... }` (1 本で全 360 行が `querySource: "repl_main_thread"`)。

新しい順の 40 本の `type: "user"` 行を、見分けに使える field の組で数えた:

| origin.kind | promptSource | isMeta | content | 行数 |
|---|---|---|---|---|
| (無し) | (無し) | (無し) | tool_result を含む配列 | 5498 |
| (無し) | (無し) | (無し) | 文字列 | 602 |
| human | typed | (無し) | 文字列 | 591 |
| peer | system | true | 文字列 | 456 |
| task-notification | system | (無し) | 文字列 | 302 |
| plugin | (無し) | true | 配列 / 文字列 | 95 / 2 |
| (無し) | (無し) | true | 文字列 / 配列 | 48 / 35 |
| human | queued | (無し) | 文字列 | 37 |
| (無し) | sdk | (無し) | 文字列 | 5 |
| human | sdk | (無し) | 文字列 / 配列 | 1 / 1 |
| (無し、`isCompactSummary: true`) | (無し) | (無し) | 文字列 | 1 |

2 行目の 602 行の内訳: 「Another Claude session sent a message:」で始まる peer の中継 509、`<bash-input>` 45、`<bash-stdout>` 45、`<local-command-stdout>` 1、`<command-name>` 1、その他 7。

### 未確認

- 実の Claude Code セッション (module 入り) での再起動の振る舞い。fixture と CLI の sidecar で代わりに観測し、module の `transcript_push` が `last_activity_at` を上書きすることはコードから読んだだけ
- module のあるセッションの facts の model/effort が再起動の後に揃うまでの時間
- say / permit の未読が再起動の後にどう数えられるかの実機観測 (コードの記述のみ)
- Session Search の `title` が rename 後に古い名前を返すことの実機観測
