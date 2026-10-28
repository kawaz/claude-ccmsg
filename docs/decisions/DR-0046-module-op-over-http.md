# DR-0046: hooks module から daemon への依頼を、daemon の Unix socket 上の HTTP の 1 endpoint で行い、頼み手を socket の相手の process で決める

- Status: Accepted (2026-10-28、kawaz 裁定) — ✅ 実装済み (daemon の `http.sock` の `POST /op` (`op-http.ts`、`http1.ts`、`peer-pid.ts`)、protocol の `module-op.ts` (socket の名前・`stateDirOf`・body の型)・`protocol-version.ts`・ErrorCode `unknown_peer`、module の `daemon-op.ts` と `send` / `peers` / 事実 / 案内 / サイドカーの依頼への返事の差し替え、CLI の `sidecar send-message` / `peer-list` / `facts` / `reply` の削除)。実機の確認は [findings 2026-10-28-mod-http-op](../findings/2026-10-28-mod-http-op.md)
- Date: 2026-10-28

## Context

hooks module が daemon に何かを頼む時は、呼び出しのたびに `$.process.run([<plugin root>/bin/ccmsg, ...])` で CLI を 1 つ起こしている。tool の `send` / `peers` は `ccmsg sidecar send-message` / `peer-list`、セッションの事実は `ccmsg sidecar facts`、サイドカーが渡した依頼への返事は `ccmsg sidecar reply`、最初の turn の前の案内の URL は `ccmsg status`。bun の起動を含めて 1 回 0.1〜0.3 秒かかり ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) Consequences、findings の表)、事実は turn や計測のたびに送るので、そのたびに process が 1 つ起きる。

DR-0039 は `$.http.fetch` の `socketPath` で daemon と直接話す案 (Alternatives の B10) を、2 つの理由で見送った: daemon に HTTP の op の endpoint と session role の名乗り方の設計が要ること、`socketPath` が任意の Unix socket に繋がるかがリファレンス自身で未確認だったこと。

kawaz 2026-10-28 の裁定:

- module → daemon の通信を、呼び出しごとの CLI の起動から、daemon の Unix socket 上の HTTP の 1 endpoint に切り替える。口が軽いなら、module → daemon のやりとりは頻度を気にせず密に行ってよい
- その口は同じユーザの別のプロセスが sid を名乗れる口になるので、自己申告 (hello) を identity の正本にしない。daemon が socket の相手の pid を取り、pid ↔ session id の対応で「どのセッションか / 知らない相手か」を決め、知らない相手は断る

### 実測 (Claude Code 2.1.312、Bun 1.4.2、[findings 2026-10-28-mod-http-op](../findings/2026-10-28-mod-http-op.md))

- `$.http.fetch(url, { socketPath })` は任意の Unix socket に繋がる。型定義の「near 100 B at most」「one per session, in a private directory」は制限として働いていない: 一時 dir の下の 93〜189 byte の path (189 はその dir で Bun が listen できた最長) のどれでも 200 が返った
- 返事を返さない server には、host が 30 秒で `aborted: no complete answer within 30000ms` で reject した (1 回)。`init` に timeout の指定は無い
- `$.http.fetch` の要求は `Content-Length` 付きの HTTP/1.1 で、`Connection: keep-alive` を送る (User-Agent は `Bun/1.4.4`)
- socket の相手の pid は Claude Code の process (`claude …`) の pid だった (`getsockopt` の `LOCAL_PEERPID` と `ps`、`$.process.run` で起こした子の親の pid とも一致、2 回)。hooks の worker は別の process ではない
- `claude -p` の process も `session.start` の時点で `<config dir>/sessions/<pid>.json` を書いていた。`/clear` の後は同じ file の `sessionId` が新しい id に変わった (1 回)
- Bun の `Bun.serve` の handler には接続の socket に届く口が無い。`Bun.listen` の socket は `fd` を持ち (型には無い)、`bun:ffi` の `getsockopt` で相手の pid が読めた (macOS の `LOCAL_PEERPID`、Linux (oven/bun:1.4.2 の image) の `SO_PEERCRED`)

## Decision

### 1. 口: state dir の `http.sock` の `POST /op`

