# upgrade で起きた daemon と launch_command の環境 (trust ダイアログの自動承認が効かない件)

`launch` で初めての cwd にセッションを立てると、launch command (kawaz の `~/bin/itumono-run-claude.sh`) の trust ダイアログ自動承認が効かずに止まることがある。止まったのは plugin 更新の upgrade (`graceful shutdown (upgrade)`) で起きた daemon の時だけで、`ccmsg daemon restart` で起こし直した daemon では通った。upgrade 経路で daemon が継ぐ環境が違うのではないか、という仮説を隔離 daemon で確かめた (2026-11-04、ccmsg v0.212.0、claude v2.1.318、hyoui 0.16.4、macOS)。

## 結果の要約

- upgrade 経路と restart 経路は同じ `spawnDaemon` (`packages/cli/src/client.ts`) を通る。daemon が継ぐのは spawn した CLI の `process.env` で、stdio は 3 本とも `/dev/null`、`detached: true` で自分の process group、制御端末なし。経路による違いは「どのプロセスが spawn したか」による env だけ
- 隔離 daemon を 3 経路 (シェル / upgrade / `just` の upgrade レシピ) で起こし、launch を各 6 回 (うち 3 回は業務面の sandbox-exec ラッパー経由の claude) 流した。起動 31 分後の (c) で流した 6 回、daemon を通さない直接実行 12 回と合わせて 36 回すべて自動承認が通った。仮説の差分 (env / stdio / process group / tty) で失敗は再現しない
- 実 daemon の記録では、止まった daemon (11-04 05:00:30 の upgrade) と通った daemon (11:33:19 の restart) は、どちらも同じ Claude Code セッションの Bash tool から起こされていた (前者は `just push` の `_local-daemon-upgrade`、後者は `ccmsg daemon restart`)。`just` を挟んでも daemon の env の key は増えない (下の (c))。「upgrade 経路だから env が違う」は観測と合わない
- 止まった launch はどれも、罫線待ち (5 秒) ではなく最後の Yes 送信 (`key:Down` → `wait:"❯ Yes, I trust"` を 2 秒) で抜けている。`key:Down` を送ってもカーソルが `No, exit` から動かなかった
- 罫線が描かれた直後の `key:Down` は、claude が入力を受け付け始める前だと捨てられる (後から届くのでもなく、2 秒待っても `❯ No, exit` のまま)。罫線の直後に送ると、sandbox-exec ラッパー経由の claude では 15 回中 12 回、素の claude では 40 回中 3 回捨てられた。50 ms 置くと全部通った (5 節)。止まった launch の画面 (Down が効かず `❯ No, exit` のまま) はこれと同じ形
- `wait:"❯ No, exit"` を Down の前に挟んでも防げない (選択肢は罫線と同じ描画で出る、15 回中 12 回捨てられた)。Down を送って `❯` が Yes に動くのを短く待ち、動かず No のままなら送り直すと 15 回すべて通った
- 実 daemon で止まった回が毎回捨てられた理由 (罫線から送信まで 0.1〜0.2 秒あったのに、入力の受け付けがそれより遅れた理由) は未特定。daemon の起動経路の差は再現で出ていない。実データで失敗と成功を分けているのは、今のところ daemon の起動からの経過時間 (失敗は起動 31〜88 分後、成功は起動 30 秒以内) だけで、標本は少ない

## 1. daemon が継ぐもの (隔離 daemon、3 経路)

