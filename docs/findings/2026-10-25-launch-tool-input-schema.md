# tool `launch` の input schema: top-level の `oneOf` / `anyOf` を `$.tool.register` に渡すとどうなるか

- Date: 2026-10-25
- 対象: Claude Code 2.1.309
- 動機: tool `launch` ([DR-0018](../decisions/DR-0018-session-launcher.md) §3.7) の入力は `type` で 4 つに分かれる variant (`LaunchInputSchema`)。それを JSON Schema に変換したもの (top-level の `oneOf` / `anyOf`) を model に見せられるなら、type ごとの必須を schema で示せる。見せられないなら、4 つの option を合併した 1 つの object にして、type ごとの必須は field の description で示す
- 方法: 隔離した config home (`CLAUDE_CONFIG_DIR`・`TMPDIR`・`XDG_*` を一時ディレクトリに向け、`env -i` で起動) と、`ANTHROPIC_BASE_URL` を手元の Messages API の代役に向けた `claude`。代役は request の body を記録し、台本の行 (tool_use か text) を順に返す ([findings 2026-10-15-mods-event-matrix-startup-resume-clear-compact](./2026-10-15-mods-event-matrix-startup-resume-clear-compact.md) の「Messages API の代役」と「代役の API の差分 (台本)」と同じ作り)。probe の plugin を `--plugin-dir` で載せ、`session.start` で schema の形だけが違う 4 つの tool を `isDeferred: false` で登録し、`tool.call` で受けた入力をそのまま result の文にして返した。判定は `$.tool.register` の戻り値、`--debug-file` の行、代役に届いた request の `tools` と tool_result

## 判明した事実

- **top-level に `oneOf` か `anyOf` を持つ input schema の tool は、session の tools から外される**。`$.tool.register` 自体は reject せず `{ tool: "mcp__<plugin>__<name>" }` で resolve するが、debug log に `[ERROR] MCP server "<plugin>" Skipping tool "<name>": its input schema uses top-level oneOf, which the Anthropic API does not accept. Other tools from this server remain available.` (`anyOf` なら `top-level anyOf`) が出て、request の `tools` に載らない。model がその名前で呼ぶと tool_result は `<tool_use_error>Error: No such tool available: mcp__<plugin>__<name></tool_use_error>` で、handler には届かない
- **`type: "object"` を並べても外される**。`{ type: "object", anyOf: [...] }` も `top-level anyOf` で外された
- **外された tool の `$.tool.register` は約 8 秒待ってから resolve する**。debug log は `[WARN] $.tool.register (<plugin>): <tool> not yet in the session's tools after 8000ms; resolving anyway`。`session.start` で登録を await する module では、その分だけ最初の turn が遅れる
- valibot の `toJsonSchema` は `v.variant` を top-level の `oneOf` に変換する (`anyOf` ではない)。`$schema` が並ぶだけで `type` は付かない
- **4 つの option を合併した object (`type: "object"`、`properties` は全 option の和、`required` は全 option に共通の `type` と `cwd`、`additionalProperties: false`) は載り、呼び出しが handler に届く**
- handler の `e` には、model の書いた入力の field と並んで `tool` と `tool_use_id` が同じ階層に入る (subagent の呼び出しなら `agentId` も、event-matrix の findings)。`e.input` は無い。各 type が `strictObject` の `LaunchInputSchema` に `e` をそのまま通すと `tool` と `tool_use_id` で読めないので、handler はこの 3 つを名前で外してから通す

## 判定

合併した object を採る ([DR-0018](../decisions/DR-0018-session-launcher.md) §3.7 のとおり)。top-level の `oneOf` / `anyOf` は、API に送られる前に Claude Code が tool ごと落とすので、API が受けるかを確かめる段まで進まない。合併は `hooks/tool-input-schemas.ts` の macro が variant の option から導き、どの type で必須・任意・受けないかを各 field の description に足す。

## 実用的な示唆

- `$.tool.register` が resolve したことは、tool が使えることの証拠にならない。schema が落とされても登録は成功に見え、debug log の `Skipping tool` だけが手がかりになる
- 型の分岐を model に見せたい tool の schema は top-level を `type: "object"` 1 つにし、分岐は field の description で書く。`oneOf` / `anyOf` を property の中 (top-level でない所) に置く形は今回試していない