- daemon は今の `daemon.sock` (1 行 1 JSON の wire) とは別に、同じ state dir に `http.sock` を bind して HTTP/1.1 を話す。endpoint は `POST /op` の 1 つで、op ごとの endpoint は作らない。どの op かは body の `op` が言う (wire と同じ)
- 別の socket にするのは、`daemon.sock` の frame が独自の行の形で、同じ socket で HTTP も話すと先頭の数バイトで判別することになるから。wire の読み手は変えない
- `Bun.listen` で受けて HTTP を自前で読む (`http1.ts`)。`Bun.serve` では接続の socket に届かず、相手の pid (§3) が取れない。読むのは module の `$.http.fetch` (と curl、Bun の fetch) が送る形だけ: 要求行、header、`Content-Length` の長さの body。chunked の body (501)、16 KiB を超える head (431)、8 MiB を超える body (413) は断る。1 つの接続に 1 つの要求で、応答は `Connection: close` を付けて接続を閉じる
- 名前の `http.sock` は `daemon.sock` より短い。`daemon.sock` を bind できる state dir なら必ず bind できる。module の fetch は Bun が bind できた最長の path まで繋がった (実測) ので、`sun_path` を理由に別の置き場へ逃がさない ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §3 のサイドカーの socket と同じ扱い)
- file mode は 0600 (bind の直後に chmod する。`daemon.sock` と同じ)。前の daemon が残した `http.sock` は、lock を取った daemon が起動時に unlink する。shutdown では lock を放す前に止める
- 接続は idle で切らない。返事の時期は op が決める (`send_message` は配送の待ち、`session_launch` は起動の待ち)

### 2. 要求と応答

- 要求の body は、wire の request と同じ JSON (`{ op, ...op の欄 }`) に `hello` 欄を足した 1 つの object。`hello` は `{ sid, client_version?, protocol? }` (§3)。`request_id` は書かない (書いても daemon が上書きする)
- daemon は 1 つの要求を 1 つの接続として扱う。§3 で決めたセッションの hello を作り、続いて body の残りを op の request にして、`daemon.sock` の 1 行と同じ処理 (`readRequest`、世代の検査、名乗りを要する op の検査、dispatch) に順に通し、要求の終わりで接続を閉じる (購読等の後始末も `daemon.sock` の接続が閉じた時と同じ)
- 応答は wire の返事の JSON をそのまま本文にする (`{ ok: true, ... }` か `{ ok: false, error: { code, msg } }`。`request_id` が付いたまま)。status は 200。hello が断られたら hello の返事を返し、op は走らせない
- body が JSON の object でない、`hello` 欄が §3 の形でない時は status 400 で `bad_request` の返事を返す。`/op` 以外の path は 404、`POST` 以外の method は 405 (`Allow: POST`)、HTTP として読めない要求は 400 / 413 / 431 / 501 (本文は理由の短い文)
- client は 200 と 400 の本文を wire の返事として読む。それ以外の status は ccmsg の口ではない何かが答えたものとして扱う

### 3. 頼み手: socket の相手の process

