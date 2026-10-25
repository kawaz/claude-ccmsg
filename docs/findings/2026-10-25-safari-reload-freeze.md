# iPhone / iPad の Safari で、青いリロードボタンを押すと固まる

- Date: 2026-10-25
- 対象: ccmsg v0.193.3 〜 v0.195.1 の webui、前段の Caddy v2.11.7 (quic-go v0.63.0、`protocols h1 h2 h3`)、iPhone の Safari (UA は `Version/26.6.3 Mobile`、iOS 26 系)
- 症状 (kawaz の報告): 青いリロードボタンを押すと読み込みが終わらない。× で止めてアドレスバーのリロードを押しても、タブを閉じて新しいタブで開いても同じ。Safari を終了して起動し直すと一瞬で開く。再現率はほぼ 100%
- 方法:
  - 実 daemon の `daemon.log` と、前段の Caddy のアクセスログ / エラーログを読んだ (読むだけ。どちらにも触っていない)。Caddy のログは 2026-10-19 〜 10-25 の分
  - webui のコードを読んだ
  - 一時ベースで、作業コピーの daemon と、同じ Caddy の binary を自前の設定 (自己署名の証明書、h1 h2 h3、`reverse_proxy` で daemon へ) で立て、Playwright の WebKit (macOS 版) と HTTP/3 対応の curl から叩いた

## 結論

固まっているのは ccmsg のページではなく、**Safari と前段の Caddy の間の HTTP/3 (QUIC) の接続**。

- その接続では、小さい応答 (450 バイト前後の HTML の殻) は届くが、大きい応答 (bundle の約 154KB、CSS の約 67KB) は最初の 4KB 前後を書いたところで送れなくなる
- 青いボタンが出るのは daemon が新しい版で起ち直した後なので、押すと、まだ手元に無い名前の bundle (`/assets/app.<hash>.js`) を取りに行く必要がある。そこで止まる。版が同じ時のリロードは bundle が cache から出る (immutable) ので、HTML だけで済み、壊れた接続の上でもたまたま通る
- タブを閉じても直らないのは、Safari がその HTTP/3 の接続をタブではなく Safari 全体で持ち回しているから。新しいタブも同じ接続を使う。Safari を終了すると接続が捨てられ、次は新しい接続になって一瞬で開く

## ボタンの実体と押した時の処理

- topbar の `#app-reload` (`packages/webui/src/client/components/App.tsx`)。「青い」のは version 不一致の時に付く `app-reload-update` (`color: var(--accent)`、`#2563eb`)。不一致は daemon の hello の `version` が bundle に焼き込まれた版より新しい時 (`version-guard.ts`)
- `onClick` は `window.location.reload()` だけ。青いかどうかで処理は変わらない
- `navigation.ts` の `navigate` の listener は `navigationType === "reload"` を素通しにする (横取りしない)
- `beforeunload` / `pagehide` / `unload` / `sendBeacon` / Service Worker の登録は webui の client に無い (grep で 0 件)
- WebSocket はタブに 1 本 (`ws.ts` の `connect()`、`wss://<host>/ws`)。前段の Caddy では HTTP/1.1 の別の TCP 接続になる (アクセスログの `/ws` の行は全部 `HTTP/1.1`)

## 実 daemon と Caddy のログで見えたこと

固まった 3 回 (2026-10-25) は、どれも「daemon が upgrade で起ち直した → 開いていたタブが新しい daemon に hello して不一致 (青) → 押す」の順だった。daemon.log では、押した時の `http GET <path> (webui page load)` は出るが、その後の新しいページの `hello` が数十秒〜数分出ない。

同じ時刻の Caddy のログ (時刻は UTC、接続は iPhone 側の UDP の port で区別):

