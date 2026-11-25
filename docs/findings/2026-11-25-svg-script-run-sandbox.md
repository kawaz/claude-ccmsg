# svg のスクリプトを sandbox の iframe で動かす受け皿: 抜け道の実測 (2026-11-25)

[DR-0067](../decisions/DR-0067-svg-script-run.md) の判断の元になった実測。webui に「svg のスクリプトの実行」を入れる時の受け皿の形を 3 つ (webui の origin の URL から配る / sandbox origin の URL から配る / webui が srcdoc で作る) と、それぞれの 1 段 (svg を受け皿の文書に入れる) と 2 段 (受け皿の中の sandbox の srcdoc に入れる) で比べ、svg のスクリプトが制限の外に出られるかを試した。

- ブラウザ: Playwright 1.65.1 の Chromium 159.0.8154.6 (headless shell。断りのある所は channel `chromium` の同じ版) と WebKit 27.2 (どちらも headless)、bun 1.4.4、macOS
- 試したのは隔離した loopback のサーバとブラウザだけで、ccmsg の daemon と人のブラウザは使っていない
- 同じ人の別のツール dirview が、同じ日に同じ 2 段の形を実測している (dirview のリポの `docs/findings/2026-11-25-svg-script-runner.md`)。ここは、その表の試し方を ccmsg の前提 (webui の文書に CSP が無い、sandbox origin がある) で埋め直し、行を足したもの

## 判明した事実

- 受け皿の置き場 (webui の origin の URL、sandbox origin の URL、srcdoc) は結果を変えなかった。結果を分けたのは、svg を受け皿の文書に入れるか (1 段)、受け皿の中の sandbox の srcdoc に入れるか (2 段) と、CSP の有無だけ (両ブラウザ)
- 1 段では、svg のスクリプトが自分の frame を外部の URL にも webui の origin の html にも遷移させられ、遷移先の文書は受け皿の CSP の外で動いて外部へ要求を出せた (両ブラウザ、3 つの置き場とも)。受け皿の文書の CSP の `frame-src 'none'` (meta でも応答ヘッダでも) は、その文書自身の frame の遷移を止めない。ccmsg の webui の文書には CSP が無いので、dirview と違って外部への遷移も止まらない
- 2 段では、試した遷移 (`location` の書き換え、meta refresh、リンク、form、`window.open`、入れ子の frame、`data:` / `blob:`、上の frame と top の遷移) のどれでも、外部にも webui 役のサーバにも要求は届かなかった (両ブラウザ)
- 2 段 + 下の CSP の下で、HTTP と WebSocket の要求は 1 本も届かなかった (fetch、XHR、WebSocket、EventSource、sendBeacon、`<a ping>`、画像、スクリプト、CSS、フォント、audio、object、embed、Worker、入れ子の iframe。サーバの記録で確認。両ブラウザ)
- **WebRTC は止まらなかった**。`RTCPeerConnection` に STUN サーバを渡すと、どの案でも UDP の受け口に STUN の要求が届いた (両ブラウザ)。CSP に `webrtc 'block'` を足しても (応答ヘッダでも meta でも) 届いた
- **WebKit では `<link rel="preconnect">` の TCP の接続が届いた** (CSP の下の全部の案で)。Chromium は、sandbox の外の普通のページでも接続が届かず、確かめられなかった
- **WebKit では、sandbox の中の `history.back()` が top (webui 役のページ) の履歴を戻した**。`history.go(-2)` は、webui 役のページを開く前に開いていた別のページまで top を戻した (どの案でも)。Chromium では top は動かなかった
- webui 役のページの DOM・localStorage・sessionStorage・cookie は、どの案でも読めず書けなかった (両ブラウザ)
- 受け皿の応答ヘッダに `sandbox allow-scripts` があると、iframe の `sandbox` 属性を付けなくても受け皿は opaque origin になり、結果は属性を付けた時と同じだった (両ブラウザ)。srcdoc で作る受け皿は、属性を付けないと webui の origin で動き、止めたのは受け皿のスクリプト自身の検査 (`self.origin !== "null"`) だけだった
- sandbox だけ (CSP 無し) の中からは、外部にも webui 役のサーバにも要求が出る。webui 役のサーバへの画像・no-cors の fetch・frame の遷移の GET には `Origin` ヘッダが付かず、XHR・WebSocket・sendBeacon には `Origin: null` が付いた (両ブラウザ)。WebKit では、画像・WebSocket・sendBeacon・`credentials: "include"` の fetch・frame の遷移に webui 役の cookie が付き、webui が直に作った srcdoc の sandbox の iframe からの sendBeacon は `Origin` が webui 役の origin になった (3 回の実行で 3 回とも)。Chromium では cookie は付かなかった
- frame の遷移を `frame-src` で検査するのは、その frame を持つ親の文書の CSP だった (両ブラウザ)。遷移を始めた文書自身の CSP ではない
- 5 MiB の svg を postMessage で渡して動いた。受け皿の iframe を文書から外すと、中のスクリプトは止まった (両ブラウザ)
- svg の中の無限ループで、WebKit と Chromium の headless shell では webui 役のページが応答しなくなった (どの案でも)。channel `chromium` の Chromium では応答し続けた