- daemon は接続を受けた時に、相手の process の pid を kernel から読む (`peer-pid.ts`、`getsockopt` を `bun:ffi` で。macOS は `SOL_LOCAL` / `LOCAL_PEERPID`、Linux は `SOL_SOCKET` / `SO_PEERCRED`)。相手が自分で選べる値ではない
- その pid の `<config dir>/sessions/<pid>.json` (Claude Code が process ごとに書く state file) を、daemon が届く config dir の中で探す。届く config dir は daemon が serve する dir (`CCMSG_CLAUDE_CONFIG_DIRS`、既定の state dir の daemon なら `$HOME/.claude*`) と、セッション自身の hello (サイドカー) が名乗った dir (そのセッションに限る、`sessionScope`) で、送信や一覧が見るのと同じ範囲。file の `pid` が相手の pid で、その dir でその `sessionId` が届く範囲なら、頼み手はそのセッションで、config dir はその dir
- 見つからなければ ErrorCode `unknown_peer` で断り、op は走らせない (msg は「process <pid> is not a Claude Code session in a config dir this daemon reaches」)。pid が読めなかった時も同じ
- body の `hello` は pid から引けないものだけを持つ:
  - `sid`: module が頼むつもりのセッション (`$.session.id()`)。daemon は §3 で決めた session id と比べ、違えば `unknown_peer` で断る (「process <pid> runs session <a>, not <b> (its id may have just changed: /clear, /resume)」)。identity は pid が決め、この欄は食い違いを見つけるためだけに使う。`/clear` の直後に module と state file の id がずれた要求を、別のセッションの名で通さない
  - 例外はサイドカーの依頼への返事 (`sidecar_reply`) で、同じ process が以前に走らせていた id なら通す (kawaz 2026-10-28)。返事は依頼が届いた id で送る (daemon はその id の依頼と返事を突き合わせる) ので、`/clear` / `/resume` の前に届いた依頼 (`prompt.send` の `session_changed` 等) への返事は古い id を名乗る。daemon は相手の pid ごとに、その state file に見つけた session id を、その process が生きている間覚えておき (`PeerSessions`)、返事が名乗る id がその中にあれば、その id で hello を作る。覚えるのは daemon の process の中だけで、daemon を起こし直すと忘れる
  - `client_version`: plugin の root の `package.json` の `version` (`ccmsg version` と同じ値)。bundle に版を焼き込むと release の bump のたびに bundle が古くなる (`bun hooks/bundle.ts --check`) ので、`$.fs.read` で読む。読めなければ欄を省き、debug の log に残す
  - `protocol`: `PROTOCOL_VERSION`。版 (`package.json` を import する `version.ts`) と分けて `protocol-version.ts` に置き、bundle は世代だけを持つ。世代の違う値は hello の世代の検査が断る
- daemon が作る hello は `role: "session"`、`sid` と `config_dir` (§3 で決めたもの)、`client_version` / `protocol` (body のもの)。所在 (`cwd` / `repo` / `ws` / `repo_root` / `branch`) と `transcript_path` は入れない
  - 所在の 5 つは 1 組で、名乗るか名乗らないかのどちらか (`registerSession`)。名乗らない hello は登録済みの所在を保つので、サイドカーの名乗り (state file を読む CLI の hello) が付けた所在がそのまま残る
  - `transcript_path` を名乗らない hello は、その sid に採用済みの path を保ち、探し直さない (server.ts の hello)。探すと全 config dir の `projects/` を読み、実の home で 1 回約 30 ms かかる。採用済みの path が無い間 (最初の transcript が書かれる前) は今までどおり hello ごとに探す
- user role はこの口に無い。頼み手は必ずセッションで、user role の op は dispatch の role の検査で今までどおり断られる

### 4. この口で断る op

1 つの要求で返事を 1 つ返して接続を閉じるので、接続が開いている間に意味を持つ op は断る (`bad_request`、msg で理由を言う)。dispatch の op を全部読んだ結果:

| op | この口 | 理由 |
|---|---|---|
| `hello` | 断る | 名乗りは `hello` 欄と相手の pid で行う |
| `sidecar_hello` | 断る | 名乗った接続が開いている間を run の生存とする op (DR-0035 §3)。返事で接続が閉じると、名乗った run はその場で去る |
| `subscribe`、`transcript_subscribe`、`transcript_unsubscribe`、`session_status_subscribe`、`session_status_unsubscribe` | 断る | 接続への push の購読とその解除。返事の後に push を受ける接続が無く、解除する購読も無い |
| 上以外の全 op | 通す | 1 つの request に 1 つの返事で、接続の状態を返事の後に使わない。role の制限は dispatch のまま |

`session_launch` も通すが、起動の待ちは最大約 61 秒で、§6 の host の 30 秒の打ち切りを超えうる。tool `launch` は待ちを 15 秒で区切る別の op `launch_tool` を使う ([DR-0018](./DR-0018-session-launcher.md) §3.7)。

### 5. 権限