| 時刻 | 接続 | 要求 | 書いたバイト / 本来の長さ | Caddy のエラー |
|---|---|---|---|---|
| 05:09:53 | A | HTML の殻 | 450 / 450 | |
| 05:09:55 | A | `/app.css` | 67217 / 67217 (1.7 秒) | |
| 05:10:32 | A | `/assets/app.<hash>.js` | 87957 / 153845 | `writing: H3_REQUEST_CANCELLED` |
| 05:10:53 | A | 同じ bundle / `/app.css` | 6703 / 153845、3933 / 67217 | `H3_REQUEST_CANCELLED` |
| 05:11:17 | A | 同上 | 0 / 153845、8064 / 67217 | `H3_REQUEST_CANCELLED` |
| 05:11:44 | B (新しい接続) | HTML / css / bundle | 全部そろう (bundle 218ms) | |
| 05:12:10 | A | 同上 | 7075 / 153845、3933 / 67217 | `writing: timeout: no recent network activity` |

- `writing: ...` は、Caddy が応答の本文を書き込もうとしたまま進めなかったことを示す。Safari が × / リロードで要求を取り消した時に `H3_REQUEST_CANCELLED`、Safari が接続ごと黙った (Safari の終了) 30 秒後に QUIC の idle timeout で終わった
- 接続 B は Safari を起動し直した直後の新しい接続 (`favicon.ico` / `apple-touch-icon*.png` の要求が同時に来ている)。同じ時刻・同じ経路で、新しい接続は 150KB を 0.2 秒で運んだ。経路の帯域や Mac の負荷ではなく、接続 A の状態の問題
- 05:23 の回 (接続 C) と 05:50 の回 (接続 D) も同じ形: HTML の殻は届き、CSS / bundle は 3873 〜 8064 バイトで止まり、新しい接続 (Safari の起動し直し) では一瞬でそろった
- 接続 C は 11 分生きていて、hyoui の iframe の要求 (別のホスト名) も同じ接続に乗っていた (Caddy の記録で、TLS の `server_name` は ccmsg のホスト名のまま、要求の `host` が hyoui)。Safari は同じ wildcard 証明書のホスト同士で HTTP/3 の接続を共有する
- **ccmsg 以外でも同じことが起きている**: 05:54 と 05:57 に hyoui の `/api/sessions/...` (約 93KB 〜 168KB) が 3975 / 3976 バイトで止まり、新しい接続では同じ要求が 1 秒前後で全部届いた。ccmsg の JS の問題ではない

### 頻度 (Caddy のログ 2026-10-19 〜 10-25、HTTP/3 で Content-Length が 50KB を超える応答)

| クライアント | 全部届いた | 途中で止まった |
|---|---|---|
| iPhone の Safari | 74 | 66 |
| Mac の Chrome (この Mac) | 495 | 20 |
| 別の Mac の Safari (26.6.2) | 8 | 3 |

途中で止まった中には、ユーザが本当に途中で離れたもの (フォントの読み込み中の遷移など) も混ざる。それでも iPhone の Safari だけ桁が違う。

iPhone で ccmsg の bundle / CSS が止まった接続の数は、10-20 に 6、10-22 に 1、10-25 に 3 (UTC の日付)。別の Mac の Safari でも 10-21 に 1 回止まったが、その時は約 10 秒後に Safari が自分で新しい接続を開いて読み込みを終えた (同じ bundle が新しい接続で 23ms)。iPhone では新しい接続に切り替わらず、止まったまま。

## 貼り付けた画像が上半分だけ出る件

kawaz の報告: スクショを貼り付けると、画像が上半分だけ表示されることがあった。

### 観測

Caddy のアクセスログとエラーログで、ccmsg のホストの画像の GET (`/attachment/<id>` と `/fs-serve`、全部 `image/png`) を数えた。ログに残っているのは 2026-10-19 〜 10-25 の分。