## 試しの作り

### サーバ

loopback に 3 つの役の HTTP サーバと 2 つの受け口を立て、届いた要求を全部記録した。

| 役 | アドレス | 中身 |
|---|---|---|
| webui 役 | `http://127.0.0.1:<port>` | 応答に CSP を付けないページ (ccmsg の webui の文書と同じ)。localStorage・sessionStorage・cookie に値を入れ、`history.pushState` を 1 回してから受け皿の iframe を作る<br>同じ origin に、CSP の無い html (遷移先の役。開かれると外部役へ fetch する) を置く |
| sandbox origin 役 | `http://localhost:<port>` | 受け皿の html を、応答ヘッダの CSP 付きで返す。webui 役とは site が別 |
| 外部役 | `http://[::1]:<port>` | どの要求にも 200 を返す (CORS は全許可)。`.html` には、開かれると外部役へ fetch して top へ postMessage する文書を返す |
| TCP の受け口 | `127.0.0.1:<port>` | 接続を記録するだけ (preconnect 用) |
| UDP の受け口 | `127.0.0.1:<port>` | 届いたデータグラムを記録するだけ (STUN 用) |

要求が届いたかは、サーバの記録だけで判定した (Playwright の request イベントには CSP で止められた要求も出るので使わない)。外部役と webui 役への URL には実行ごとの印を付け、実行は 1 つずつ順に流した。

### 案

| 記号 | 受け皿 | svg の入れ先 | CSP |
|---|---|---|---|
| 対照 1 | webui 役が作る srcdoc の iframe | 受け皿の文書 (1 段) | 無し |
| 対照 2 | webui 役が作る srcdoc の iframe | 受け皿の中の sandbox の srcdoc (2 段) | 無し |
| A1 | webui 役の origin の URL | 1 段 (`document.write`) | meta の Q |
| A2 | webui 役の origin の URL | 2 段 | meta の Q + 応答ヘッダ `sandbox allow-scripts` |
| A2h | webui 役の origin の URL | 2 段 | 応答ヘッダに `sandbox allow-scripts`、Q、`webrtc 'block'`、`frame-ancestors 'self'` |
| B1 | sandbox origin 役の URL | 1 段 (`document.write`) | 応答ヘッダに `sandbox allow-scripts`、Q、`frame-ancestors <webui 役の origin>` |
| B2 | sandbox origin 役の URL | 2 段 | B1 と同じ |
| C1 | webui 役が作る srcdoc の iframe | 1 段 | meta の Q |
| C2 | webui 役が作る srcdoc の iframe | 2 段 | meta の Q |
| D | webui 役の origin の URL | 2 段。svg は MessagePort で受ける | 応答ヘッダに `sandbox allow-scripts`、Q から `media-src` を除いたもの、`webrtc 'block'`、`frame-ancestors 'self'` (DR-0067 の Decision の形) |

どの案も、webui 役が作る iframe には `sandbox="allow-scripts"` を付け、2 段の中の iframe にも `sandbox="allow-scripts"` を付けた (属性を付けない時は「iframe の sandbox 属性が無い時」)。URL の受け皿と 2 段の srcdoc の受け皿には、受け皿が `ready` を送り、webui 役が svg を postMessage で渡した (D だけは、受け皿が `ready` に MessagePort を付け、受け皿の URL の origin を targetOrigin にして送り、webui 役が port に svg を書く)。

Q は dirview の受け皿と同じ CSP:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

### 抜け道を試す svg

