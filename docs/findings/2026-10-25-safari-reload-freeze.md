# iPhone / iPad の Safari で、青いリロードボタンを押すと固まる

- Date: 2026-10-25
- 対象: ccmsg v0.193.3 〜 v0.195.1 の webui、前段の Caddy v2.11.7 (quic-go v0.63.0、`protocols h1 h2 h3`、launchd で常駐)、この Mac (macOS 26.5.2、Tailscale の interface の MTU は 1280)、iPhone の Safari (iOS 26 系)
- 症状 (kawaz の報告): 青いリロードボタンを押すと読み込みが終わらない。× で止めてアドレスバーのリロードを押しても、タブを閉じて新しいタブで開いても同じ。Safari を終了して起動し直すと一瞬で開く。再現率はほぼ 100%。体感では ccmsg でしか出ない
- 方法:
  - 実 daemon の `daemon.log`、前段の Caddy のアクセスログ / エラーログ (2026-10-19 〜 10-25)、`pmset -g log`、`netstat -s`、`sysctl`、`tailscale status` を読んだ (読むだけ)
  - webui と daemon のコードを読んだ
  - 一時ベースで、作業コピーの daemon と、前段と同じ Caddy の binary を自前の設定で立て、Playwright の WebKit (macOS 版) と HTTP/3 対応の curl で叩いた。この Mac の Tailscale の interface に UDP を送り、DF と fragmentation の挙動を見た
- 前提: ブラウザの QUIC の bug は前提にしない。こちら側 (サーバの経路・設定) の候補から潰す

## 今わかっていること

- 固まる時、止まっているのは iPhone の Safari と前段の Caddy の間の HTTP/3 (QUIC) の接続。ccmsg の daemon は全部の要求に即座に応答している
- その接続では、小さい応答 (約 450 バイトの殻 HTML) は届くが、大きい応答 (bundle の約 154KB、CSS の約 67KB) は Caddy が最初の約 4KB を書いたところで送れなくなる
- 青いボタンが出るのは daemon が新しい版で起ち直した後で、押すとまだ手元に無い名前の bundle (`/assets/app.<hash>.js`) を運ぶ必要がある。版が同じ時のリロードは bundle が cache から出る (immutable) ので殻だけで済み、止まった接続の上でも開く
- 止まった接続は Safari の中でタブをまたいで使われ続け、Safari を終了すると捨てられる。終了後に張られた新しい接続は、同じ時刻・同じ経路で bundle を 0.2 秒前後で運んだ
- **こちら側の候補として、この Mac は Tailscale の interface (MTU 1280) で IPv4 の UDP を送る時、DF を求めても EMSGSIZE を返さず、kernel が IP fragment に分ける**ことを確かめた (下の「候補 1」)。quic-go の packet size の探索 (DPLPMTUD) は EMSGSIZE を前提に上限を見つけるので、この経路では 1252 バイトより大きい packet を fragment にして送りうる。本物の前段の Caddy でも、この経路の HTTP/3 の応答は約 1,460 バイトの packet で送られ、fragment に分けられていた。iPhone 宛てでその fragment が落ちているか、それが今回の停止の原因かは、まだ確かめていない

## ボタンの実体と押した時の処理

- topbar の `#app-reload` (`packages/webui/src/client/components/App.tsx`)。青いのは version の不一致の時に付く `app-reload-update` (`color: var(--accent)`)。不一致は daemon の hello の `version` が bundle に焼き込まれた版より新しい時 (`version-guard.ts`)
- `onClick` は `window.location.reload()` だけで、青いかどうかで処理は変わらない。`navigation.ts` の `navigate` の listener は reload を横取りしない
- `beforeunload` / `pagehide` / `unload` / `sendBeacon` / Service Worker の登録は webui の client に無い
- WebSocket はタブに 1 本。前段では HTTP/1.1 の別の TCP 接続になる (Caddy のログの `/ws` は全部 `HTTP/1.1`)

配信の header (一時ベースの Caddy 経由で確認):

| path | cache-control | ETag | 大きさ (br) |
|---|---|---|---|
| 殻 (`/`、`/s/...`) | `no-cache` | あり | 約 450 バイト |
| `/assets/app.<hash>.js` | `public, max-age=31536000, immutable` | なし | 約 154KB |
| `/app.css` | なし | なし | 約 67KB |

