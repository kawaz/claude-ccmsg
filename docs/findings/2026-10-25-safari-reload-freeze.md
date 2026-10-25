# iPhone / iPad の Safari で、青いリロードボタンを押すと固まる

- Date: 2026-10-25
- 対象: ccmsg v0.193.3 〜 v0.195.1 の webui、前段の Caddy v2.11.7 (quic-go v0.63.0、`protocols h1 h2 h3`、launchd で常駐)、この Mac (macOS 26.5.2、Tailscale の interface の MTU は 1280)、iPhone の Safari (iOS 26 系)、iPad の Safari (UA は Mac を名乗る)
- 症状 (kawaz の報告): 青いリロードボタンを押すと読み込みが終わらない。× で止めてアドレスバーのリロードを押しても、タブを閉じて新しいタブで開いても同じ。Safari を終了して起動し直すと一瞬で開く。再現率はほぼ 100%。体感では ccmsg でしか出ない
- 方法: 実 daemon の `daemon.log`、前段の Caddy のアクセスログ / エラーログ、`netstat -s`、`sysctl`、`pmset -g log`、`tailscale status` と Tailscale の metrics を読んだ。webui・daemon・Caddy v2.11.7・quic-go v0.63.0 の source を読んだ。一時ベースの Caddy と作業コピーの daemon を Playwright の WebKit と HTTP/3 対応の curl で叩き、この Mac の Tailscale の interface に UDP を送って DF と fragment の挙動を見た。本番の前段の Caddy にも、この Mac から curl で HTTP/3 の要求を出した
- 時刻は UTC。接続は Caddy のログの client 側の UDP の port で見分ける (QUIC の接続が port を変えて移った場合、1 つの接続が 2 つに見える)

## 結論

原因は未確定。

- サーバ側で QUIC の packet が IP fragment に分けられていることは事実 (この Mac の Tailscale の interface では、IPv4 の UDP は DF を求めても EMSGSIZE にならず fragment になる。前段の Caddy の HTTP/3 の応答も、この Mac の中の往復では fragment になっていた)
- それが iPhone のフリーズに効いているかは、iPhone との経路の観測が無い限り言えない。ここまでの観測は全部この Mac の中で完結していて、WireGuard のトンネル・relay・iPhone 側の netstack と組み立て直しを通っていない
- 接続全体の flow control の枠が尽きる (`DATA_BLOCKED` が出る形) 可能性も、同じく否定していない
- 決め手は、iPhone と通信している最中の観測 (「切り分けの実験」の pcap と前段の qlog)

## 症状の構造

- 固まる時、止まっているのは Safari と前段の Caddy の間の HTTP/3 (QUIC) の接続。ccmsg の daemon は全部の要求に即座に応答している
- その接続では、小さい応答 (約 450 バイトの殻 HTML、hyoui の 580 バイトの polling) は届き、大きい応答は止まる
- 青いボタンが出るのは daemon が新しい版で起ち直した後で、押すとまだ手元に無い名前の bundle (`/assets/app.<hash>.js`、約 154KB) を運ぶ必要がある。版が同じ時のリロードは bundle が cache から出る (immutable) ので、殻と CSS で済む。リロードは原因ではなく、具合の悪い接続に大きい取得を載せるきっかけ
- 止まった接続は Safari の中でタブをまたいで使われ続け、Safari を終了すると捨てられる。終了後の新しい接続は、同じ時刻・同じ経路で bundle を 0.2 秒前後で運んだ
- **接続の共有**: HTTP/3 では、hyoui の要求が SNI = ccmsg の QUIC の接続に乗っている (Caddy のログで、要求の host が hyoui、`tls.server_name` が ccmsg。wildcard 証明書で同じ IP)。HTTP/2 では host ごとに別の接続だった。ccmsg は Terminal タブで hyoui を iframe で埋め込むので、hyoui の重い font (HackGen、約 4.4MB) が ccmsg の接続に乗る。「ccmsg でしか出ない」ことの一番直接の説明はこれ

## ボタンの実体と押した時の処理