svg は html の文書の body に入れた (dirview と同じ)。svg のスクリプトは結果を top へ postMessage で返し、webui 役のページが貯める。

- まとめて試すもの (1 回の実行): 通信の API、要素による読み込み、storage、上の frame への参照、`window.open`、入れ子の iframe、Worker、`alert` / `print`、`eval`、アニメーション。対照で全部の結果が返り、要求が届くことを先に確かめた
- 1 回の実行に 1 つだけ試すもの: 遷移 (試すと文書が替わる)、`<base>`、`<a ping>`、meta の CSP の `report-uri`、WebRTC、履歴
- Playwright の実際のクリック: `target` の違うリンク、`onclick`、クリックの中の `window.open` と `top.location`

「届かない」は、対照で届いた同じ試しが届かなかったことを指す。遷移の試しは 1.5 秒、まとめて試すものは全部の結果が返ってから 0.7 秒、記録を待った。対照で届いた要求は、遷移の試しではページを開いてから最大 25ms で届いていた (176 本)。

## 観測

下の表で「1 段」は A1・B1・C1、「2 段」は A2・A2h・B2・C2・D を指す。同じ組の中の案は、断りが無い限り同じ結果だった。

### スクリプトが動くか (2 段)

| 項目 | Chromium | WebKit |
|---|---|---|
| `<script>` | 動く | 動く |
| イベント属性 (`<svg onload>`、`onclick` の dispatch、`<animate onbegin>`、`<image onerror>`) | 動く | 動く |
| `onclick` (Playwright のクリック) | 動く | 未確認 (下の「未確認」) |
| SMIL の `<animate>` (r 10→40 / 1 秒を 0.6 秒後に読む) | r=27〜28 | r=27〜28 |
| `requestAnimationFrame` | 動く | 動く |
| `eval` | EvalError (Q に `'unsafe-eval'` が無い) | EvalError |
| `self.origin` | `"null"` | `"null"` |

外部の資源を多く持つ試しの svg では、WebKit は 0.3 秒の時点で `<svg onload>` がまだ発火していなかった (対照でも同じ。イベント属性だけの svg では発火した。原因は調べていない)。

### HTTP と WebSocket の要求

対照 1・対照 2 では、下の全部が外部役 (webui 役宛てのものは webui 役) に届いた。1 段と 2 段の全部の案で、1 本も届かなかった (両ブラウザ)。

| 種類 | 試したもの |
|---|---|
| スクリプトからの通信 | `fetch` (cors / no-cors / keepalive の POST)、XHR、WebSocket、EventSource、`navigator.sendBeacon`、`<a ping>` |
| 画像 | `new Image()`、html の `<img>` と `srcset`、`<input type="image">`、svg の `<image>` と `<feImage>`、CSS の `background`、`<video poster>` |
| スクリプトと CSS | `<script src>`、`import()`、`<link rel="stylesheet">`、`<style>` の `@import` |
| フォント | `@font-face`、`FontFace` |
| `<link>` | `preload`、`modulepreload`、`prefetch` (対照で届いたのは Chromium だけ) |
| 埋め込み | `<audio>`、`<object>`、`<embed>` |
| Worker | Blob の Worker の中の `fetch` (Q の下では Worker が起きない) |
| 入れ子の iframe | 外部の URL、srcdoc の中の `fetch`、`data:` の中の `fetch`、`blob:` の中の `fetch`、webui 役の origin の html |
| webui 役宛て | `fetch`、`credentials: "include"` の `fetch`、XHR、WebSocket、`sendBeacon`、画像 |

- スクリプトから見た結果 (Q の下): `fetch` は TypeError、XHR は error、`sendBeacon` は `true` を返すが届かない。WebSocket と EventSource は、Chromium は error のイベント、WebKit は SecurityError
- 入れ子の srcdoc の iframe は Q の下でも作れ、中のスクリプトも動く (中の `fetch` は reject)
- `<base href>` は Q の `base-uri 'none'` で効かず、`document.baseURI` は変わらなかった
- svg が自分で足した meta の CSP の `report-uri` には、違反の報告は届かなかった (対照でも)
- 対照でも届かず、試しとして働かなかったもの: 外部の svg を指す `<use href>`、`<link rel="manifest">`、`<link rel="icon">`、speculation rules、WebKit の `prefetch`

### 自分の frame の遷移

「届く」は、遷移先の文書の取得と、遷移先の文書が出した外部役への fetch の両方が届いたことを指す。