`/app.css` は cache の指定が無く、リロードのたびに取り直されている (WebKit でも Caddy のログでも、リロードごとに要求がある)。

## ログで見えたこと

### 固まった時の列

2026-10-25 に固まった 3 回は、どれも「daemon が upgrade で起ち直す → 開いていたタブが新しい daemon に hello して不一致 (青) → 押す」の順だった。daemon.log には押した時の `http GET <path> (webui page load)` が出て、新しいページの `hello` が数十秒〜数分出ない。

1 回目の Caddy のログ (UTC。接続は iPhone 側の UDP の port で見分ける):

| 時刻 | 接続 | 要求 | 書いたバイト / 本来の長さ | Caddy のエラー |
|---|---|---|---|---|
| 05:09:53 | A | 殻 | 450 / 450 | |
| 05:09:55 | A | `/app.css` | 67217 / 67217 (1.7 秒) | |
| 05:10:32 | A | bundle | 87957 / 153845 | `writing: H3_REQUEST_CANCELLED` |
| 05:10:53 | A | bundle / `/app.css` | 6703 / 153845、3933 / 67217 | `H3_REQUEST_CANCELLED` |
| 05:11:17 | A | 同上 | 0 / 153845、8064 / 67217 | `H3_REQUEST_CANCELLED` |
| 05:11:44 | B (Safari の起動し直し後) | 殻 / css / bundle | 全部そろう (bundle 218ms) | |
| 05:12:10 | A | 同上 | 7075 / 153845、3933 / 67217 | `writing: timeout: no recent network activity` |

- `writing: ...` は、Caddy が応答の本文を書こうとしたまま進めなかったことを示す。Safari の × / リロードで要求が取り消されると `H3_REQUEST_CANCELLED`、Safari が接続ごと黙ると 30 秒後に QUIC の idle timeout
- 05:23 と 05:50 の回も同じ形 (殻は届き、CSS / bundle は 3873 〜 8064 バイトで止まり、Safari の起動し直し後の接続では一瞬でそろう)

### 止まった接続の、止まる前の要求

iPhone の Safari で途中で止まった HTTP/3 の接続ごとに、最初に止まった要求と、それより前にその接続で記録された要求を数えた。

| 接続の始まり (UTC) | 最初に止まった要求 | それより前の要求 | 前の要求のホスト | 前に運んだバイト |
|---|---|---|---|---|
| 10-20 01:54:52 | ccmsg の bundle | 2 | ccmsg | 66424 |
| 10-20 01:56:59 | ccmsg の bundle | 2 | ccmsg | 65976 |
| 10-20 08:07:44 | ccmsg の bundle | 2 | ccmsg | 66425 |
| 10-20 08:23:30 | ccmsg の bundle | 2 | ccmsg | 66573 |
| 10-20 08:39:06 | ccmsg の `/app.css` | 8 | bark, ccmsg | 14429 |
| 10-20 22:49:15 | ccmsg の bundle | 5 | ccmsg | 134399 |
| 10-22 06:46:20 | hyoui の `xterm.js` | 12 | ccmsg, hyoui | 201488 |
| 10-25 05:09:53 | ccmsg の bundle | 2 | ccmsg | 67667 |
| 10-25 05:13:20 | hyoui のフォント | 27 | ccmsg, hyoui | 496908 |
| 10-25 05:50:28 | ccmsg の bundle | 2 | ccmsg | 67784 |
| 10-25 05:51:24 | hyoui のフォント | 13 | hyoui | 484585 |
| 10-25 06:08:23 | hyoui の `/api/sessions/...` | 102 | hyoui | 1697923 |

- ccmsg の bundle で止まった 7 接続のうち 6 つは、止まる前に記録された要求が殻と `/app.css` の 2 件 (合わせて約 66 〜 68KB) だけで、その直後の bundle で止まっている
- 止まる前に、長く開いたままの要求や完了しなかった要求は居ない (Caddy は要求が終わった時に記録するので、idle timeout で終わった接続の開いていた要求も記録に出る。そういう行は無い)
- 接続を UDP の port で見分けているので、QUIC の接続が port を変えて移った場合は 1 つの接続が 2 つに見える

### 頻度 (HTTP/3 で Content-Length が 50KB を超える応答)

| クライアント | 経路 | 全部届いた | 途中で止まった |
|---|---|---|---|
| iPhone の Safari | Tailscale | 74 | 66 |
| iPad の Safari (UA は Mac を名乗る) | Tailscale | 8 | 3 |
| この Mac の Chrome | この Mac の中 | 495 | 20 |

