---
title: CLI が起こす daemon が、起こしたセッションの Claude Code の変数 (session id・messaging の token 等) を持ち続ける
status: open
category: design
created: 2026-11-20
---
# CLI が起こす daemon が、起こしたセッションの Claude Code の変数 (session id・messaging の token 等) を持ち続ける

## 概要

CLI が spawn する daemon は、`TMPDIR` を除いて呼んだプロセスの環境をそのまま継ぐ ([DR-0002](../decisions/DR-0002-daemon-supervision.md) §2)。呼んだのがセッションの中 (hook、`just push` の upgrade の接触、エージェントの Bash) だと、そのセッションの Claude Code が子に付ける変数も daemon に残り、daemon が生きている間ずっと持ち続ける。daemon はそれを起動コマンド・say のコマンド・`claude update` 等の子に継がせる。`TMPDIR` は findings `2026-11-20-launch-inherits-daemon-tmpdir` で直したが、これらは扱いを決めていない。

## 観測 (2026-11-20、本番の daemon、Claude Code 2.1.328)

`ps -E -p <daemon の pid>` の環境に、daemon を起こした統括のセッションの次の変数があった (settings.json の `env` に無く、Claude Code がセッションの子に付けているもの)。

- `CLAUDECODE`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_PID`、`CLAUDE_EFFORT`
- `CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN` (そのセッションの messaging の socket と token)
- `CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_CHILD_NOTES_DIR`、`CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_EXECPATH`
- 他に、起こしたセッションの config dir の settings.json の `env` の値 (`ANTHROPIC_*`、`CLAUDE_CODE_*` の設定) と `CLAUDE_CONFIG_DIR`

## 影響 (未検証を含む)

- 起動コマンド: `clean_env` の既定は空 ([DR-0018](../decisions/DR-0018-session-launcher.md) §3.1)。組み込みの起動コマンドは自分で `CLAUDE*` 等を消すが、自前の起動コマンドで `clean_env` を書いていないと、起動したセッションに上の変数が届く。届いた先で CLI が `CLAUDE_CODE_SESSION_ID` を自分の sid と読む (`ccmsg` の identity の自動判定) と、起こしたセッションを名乗る (未検証)
- messaging の token: あるセッションの token が、別のセッションと daemon の子の全部の環境に載る
- say のコマンドと `claude update`: `CLAUDECODE=1` 等を持ったまま走る。挙動が変わるかは未検証

## 決めること

- daemon の spawn で落とす変数の範囲 (`CLAUDECODE` と `CLAUDE_CODE_*` の中で、セッションごとに Claude Code が付けるものだけか、settings の `env` 由来のものも含むか)。Claude Code の版で名前が増減するので、名前の列挙か形のパターンか
- daemon は複数の config dir を受け持つので、起こしたセッションの config dir の settings の `env` を daemon が持つこと自体の扱い
- 起動コマンドの `clean_env` の既定を空のままにするか