| 操作 | 対照 1・2 | 1 段 | 2 段 |
|---|---|---|---|
| `location.href` に外部の URL | 届く | 届く | 届かない |
| `location.replace` | 届く | 届く | 届かない |
| meta refresh (スクリプトで足す / svg の文字に書く) | 届く | 届く | 届かない |
| `target` の無いリンクの `click()` | 届く | 届く | 届かない |
| `window.open(url, "_self")` | 届く | 届く | 届かない |
| `<a download>` の `click()` | 要求が届く (保存は起きない) | 要求が届く | 届かない |
| `location.href` に webui 役の origin の html | 届く (遷移先は opaque origin で動き、外部役と webui 役の両方へ fetch が届く。localStorage と cookie は読めない) | 届く | 届かない |
| `location.href` に `data:` の html | 遷移し、中の fetch も届く | 遷移するが、中の fetch は届かない | 遷移しない |
| `location.href` に `blob:` の html | 遷移し、中の fetch も届く | 遷移するが、中の fetch は届かない | 遷移しない |
| 入れ子の iframe を外部の URL へ遷移 | 届く | 届かない | 届かない |
| form の `submit()` (GET・POST、宛先は外部と webui 役) | 届かない | 届かない | 届かない |
| Playwright のクリックで `target` の無いリンク | Chromium: 届く | Chromium: 届く | Chromium: 届かない |

- 2 段で遷移が止まった時、Chromium は中の frame がエラーの文書になり、WebKit は元の文書のままだった (dirview の観測と同じ)
- WebKit では、webui 役の origin の html への遷移の要求に webui 役の cookie が付いた

### 上の frame・top・新しい窓

対照を含む全部の案で同じ結果だった (sandbox が止めている)。両ブラウザ。

| 操作 | 結果 |
|---|---|
| `parent.location` / `top.location` への代入 | SecurityError、届かない |
| `target="_parent"` / `target="_top"` / `target="_blank"` のリンクの `click()` | 届かない、文書はそのまま、窓は増えない |
| `window.open(url)` / `"_blank"` / `"_parent"` / `"_top"` | `null`、届かない |
| form の `target="_top"` の `submit()` | 届かない |
| 入れ子の iframe の中から `parent.location` | SecurityError |
| `top.history.back()` | SecurityError |
| `alert()` / `print()` | ダイアログは出ない |
| Playwright のクリックの中の `window.open` / `top.location` / `target="_top"`・`"_blank"` のリンク | Chromium: `null` / SecurityError / 届かない。WebKit: 未確認 |

2 段の中から受け皿の frame を遷移させる試し (`parent.location`、`target="_parent"`、`window.open(url, "_parent")`) も上の表のとおり止まった。

### webui 役のページの DOM・storage・cookie

対照を含む全部の案で同じ結果だった。

| 操作 | Chromium | WebKit |
|---|---|---|
| `top.document` / `parent.document` | SecurityError | SecurityError |
| `top.localStorage`、`top.location.href` の読み取り、`top.name` への代入 | SecurityError | SecurityError |
| `localStorage` / `sessionStorage` | SecurityError | SecurityError |
| `document.cookie` の読み書き | SecurityError | 空文字が返り、書いても空のまま (A1・B1 は SecurityError) |
| `indexedDB.open` / `caches.open` / `cookieStore` | SecurityError | SecurityError |
| `navigator.serviceWorker.register` | SecurityError | SecurityError |
| `SharedWorker` (Blob) | SecurityError | 対照では動く。Q の下では error |
| `top.frames.length` | 読める (1) | 読める (1) |
| `window.frameElement` | `null` | `null` |

試しの後、webui 役のページの localStorage に svg の書き込みは無かった。`BroadcastChannel` は例外なく使えた (webui 役の同じ名前の channel に届かないことは確かめていない。ccmsg の webui は `BroadcastChannel` を使っていない)。

### 止められなかったもの