- iPhone の Safari の HTTP/2 では、50KB を超える 32 件が全部届いている
- 途中で止まった中には、ユーザが途中で離れたものも混ざる
- iPad では ccmsg の bundle が 1 回止まり、約 10 秒後に新しい接続で読み込みを終えた

### ccmsg 固有の原因の検討 (該当なし)

「ccmsg のページがその接続を壊している」可能性を見た。

- **本文を読まない応答で、接続全体の受信の枠 (`MAX_DATA`) が尽きる**: 該当なし。webui の client に `fetch` / `EventSource` / streaming の読み出し / polling は無い。HTTP の経路は殻・CSS・`/assets` (`import()` の chunk を含む)、`POST /attachment` の XHR (`onload` で `responseText` を全部読む)、`<img>` (添付、`/fs-serve`)、Terminal タブの hyoui の `<iframe>` だけ。daemon の WebSocket 以外の endpoint (`/attachment`、`/fs-serve`、`/webhook/*`) は、長さの決まった本文を 1 回返して終わる
- **WebSocket を HTTP/3 で張ろうとした**: 記録なし。Caddy のログに method `CONNECT` の要求は 0 件、`/ws` は ccmsg も hyoui も全部 `HTTP/1.1` (前段の Caddy は HTTP/3 の SETTINGS で `settings_enable_connect_protocol` を出している。一時ベースの Caddy の qlog で確認)
- **「ccmsg でしか出ない」こと**: iPhone の Safari が HTTP/3 で 50KB を超える応答を受けたホストは ccmsg と hyoui だけで、hyoui のページは全部 ccmsg の Terminal タブの iframe (`Sec-Fetch-Dest: iframe`、`embed=1`) だった。HTTP/3 で大きい応答を受ける場面が ccmsg の中にしか無いので、体感が ccmsg に偏ることとは矛盾しない。hyoui で止まった接続のうち 2 つ (10-25 05:51 と 06:08) には、止まるまで hyoui の要求しか乗っていなかった (ccmsg のページ自身は WebSocket の HTTP/1.1 でしか喋らない)

## こちら側の候補

### 候補 1. 経路の MTU と fragmentation: 該当する条件がある、原因かは未確定

観測:

- iPhone への経路はこの Mac の Tailscale の interface (`utun`、MTU 1280)。iPhone は Tailscale の IPv4 の address で繋いでいる。前段の Caddy の UDP は dual-stack の socket (`*:443`)
- 今の iPhone は Tailscale で direct (同じ LAN)。固まった時刻にどうだったかは記録が無い
- この Mac で、Tailscale の interface 宛てに UDP を 50 個ずつ送って `netstat -s -p ip` の「output datagrams fragmented」の増えを見た:

| socket | DF の指定 | UDP の本文 | 結果 |
|---|---|---|---|
| IPv4 | `IP_DONTFRAG=1` | 1252 | 送れた、fragment なし |
| IPv4 | `IP_DONTFRAG=1` | 1300 | 送れた、50 個とも fragment に分けられた (EMSGSIZE は 0) |
| IPv4 | なし | 1300 | 同上 |
| dual-stack、IPv4-mapped 宛て | `IPV6_DONTFRAG=1` | 1300 | 同上 |
| dual-stack、IPv6 (Tailscale の IPv6) 宛て | `IPV6_DONTFRAG=1` | 1252 / 1300 | EMSGSIZE (IPv6 は DF が効く) |

- この Mac の起動以来の累計で、IPv4 の「output datagrams fragmented」は約 218 万、「fragments received」は約 1.1 万。どの process が fragment を出しているかは分けていない
- quic-go は macOS では `IP_DONTFRAG` / `IPV6_DONTFRAG` を立て、送れない大きさは EMSGSIZE で知る前提で packet size を上げていく (quic-go の `sys_conn_df_darwin.go`)。Caddy v2.11.7 は初めの packet size (`InitialPacketSize`) を 1200 に固定している (Caddy の `listeners.go` の `ListenQUIC`)。一時ベースの Caddy の qlog では、loopback で `recovery:mtu_updated` が 1326 → 1389 → 1420 と上がった
- **本物の前段の Caddy でも、QUIC の packet が fragment に分けられていた** (統括が観測)。この Mac から自分の Tailscale の IPv4 の address 宛て (iPhone と同じ Tailscale の interface を通る) に、前段が配る 2,701,756 バイトのファイル (観測のために一時的に置き、観測後に消した) を `curl --http3-only` で 5 回取った:
  - 5 回とも 200 / 2,701,756 バイト、0.12 〜 0.27 秒
  - `netstat -s -p ip` の「output datagrams fragmented」は 2,185,270 → 2,194,532 (+9,262。1 回あたり約 1,850 個。ファイルの大きさを割ると約 1,460 バイト / packet)
  - 対照の `--http2` は 200、0.40 秒
  - 同じ Mac の中で往復するので、fragment は組み立て直されて止まらなかった