## 検証の詳細

### probe の tool

| tool | input schema | `$.tool.register` | request の `tools` | 呼び出しの結果 |
|---|---|---|---|---|
| `l_oneof` | `toJsonSchema(LaunchInputSchema)` の出力そのまま (`{ $schema, oneOf: [4 つの object] }`) | resolve (8 秒後) | 載らない | `No such tool available` |
| `l_anyof` | 上の `oneOf` を `anyOf` に改名 | resolve (8 秒後) | 載らない | `No such tool available` |
| `l_anyof_obj` | `{ type: "object", anyOf: [同じ 4 つ] }` | resolve (8 秒後) | 載らない | `No such tool available` |
| `l_merged` | `{ type: "object", properties: {...}, required: ["type", "cwd"] }` | resolve (11 ms) | 載る | handler に届き、入力の field と `tool`・`tool_use_id` を受けた |

`-p` の 2 run (台本で 4 つを順に呼ぶ run と、debug log を取る run) で同じ結果だった。登録は 1 つずつ順に行われ、各登録のたびに server を作り直して、それまでの tool の schema を検査し直す (`Skipping tool` の行は登録のたびに外された tool 全部について出る)。

### 実装後の確認 (/verify)

同じ隔離環境で、作業コピーの plugin を `--plugin-dir` で載せた対話セッション (`--name "🤖ccmsg-verify-launch"`、`ENABLE_TOOL_SEARCH=true`) を tmux の中で起動した。ccmsg の daemon は `CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` を一時ディレクトリに向け、config の `session_launcher.launch_command` は標準入力を一時ファイルに書いて 1 行を出し、exit 0 で終わる代役のスクリプト (`/bin/sh <script>`) にした。台本は「`launch` を `type: "new"` で呼ぶ → `model` / `effort` の無い `type: "new"` で呼ぶ → text」と、別の turn で「ToolSearch `select:mcp__ccmsg-v1__launch` → text」。

| 確かめたこと | 結果 |
|---|---|
| tool が登録され deferred になる | debug log `mcp__ccmsg-v1__launch visible after 104ms`。最初の request では `tools` に無く、deferred の一覧に `mcp__ccmsg-v1__launch` の名前だけがあった |
| ToolSearch で読み込んだ時に model に見える schema | `defer_loading: true`、`type: "object"`、`required: ["type", "cwd"]`、properties は `type` / `cwd` / `name` / `prompt` / `model` / `effort` / `resume_session_id` / `resume_at`、`oneOf` / `anyOf` は無い |
| 未ロードの deferred tool を名前で呼んで handler に届く | 届いた (画面に `ccmsg-v1 - launch (MCP)(type: "new", ...)`) |
| handler → `ccmsg sidecar launch` → daemon → 起動コマンド | 起動コマンドの標準入力は `{"type":"new","cwd":"<realpath>","name":"🤖ccmsg-verify-launch-child","prompt":"hello from verify","model":"haiku","effort":"low","session_id":"<uuid>"}`。daemon.log に `session_launch: by=<試験セッションの sid> type=new cwd=<realpath> session_id=<uuid> prompt_bytes=17 exit_code=0 stdout_bytes=119 stderr_bytes=0` |
| 結果が model に返る | tool_result は `{"session_id":"<上と同じ uuid>","exit_code":0,"stdout":"stand-in launch command ran in <realpath>\n","stderr":""}` |
| 読めない入力 | `type: "new"` で `model` / `effort` が無い入力の tool_result は `launch の入力が形に合わないので何もしていない: model: Invalid key: Expected "model" but received undefined; effort: Invalid key: Expected "effort" but received undefined`。起動コマンドは走らなかった |

代役の API なので、本物の model が description を読んで type ごとの必須を守るかは見ていない。

## 未観測

- 本物の model が、合併した schema の description に従って type ごとに必須の field を書き、受けない field を書かないか
- first-party の API に対する request (`ANTHROPIC_BASE_URL` が first-party の時に `Skipping tool` の検査が同じか)
- property の中に置いた `oneOf` / `anyOf` の扱い
- subagent からの `launch` の呼び出し