| 経路 | Chromium | WebKit | 案による違い |
|---|---|---|---|
| WebRTC: `new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:<port>" }] })`、data channel、`setLocalDescription` | UDP の受け口に 4 秒で 5 個届く。host の candidate も返る | 同じ | 無い (対照、1 段、2 段の全部) |
| 上に CSP の `webrtc 'block'` を足す (A2h と D は応答ヘッダ、C2 に足したものは meta) | 届く (変わらない) | 届く (変わらない) | — |
| `<link rel="preconnect" href="http://127.0.0.1:<port>/">` | 届かない (sandbox の外の普通のページでも届かないので、止まったとは言えない) | TCP の接続が届く | 無い (Q の下の全部の案で届く) |
| `history.back()` | top は動かない | top の履歴が 1 つ戻る (webui 役のページに popstate と hashchange が起きる) | 無い |
| `history.go(-2)` (webui 役のページの前に別のページを開いておく) | top は動かない | top が前のページへ戻る | 無い (対照 1・A2h・C2・D で試した) |

- channel `chromium` の Chromium でも、A2h で WebRTC の UDP は届いた
- WebRTC で届いたのは loopback の STUN の要求までで、運べるデータの量は確かめていない (下の「未確認」)
- `history` で戻れる先は履歴にあるページだけで、svg が URL を選べるわけではない。戻った後の文書は svg のものではない

### iframe の sandbox 属性が無い時

webui 役が作る iframe に `sandbox` 属性を付けずに、同じ試しをした。

| 案 | 受け皿の origin | 結果 |
|---|---|---|
| A2・A2h・B2・D (応答ヘッダに `sandbox allow-scripts`) | `"null"` | 属性を付けた時と同じ: storage と DOM は SecurityError、要求は届かない、自分の遷移と受け皿の遷移は止まる |
| C2・対照 2 (srcdoc) | webui 役の origin | 受け皿のスクリプトの検査 (`self.origin !== "null"`) が断り、svg は描かれなかった |

両ブラウザで同じ。応答ヘッダの `sandbox` は iframe の属性によらず効く。srcdoc の受け皿には応答が無いのでヘッダを付けられず、meta の CSP では `sandbox` を指定できない (下の「一次資料から読んだこと」)。

### 親の文書に frame-src がある時

webui 役のページの応答に `Content-Security-Policy: frame-src 'self' <sandbox origin 役の origin>` を付けた。

| 案 | 外部の URL への自分の遷移 | webui 役の origin の html への自分の遷移 |
|---|---|---|
| 対照 1 (文書に CSP 無し) | 届かない | 届く |
| 1 段 (A1・B1・C1) | 届かない | 届く (遷移先は Q の外で動き、外部へ届く) |
| 2 段 (A2h・C2) | 届かない | 届かない |

両ブラウザで同じ。対照 1 でも外部への遷移が止まり、文書自身に `frame-src 'none'` を持つ C1 で (親に CSP が無い時) 外部への遷移が通ったことから、frame の遷移を検査しているのは親の文書の CSP と言える。2 段の受け皿は、親に frame-src があっても読めて動いた。

### svg の渡し方・大きさ・止め方

A2h・B2・C2 と、svg を MessagePort で渡す D で試した。両ブラウザで同じ。

| 試し | 結果 |
|---|---|
| `<desc>` に 5 MiB の文字を持つ svg を渡す | 動く (スクリプトから 5,242,880 文字を読めた) |
| 中で 0.1 秒ごとに top へ postMessage し、0.8 秒後に webui 役が iframe を文書から外す | 外す前に 7〜8 通、外した後の 1 秒は 0 通 |
| svg が受け皿へ `{ type: "render" }` を送る | 受け皿は無視した (送り主が親でない。`event.origin` は `"null"`)。port で受ける受け皿は window の message を使わない |
| svg が top へ `{ type: "ready" }` / `{ type: "height", h: 3333 }` を送る | webui 役に届くが、`event.source` が受け皿の window でないので見分けられる |
| MessagePort で渡す (D) | 動く。受け皿の window には webui 役からの message が要らない |

`typeof Origin` は両ブラウザで `"function"` だった。

### 固まる svg

svg のスクリプトで `for (;;) {}` を回し、1.5 秒後に webui 役のページで式を評価して 3 秒待った。

| ブラウザ | 対照 1・A2h・B2・C2 |
|---|---|
| Chromium 159 (headless shell) | 4 つとも応答しない |
| Chromium 159 (channel `chromium` の headless、A1 も足した 5 つ) | 5 つとも応答する |
| WebKit 27.2 | 4 つとも応答しない |

sandbox origin 役の受け皿 (B2、webui 役とは site が別) でも、WebKit と headless shell では応答しなかった。

### sandbox だけの時に webui 役のサーバへ届いた要求 (対照)

