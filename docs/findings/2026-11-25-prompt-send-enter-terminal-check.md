# prompt.send の Enter の前に、押す端末が自分の claude の端末かを確かめる方法 (2026-11-25)

issue [2026-11-22-prompt-send-trusts-inherited-hyoui-session-id](../issue/2026-11-22-prompt-send-trusts-inherited-hyoui-session-id.md) の調査。直し方の案までで、実装はしていない。

## 判明した事実 (観測)

- module が `$.process.spawn` で起こした子 (サイドカー) は、claude と同じ process group・同じ制御端末にいる。動いている 32 の run の全部で、サイドカーの ppid = claude の pid、サイドカーの pgid = claude の pid、tty = claude の tty、stat に `+` (前面の process group) が付いていた
- 32 の run の全部で、名乗りの `HYOUI_SESSION_ID` を `hyoui status <id> --format json` に引くと、`child_pid` と `child_pgid` がどちらもその run の claude の pid と一致し、`ps -o tty=,tpgid= -p <child_pid>` の tty はサイドカーの tty、tpgid は claude の pid だった。claude は hyoui の子そのものとして走っている (`claude` を直に起こすものと、`exec sandbox-exec … claude` の wrapper を通すもの。どちらも exec で置き換わるので子の pid が claude になる)
- hyoui の session 36 本の子の argv[0] は `claude` 20、wrapper 15、claude でないもの 1。login shell (`hyoui run --login`) の中で `claude` を打った session は無かった
- 継いだ `HYOUI_SESSION_ID` を持つ使い捨てのプロセスを 3 通りで起こすと、どれも変数は起こした側の session の id のままで、pgid と tty は hyoui の子と違った:

| 起こし方 | `HYOUI_SESSION_ID` | pgid | tty | hyoui の子 (pgid / tty) との一致 |
|---|---|---|---|---|
| claude の Bash から直に (`sh -c`) | 継いだ id | Bash の shell の pgid | 無し (`??`) | 一致しない |
| `script` で新しい pty | 継いだ id | 自分 (新しい session) | 新しい pty | 一致しない |
| tmux (専用 socket の server) の pane | 継いだ id | 自分 (新しい session) | pane の pty | 一致しない |
| (比べる相手) hyoui の子 = 起こした側の claude | — | claude の pid | hyoui の pty | — |

- claude の Bash の shell は claude と別の session にいて、制御端末を持たない (`tty` は `not a tty`、ps の tty は `??`)。Bash から起こしたものは、何を挟んでも claude の process group と端末には戻らない
- `CLAUDE_PID` は Bash の子の環境にはあるが、サイドカー (module の `process.spawn` の子) の環境には無かった (8 本を見た)。module は環境変数から自分の claude の pid を知れない
- 所要時間 (hyperfine、30 回、平均 ± 標準偏差 [最小 … 最大]):

| コマンド | 時間 |
|---|---|
| `hyoui status <id> --format json` | 53.5 ± 13.7 ms [8.6 … 68.4] |
| `/bin/sh -c 'exec /bin/ps -o pgid=,tty= -p $$'` | 9.5 ± 3.1 ms [6.3 … 16.5] |
| `/bin/ps -o tty=,tpgid=,pgid= -p <pid>` | 4.3 ± 1.0 ms [3.2 … 7.1] |

## コードと資料を読んで分かったこと (観測していない)

- Enter を押すのは `hooks/prompt-send.ts` の `handlePromptSend` で、`$.env.get("HYOUI_SESSION_ID")` の値をそのまま `hyoui input <id> key:Enter` に渡す。確かめは無い
- bash mode (`mode: "bash"`) では、Enter の前に同じ id へ `text:!` と `wait:` も送る (`hyouiShellModeArgv`)。継いだ id では、自分の composer を空にした後で `!` が別のセッションの端末に打たれ、その端末が bash mode に切り替わると `wait:` も通ってしまう。確かめは `!` の前にも要る
- サイドカーの名乗り (`hooks/sidecar.ts` の `sidecarArgv`) も同じ `$.env.get("HYOUI_SESSION_ID")` を `--hyoui-session-id` で daemon に渡す。コメントは「daemon に言う値と module が使う値を同じにする」と書く。daemon はこの値で `input_readiness` (`packages/daemon/src/user-prompt.ts` の `inputReadiness`) を決め、webui の Terminal タブはこの値の端末を iframe に出す。継いだ id では、届かない run が `ready` と出て、Terminal タブには起こした側のセッションの端末が出ることになる
- 理由の語彙は `packages/protocol/src/sidecar.ts` の `UserPromptModuleReasonSchema`。`no_terminal` は「hyoui の下で起こされていないので Enter を送る端末が無い」、`not_submitted` は「Enter が文を submit しなかった。composer は書きかけに戻した」
- DR-0035 §3: 同じ sid の run が複数ある時、daemon が次の run へ進むのは `no_composer` / `no_terminal` / `session_changed` の時。`not_submitted` では進まない
- DR-0035 §3 は「module とサイドカーは harness の pid を知らず、探さない (祖先を `ps` で辿る方法は sandbox の中では使えない)」と書く。下の候補は祖先を辿らず、自分の子の pgid と tty を 1 回読むだけだが、`ps` を使う点は同じ
- hyoui の `status` は `child_pid` と `child_pgid` を返し、PTY の名前 (slave の path) と前面の process group (`tcgetpgrp`) は返さない (`hyoui status --help`、hyoui リポの `crates/hyoui/src/protocol/messages/status.rs` の `StatusResponse`)。子は独立した session leader として起こされ、普通は `child_pgid == child_pid` (同ファイルのコメント、`crates/hyoui/src/daemon/control.rs` は `getpgid(child)` を返す)。子は session leader なので、子の pid に `ps -o tty=,tpgid=` を当てれば PTY の名前と前面の process group が取れる。下の候補に要るものは今の hyoui で足りている
- ccmsg の launch は `hyoui run --detached -- claude …` で起こす (`packages/daemon/src/default-launch-command.sh`)。hyoui の子が claude そのものになる