読み (未検証):

- 前段の quic-go は、この経路で packet size を 1452 付近まで上げていて、その packet は kernel が 2 つの fragment に分けて Tailscale に渡している (上の観測と数が合う)。iPhone 宛てでは、fragment が Tailscale の経路 (WireGuard、relay、iOS の側) を通る。そこで fragment の一部が落ちれば、その接続は大きい応答を運べなくなる。小さい応答 (殻) は 1 packet に収まるので届く。新しい接続は小さい packet から始め直すので、size を上げる前に運び終えれば届く
- TCP (WebSocket) は MSS が interface の MTU から決まり、fragment を使わないので影響を受けない。これは「WebSocket は同じ時刻に問題なく流れていた」ことと合う
- まだ確かめていないこと: iPhone 宛ての fragment が経路のどこかで落ちているか、iPhone との接続で `mtu_updated` が 1252 を超えたか

確かめ方: 前段の Caddy を `QLOGDIR` 付きで起動し、次に止まった接続の qlog で `mtu_updated` と `packet_lost` を見る (前段の持ち主の作業)。

直し方の候補 (前段側の作業、確かめてから):

- **quic-go の packet size の探索を止める**: quic-go には `quic.Config.DisablePathMTUDiscovery` がある (v0.63.0 の型定義で確認)。止めれば packet size は `InitialPacketSize` (Caddy では 1200) のままで、IPv4 で MTU 1280 の interface に収まる。ただし Caddy v2.11.7 はこの項目を設定として出していない。`ListenQUIC` の `quic.Config` で設定しているのは `InitialPacketSize: 1200`、`Allow0RTT`、`Tracer` の 3 つだけで、利用者が変えられるのは `allow_0rtt` だけ。前段の binary に入っている quic-go の環境変数は `QUIC_GO_DISABLE_ECN` / `QUIC_GO_DISABLE_RECEIVE_BUFFER_WARNING` / `QUIC_GO_DISABLE_CLIENTHELLO_SCRAMBLING` / `QUIC_GO_LOG_LEVEL` で、packet size の探索を止めるものは無い。止めるには Caddy の source を変えた build が要る
- **iPhone が Tailscale の IPv6 で繋ぐようにする**: IPv6 では DF が効き (上の表)、EMSGSIZE で interface の MTU に収まる大きさ (UDP の本文で 1232 バイト) に留まる。前段のホスト名の DNS の答え方の変更になる
- **Tailscale を通る client に HTTP/3 を出さない**: 前段の site は tailnet からの接続しか受けず、この Mac の Chrome も自分の Tailscale の address 経由で繋いでいる。そのため実質は前段で HTTP/3 を止めること (`servers { protocols h1 h2 }`) と同じになる。ホストを絞るなら `Alt-Svc` を落とす形 (この形を使った報告はあるが、ここでは試していない)

### 候補 2. UDP の buffer: 該当しない

- 前段の Caddy のログ (2026-07 以降) に、quic-go の `failed to sufficiently increase receive buffer size` の警告は無い
- `kern.ipc.maxsockbuf` は 8388608 (quic-go が求める 7MB を許す)、`net.inet.udp.recvspace` は 786896、`net.inet.udp.maxdgram` は 9216
- `netstat -s -p udp` の「dropped due to full socket buffers」は起動以来の累計で 89

### 候補 3. Caddy / quic-go の版: 該当しない