CSP を付けない対照で、webui 役のサーバに届いた要求のヘッダ。

| 要求 | Chromium | WebKit |
|---|---|---|
| `fetch` (no-cors の GET) | `Origin` ヘッダ無し、cookie 無し | `Origin` ヘッダ無し、cookie 無し |
| `fetch` (no-cors、`credentials: "include"`)、画像、frame の遷移 | `Origin` ヘッダ無し、cookie 無し | `Origin` ヘッダ無し、cookie 付き |
| XHR | `Origin: null`、cookie 無し | `Origin: null`、cookie 無し |
| WebSocket | `Origin: null`、cookie 無し | `Origin: null`、cookie 付き |
| `sendBeacon` (対照 1。webui 役が直に作った srcdoc の sandbox の iframe) | `Origin: null`、cookie 無し | `Origin` が webui 役の origin、cookie 付き (3 回の実行で 3 回とも) |
| `sendBeacon` (対照 2。2 段の中) | `Origin: null`、cookie 無し | `Origin: null`、cookie 付き |

ccmsg の daemon は、`Origin` ヘッダの無い要求を通し、許可 origin に無い `Origin` (`null` の文字を含む) を 403 にする (`packages/daemon/src/http.ts`)。cookie は使わない。この観測は、sandbox だけでは、画像と no-cors の fetch の GET が `Origin` ヘッダ無しで中から届き、WebKit では webui の origin を名乗る sendBeacon の POST が中から出うることを示す。Q の下では、どれも届かなかった。

## 一次資料から読んだこと

閲覧は 2026-11-25。引用は仕様の原文で、取得した文書の中にその文字があることを照合した。

HTML Living Standard (`html.spec.whatwg.org`)。

- sandbox の属性の値が `allow-scripts` だけの時、外れる flag は scripts と automatic features の 2 つで、navigation、auxiliary navigation、top-level navigation (user activation の有無の 2 つ)、origin、forms、modals、downloads などは残る (7.1.5 Sandboxing の「parse a sandboxing directive」)
- 入れ子の browsing context の flag は、埋め込む要素の sandbox の flag と、その要素の文書の flag の和 (「determine the creation sandboxing flags」: "the flags set on embedder's node document's active sandboxing flag set")
- `about:srcdoc` の文書は親の policy container の複製を持ち、local な URL (`about:` / `blob:` / `data:`) の文書は遷移を始めた側の複製を持つ (「determine navigation params policy container」: "If responseURL is about:srcdoc ... Return a clone of parentPolicyContainer"、"If responseURL is local and initiatorPolicyContainer is not null, then return a clone of initiatorPolicyContainer")。実測の「`data:` / `blob:` へ遷移しても fetch は届かない」「入れ子の srcdoc の fetch も届かない」と合う
- 遷移の request は、遷移を始めた文書の policy container の複製を持つ (「create navigation params by fetching」: "policy container: sourceSnapshotParams's source policy container"、"Set request's destination to navigable's container's local name")。CSP の fetch の検査は request の policy container の CSP を使う (CSP3 4.1.2: "Let CSP list be request’s policy container’s CSP list")。2 つを合わせると、frame の遷移の `frame-src` は遷移を始めた文書の CSP で検査される読みになる。実測は両ブラウザとも、親の文書の CSP で検査していた。2 段の形は、どちらの検査でも止まる (遷移を始める中の文書も、その親の受け皿も `frame-src 'none'` を持つ)
- 「allowed by sandboxing to navigate」は、遷移の先が遷移を始めた側の祖先で、top でない時に true を返す ("If target is an ancestor of source: If target is not a top-level traversable, then return true.")。この手順の文面は、sandbox の中の文書が top でない祖先の frame を遷移させることを止めていない。実測では、2 段の中から受け皿の frame への `parent.location` は両ブラウザとも SecurityError だった
- 履歴の移動は、同じ手順で確かめてから行う (「apply the history step」: "if initiatorToCheck is not allowed by sandboxing to navigate navigable given sourceSnapshotParams, then return")。top が先で user activation が無く、top-level navigation without user activation の flag があれば false になる読み。WebKit の実測はこれと違った

Content Security Policy Level 3 (W3C の TR、`www.w3.org/TR/CSP3/`)。