## 確かめ方の候補

どれも「module の `$.process.run` の子は claude と同じ process group・同じ制御端末にいる」を使う (サイドカーで観測、`process.run` の子では未確認)。自分の側は `["/bin/sh", "-c", "exec /bin/ps -o pgid=,tty= -p $$"]` 1 本で読める (exec で ps が sh の pid を継ぐので、ps 自身の pgid と tty が出る)。

| | A. process group の一致 | B. 端末の一致と前面 | C. 画面に fill した文が出るか |
|---|---|---|---|
| 確かめること | `hyoui status` の `child_pgid` == 自分の pgid | 自分の tty == hyoui の子の tty、かつその tty の前面の pgid (tpgid) == 自分の pgid | fill の後、`hyoui wait` で hyoui の画面に fill した文 (か nonce) が出るか |
| 同じ端末と言える根拠 | 同じ process group は同じ session にあり、session の制御端末は 1 つ。hyoui の子の group にいれば、その PTY が自分の端末で、そこが前面 | 制御端末が同じ PTY で、キーを読む前面の group が自分 | hyoui の画面に自分の composer が映っている |
| 継いだ id (Bash・script・tmux から) | 外れる (観測) | 外れる (観測) | 起こした側の画面に同じ文があると通ってしまう (送った側がその文を表示していることがある)。nonce にすると人の composer を書き換える |
| tmux の中の claude (hyoui の中で tmux) | 外れる (pane の pty は別の session) | 外れる | pane が見えていれば通るが、分割で前面でない pane でも通る |
| ssh 越し | 外れる (環境変数が渡らなければ今も `no_terminal`。渡っても相手の機械に同じ id の hyoui は無く `hyoui status` が失敗) | 同左 | 同左 (推論、未観測) |
| hyoui の無い端末 | 変数が無ければ今と同じ `no_terminal` | 同左 | 同左 |
| `hyoui run --detached -- claude` | 通る (32 の run で観測) | 通る (同) | 未観測 |
| `exec` で claude に置き換わる wrapper | 通る (観測) | 通る (観測) | 未観測 |
| login shell の中で `claude` を打った | 外れる (shell の job control で claude は別の group。推論、未観測) | 通る (推論、未観測) | 通る見込み |
| 結果が変わる時 | 変わらない (claude の pgid と hyoui の子の pgid はどちらもプロセスの寿命の間固定) | tty の一致は固定。前面は変わりうる (login shell で claude が後ろに回る等) | 画面が変わるたび |
| 掛かる時間 | `hyoui status` (約 9〜68 ms) + sh/ps (約 6〜17 ms)。run ごとに 1 回で足りる | 同じ 2 本 (自分と hyoui の子を 1 本の ps に `-p $$,<child_pid>` でまとめられる)。前面も見るなら Enter のたび | 描画を待つ分 (未計測、試験用セッションでの実測が要る) |

比較から外したもの: daemon の側で、run の pid (agents の行から引いたもの) と `hyoui status` の `child_pid` を比べる案。issue が確かめ方を module の責務としていることと、名乗りの時点で daemon が pid をまだ引けていないことがある (DR-0035 §3) ため。祖先を ps で辿る案は、Bash から `script` 等で起こした claude の祖先に起こした側の claude と hyoui がいるので、継いだ id を通してしまう。

## 推す案

A を、run ごとに 1 回、サイドカーを名乗る前に確かめる形で推す。