- topbar の `#app-reload` (`packages/webui/src/client/components/App.tsx`)。青いのは version の不一致の時に付く `app-reload-update`。不一致は daemon の hello の `version` が bundle に焼き込まれた版より新しい時 (`version-guard.ts`)
- `onClick` は `window.location.reload()` だけで、青いかどうかで処理は変わらない。`navigation.ts` の `navigate` の listener は reload を横取りしない
- `beforeunload` / `pagehide` / `unload` / `sendBeacon` / Service Worker の登録は webui の client に無い
- WebSocket はタブに 1 本。前段では HTTP/1.1 の別の TCP 接続になる (Caddy のログの `/ws` は全部 `HTTP/1.1`)

配信の header (一時ベースの Caddy 経由で確認):

| path | cache-control | ETag | 大きさ (br) |
|---|---|---|---|
| 殻 (`/`、`/s/...`) | `no-cache` | あり | 約 450 バイト |
| `/assets/app.<hash>.js` | `public, max-age=31536000, immutable` | なし | 約 154KB |
| `/app.css` | なし | なし | 約 67KB |

## Caddy のログの読み方

- access log の `size` は、Caddy が client への書き込みに渡したバイト数で、client に届いた量ではない。止まった要求の `size` が約 4KB に揃うのは、上流から読んだ最初の chunk が buffer に入っただけの見かけである可能性が高い (未検証)
- 止まった要求の `duration: 0` は計測値ではない。reverse_proxy が書き込みの失敗で `panic(http.ErrAbortHandler)` で抜け、`duration` の代入が飛んだ見かけ (Caddy の `modules/caddyhttp/server.go` の 706 行付近、`reverseproxy.go` の 1352 行)。所要はログの時刻の差で読む
- `writing: deadline exceeded` は Caddy v2.11.7 の `write_idle_timeout` (既定 1 分): 64KiB ごとの書き込みが 60 秒進まないと打ち切る (`modules/caddyhttp/app.go` の `defaultWriteIdleTimeout`、`idletimeout.go`)。この error は前段の binary が差し替わった 10-14 以降にだけ出る。それ以前の止まった要求は `writing: timeout: no recent network activity` (QUIC の idle timeout、30 秒) か `writing: H3_REQUEST_CANCELLED` (client の取り消し)

## ログで見えたこと

### 固まった時の列

2026-10-25 に固まった 3 回は、どれも「daemon が upgrade で起ち直す → 開いていたタブが新しい daemon に hello して不一致 (青) → 押す」の順だった。daemon.log には押した時の `http GET <path> (webui page load)` が出て、新しいページの `hello` が数十秒〜数分出ない。

1 回目の Caddy のログ:

| 時刻 | 接続 | 要求 | `size` / 本来の長さ | Caddy のエラー |
|---|---|---|---|---|
| 05:09:53 | A | 殻 | 450 / 450 | |
| 05:09:55 | A | `/app.css` | 67217 / 67217 | |
| 05:10:32 | A | bundle | 87957 / 153845 | `H3_REQUEST_CANCELLED` |
| 05:10:53 | A | bundle / `/app.css` | 6703 / 153845、3933 / 67217 | `H3_REQUEST_CANCELLED` |
| 05:11:17 | A | 同上 | 0 / 153845、8064 / 67217 | `H3_REQUEST_CANCELLED` |
| 05:11:44 | B (Safari の起動し直し後) | 殻 / css / bundle | 全部そろう | |
| 05:12:10 | A | 同上 | 7075 / 153845、3933 / 67217 | `timeout: no recent network activity` |

05:23 の回 (接続 C) と 05:50 の回 (接続 D) も同じ形。

接続 C は、リロード (05:23:10) の約 9 分前、05:14:57 から hyoui の font と画面の取得が `deadline exceeded` で切られていた。その間も 5 秒ごとの 580 バイトの polling は通っていた。

### 止まった接続の、止まる前の要求

| 接続の始まり | 最初に止まった要求 | それより前の要求 | 前の要求のホスト | 前の要求の `size` の合計 |
|---|---|---|---|---|
| 10-20 01:54:52 | ccmsg の bundle | 2 | ccmsg | 66424 |
| 10-20 01:56:59 | ccmsg の bundle | 2 | ccmsg | 65976 |
| 10-20 08:07:44 | ccmsg の bundle | 2 | ccmsg | 66425 |
| 10-20 08:23:30 | ccmsg の bundle | 2 | ccmsg | 66573 |
| 10-20 08:39:06 | ccmsg の `/app.css` | 8 | bark, ccmsg | 14429 |
| 10-20 22:49:15 | ccmsg の bundle | 5 | ccmsg | 134399 |
| 10-22 06:46:20 | hyoui の `xterm.js` | 12 | ccmsg, hyoui | 201488 |
| 10-25 05:09:53 | ccmsg の bundle | 2 | ccmsg | 67667 |
| 10-25 05:13:20 (C) | hyoui の font | 27 | ccmsg, hyoui | 496908 |
| 10-25 05:50:28 | ccmsg の bundle | 2 | ccmsg | 67784 |
| 10-25 05:51:24 | hyoui の font | 13 | hyoui | 484585 |
| 10-25 06:08:23 | hyoui の `/api/sessions/...` | 102 | hyoui | 1697923 |

