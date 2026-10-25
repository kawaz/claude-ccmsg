# 起動の入力を claude のオプション名にした後の tool `launch` と webui のフォームの実機確認

- Date: 2026-10-25
- 対象: Claude Code 2.1.309、ccmsg の作業コピー (v0.193.3 の上の未 push の変更)
- 動機: [DR-0018](../decisions/DR-0018-session-launcher.md) の起動の入力を、claude のオプション名の field (`cwd` / `model` / `effort` / `continue` / `resume` / `resume_session_at` / `fork_session` / `name` / `prompt`) にし、tool の入力から `resume_session_at` を外し、起動コマンドの入力に `requested_by` を足した。tool と webui の両方から起動コマンドの代役まで通ることを実機で確かめる
- 方法:
  - daemon は作業コピーの `packages/daemon/src/index.ts --foreground` を、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` / `CLAUDE_CONFIG_DIR` を一時ディレクトリに向けて起動した (verify skill の手順)。`CLAUDE_CONFIG_DIR` の `settings.json` は `{"modelSettings":{"fable":{"effortLevel":"xhigh"},"opus":{"effortLevel":"low"}}}`。`CCMSG_CLAUDE_CONFIG_DIRS` は試験セッションの config dir だけを指す
  - config の `session_launcher.launch_command` は、標準入力を一時ファイルに書いて 1 行を出し exit 0 で終わる代役のスクリプト
  - 試験セッションは隔離した config dir と `ANTHROPIC_BASE_URL` を手元の Messages API の代役 (台本で tool_use / text を返す、[findings 2026-10-25-launch-tool-input-schema](./2026-10-25-launch-tool-input-schema.md) と同じ作り) に向け、作業コピーの plugin を `--plugin-dir` で載せた対話セッション (`--name "🤖ccmsg-verify-launch-rework"`、`ENABLE_TOOL_SEARCH=true`) を専用の tmux で起動した
  - webui は daemon の HTTP を `playwright-cli` で開いて操作した

## 判明した事実

### tool `launch` (試験セッション、代役の API の台本)

台本は 1 つ目の turn で「ToolSearch `select:mcp__ccmsg-v1__launch` → text」、2 つ目の turn で「`launch` を新規で呼ぶ → `launch` を `continue` と `resume` を両方付けて呼ぶ → text」。

| 確かめたこと | 結果 |
|---|---|
| model に見える input schema | ToolSearch の後の request の `tools` で `defer_loading: true`、`type: "object"`、`required: ["cwd"]`、`additionalProperties: false`、properties は `cwd` / `model` / `effort` / `continue` / `resume` / `fork_session` / `name` / `prompt` の 8 つ。`continue` / `fork_session` は `type: "boolean"`、`resume` は小文字の uuid の `pattern`。`type` と `resume_session_at` は無く、`oneOf` / `anyOf` も無い。組み合わせの決まりは description にある (`model` の「Required when neither continue nor resume is given」、`fork_session` の「Needs continue or resume.」) |
| 新規の呼び出しが起動コマンドまで通る | 起動コマンドの標準入力は `{"cwd":"<realpath>","model":"haiku","effort":"low","name":"🤖ccmsg-verify-launch-child","prompt":"hello from verify","session_id":"<uuid>","requested_by":"<試験セッションの sid>"}`。`requested_by` は試験セッションの sid と一致した |
| 結果が model に返る | tool_result は `{"session_id":"<上と同じ uuid>","exit_code":0,"stdout":"stand-in launch command ran in <realpath>\n","stderr":""}` |
| daemon.log の行 | `session_launch: by=<sid> cwd="<realpath>" session_id=<uuid> prompt_bytes=17 exit_code=0 stdout_bytes=132 stderr_bytes=0` (cwd は JSON の文字列) |
| `continue` と `resume` の同時指定 | tool_result は `launch の入力が形に合わないので何もしていない: resume: continue と resume は同時に指定できない`。起動コマンドは走らなかった (標準入力のファイルは増えていない) |

### webui のフォーム

| 経路 | 確かめたこと | 結果 |
|---|---|---|
| 「+ New」(新規) | 欄と見出し | cwd、`--model`、`--effort`、`--continue` (checkbox)、`--resume`、`--resume-session-at`、`--fork-session` (checkbox)、`--session-id`、`--name`、`PROMPT` の順に常に出る。見出しはオプション名のまま (大文字にならない) |
| 同上 | model / effort の既定 | `--model` は `fable`、`--effort` は `xhigh` (settings の `modelSettings.fable.effortLevel`) で開く。model を `opus` にすると effort は `low`、`haiku` / `sonnet` (settings に無い) にすると未選択 (「選んでください」)、`fable` に戻すと `xhigh`。「指定しない」の選択肢は無い |
| 同上 | `--session-id` | 入力できない (`disabled`)、placeholder は「自動生成」 |
| 同上 | 起動 | cwd を入力して起動すると、起動コマンドの標準入力は `{"cwd":"<realpath>","model":"fable","effort":"xhigh","name":"🤖ccmsg-verify-webui-new","session_id":"<uuid>","requested_by":"user"}`。結果パネルに `session_id` (セッションの view へのリンク)、`exit_code: 0`、stdout、stderr「出力なし」 |
| Session Search の「resume」 | 開いたフォーム | URL は `?sb.panel=new&sb.cwd=…&sb.model=haiku&sb.effort=medium&sb.resume=<sid>&sb.name=…`。`--resume` に元の sid、select は `haiku` / `medium` で先頭に「指定しない」がある。`--session-id` の placeholder は「自動生成 (新規と --fork-session の時)」 |
| 同上 | 起動 | 標準入力は `{"cwd":…,"model":"haiku","effort":"medium","resume":"<sid>","name":…,"requested_by":"user"}` (`session_id` は無い)。結果パネルに `session_id` は出ない |
| Timeline の「この項目まで残して fork」 | 開いたフォーム | URL は `…&sb.resume=<sid>&sb.resume_session_at=<record uuid>&sb.fork_session=true&…`。`--fork-session` は on、`--resume-session-at` に選んだ項目の uuid、`--session-id` の placeholder は「自動生成」 |
| 同上 | 起動 | 標準入力は `{…,"resume":"<sid>","resume_session_at":"<record uuid>","fork_session":true,…,"session_id":"<新しい uuid>","requested_by":"user"}`。結果パネルに新しい `session_id` のリンク |
| 同上 | `--continue` も on にして起動 | 送られず、`--resume` の下に「continue と resume は同時に指定できない」。起動コマンドは走らなかった |

`--session-id` の欄は最初の画面では打てる欄と同じ見た目だったので、入力を受けない欄の背景を落とし枠を破線にした (確認後の computed style は `border-style: dashed`)。

## 未観測

- 本物の model が input schema の description に従って組み合わせを守るか (代役の API の台本なので見ていない)
- first-party の API に対する request の `tools` の形
- 実際の起動コマンド (端末に claude を載せるもの) と、起動されたセッションが daemon に名乗るまで