- 前段は Caddy v2.11.7、quic-go v0.63.0、go 1.26.4。iOS 18 の Safari で Caddy の HTTP/3 が壊れた件 ([quic-go #4679](https://github.com/quic-go/quic-go/issues/4679)、2024-09-26 に closed、Caddy の forum では quic-go v0.47.0 で解消とされる) より新しい

### 候補 4. Caddy の HTTP/3 の設定と timeout: 判断できない

- Caddyfile は `servers { protocols h1 h2 h3 }` だけで、`timeouts` も reverse_proxy の stream の timeout も指定していない
- 止まった要求の一部は、止まってから約 60 秒で `writing: deadline exceeded` になる。この deadline がどこから来るかは特定していない
- 「新しい接続では同じ時刻に運べる」ので、Caddy の中で上流 (daemon) からの読みや圧縮が詰まっている可能性は低いと読めるが、Caddy の中の接続ごとの状態 (その接続の書き込みの経路) と QUIC の状態は、サーバ側のログだけでは分けられない

### 候補 5. ホストのスリープ・ネットワークの切り替え: Mac 側は該当しない、経路は不明

- `pmset -g log` (2026-10-18 以降が残っている) に Sleep / Wake の記録は無い。Mac は固まった時刻に起きていた
- Tailscale の経路 (direct / relay、iPhone の Wi-Fi / 携帯網) が固まった時刻にどうだったかは記録が無い

## 貼り付けた画像が上半分だけ出る件

kawaz が見たのは Mac の Chrome。Caddy のログで画像の GET (`/attachment/<id>`、`/fs-serve`、全部 `image/png`、20 件、全部 HTTP/3) を見ると、途中で止まったのは 2026-10-22 04:39:32 (UTC) の Mac の Chrome の 2 件だけだった。2 枚を upload した直後の表示の GET。

| 要求 | 書いたバイト / 本来の長さ | Caddy のエラー |
|---|---|---|
| `/attachment/<id 1>` | 354202 / 579100 (61%) | `writing: deadline exceeded` |
| `/attachment/<id 2>` | 327613 / 680013 (48%) | `writing: deadline exceeded` |

- 同じ接続はその後も使えた (04:40:09 の upload は通り、04:40:34 の `/app.css` 66742 バイトは全部届いた)。この 2 枚の取り直しの記録は無い
- この Mac の Chrome から前段へは、自分の Tailscale の address 宛てなので Tailscale の interface を通る (候補 1 と同じ interface)。ただし半分前後まで届いてから止まり接続は回復した点で、iPhone の件と形が違い、原因が同じとは確定していない
- PNG が途中まで届けば上の部分だけ描かれるのは見た目と合う (推測)

## 切り分けの実験

- Mac の Chrome で `chrome://flags/#enable-quic` を Disabled にして画像を貼る。止まらなくなれば、画像の件は HTTP/3 の経路の問題
- 候補 1 の「確かめ方」(前段の qlog)。iOS の Safari には利用者が HTTP/3 を切る設定が無い (kawaz が実機で確認) ので、iPhone の側からは切り分けられない

## ローカルで試したこと

- 一時ベースの Caddy (h1 h2 h3、127.0.0.1) + 作業コピーの daemon に Playwright の WebKit で繋ぐと、WebKit は `Alt-Svc` を受けても HTTP/2 のままだった (自己署名の証明書を `ignoreHTTPSErrors` で通した構成)。HTTP/3 の経路はこれでは試せない
- 同じ構成で `#app-reload` を 5 回押すと、5 回とも 88 〜 228ms で読み込みが終わり、毎回 daemon に `hello nav=reload` が来た
- HTTP/3 対応の curl では、同じ Caddy (127.0.0.1) から 540KB を HTTP/3 で取れた。`QLOGDIR` を付けて起動した Caddy は、接続ごとに qlog を書いた

## 未確定のこと

- 停止の仕組み (候補 1 の fragment なのか、別のものか)
- 止まる接続と止まらない接続の違い。止まる接続には、作られた直後から遅いもの (CSS 67KB に 1.7 〜 2.2 秒、正常な接続では 0.03 〜 0.3 秒) がある
- `writing: deadline exceeded` の deadline の出どころ
- 固まった時刻の Tailscale の経路

## ccmsg 側でできること

ccmsg のコードに停止の原因は見つかっていない。当たる場面を狭める緩和として、`/app.css` を bundle と同じく hash 付きの名前で immutable に配れる (版が同じリロードでは CSS も運ばずに済む)。版が変わった直後のリロードは bundle を運ぶので、これでは直らない。止まるのは bundle が届く前なので、webui の JS から回復する手は無い。