止まる前に、長く開いたままの要求や完了しなかった要求は居ない。Caddy は要求が終わった時に記録するので、idle timeout で終わった接続の開いていた要求も記録に出る。そういう行は無い。

### HTTP/3 の停止は ccmsg に限らない

Content-Length が 16KB を超える応答のうち、途中で止まったもの:

| クライアント | HTTP/3 | HTTP/2 |
|---|---|---|
| iPhone の Safari | 92 / 216 | 0 / 38 |
| iPad の Safari | 3 / 18 | 0 / 44 (32MB の転送を含む) |
| この Mac の Chrome | 20 / 723 | |

- hyoui だけを運ぶ HTTP/3 の接続でも止まっている (この Mac の Chrome で 10-14 に 22 件、10-15 に 25 件、10-21 に 17 件。iPad で 10-07 と 10-23)
- 途中で止まった中には、利用者が途中で離れたもの (`H3_REQUEST_CANCELLED`) も混ざる
- 前段は 07-12 から HTTP/3 を出している。HTTP/3 の error は 10-03 からで、03:42 に iPhone の `H3_REQUEST_CANCELLED` が 1 件、14:23 に iPad の idle timeout が最初。それより前の iOS の error は HTTP/2 のものだけ。端末が HTTP/3 を使い始めた時期と読めるが、特定していない

### ccmsg のページがその接続を壊しているか: 該当なし

- **本文を読まない応答で、接続全体の受信の枠 (`MAX_DATA`) が尽きる**: webui の client に `fetch` / `EventSource` / streaming の読み出し / polling は無い。HTTP の経路は殻・CSS・`/assets` (`import()` の chunk を含む)、`POST /attachment` の XHR (`onload` で `responseText` を全部読む)、`<img>` (添付、`/fs-serve`)、Terminal タブの hyoui の `<iframe>` だけ。daemon の WebSocket 以外の endpoint (`/attachment`、`/fs-serve`、`/webhook/*`) は、長さの決まった本文を 1 回返して終わる
- **WebSocket を HTTP/3 で張ろうとした**: Caddy のログに method `CONNECT` は 0 件。`/ws` は ccmsg も hyoui も全部 `HTTP/1.1`。前段の HTTP/3 の SETTINGS には `settings_enable_connect_protocol` が出ている (一時ベースの Caddy の qlog で確認)

## こちら側の候補

### 候補 1. 経路の MTU と fragment: 未確定

**観測の射程**: 下のローカルの観測が言えるのは、「この Mac の Tailscale の interface から出る時に、1280 バイトを超える IPv4 の packet が fragment に分けられる」ことまで。この Mac から自分の Tailscale の address 宛ての通信は tailscaled の中で折り返すだけで、WireGuard のトンネル・relay・相手側の netstack・相手側での組み立て直しを通らない。iPhone との経路で fragment が落ちるか、そもそも iPhone 宛てに同じ大きさの packet が出ているかは観測していない。

観測:

- iPhone への経路はこの Mac の Tailscale の interface (`utun`、MTU 1280)。iPhone は Tailscale の IPv4 の address で繋いでいる。この Mac から自分の Tailscale の address 宛ても `route -n get` では同じ interface になる (interface の受信と送信の packet 数はほぼ同じで、tailscaled が折り返している)
- この Mac で、Tailscale の interface 宛てに UDP を 50 個ずつ送り、`netstat -s -p ip` の「output datagrams fragmented」の増えを見た:

