# 組み込みの起動コマンドの print の起動で起こした btw の fork の cache と取り消し (実測)

- Date: 2026-11-22
- 対象: Claude Code 2.1.330、ccmsg の [DR-0064](../decisions/DR-0064-btw-through-launch-command.md) の実装 (段 1〜5) の後の組み込みの起動コマンド (`packages/daemon/src/default-launch-command.sh`)
- 動機: DR-0064 の「測ること」のうち、組み込みの起動コマンドで確かめられるもの。btw の fork を起動コマンドの print の起動に替えても、元のセッションの prompt cache を読めるか (1)、取り消しの SIGTERM (process group) が claude に届いて止まるか (2)。ユーザの自前の起動コマンド (sandbox ラッパー、信頼の判定) を通した場合 (1〜3) は測っていない
- 方法:
  - 認証のある普段使いの config dir で、リポの外の一時ディレクトリ (`git init` だけした空のディレクトリ) を cwd にした。計測するセッション自身の環境変数のうち子の claude をその子として扱わせるもの (`CLAUDE_CODE_CHILD_SESSION` 等 7 つ) は `env -u` で落とし、daemon と同じく `TMPDIR` を OS の利用者ごとの一時ディレクトリに、`CCMSG_LAUNCH_REQUESTED_BY=user` を重ねた
  - fork 元 S は `echo "3 つの果物の名前を挙げて" | claude -p --model haiku --output-format json` で作った (S の request は `cache_creation_input_tokens` 61,043)
  - fork は daemon が `btw_ask` で作るのと同じ形の入力 (`resume` S、`fork_session`、新しい `session_id`、`print` と print のオプション、`model: claude-haiku-5-5`、`prompt`) を `zsh -f default-launch-command.sh` の標準入力に渡して起こした。`PATH` には `direnv` があり、組み込みは `direnv exec .` を通る (cwd に `.envrc` は無い)
  - 取り消しは、daemon と同じく自分の process group で起こし (`Bun.spawn` の `detached: true`)、標準出力に最初の `text_delta` が出た時に group に SIGTERM を送った。group の中の process は `ps -A -o pid=,pgid=,comm=` で見た

## 判明した事実

### 1. cache

| 起こし方 | 終了 | 標準出力 | `init` の `session_id` | `cache_read_input_tokens` / `cache_creation_input_tokens` | 答え |
|---|---|---|---|---|---|
| 組み込みの起動コマンドの print の起動 | 0 (全体で 2.8 秒) | JSON の行だけ (`system` 2、`stream_event` 8、`assistant` 1、`result` 1。JSON でない行は 0) | 入力の `session_id` | 61,043 / 420 | `みかんです。` |

- **fork は S の cache を全部読んだ** (read が S の書いた 61,043 と同じ)。`init` の `model` は `claude-haiku-5-5`
- 起動コマンド自身の出力は標準出力に混ざらず、stderr も空だった
- fork の transcript は作られなかった (config dir の `projects/<cwd の slug>/` には S の transcript だけ)

### 2. 取り消し

| # | 起こした process の pid | SIGTERM の前の group | SIGTERM の後 | 終了 | `result` |
|---|---|---|---|---|---|
| T1 | 76935 | `claude` 1 つ、pid = 起こした pid (`ps -g <pid>` で見た。macOS の `ps -g` の選び方は確かめていないので、T2 で group を数え直した) | fork の session id を argv に持つ process (`pgrep -f`) は残らない | 143 | 無い |
| T2 | 78651 | `claude` 1 つ (pid と pgid が起こした pid) | group の process は 0 | 143 | 無い |

- **組み込みは claude を exec していて、daemon が起こした process がそのまま claude だった** (`direnv exec .` を通っても pid が変わらない)。group には claude だけがいた
- **group への SIGTERM で claude は止まった**: 最初の差分から約 0.6〜0.8 秒で 143 で終わり、group に process は残らなかった。`result` の行は出ない (daemon は取り消した btw を `canceled` にする)

## 実用的な示唆

- 組み込みの起動コマンドで起こす btw は、組み込みの btw コマンドで起こしていた時と同じく元のセッションの cache を読み、取り消しが効く
- ユーザの自前の起動コマンドがラッパーを挟む時は、ラッパーが claude を同じ group の中で前景で走らせ、標準出力に自分の出力を混ぜないこと (DR-0064 §3) を、そのラッパーで確かめる必要がある (未測)
