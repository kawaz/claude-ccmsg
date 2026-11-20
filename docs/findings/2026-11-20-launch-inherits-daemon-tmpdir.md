# launch で起動したセッションが、daemon を起こした別のセッションの TMPDIR を継いでいた

- Date: 2026-11-20
- 対象: ccmsg v0.293.0 の daemon と CLI、Claude Code 2.1.328、macOS (Darwin 25.5.0)
- 動機: 2026-11-20 11:01 に launch で起動した、業務面 (サンドボックスで包む面) のリポのセッションの `TMPDIR` が、起動先でなく統括のセッションの置き場 `~/.local/share/repos/github.com/kawaz/claude-ccmsg/main/tmp.local/b74279ed-…/` を指し、その面のサンドボックスから書けずに `mktemp` と `git commit` が `Operation not permitted` で落ちた (報告。再現手順は無い)。前日夕方に個人面のリポへ launch したセッションの `TMPDIR` は `<cwd>/tmp.local/<自分の session id>/` で正しかった

## 判明した事実

### (a) daemon はたまたま起こしたセッションの環境で起動する

- CLI が daemon を起こす経路は `packages/cli/src/client.ts` の `spawnDaemon` 1 つだけで、`Bun.spawn(..., { env: process.env })` だった。`ensureDaemon` が「繋がらない時」と「daemon が CLI より古い時 (newer-wins の入れ替え)」にここを通る
- `just push` の最後の `_local-daemon-upgrade` は、plugin cache の最新版の `bin/ccmsg peers` を呼ぶ。`peers` は `ensureDaemon` を通るので、push で版が上がっていれば旧 daemon を止めて、push を回したセッションの shell の環境で新しい daemon を spawn する
- 今動いている daemon (pid 13322、2026-11-19 15:33:47 JST 起動、v0.293.0、daemon.log の `listening ... (v0.293.0)` と同時刻) の環境を `ps -E` で見ると、統括のセッションのものだった:
  - `TMPDIR=~/.local/share/repos/github.com/kawaz/claude-ccmsg/main/tmp.local/b74279ed-…/`
  - `CLAUDE_CODE_SESSION_ID=b74279ed-…`、`PWD=…/claude-ccmsg/main`、`CLAUDE_CONFIG_DIR=~/.claude-personal`
  - Claude Code がセッションの子に付ける変数 (`CLAUDECODE`、`CLAUDE_PID`、`CLAUDE_CODE_MESSAGING_TOKEN` 等) も全部持っていた (これは issue `2026-11-20-daemon-env-carries-spawning-session-identity` に分けた)
- 2026-11-19 の 13:16〜15:33 JST に daemon は 8 回入れ替わっていて (daemon.log の `graceful shutdown (upgrade)`)、統括のセッションはその間 `just push` を回していた。今の daemon が統括の環境を持つことは上の観測で確かめた。それより前の入れ替えの環境は、プロセスが残っていないので確かめていない

### (b) セッションの TMPDIR を付けているのは起動ラッパーで、面によって付けない

- Claude Code 本体、`~/.claude-personal/settings.json` と `~/.claude-emrd/settings.json` (`env` に `TMPDIR` は無い)、`~/.local/bin`、`~/bin` を探し、`TMPDIR` を付けているのは launch の起動コマンドに設定された `~/bin/itumono-run-claude.sh` だけだった
- このラッパーは、個人面等のリポ (`BIN_CLAUDE == claude`) で diskdrift がある時だけ、`<cwd>/tmp.local/<session id>` を diskdrift の置き場への symlink にして `export TMPDIR=<cwd>/tmp.local/<session id>/` する。既存の `TMPDIR` を見ずに上書きする
- 業務面 (業務用アカウントと業務先の owner のリポ) では claude を Seatbelt (`sandbox-exec`) で包むスクリプトに差し替え、`TMPDIR` を付けない (「その面のスクリプトが自分の形で用意する」とコメントにあるが、スクリプトは `TMPDIR` に触れていない)。継いだ `TMPDIR` がそのまま claude に届く
- その面のサンドボックスの profile は個人面の owner のリポ (`repos/github.com/kawaz/` の下) の読み書きを deny し、`/private/var/folders` と `/private/tmp` を許している。統括の置き場は個人面のリポの下なので書けない (どの rule に当たったかは確かめていない)

### (c) launch で起動したセッションに daemon の TMPDIR が届いていた

- daemon は起動コマンドに自分の環境を `buildLaunchEnv` (`clean_env` / `keep_env`) で掃除して渡す。kawaz の config の `clean_env` は `CLAUDE*` 等で、`TMPDIR` は含まない (既定の `clean_env` は空)
- 2026-11-20 11:01 に起動したセッション (session_launch の行 `by=725686d9-… cwd=<業務面のリポ>/main session_id=d9c3534d-…`) の端末プロセス (`hyoui run --detached`、pid 56947) の環境: `TMPDIR=~/.local/share/repos/github.com/kawaz/claude-ccmsg/main/tmp.local/b74279ed-…/`、`CLAUDE_CONFIG_DIR=~/.claude-emrd`。daemon の `TMPDIR` と同じ値
- 同じ面の端末プロセスで今も残っている 9 つ (2026-11-12〜19 12:41 JST に起動) の `TMPDIR` は、どれも `/var/folders/dh/…/T/` (`getconf DARWIN_USER_TEMP_DIR` と同じ)。そのうち 2026-11-19 12:24 と 12:41 JST の 2 つは daemon.log の session_launch の行と時刻・cwd が一致し、daemon から起動したもの。この面のラッパーは `TMPDIR` を付けないので、その時の daemon の `TMPDIR` が OS の既定だったことになる。残りの 7 つが daemon からの起動か手での起動かは確かめていない
- daemon.log の業務面への launch は 2026-11-19 12:54 JST の後、今日の 11:01 まで無い。daemon の入れ替わりが始まったのは 11-19 13:16 JST で、その間に daemon の `TMPDIR` が統括の置き場に変わった