| socket | DF の指定 | UDP の本文 | 結果 |
|---|---|---|---|
| IPv4 | `IP_DONTFRAG=1` | 1252 | 送れた、fragment なし |
| IPv4 | `IP_DONTFRAG=1` | 1300 | 送れた、50 個とも fragment に分けられた (EMSGSIZE は 0) |
| IPv4 | なし | 1300 | 同上 |
| dual-stack、IPv4-mapped 宛て | `IPV6_DONTFRAG=1` | 1300 | 同上 |
| dual-stack、IPv6 (Tailscale の IPv6) 宛て | `IPV6_DONTFRAG=1` | 1252 / 1300 | EMSGSIZE (IPv6 は DF が効く) |

- 「datagrams that can't be fragmented」は 1285 のまま動かない
- quic-go は macOS で DF を立て、送れない大きさを EMSGSIZE で知る前提で packet size を上げる (`sys_conn_df_darwin.go`)。Caddy は初めの packet size (`InitialPacketSize`) を 1200 に固定している (`listeners.go` の `ListenQUIC`)。quic-go v0.63.0 の `mtu_discoverer.go` は、試しの packet に ACK が来た時だけ size を上げる。data packet が失われても size を下げる処理は無く、下げるのは経路が移った時の reset だけ
- 一時ベースの Caddy の qlog (loopback) で、`recovery:mtu_updated` が 1326 → 1389 → 1420 と上がった
- 本番の前段の Caddy から、この Mac の Tailscale の IPv4 の address 宛てに 2,701,756 バイトのファイル (観測のために一時的に置き、観測後に消した) を `curl --http3-only` で 5 回取った。5 回とも全部届き 0.12 〜 0.27 秒。その間「output datagrams fragmented」は +9,262 (1 回あたり約 1,850 個。ファイルの大きさを割ると約 1,460 バイト / packet)。対照の `--http2` は 0.40 秒
  - 注意: 何もしていない 6 分間でも、この counter は +10,532 (毎秒約 29) 増える。+9,262 を HTTP/3 の転送に帰すのは、5 回で約 1 秒という時間窓の短さに依っている
- 本番の前段への `curl --http3-only` (Tailscale の IPv4 宛て) を約 100 回出して、2 回止まった。617KB のうち 194,740 バイトで止まり 63.9 秒で打ち切られた回と、8 秒間 0 バイトの回。**2 回とも、しばらく間が空いた後の最初の要求**だった。loopback 宛ての 48 回では 0 回だが、間を空けた条件では試していない。10-25 06:52 〜 06:55 のこの Mac からの HTTP/3 の行と、06:53 の `deadline exceeded` は、この試験のもの。これもこの Mac の中で折り返す通信なので、iPhone との経路については何も言っていない
- Tailscale の metrics: `tstun_in_from_wg_drop` 176 / 27331。`tstun_out_to_wg_drop_filter` は、次に止まった時に前後の差を取る候補

読み (未検証):

- iPhone との接続でも、前段の quic-go が packet size を約 1,460 バイトまで上げているなら、その packet は kernel が 2 つの fragment に分けて Tailscale に渡している。fragment の一部が落ちる経路なら、その接続では大きい応答の packet が届かない。quic-go は損失で size を下げないので、その接続は運べないままになる。小さい応答は 1 packet に収まるので届く
- TCP (WebSocket、HTTP/2) は MSS が interface の MTU から決まり、fragment を使わない。HTTP/2 で止まった記録が 0 であることと合う
- 説明できていないこと: fragment が継続して落ちる仕組み。新しい接続が 0.15 秒で 342KB を運ぶ (size の探索は数 RTT で終わるので、新しい接続もすぐ同じ size になるはず) こと。「間が空いた後の最初の要求」で止まること (NAT の UDP の状態や経路の再確立との関係は見ていない)

### 候補 2. 接続全体の flow control: 未否定

- ccmsg の webui に本文を読まない経路は無い (上)。ただし、受信の枠を広げないのが client 側の事情によるものかは、サーバ側のログでは分からない。qlog の `DATA_BLOCKED` / `STREAM_DATA_BLOCKED` で分かる

### 候補 3. UDP の buffer: 該当しない

- 前段の Caddy のログ (2026-07 以降) に、quic-go の `failed to sufficiently increase receive buffer size` は無い
- `kern.ipc.maxsockbuf` は 8388608 (quic-go が求める 7MB を許す)、`net.inet.udp.recvspace` は 786896、`net.inet.udp.maxdgram` は 9216
- `netstat -s -p udp` の「dropped due to full socket buffers」は起動以来の累計で 89