| クライアント | 件数 | 途中で止まった |
|---|---|---|
| iPhone の Safari | 1 (HTTP/3、108860 バイト、31ms で全部届いた) | 0 |
| Mac の Chrome (この Mac) | 17 (全部 HTTP/3) | 2 |
| 別の Mac の Safari | 2 (HTTP/3) | 0 |

途中で止まった 2 件はどちらも、2026-10-22 04:39:32 (UTC) に Mac の Chrome の同じ HTTP/3 の接続で起きた。その接続で 04:38:18 に 2 枚を upload した (`POST /attachment`、579285 / 680198 バイト) 直後の表示の GET だった。

| 要求 | 書いたバイト / 本来の長さ | Caddy のエラー |
|---|---|---|
| `/attachment/<id 1>` | 354202 / 579100 (61%) | `writing: deadline exceeded` |
| `/attachment/<id 2>` | 327613 / 680013 (48%) | `writing: deadline exceeded` |

- 同じ接続は止まったままにはならなかった。同じ接続の 04:40:09 の upload は通り、04:40:34 のページの読み込みでは `/app.css` (66742 バイト) が全部届いた
- この 2 枚の id の GET は、その後のログに無い (取り直しの記録が無い)
- iPhone の Safari が画像を GET したのは 1 件だけで、それは全部届いている。HTTP/2 で画像を取った記録は無い (どのクライアントも HTTP/3 だった)

### 観測から言えること / 言えないこと

- 「大きい応答が HTTP/3 の上で途中までしか届かない」ことは画像でも起きていた。ただしログにある 2 件は Mac の Chrome で、iPhone の Safari の件ではない。止まった位置も 4 〜 8KB ではなく 48 〜 61% で、止まった後に同じ接続が回復している。iPhone の Safari で接続ごと止まる件 (上の節) とは形が違う
- PNG が途中まで届いて上の部分だけ描かれるのは、「上半分だけ」の見た目と合う (推測。ブラウザがどこまで描くかは確かめていない)
- kawaz が見たのは Mac の Chrome だった (kawaz の申告)。10-22 04:39 の 2 枚と端末が一致する
- 「HTTP/3 の応答が途中で止まる」という症状の類はリロードの件と同じだが、形が違う (半分前後まで届いてから止まり、接続はその後回復した) ので、**原因が同じとは確定していない**

### 既知の問題との関係