- `http.sock` は 0600 で、daemon と同じ uid のプロセスだけが繋げる。その中でも、daemon が届く config dir の state file が名指す process (Claude Code のセッション) だけが頼める
- Origin と送り元の IP は検査しない。ブラウザの fetch と WebSocket は Unix socket を宛先にできず、ページの JS から届く経路が無い。`http.ts` の Origin の検査は、TCP の listener にはブラウザが届くので要るもので、この socket には当たらない。`Host` header も読まない (module は `http://ccmsg/op` と書く)
- 守れる範囲: 同じ uid の別のプロセス (Bash の中の script 等) が body で他のセッションの sid を名乗っても、そのセッションとしては通らない。守れない範囲: 同じ uid のプロセスは state file そのものを書けるので、`sessions/<自分の pid>.json` を作れば名乗れる。これは偶然の名乗り間違いや雑な成りすましを止める線で、同じ uid の悪意あるプロセスを止める線ではない (`daemon.sock` も同じ uid には開いている)

### 6. module 側の client

- `hooks/daemon-op.ts` の `daemonOp($, request, { timeoutMs? })` 1 つ。state dir を `CCMSG_STATE_DIR` / `XDG_STATE_HOME` / `HOME` から daemon と同じ規則 (protocol の `stateDirOf`、`resolveStateDir` もこれを使う) で組み、`$.http.fetch("http://ccmsg/op", { method: "POST", body, socketPath })` で送る
- 結果は 4 つ:
  - `answered`: wire の返事 (本文の text)。呼び手が op の返事のスキーマで読む (断りは ErrorResponse として読む)
  - `no_daemon`: `http.sock` も `daemon.sock` も無い。何も送っていない
  - `outdated`: `daemon.sock` はあるが `http.sock` が無い。この口を持たない古い daemon で、何も送っていない
  - `unanswered`: fetch が reject した (繋がらない、host の 30 秒の打ち切り) か、200 / 400 以外の status。届いたかは分からない。待ちの間に人が Esc を押した時に fetch がどう終わるかは確かめていない
  - socket の有無を見るのは fetch が reject した時だけ (`$.fs.exists`)。成功する往復には足さない
- 時間の上限は原則として client が持たない。各 op の待ちの長さは daemon の側の期限 (`send_message` の配送の待ち等) と host の 30 秒が決める。例外は人の操作を止めて待つ呼び出しで、案内の `ping` は prompt を待たせるので 3 秒 (`$.clock.after` との race) で `unanswered` にする。時計の待ちが hook の 10 秒の予算に数えられるかは `tool.call` で確かめていないので、上限は予算より十分短くする
- tool は daemon を起こさない。daemon を起こすのはセッションの開始 (`ccmsg sidecar begin`) と人の CLI (`ccmsg daemon start` 等) だけ。`send` / `peers` の CLI が daemon を起こし、古い daemon を置き換えていた (`ensureDaemon`) 振る舞いは無くなる
- tool が model に返す文:

| 結果 | `send` | `peers` |
|---|---|---|
| `no_daemon` | ccmsg の daemon が居ないので、送っていない。daemon を起こす (`ccmsg daemon start`) | 一覧を返せなかった: ccmsg の daemon が居ない。daemon を起こす (`ccmsg daemon start`) |
| `outdated` | ccmsg の daemon がこの plugin より古いので、送っていない。daemon を更新する (`ccmsg daemon restart`) | 一覧を返せなかった: ccmsg の daemon がこの plugin より古い。daemon を更新する (`ccmsg daemon restart`) |
| `unanswered` | ccmsg の daemon から返事が無く、届いたか確かめられなかった: <理由>。(送り直しの注意) | 一覧を返せなかった: <理由> |
| 断り (`ok: false`、`unknown_peer` を含む) | `internal` 以外は「daemon が送信を断ったので、送っていない: <msg>」、`internal` と返事として読めない本文は「確かめられなかった」 | 一覧を返せなかった: <msg> |

事実の送信と案内は人の目に出ないので、`no_daemon` は何も言わず (事実は次に立った daemon が `session.facts` で問う)、他は debug の log に 1 行残す。

### 7. 移すものと残すもの

この口に移す (module の呼び出しを差し替え、CLI の内部コマンドを削る):