- 根拠が最も強く単純: 比べるのは数 1 つで、同じ process group なら同じ制御端末であることは OS が保証する。今の起こし方 (launch の `--detached`、手で `hyoui run -- claude`、exec する wrapper) は全部通り、継いだ id の 3 通りは全部外れた
- 結果がプロセスの寿命の間変わらないので、Enter のたびに確かめなくてよい。1 回 60 ms 前後をサイドカーの起動に足すだけで、prompt.send の 12 秒の期限には触らない
- 確かめた id だけを名乗りと Enter・`!` の宛先に使えば、DR-0035 §3 の「daemon に言う値と module が使う値を同じにする」がそのまま保たれる。継いだ id の run は `no_terminal` と名乗ったのと同じになり、daemon の `input_readiness`、webui の入力欄の案内、Terminal タブ、複数 run の時の次の run への進み方が全部揃う
- 確かめられない時 (hyoui が無い、`hyoui status` が失敗、ps が失敗、一致しない) は押さない側に倒れる

A の弱い所:

- login shell の中で `claude` を打った session では、今は届く Enter が届かなくなる (推論。今の 36 の session には無い)。その使い方が現にあるなら B (前面の確かめを Enter のたびに足す) が要る
- hyoui の中の tmux・ssh 越しで、たまたま届いていた Enter も届かなくなる。どちらも今の DR の「自分の端末に Enter」の外の使い方
- `ps` が使えない環境 (DR-0035 §3 の言う sandbox) では確かめられず、prompt.send が全部 `no_terminal` になる。kawaz の環境の Claude Code の sandbox は無効で、sandbox-exec の wrapper は allow-default の profile だが、その中から `ps` を打てるかは見ていない

## 決めてほしいこと

- 理由の語彙: issue と依頼は「確かめられなければ `not_submitted` を返す」と書くが、推す形では `no_terminal` になる。`not_submitted` の定義は「Enter が submit しなかった」で、Enter を押していない場合と合わない。また `not_submitted` では daemon が同じ sid の次の run へ進まない (DR-0035 §3)。`no_terminal` の定義 (「hyoui の下で起こされていない」) を「自分の端末と確かめられた hyoui の端末が無い」に広げるか、新しい理由を足すかの判断が要る。Enter のたびに確かめて `not_submitted` を返す形にすると、daemon の `input_readiness` と Terminal タブは継いだ id のまま残る
- DR-0035 §1・§3 の「`$.env.get` で読んだ `HYOUI_SESSION_ID` を宛先に」「名乗りは `$.env.get` で読んだ値」は、確かめた値に書き換えが要る

## 未確認 (実測が要る)

- `$.process.run` の子も `process.spawn` の子 (サイドカー) と同じく claude の process group・制御端末にいるか。試験用の claude セッションで `["/bin/sh", "-c", "exec /bin/ps -o pid=,ppid=,pgid=,tpgid=,tty= -p $$"]` を走らせて確かめる
- `$.process.run` 1 回の上乗せの時間
- login shell の中で `claude` を打った時の pgid と tpgid (A が外れ、B が通るという推論の裏付け)
- sandbox-exec の profile の中と、Claude Code の sandbox を有効にした時に、`$.process.run` から `ps -p $$` が通るか
- C の描画待ちの時間

## 検証の詳細

### 条件

- macOS (Darwin 25.5.0)、hyoui 0.16.4、Claude Code 2.1.332
- 観測は読み取りだけ: `ps`、`hyoui status`、`hyoui list --format=jsonl`。人のセッションの端末にキーは送っていない。hyoui の端末は作っていない
- 環境変数は、サイドカーの `ps -E` の出力から `CLAUDE_PID=` と `HYOUI_SESSION_ID=` に当たる部分だけを `grep -o` で抜き出した (他の値は見ていない)
- 使い捨てのプロセスは、この調査をしたセッションの Bash から起こした: `sh -c` を直に、`script -q /dev/null sh -c …`、`tmux -L <専用の名前> -f /dev/null new-session -d …` (調べた後に `kill-server`)。どれも自分の `ps -o pid=,ppid=,pgid=,tpgid=,tty= -p $$` と `HYOUI_SESSION_ID` を出すだけ

### run ごとの突き合わせ

各サイドカー (`ccmsg sidecar --sid … --hyoui-session-id <id>`) について、次を比べた。

- サイドカーの ppid (= claude の pid)、pgid、tty
- `hyoui status <id> --format json` の `child_pid` / `child_pgid`
- `ps -o tty=,tpgid= -p <child_pid>`

32 本すべてで `child_pid == claude の pid`、`child_pgid == claude の pid`、子の tty == サイドカーの tty、子の tty の tpgid == サイドカーの pgid だった。`--hyoui-session-id` を持たないサイドカーは無かった。

### 所要時間

`hyperfine -N --warmup 3 --runs 30` で、`hyoui status <自分の session の id> --format json`、`/bin/sh -c 'exec /bin/ps -o pgid=,tty= -p $$'`、`/bin/ps -o tty=,tpgid=,pgid= -p <claude の pid>` を計った。`$.process.run` を通した時の上乗せは含まない。