iOS 18 の Safari で Caddy の HTTP/3 が壊れるという報告 ([quic-go #4679](https://github.com/quic-go/quic-go/issues/4679)) は、2024-09-26 に closed になっている。閉じた時のコメントは「quic-go を最新に上げたら解消した」で、Caddy の forum の議論では v0.47.0 で直ったとされている。前段の Caddy は quic-go v0.63.0 なので、その修正は入っている。本件はそれとは別の問題で、既知の未解決の問題としては扱わない。

## ccmsg 固有の原因の検討

kawaz の体感では、この症状は ccmsg でしか出ない。経路や Caddy 全般の問題ならそうはならないはずなので、「ccmsg のページがその HTTP/3 の接続を壊している」可能性を検討した。原因は未確定のまま扱う。

### 1. 本文を読まない応答で、接続全体の受信の枠が尽きる: ccmsg のコードには該当なし

QUIC の接続全体の受信の枠 (`MAX_DATA`) は、クライアントが応答の本文を読まないと広がらない。webui が WebSocket 以外で HTTP を使う経路を全部挙げた (`packages/webui/src/client` を `fetch(` / `EventSource` / `ReadableStream` / `getReader` / `XMLHttpRequest` / `sendBeacon` / `<img` / `<iframe` / `import(` で grep した)。

| 経路 | 本文の扱い |
|---|---|
| ページの殻、`/app.css`、`/assets/*` (entry と `import()` の chunk) | ブラウザが読み切る |
| `POST /attachment` (`composer-upload.ts` の XHR) | `onload` で `responseText` を全部読む |
| `<img src>`: 添付 (`markdown-view.tsx`、`ImageLightbox.tsx`)、`/fs-serve` (`FileViewer.tsx`) | ブラウザが読む |
| Terminal タブの `<iframe>` (別ホストの hyoui の embed ページ) | iframe の中のページの責務 |

- `fetch` / `EventSource` / streaming の読み出し / polling は webui の client に無い。本文を読まずに放置する経路は見つからなかった
- daemon 側の WebSocket 以外の endpoint (`/attachment` の GET、`/fs-serve`、`POST /attachment`、`/webhook/*`) は、どれも長さの決まった本文を 1 回返して終わる。長く開いたままにする endpoint は無い

### 2. WebSocket を HTTP/3 で張ろうとしたか: 記録なし

Caddy のログ (10-19 〜 10-25) に、method `CONNECT` の要求は 1 件も無い。`/ws` は全部 `HTTP/1.1` で `101` (ccmsg 156 件)。hyoui の WebSocket も全部 `HTTP/1.1`。Safari が Extended CONNECT を試して失敗したのか、最初から試していないのかは、ログからは分からない (Caddy が CONNECT を受け付けずに記録しない場合もありうる。未確認)。

### 3. 止まった接続の、止まる前の要求: 長命の stream も未完了の要求も居ない

iPhone の Safari で途中で止まった HTTP/3 の接続ごとに、最初の要求の時刻、最初に止まった要求、それより前にその接続で完了した要求の数とホストを数えた。

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

- ccmsg の bundle で止まった 7 接続のうち 6 つは、止まる前にその接続で記録された要求が HTML の殻と `/app.css` の 2 件 (合わせて約 66 〜 68KB) だけだった。その直後、3 件目の bundle で止まっている
- 止まる前に、長く開いたままの要求や、完了しなかった要求は居ない。Caddy は要求が終わった時に 1 行書くので、接続が idle timeout で終わった時点で、まだ開いていた要求も記録に出る。そういう行は無かった
- 前提: 接続を iPhone 側の UDP の port で見分けている。QUIC の接続が port を変えて移った (connection migration) 場合、1 つの接続が 2 つに見える。そのため「接続で最初の要求」が本当に新しい接続の最初かどうかは、ログだけでは確定しない

### 4. hyoui の停滞は ccmsg のページが開いている時だけか: iPhone の hyoui の HTTP/3 は全部 ccmsg の中だった

- iPhone の Safari が HTTP/3 で開いた hyoui のページ (`/sessions/...`) は、全部 `Sec-Fetch-Dest: iframe` かつ `embed=1` だった。ccmsg の Terminal タブの iframe で、hyoui を単独で開いた HTTP/3 の記録は無い。hyoui を単独で開いた記録は HTTP/2 の 1 件だけで、途中で止まったものは無い
- ただし、hyoui で止まった接続のうち 10-25 05:51 と 06:08 の 2 つでは、止まるまでにその接続に乗っていたのは hyoui の要求だけで、ccmsg のページ自身の HTTP/3 の要求は乗っていない (ccmsg のページは WebSocket の HTTP/1.1 でしか喋っていない)
- iPhone の Safari の HTTP/3 で、50KB を超える応答があったホストは ccmsg と hyoui だけ。bark は小さい応答 (72 件) しか無い。HTTP/2 では、50KB を超える 30 件 (ccmsg と hyoui) が全部届いている

### まとめ (観測 / 推測)

- 観測: webui に、本文を読まずに放置する HTTP の経路は無い。止まった接続にも、止まる前に長命・未完了の要求は居ない。WebSocket は全部 HTTP/1.1
- 観測: iPhone の Safari が HTTP/3 で大きい応答を受けるのは、ccmsg のページか、その中の hyoui の iframe の時だけ。「ccmsg でしか出ない」という体感は、HTTP/3 で大きい応答を受ける場面が ccmsg の中にしか無いこととも矛盾しない
- 推測 (未検証): ccmsg の bundle で止まる接続の多くが、殻と CSS の約 66 〜 68KB を運んだ直後に止まる。接続の初めの受信の枠の大きさと関係があるのかもしれない。ただし、正常な新しい接続 (同じ殻と CSS と bundle を全部運んだもの) との違いは、ログの項目からは見つからなかった
- ccmsg のコードに該当する原因が見つからなかったので、ccmsg 側の直し方の候補 (本文を読む、abort する、WebSocket の扱い) は無い

## 仮説ごとの判定

| 仮説 | コード / 設定で該当するか | 再現 | 根拠 |
|---|---|---|---|
| Service Worker が navigation を握る | 該当しない | (不要) | webui の client に `serviceWorker` の登録が無い。前段も ccmsg のホストには SW を足していない |
| ホストあたりの接続の上限 (WebSocket が数を食う) | 該当しない | (不要) | WebSocket はタブに 1 本で、リロードの時に旧ページの分は閉じている (daemon.log の `ws closed` と Caddy の `/ws` の終了が押した瞬間)。止まった要求は Caddy まで届いて応答の書き込みに入っている。接続が取れずに待っているのではない |
| `beforeunload` / `pagehide` / `unload` で待つ | 該当しない | (不要) | 該当する listener / `sendBeacon` が無い |
| HTTP cache の revalidation で固まる | 該当しない | (不要) | 殻は `no-cache` + ETag、bundle は hash 付きの名前で immutable。止まった要求は Caddy まで来て 200 の本文を書いている途中。revalidation の待ちではない |
| Safari と Caddy の HTTP/3 の接続が、大きい応答を運べない状態になる | 該当する (前段が h3 を出し、`Alt-Svc: h3=":443"; ma=2592000` で Safari は HTTP/3 を使う) | ローカルでは再現できていない (下) | 上のログ。同じ時刻に新しい接続では運べるので、接続ごとの状態 |

## ローカルで試したこと

- 一時ベースの Caddy (h1 h2 h3) + 作業コピーの daemon に、Playwright の WebKit (macOS 版、iOS の WebKit とは別物) で繋いだ。WebKit は `Alt-Svc` を受けても HTTP/2 のまま (自己署名の証明書を `ignoreHTTPSErrors` で通した構成。HTTP/3 を使わない理由は未確認)。この構成では HTTP/3 の経路を再現できない
- 同じ構成で `#app-reload` を 5 回続けて押すと、5 回とも 88 〜 228ms で読み込みが終わり、毎回 daemon に `hello nav=reload` が来た。HTTP/2 の上では webui のリロード自体は固まらない
- HTTP/3 対応の curl では、同じ Caddy から 540KB を HTTP/3 で取れた。この Caddy は環境変数 `QLOGDIR` を付けて起動すると、HTTP/3 の接続ごとに qlog (`*_server.sqlog`) を書いた

## 確定したこと

- 青いボタンで固まる時、止まっているのは Safari と前段の Caddy の HTTP/3 の接続で、ccmsg の daemon は全部の要求に即座に応答している
- 青い時に限って起きるのは、新しい bundle (約 154KB) と CSS (約 67KB) を運ぶ必要があるため。殻 (約 450 バイト) は止まった接続でも届く
- その接続はタブをまたいで使い回され、Safari を終了するまで捨てられない。新しい接続は同じ時刻に問題なく運ぶ
- 同じ現象は同じ前段の別のアプリ (hyoui) でも起きている
- `/app.css` は `cache-control` も ETag も付かずに配られ、リロードのたびに約 67KB を取り直している (Playwright の WebKit と Caddy のログの両方で、リロードごとに `/app.css` の要求がある)

## 未確定のこと

- 接続が「大きい応答を運べない」状態になる仕組み。候補は、Safari 側が受信の flow control の枠 (`MAX_DATA` / `MAX_STREAM_DATA`) を広げなくなる、送った packet が失われ続けて輻輳制御が送れなくなる、のどちらか (どちらも未検証)。Caddy が書けたのが毎回最初の約 4KB で止まること、小さい応答は届くことからは決めきれない
- その状態に入るきっかけ。止まった接続には、作られた直後から遅いもの (CSS 67KB に 1.7 〜 2.2 秒、正常な接続では 0.03 〜 0.3 秒) と、長く生きた後で止まるものがある。iPhone の画面が消えていた後かどうかとの関係は未確認
- `writing: deadline exceeded` (止まってから約 60 秒で出る) の deadline がどの設定から来るか
- Caddy の内部で詰まっている可能性を潰していない: 上流 (daemon) からの読み、応答の圧縮の stream、write deadline の設定。「新しい接続では同じ時刻に運べる」ことは接続ごとの状態を指すが、Caddy の中の接続ごとの状態 (その接続の書き込みの経路) と QUIC の状態は、サーバ側のログだけでは分けられない
- iOS の実機の観測 (qlog、packet の capture、Web Inspector) はしていない。上はすべてサーバ側のログからの推定を含む
- Mac の Safari で同じボタンを押した時に固まるか (別の Mac の Safari では、ccmsg の bundle が 1 回止まり、約 10 秒で自分で回復した記録だけがある)

## 切り分け (前段を触らずにできる実験)

- (a) iPhone の 設定 → Safari → 詳細 → 機能フラグ で HTTP/3 を切り、daemon の upgrade の後に青いボタンを押す (項目の名前と場所は iOS の版で違うかもしれない、未確認)。固まらなくなれば HTTP/3 の経路の問題。それでも固まるなら、Caddy の内部 (上流からの読み、圧縮の stream、write timeout) か daemon 側の問題で、本 findings の読みは外れている
- (b) Mac の Chrome で `chrome://flags/#enable-quic` を Disabled にして画像を貼る。半分で止まることが無くなれば、画像の件も HTTP/3 の経路の問題。HTTP/2 でも止まるなら、HTTP/3 とは別の原因
- (c) 前段の Caddy を `QLOGDIR` 付きで起動する (前段の持ち主の作業)。次に止まった接続の qlog で、flow control の枠が尽きたのか packet の喪失なのかが分かる

## 直し方の候補

前段の HTTP/3 の問題なので、直す場所は第一に前段のリバースプロキシ。ccmsg 側でできるのは、運ぶ量を減らして当たる場面を狭めることまで。

1. **前段で ccmsg のホスト (または iOS の Safari) に HTTP/3 を出さない** (Caddy の `servers { protocols h1 h2 }`、またはホストを絞って `Alt-Svc` を落とす)。WebSocket はすでに HTTP/1.1 の TCP で安定しているので、TCP に寄せれば今回の経路から外れる。全ホストから外すと他のアプリの HTTP/3 も止まるので、範囲は前段の持ち主の判断。`Alt-Svc` の `ma=2592000` (30 日) を Safari が覚えているので、切り替えた直後は Safari を 1 度終了する必要があるかもしれない (未検証)
2. **原因の切り分けの観測**: 前段の Caddy を `QLOGDIR=<dir>` 付きで起動しておき、次に固まった時の接続の qlog で、Safari が送ってくる `MAX_DATA` / `MAX_STREAM_DATA` と、Caddy 側の loss / PTO を見る。flow control なのか packet の喪失なのかがここで決まる
3. (ccmsg 側、緩和) `/app.css` を bundle と同じく hash 付きの名前で immutable に配る。版が同じリロードでは CSS の 67KB も運ばずに済み、壊れた接続の上でも開ける場面が増える。版が変わった直後のリロードは bundle を運ぶ必要があるので、これでは直らない

webui の JS から自力で回復する手は無い: 止まるのは bundle が届く前なので JS が動いておらず、ページから接続を捨てさせる API も無い。