| 呼び出し | op | 削る CLI の内部コマンド |
|---|---|---|
| tool `send` | `send_message` | `ccmsg sidecar send-message` |
| tool `peers` | `peer_list` | `ccmsg sidecar peer-list` |
| セッションの事実 | `session_facts` | `ccmsg sidecar facts` |
| サイドカーの依頼への返事 (DR-0035 §3) | `sidecar_reply` | `ccmsg sidecar reply` |
| 案内の URL (DR-0039 §5) | `ping` (`webui_url`) | なし (`ccmsg status` は人の口として残る) |
| tool `launch` (kawaz 2026-10-29) | `launch_tool` (起動の待ちを 15 秒で区切り、超えた起動の結果は notify で戻す、[DR-0018](./DR-0018-session-launcher.md) §3.7) | `ccmsg sidecar launch` |

この DR では移さないもの:

- `ccmsg sidecar begin`: state file を書き、daemon が無ければ起こし、古ければ置き換える。HTTP の口は daemon が居ないと話せない
- `ccmsg sidecar permit` (tool `permit`)、request override、turn abort: 別の作業 (DR-0040、DR-0041、DR-0044) が CLI 経由で仕上げた後に、この口へ移す。tool `say` は CLI を起こさない (daemon が push の行から発声する、[DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §6)
- daemon → module の向き: サイドカー (`ccmsg sidecar`) が daemon の依頼を module に渡す経路と、`describe` の版 (`ccmsg version`) は DR-0035 §3 のまま。依頼への返事だけがこの口に移る

### 8. 互換

- 旧版の plugin の module は自分の root の CLI を呼ぶ。新しい版の CLI から内部コマンドを削っても、その module には影響しない
- 新しい module が `http.sock` を持たない古い daemon に当たると `outdated` の文を返す。セッションの開始の `sidecar begin` が古い daemon を置き換えるので、起きるのは開始の後に古い daemon が立った時に限られる
- `daemon.sock` の wire は変えず、protocol の世代も上げない。古い module の CLI はそのまま話せる。`daemon.sock` の hello は今までどおり自己申告で、この DR は変えない

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| 頼み手を body の hello (自己申告の sid) で決める | 同じユーザの別のプロセスが他のセッションの sid を名乗れる (kawaz 2026-10-28) |
| `Bun.serve({ unix })` で受ける | handler に接続の socket が渡らず、相手の pid が取れない。HTTP の読み書きを任せられる利点より、頼み手を kernel の記録で決めることを取る |
| 相手の pid を `lsof` 等の外部コマンドで引く | 要求ごとに process が 1 つ起き、この DR が無くしたい費用が daemon の側に移る |
| `daemon.sock` で先頭のバイトから HTTP を判別して両方を話す | wire の読み手に HTTP の判別が混ざる。socket を分ければ wire は変わらない |
| op ごとに endpoint を切る (`POST /send_message` 等) | op が増えるたびに口が増え、wire の op と別の名前の体系を持つ。dispatch には op 名で入るので、path は何も足さない |
| 最初に名乗って token を受け取り、以後は token で名乗る | 往復が 1 つ増え、daemon が token の表を持つ (再起動で消える状態が増える)。相手の pid で毎回決められる |
| keep-alive で接続を使い回す | 1 要求の往復は 0.5 ms 前後で (Consequences)、接続を張る費用は小さい。使い回すと 1 つの接続の中で要求の区切りと相手の pid の持ち越しを扱うことになる。行ごとの push (DR-0045) で接続の数が問題になった時に足す |
| module の側に timeout を持つ (`$.clock.after` との race) | `tool.call` の hook で時計の待ちが 10 秒の予算に数えられるかを確かめていない。host の 30 秒の打ち切りと daemon の側の期限で上限は決まっている |
| module が所在を名乗る (`$.session.cwd()`) | 所在は 5 つの 1 組で、module は `repo` / `ws` / `branch` / `repo_root` を持たない。cwd だけを名乗ると `repo_root` が消え、ファイルを読める範囲 (fs-access) が変わる |

## Consequences

- tool の `send` / `peers`、事実の送信、案内、サイドカーの依頼への返事で CLI の process が起きない。host の中から測った往復は、旧 CLI の約 0.1 秒 (中央値 97〜117 ms、初回は 578 ms) から 1〜4 ms になった (findings の表)
- 1 要求 1 接続の負荷の見積もり (daemon を同じ process に置き、`session_facts` を流した): transcript の path が採用済みのセッションで、直列 1000 回が 450 ms (1 回 0.45 ms、daemon の処理だけなら 0.23 ms)、同時 200 本が 28 ms。同時 500 本は接続が張れずに失敗した (listen の backlog)。1 MiB の body は 73 ms。module が `session.append` の全行を 1 行 1 POST で流す (DR-0045 の作り直し) と、1 つのセッションの送信は 1 本ずつ並ぶので同時の本数はセッションの数ほどで、行の数 × 0.5 ms 程度の負荷になる。同時に数百本を超える使い方、1 行ごとの往復の費用が問題になる場合は、keep-alive か複数行をまとめる op を足す
- transcript の path がまだ無いセッション (最初の transcript が書かれる前) は、hello ごとに全 config dir の `projects/` を探すので 1 要求約 30 ms (実の home) かかる。module が密に頼むほどこの間の費用が増える
- daemon が動いていない時、`send` / `peers` は daemon を起こさずに `no_daemon` を返す。人が止めた daemon を tool が蘇らせなくなり、DR-0039 Consequences の「daemon が立つ契機は module の `session.start` と人の CLI」がそのとおりになる。tool による古い daemon の置き換え (`ensureDaemon` の upgrade) も無くなり、置き換えはセッションの開始だけが行う
- 頼み手の state file が daemon の届く config dir に無い間は断られる。既定の daemon は `$HOME/.claude*` を serve するので起きない。serve しない config dir のセッション (試験の daemon 等) は、サイドカーの hello がその dir を名乗るまで (セッションの開始の直後) の要求が `unknown_peer` になる。事実は次の変化か daemon の `session.facts` の問いで埋まる
- `/clear` の直後に module と state file の id がずれている間の要求は `unknown_peer` で断られる (別のセッションの名では通らない)。観測した 1 回では state file が先に変わり、新しい id の事実は通った
- 古い id への返事が通るのは、daemon がその process をその id で見たことがある時だけ。daemon を起こし直した後は、その process がこの daemon に一度も頼まないうちに id が変わると、古い id への返事は `unknown_peer` で断られ、その依頼は期限で未確認になる。依頼はその id のサイドカーが名乗った daemon からしか来ず、名乗りの時に daemon が問う `session.facts` の返事がその id で届くので、ふつうはその前に覚えている
- daemon がまだその sid を知らない時 (daemon の再起動の直後、サイドカーが名乗り直す前) に module の要求が来ると、所在の無い登録ができ、サイドカーの名乗りで所在が付くまで webui の一覧の repo / ws の欄が空になる
- `ping` の `clients` は、要求の間だけ開いている接続も数える
- `peer-pid.ts` は macOS と Linux (glibc の `libc.so.6`) の呼び方だけを持つ。他の OS では相手の pid が読めず、すべての要求が `unknown_peer` になる
- bun-types (1.3.14、1.4.4) の `Socket` に `fd` が無いので、`Bun.listen` の socket の `fd` はスキーマで読む
- 置き換わる判断: DR-0039 Alternatives の B10 の行 (この DR で採る)、DR-0039 §4 の「module の transport」(sidecar 系のうち `send-message` / `peer-list` / `facts` / `reply` はこの口に移る)、DR-0035 §3 の返事と事実の送り方、DR-0039 §5 の URL の聞き方 (`ccmsg status`)

## 関連

- [findings 2026-10-28-mod-http-op](../findings/2026-10-28-mod-http-op.md) — `$.http.fetch` の `socketPath` と相手の pid の実測、往復時間と負荷の測定、CLI の process が起きないことの観測
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — tool と daemon の関係、§5 の案内、B10
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) §3 — サイドカーとセッションの事実
- [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) — say と `permit` の音声の作り直し、行の push
- [DR-0034](./DR-0034-peer-socket-injection.md) §5 — `sessions/<pid>.json`
- [DR-0018](./DR-0018-session-launcher.md) §3.7 — `launch` の待ち
- [DR-0002](./DR-0002-daemon-supervision.md) — state dir と socket の置き場