### 候補 4. Caddy / quic-go の版: 該当しない

- Caddy v2.11.7、quic-go v0.63.0、go 1.26.4。iOS 18 の Safari で Caddy の HTTP/3 が壊れた件 ([quic-go #4679](https://github.com/quic-go/quic-go/issues/4679)、2024-09-26 に closed、Caddy の forum では quic-go v0.47.0 で解消とされる) より新しい

### 候補 5. Caddy の設定と timeout: 停止の原因ではない

- Caddyfile は `servers { protocols h1 h2 h3 }` だけで、timeout は既定のまま
- `deadline exceeded` は既定の `write_idle_timeout` (1 分) が、止まった書き込みを打ち切った結果。止まること自体の原因ではない

### 候補 6. ホストのスリープ・ネットワークの切り替え: Mac 側は該当しない、経路は不明

- `pmset -g log` (2026-10-18 以降が残っている) に Sleep / Wake の記録は無い
- iPhone は今は Tailscale で direct (同じ LAN)。固まった時刻の Tailscale の経路 (direct / relay、Wi-Fi / 携帯網) は記録が無い

## 貼り付けた画像が上半分だけ出る件

kawaz が見たのは Mac の Chrome。Caddy のログで画像の GET (`/attachment/<id>`、`/fs-serve`、全部 `image/png`、20 件、全部 HTTP/3) を見ると、途中で止まったのは 2026-10-22 04:39:32 の Mac の Chrome の 2 件だけだった。2 枚を upload した直後の表示の GET。

| 要求 | `size` / 本来の長さ | Caddy のエラー |
|---|---|---|
| `/attachment/<id 1>` | 354202 / 579100 | `writing: deadline exceeded` |
| `/attachment/<id 2>` | 327613 / 680013 | `writing: deadline exceeded` |

- 同じ接続はその後も使えた (04:40:09 の upload は通り、04:40:34 の `/app.css` 66742 バイトは全部届いた)。この 2 枚の取り直しの記録は無い
- この Mac の Chrome から前段へは自分の Tailscale の address 宛てで、tailscaled の中で折り返す (iPhone の経路とは違う)。HTTP/3 の応答が途中で止まった点は同じだが、接続が回復した点が iPhone の件と違い、原因が同じとは確定していない
- PNG が途中まで届けば上の部分だけ描かれるのは見た目と合う (推測)

## 切り分けの実験

### iPhone と通信している最中の観測 (kawaz が iPhone を触れる時)

daemon の版が上がった直後、青いボタンで固まらせる。その前から次の 2 つを回しておく。

1. この Mac で、iPhone との packet を記録する。iPhone の Tailscale の address は `tailscale status` の iPhone の行で確かめる。interface は Tailscale の address を持つ `utun` (`ifconfig` で確かめる。この記録の時点では `utun4`):

   ```bash
   sudo tcpdump -i utun4 -w <pcap> host <iPhone の Tailscale の IPv4>
   ```

   固まらせた後、しばらく (Caddy の `deadline exceeded` が出る 1 分以上) 待ってから止める。集計は一時ベースに置いた `quic-pcap-summary.sh` で行う (`tcpdump -r` と awk だけで動く)。

   ```bash
   sh quic-pcap-summary.sh <pcap> <この Mac の Tailscale の IPv4> <iPhone の Tailscale の IPv4> 1
   ```

   向きごとに次を出す:
   - IP の長さの分布 (UDP の本文が 1200 以下 / 1280 以下 / fragment)、IP fragment の数、DF の数
   - 1 秒を超えて packet が途切れた時刻と長さ
   - iPhone からの packet が途切れた後に、この Mac が送った packet の数

   見るもの:
   - Caddy → iPhone で fragment が出ているか (packet size が上がっているか)
   - 固まった瞬間に、iPhone → Mac の packet (ACK) が途切れているか
   - 途切れた後も Caddy が送り続けているか (再送。packet が届いていない側)、送るのを止めているか (flow control の待ち)
2. 本番の前段の Caddy に `QLOGDIR` を付けて (launchd の環境変数、前段の持ち主の作業)、同じ瞬間の qlog を取る。見るのは `mtu_updated` (iPhone との接続で 1252 を超えたか)、`packet_lost`、`DATA_BLOCKED` / `STREAM_DATA_BLOCKED`
3. 前後で Tailscale の metrics (`tstun_in_from_wg_drop`、`tstun_out_to_wg_drop_filter`) の差を取る

pcap で「fragment が出ていて、iPhone からの ACK が途切れ、Caddy が再送を続けている」なら候補 1、「fragment が無いか、Caddy が送るのを止めて `DATA_BLOCKED` を出している」なら候補 2 の側。

### この Mac の中でできる実験

この Mac の中で折り返す通信なので、iPhone の経路の代わりにはならない。Caddy / quic-go の側だけで止まるかを見る用途。

- **間を空けた後の最初の要求**: この Mac から本番の前段へ、Tailscale の IPv4 の address 宛てと loopback 宛てを交互に、45 秒ずつ空けて 5 回ずつ `curl --http3-only` で大きいファイルを取る。Tailscale 宛てだけで止まれば tailscaled の折り返しを含む経路の側、両方で止まれば Caddy / quic-go の側

### その他

- Mac の Chrome で `chrome://flags/#enable-quic` を Disabled にして画像を貼る。止まらなくなれば、画像の件は HTTP/3 の経路の問題
- iOS の Safari には利用者が HTTP/3 を切る設定が無い (kawaz が実機で確認) ので、iPhone の側からは切り分けられない

## 直し方の候補 (前段側の作業、確かめてから)

- **quic-go の packet size の探索を止める**: quic-go には `quic.Config.DisablePathMTUDiscovery` がある (v0.63.0 の型定義で確認)。止めれば packet size は `InitialPacketSize` (Caddy では 1200) のままで、IPv4 で MTU 1280 の interface に収まる。ただし Caddy v2.11.7 はこの項目を設定として出していない。`ListenQUIC` の `quic.Config` は `InitialPacketSize: 1200`、`Allow0RTT`、`Tracer` の 3 つだけで、利用者が変えられるのは `allow_0rtt` だけ。前段の binary に入っている quic-go の環境変数は `QUIC_GO_DISABLE_ECN` / `QUIC_GO_DISABLE_RECEIVE_BUFFER_WARNING` / `QUIC_GO_DISABLE_CLIENTHELLO_SCRAMBLING` / `QUIC_GO_LOG_LEVEL` で、size の探索を止めるものは無い。止めるには Caddy の source を変えた build が要る
- **Tailscale の IPv6 で繋ぐようにする**: IPv6 では DF が効き (上の表)、EMSGSIZE で interface の MTU に収まる大きさ (UDP の本文で 1232 バイト) に留まる。前段のホスト名の DNS の答え方の変更になる
- **Tailscale を通る client に HTTP/3 を出さない**: 前段の site は tailnet からの接続しか受けず、この Mac の Chrome も自分の Tailscale の address 経由で繋いでいる。そのため実質は前段で HTTP/3 を止めること (`servers { protocols h1 h2 }`) と同じ。ホストを絞るなら `Alt-Svc` を落とす形 (この形を使った報告はあるが、ここでは試していない)

## ローカルで試したこと

- 一時ベースの Caddy (h1 h2 h3、127.0.0.1) + 作業コピーの daemon に Playwright の WebKit で繋ぐと、WebKit は `Alt-Svc` を受けても HTTP/2 のままだった (自己署名の証明書を `ignoreHTTPSErrors` で通した構成)
- 同じ構成で `#app-reload` を 5 回押すと、5 回とも 88 〜 228ms で読み込みが終わり、毎回 daemon に `hello nav=reload` が来た
- HTTP/3 対応の curl で、同じ Caddy (127.0.0.1) から 540KB を HTTP/3 で取れた。`QLOGDIR` を付けて起動した Caddy は、接続ごとに qlog を書いた

## ccmsg 側でできること

ccmsg のコードに停止の原因は見つかっていない。当たる場面を狭める緩和として、次の 2 つがある。

- `/app.css` を bundle と同じく hash 付きの名前で immutable に配る。版が同じリロードでは CSS も運ばずに済む
- Terminal タブの hyoui の iframe が重い font を ccmsg の接続に載せる構造は、HTTP/3 の接続の共有から来ている。ccmsg 側では変えられない (host を分けても、証明書と IP が同じなら共有されうる。RFC 9114 の接続の再利用の条件からの推測)

止まるのは bundle が届く前なので、webui の JS から回復する手は無い。