### 個人面の対照が正しかった理由

- 2026-11-19 17:54 JST の個人面のリポへの launch (session `7120604b-…`) は、今と同じ daemon (統括の `TMPDIR` を持つ) から起動していた。端末プロセスの `TMPDIR` は `…/workboard-personal/main/tmp.local/7120604b-…/` で正しい
- 個人面ではラッパーが継いだ `TMPDIR` を見ずに上書きするので、daemon の値は消える。業務面では上書きしないので daemon の値が残る。差は起動ラッパーの面ごとの分岐で、daemon の側はどちらにも同じ値を渡していた

### 添付の置き場も同じ所に向いていた

- 添付の置き場は daemon の `TMPDIR/claude-ccmsg-<uid>/attachment/` (DR-0015 §2.1)。統括の置き場の下の `claude-ccmsg-501/attachment/` に 2026-11-19 17:33 の添付が 11 件あり、OS の既定の置き場 (`/var/folders/…/T/claude-ccmsg-501/attachment/`) にはそれより前の 23 件があった。統括のセッションの置き場が diskdrift の期限で消えると添付も消え、業務面のサンドボックスのセッションからは添付を読めない

## 直したこと

- `packages/daemon/src/user-temp-dir.ts`: OS の利用者ごとの一時ディレクトリ (`userTempDir()`、macOS は空の環境で `/usr/bin/getconf DARWIN_USER_TEMP_DIR`、他の OS は無し) と、環境の `TMPDIR` を置き換える `withTmpdir()`
- daemon の spawn (`spawnDaemon`): 環境を `withTmpdir(process.env, userTempDir())` にした。daemon の `TMPDIR` は呼んだセッションに依らず `/var/folders/…/T/` になり、添付もそこに戻る (DR-0002 §2)
- launch (`launchSession`): `buildLaunchEnv` の結果の `TMPDIR` を `userTempDir()` に置き換え、その上に `CCMSG_LAUNCH_REQUESTED_BY` を重ねる。`clean_env` / `keep_env` の判定の外 (DR-0018 §3.1、§3.5、launch-command の「環境変数」)。daemon がどう起動されていても (手で `ccmsg daemon run` した時も)、起動コマンドに daemon の `TMPDIR` は届かない
- 外すだけでなく OS の既定に置き換えるのは、`TMPDIR` を付けない起動コマンド (業務面のラッパー、組み込みの起動コマンド) のセッションが、事故の前と同じ `/var/folders/…/T/` で動くようにするため。外すと macOS では `/tmp` (全員の共有) に落ち、ログインの端末で起こしたプロセスと違う環境になる
- テストで固定した
  - `packages/cli/test/daemon-spawn-env.test.ts`: `TMPDIR` をセッションの置き場の形にして `ensureDaemon` で daemon を spawn し、走っている daemon の環境を OS から読んで (`ps eww` / `/proc`)、`TMPDIR` が呼んだ側の値でなく `userTempDir()` であること。直す前のコードでは落ちる (確かめた)
  - `packages/daemon/test/session-launcher-integration.test.ts`: daemon の `TMPDIR` がセッションの置き場の時、起動コマンドが受ける `TMPDIR` が `userTempDir()` (無い OS では無し) であること。`keep_env: ["TMPDIR"]` でも `clean_env: ["TMPDIR"]` でも同じ。直す前のコードでは落ちる (確かめた)
  - `packages/daemon/test/user-temp-dir.test.ts`: macOS で `userTempDir()` が getconf の値で、持ち主だけのディレクトリであり、テストの `TMPDIR` と違うこと。`withTmpdir` の置き換え・外し・足し

## 未確認

- 起動コマンドへの `TMPDIR` を OS の既定にした後で、実際に業務面のセッションを launch して `mktemp` と `git commit` が通ること (実セッションを起動していない。直した daemon が本番で動くのは次の release の後)
- 本番の daemon の入れ替え後に、新しい daemon の `TMPDIR` が `/var/folders/…/T/` になること (本番の daemon には触れていない。上の CLI のテストは同じ経路の spawn を実プロセスで確かめている)
- Linux で `TMPDIR` を外した daemon の添付の置き場が `/tmp/claude-ccmsg-<uid>/` になる時の扱い (共有の `/tmp` で、他の利用者が先に作ったディレクトリを使う形になりうる)。kawaz の環境は macOS だけなので確かめていない

## 実用的な示唆

- 長く生きるプロセスを、たまたま呼んだプロセスの環境で起こすと、呼んだ側のセッション固有の値がそのプロセスの寿命の間ずっと残り、その子の全部に配られる。`TMPDIR` は値が常にあるので「無ければ付ける」側では直らず、起こす側で意味のある値に置き換えるしかない
- 起動ラッパーが面ごとに環境の作り方を分けていると、ある面だけ daemon の値が素通りする。面ごとの分岐の片方にだけ `TMPDIR` を付けていないかは、ラッパー側でも点検する価値がある