隔離 daemon は `CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `CCMSG_HTTP_BIND` を一時ディレクトリに向けて起こした。env は `ps -E`、stdio は `lsof -d 0,1,2`、process group / session / tty は `ps -o pid,ppid,pgid,sess,tty`。

| 経路 | 起こし方 | ppid | pgid | tty | fd 0 / 1 / 2 | env の key 数 | `CLAUDE*` / `ANTHROPIC_*` / `AI_AGENT` |
|---|---|---|---|---|---|---|---|
| (a) シェル | `hyoui run --login` のログインシェル (PTY あり) から `bin/ccmsg daemon restart` | 1 | 自分 (= pid) | なし | `/dev/null` ×3 | 44 | 1 (`CLAUDE_CONFIG_DIR`) |
| (b) upgrade | v0.211.0 の daemon を立て、Claude Code の Bash tool (TTY なし、`CLAUDE_CODE_*` 付き) から v0.212.0 の `bin/ccmsg peers` | 1 | 自分 | なし | `/dev/null` ×3 | 94 | 23 |
| (c) upgrade (`just`) | (b) と同じ条件で `just _local-daemon-upgrade > file 2>&1` (plugin cache の v0.212.0 で `peers`) | 1 | 自分 | なし | `/dev/null` ×3 | 94 | 23 |

- (b) と (c) の env は key が同じで、値の違いは `PWD` と `SHLVL` だけ
- (a) と (b) の違いは env だけ。(b) にだけあるのは Claude Code のセッション由来の変数 (`CLAUDE_*` / `ANTHROPIC_*` / `AI_AGENT`、`DIRENV_*`、`GHOSTTY_*`、`TERMINFO`、`TERM_PROGRAM*`、`TMPDIR`、`GIT_EDITOR`、`JJ_EDITOR` ほか launchd 由来の変数)。(a) は `hyoui run --login` の最小 env から始まったログインシェルなので launchd 由来の変数を持たない
- 実 daemon (11:33:19 の restart) も同じ形: ppid 1、自分の process group、tty なし、stdio は `/dev/null`、env に `CLAUDE_PID` (起こしたセッションの pid) を含む Claude Code セッション由来の変数

## 2. launch command に渡る環境と結果

launch command は `~/bin/itumono-run-claude.sh` の計測用複製。違いは、ROOT を一時ディレクトリに向ける、remote / gh の信頼チェックを省く、`CLAUDE_CONFIG_DIR` を隔離 config dir (onboarding 済み、trust 未登録) に固定する、各段の結果 (`hyoui input` の rc と stderr、screen dump、env、fd、tty) を記録して失敗でも抜けない、の 4 点。cwd は毎回新しい空の git repo (trust 未登録 = ダイアログが出る条件)。`clean_env` / `keep_env` は実 config と同じ。

| 経路 | claude | 回数 | 罫線 (5 秒以内) | tail10 に `Quick safety check` | Yes 送信 |
|---|---|---|---|---|---|
| daemon なし (Bash tool から直接) | `claude` | 6 | 6 | 6 | 6 OK |
| daemon なし (Bash tool から直接) | sandbox-exec ラッパー | 6 | 6 | 6 | 6 OK |
| (a) シェル | `claude` | 3 | 3 | 3 | 3 OK |
| (a) シェル | sandbox-exec ラッパー | 3 | 3 | 3 | 3 OK |
| (b) upgrade | `claude` | 3 | 3 | 3 | 3 OK |
| (b) upgrade | sandbox-exec ラッパー | 3 | 3 | 3 | 3 OK |
| (c) upgrade (`just`) | `claude` | 3 | 3 | 3 | 3 OK |
| (c) upgrade (`just`) | sandbox-exec ラッパー | 3 | 3 | 3 | 3 OK |
| (c) を起動 31 分後に再度 (隔離 daemon は他にセッション無し) | `claude` | 3 | 3 | 3 | 3 OK |
| 同上 | sandbox-exec ラッパー | 3 | 3 | 3 | 3 OK |

- launch command 自身: tty なし、自分の process group (daemon の `detached: true`)、stdin は daemon が JSON を書いた unix socket、stdout / stderr は daemon への pipe。(a) と (b) で同じ
- launch command の env は daemon の env から `clean_env` を落としたもの。(a) と (b) の差は 1 の表の env の差のうち `clean_env` に掛からないもの (`DIRENV_*`、`GHOSTTY_*`、`TERMINFO`、`TMPDIR` ほか)。どちらでも通る
- (b) では daemon の env に `DIRENV_DIFF` (起こしたセッションの cwd の `.envrc`) が残るので、`.envrc` の無い cwd で `direnv exec .` するとその分が外れる。hyoui と claude の動きには影響しなかった
- `DIRENV_IN_ENVRC=1` (Claude Code セッションの env に入っている) があっても `direnv exec .` は `.envrc` を読み込む (有無の両方で確認)
- 画面は 80×24 (`hyoui run --detached` の既定)。ダイアログの選択肢は `❯ No, exit` / `Yes, I trust this folder` の順で、`No` が選択中。スクリプトは Down 1 回 → `❯ Yes, I trust` を待って Enter で通る

## 3. 実 daemon で止まった launch の記録

daemon.log の `session_launch` 行と、launch を頼んだセッションの transcript の tool 呼び出しと返事の時刻から。

| 時刻 (UTC) | daemon | daemon の起動からの経過 | ダイアログ | launch の所要 (呼び出し → 返事) | stderr | 結果 |
|---|---|---|---|---|---|---|
| 11-04 05:31:40 | 05:00:31 の upgrade | 31 分 | 出る | 3.23 s | direnv の 2 行だけ (128 B) | 止まる |
| 11-04 06:27:19 | 同上 | 87 分 | 出る | 3.22 s | 同上 | 止まる |
| 11-04 06:28:20 | 同上 | 88 分 | 出る | 3.19 s | 同上 | 止まる |
| 11-04 09:09:30 | 同上 | 249 分 | 出ない (resume) | 1.77 s | 同上 (130 B) | 正常 |
| 11-04 11:32:49 | 11:32:35 の restart | 14 秒 | 出る | 1.66 s | 計測版の各段 (354 B) | 通る |
| 11-04 11:33:37 | 11:33:19 の restart | 18 秒 | 出る | 1.36 s | direnv の 2 行だけ (128 B) | 通る |

10-28 の 2 回 (07:18:32 / 07:30:49) は 06:38:40 の upgrade で起きた daemon で、起動から 40 分 / 52 分後。この 2 回の所要時間は確かめていない。

どの段で抜けたか:

- 罫線待ち (`hyoui input --timeout 5s … "wait:────────" || exit 0`) が時間切れになると、hyoui は stderr に `hyoui: input: spec[0]: wait: timeout (pattern=…)` を出す (実機で確認)。この行は stderr を捨てていないので、止まった回の stderr が direnv の 2 行だけなら、罫線待ちは通っている
- tail10 に `Quick safety check` が無い、または `❯` / `Yes` の行が取れない分岐は、その場で `exit 0` するので所要時間は通った回と変わらない (resume の 1.77 s が近い)
- 止まった 3 回は通った回より 1.6〜1.9 秒長い。Yes 送信 (`hyoui input --timeout 2s … key:Down wait:"❯ Yes, I trust" key:Enter 2>/dev/null || exit 0`) の待ちが 2 秒で切れた場合の所要と合う
- 06:27 の回は、launch を頼んだセッションが 0.25 秒刻みで画面を見ていた。ダイアログは launch の呼び出しから 1.1 秒後には出ていて、その後 10 秒間カーソルは `No, exit` のまま動かなかった。06:28 の回は、返事の 4 秒後に同じ `key:Down wait:"❯ Yes, I trust" key:Enter` をそのセッションの Bash から送ると通った

つまり止まった回は、ダイアログが描かれた後に送った `key:Down` が選択を動かさなかった。送ったキーが claude に届かなかったのか、届いて捨てられたのかは見分けられていない。

同じ時間帯 (06:24〜06:31) に、同じスクリプトの複製を launch を頼んだセッションの Bash から直接流すと、ダイアログが出た 7 回は env を daemon 経由の claude の env に揃えた回、`setsid` した回を含めてすべて通っている。止まるのは、その時点で動いていた daemon を通した時だけだった。

## 4. 退けた候補

| 候補 | 確かめたこと | 結果 |
|---|---|---|
| upgrade 経路の env / stdio / process group / tty | 1・2 の表 | 経路で失敗は変わらない。止まった daemon と通った daemon は同じセッションの Bash から起きている |
| daemon が sandbox (sandbox-exec) の中で起きた | `sandbox_check(pid)` で、止まった daemon が 05:04 に立てたセッションの claude を見ると sandbox の外 (子は sandbox を継ぐので、daemon も外) | 違う |
| hyoui の state の root が `hyoui run` と `hyoui input` で食い違う | hyoui 0.16.4 は `HYOUI_NAMESPACE` を読まず、root は `HYOUI_STATE_DIR` か `$XDG_STATE_HOME/hyoui`。スクリプトは `HYOUI_*` を両方の前に消す | 違う。食い違うなら `hyoui input` が stderr に出す |
| 画面サイズで tail10 からダイアログの見出しが外れる | `--detached` は既定 80×24、新しいセッションに自動で attach して resize する client は居ない | 違う (所要時間とも合わない) |
| daemon が実行中に `process.env` を書き換える | `packages/` を検索、書き換えは testkit だけ | 違う |
| Bun / nix の切り替え | 10-14 以降 nix の profile の切り替えなし、bun は 1.4.2 | 違う |

## 5. 罫線の直後に送ったキーの取りこぼし

daemon を通さず、Bash tool から `hyoui run --detached` で claude (隔離 config dir、新しい空の git repo) を起こし、`hyoui input --timeout 5s <id> "wait:────────"` が返ってから指定の間を置いて `hyoui input --timeout 2s <id> key:Down "wait:❯ Yes, I trust"` を送った。捨てられた回は 2 秒後の画面でも `❯ No, exit` のままだった。

| claude | 罫線から Down までの間 | 回数 | `❯` が Yes に動いた | 捨てられた |
|---|---|---|---|---|
| `claude` | 0 | 40 | 37 | 3 |
| `claude` | 50 ms | 10 | 10 | 0 |
| `claude` | 100 ms | 10 | 10 | 0 |
| `claude` | 200 ms | 10 | 10 | 0 |
| sandbox-exec ラッパー | 0 | 15 | 3 | 12 |
| sandbox-exec ラッパー | 50 ms | 15 | 15 | 0 |

送り方を変えた比較 (sandbox-exec ラッパー、罫線の直後):

| 送り方 | 回数 | 通った |
|---|---|---|
| `wait:"❯ No, exit"` → `key:Down` → `wait:"❯ Yes, I trust"` (2 秒) | 15 | 3 |
| `key:Down` → `wait:"❯ Yes, I trust"` (300 ms)、動かず `❯ No, exit` のままなら送り直す (最大 10 回) | 15 | 15 (送信は計 26 回) |

- 罫線と選択肢は同じ描画で出るので、`❯ No, exit` を待っても入力の受け付けの開始は待てない
- キーは後から処理されるのではなく捨てられる。送り直すと、2 回目以降で通る
- launch command は罫線待ちの後に screen dump と grep を挟むので、この隔離環境では Down までに 50 ms 以上空き、2 節の launch は全部通った。実 daemon で止まった回は、罫線から送信まで 0.1〜0.2 秒空いていたが捨てられた (launch を頼んだセッションの観測)。実 config dir の claude では入力の受け付けの開始がそれより遅れることがある、というところまでは言えるが、なぜその daemon を通した時だけ毎回遅れたのかは確かめられていない

## 6. 次に見るもの

止まった daemon を再起動する前に、その daemon を通して観測する。必要なのは:

- Yes 送信の `hyoui input` の stderr と rc (今は `2>/dev/null` で捨てている) と、送った直後と 2 秒後の screen dump
- そのとき動いている daemon の `ps -E` (env)、`lsof -p` (fd の数と種類)、起動からの経過時間
- 同じ daemon で launch を何回か流して、毎回止まるのか
- 経過時間の仮説を確かめるなら、restart 直後に通ることを確かめた実 daemon で、30 分以上経ってからもう一度流す (他にセッションの無い隔離 daemon では、起動 31 分後でも 6 回すべて通った)

## 7. launch command 側への提案 (kawaz のスクリプト、リポ外)

Yes 送信を「Down を送って `❯` が Yes に動いたのを確かめてから Enter、動かず `❯ No, exit` のままなら Down を送り直す」形にする。5 節の retry の形で、入力の受け付けが遅れても数回の送り直しで通る。選択肢が 2 つより多い並びにも合わせるなら、送り直す前に `❯` の行を取り直して、残りの移動量だけ送る。

あわせて、Yes 送信の `2>/dev/null` を外して stderr を launch の返事に残し、自動承認できずに `exit 0` する分岐ではその時の tail10 を stderr に出すと、次に止まった時にどの段で抜けたかが返事だけで分かる。