- `frame-src` は "restricts the URLs which may be loaded into child navigables"
- meta 要素の policy では `sandbox`・`frame-ancestors`・`report-uri` が使えない (3.3: "Neither are the report-uri, frame-ancestors, and sandbox directives."。`sandbox` の節は "ignored entirely when delivered in a Content-Security-Policy-Report-Only header, or within a meta element")
- local な scheme の文書は元の文書の policy の複製を継ぐ (7.8 CSP Inheriting to avoid bypasses: "Documents loaded from local schemes will inherit a copy of the policies in the source document"。対象に srcdoc、`blob:`、`data:`、`about:blank` を挙げる)
- `connect-src` の対象は fetch、XHR、EventSource、Beacon、`<a ping>`、WebSocket
- `'unsafe-inline'` は、同じ source list に nonce か hash があると効かない (6.7.3.2: "If expression matches the nonce-source or hash-source grammar, return "Does Not Allow"")
- `webrtc` の指令がある ("The webrtc directive restricts whether connections may be established via WebRTC")。値が `'allow'` 1 つでなければ "Blocked" を返し (6.2.1.1)、その時は ICE の candidate を全部禁じる読み (4.3: "prohibits all candidates if it returns "Blocked"")。MDN の Content-Security-Policy の指令の一覧には `webrtc` が無い。実測では両ブラウザとも、`webrtc 'block'` を付けても STUN の要求が届き、host の candidate が返った
- resource hint について、`default-src` の節は "Resource hints such as prefetch and preconnect generate requests that aren’t tied to any specific fetch directive, but are instead governed by the union of servers allowed in all of a policy’s directives' source lists" と述べる。判定の手順 (6.7.2.2) が呼ばれるのは request の initiator が "prefetch" の時。WebKit の実測では、`default-src 'none'` の下で preconnect の接続が届いた
- `navigate-to` は、この文書にも MDN の一覧にも無い
- 8.6 Exfiltration: "a policy which lacks the default-src directive cannot mitigate exfiltration"。挙げている経路は fetch と prefetch で、WebRTC・DNS・遷移は述べていない

## dirview の実測との関係

- 同じ結果: 2 段で通信と遷移が止まること、1 段で同じ origin の html へ遷移して CSP の外へ出られること、遷移が止まった時の両ブラウザの違い、storage と DOM、WebKit の `document.cookie` の空文字、受け皿が svg からの message を無視できること
- 前提が違う所: dirview のビューアは `frame-src 'self'` を持つので、1 段でも外部への遷移は止まる。ccmsg の webui の文書には CSP が無く、1 段では外部へも出られる
- dirview の表に無い行: WebRTC、preconnect、sandbox の中からの `history.back()` / `history.go()`、iframe の sandbox 属性が無い時、meta refresh、`<a ping>`、`<base>`、5 MiB の svg、無限ループ (dirview の設計文書は Chromium で固まらなかったと書く。ここでは headless shell と WebKit で固まった)
- dirview の受け皿は同じ CSP と同じ 2 段なので、WebRTC・WebKit の preconnect・WebKit の履歴の 3 つは dirview の受け皿にも当てはまるはず (dirview では試していない)

## 未確認

- WebKit の Playwright のクリック。実測の間、画面が消えてロックされていて、WebKit のクリックがページに届かなかった ([findings 2026-11-22](./2026-11-22-webkit-e2e-click-after-display-sleep.md) の状態)。人の操作を伴う top の遷移・新しい窓・ダウンロードが WebKit で止まるかは確かめていない (Chromium は止まった)
- WebRTC で運べるデータ。STUN の宛先のホスト名にデータを載せた名前解決、TURN の username、TCP の TURN (`turn:…?transport=tcp`) で ccmsg のサーバの port へ接続できるか
- Chromium の preconnect (sandbox の外でも届かなかった)、`dns-prefetch` などの名前解決だけの経路 (観測の手段を用意していない)
- WebKit の `history` で戻れる・進める範囲 (試したのは `back()` と `go(-2)`)、`history.pushState` を重ねて top の履歴を増やせるか
- 本物の Safari と Chrome、Firefox
- webui の文書に CSP を入れた時の srcdoc の受け皿 (dirview は、ビューアの CSP の下の srcdoc では svg のスクリプトが動かないことを実測している)
- 人の操作の最中の clipboard への書き込み (操作の無い時の `navigator.clipboard.writeText` は両ブラウザとも NotAllowedError)、フォーカスを取った後のキー入力、メモリを使い切る svg
