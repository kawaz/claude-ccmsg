# Origin 無しの要求は daemon のどの口に届き、何が起きるか (2026-11-26)

[issue 2026-11-25-origin-less-requests-reach-daemon](../issue/2026-11-25-origin-less-requests-reach-daemon.md) の調査。webui が表示する信頼しない文書 (エージェントが書いた html・svg) から、daemon の HTTP と WebSocket のどの口に要求が届き、届くことで何が起きるかを、コードを読んだことと実測とに分けて書く。

- ブラウザ: Playwright 1.65.1 の Chromium 159.0.8154.6 (headless shell) と WebKit 27.2 (どちらも headless)、bun 1.4.4、macOS
- daemon: このリポの commit `61f06be1` (v0.422.0) を、state・config・data・HOME・TMPDIR を一時ディレクトリに分けた隔離 daemon として `127.0.0.1:<port>` で動かした。`sandbox_origin_template` は `http://ccmsg-files-{gid}.localhost:<port>` (両ブラウザとも `*.localhost` を loopback に解決し、webui の origin とは site が別になる)
- daemon に届いた要求は、起動時に読み込ませた小さな preload で `Bun.serve` の `fetch` を包み、method・URL・ヘッダ (`Origin`、`Sec-Fetch-*`、`Referer`、`Host`)・応答の status を記録して判定した。daemon のコードは変えていない
- 試験用の session は、隔離 daemon に自分で作った sid で hello しただけのもので、cwd は一時ディレクトリの中の試験用のプロジェクト。人のセッション・本番の daemon・人のブラウザには触っていない

## 判明した事実

- **重い穴がある (両ブラウザ)**。`GET /fs-serve` は `.svg` を、`GET /attachment/<名前>` は `.html` と `.svg` を、webui と同じ origin から、文書としての実行を止めるヘッダ無しで返す。これを top の文書として開くと、中のスクリプトが webui の origin で動き、webui の localStorage を読め、`/ws` に正規の webui の `Origin` で繋がり、op が通る (確かめた op は `hello` と `ping`。webui と同じ権限なので、他の op も送れる見込み)
- preview のタブ (sandbox origin の文書。daemon が応答ヘッダで `sandbox allow-scripts allow-same-origin` と `default-src 'self'` などの CSP を付ける) の中の文書は、自分のタブを `location.href` の書き換えか `a.click()` で上の URL へ遷移させられた。CSP はこの遷移を止めなかった。遷移の要求は `Origin` 無し、`Sec-Fetch-Site: cross-site`、`Sec-Fetch-Mode: navigate`、`Sec-Fetch-Dest: document` で届き、200 が返った (両ブラウザ)。`window.open` は開かなかった (CSP の `sandbox` に `allow-popups` が無い)
- したがって、エージェントが自分の cwd の下に svg を書き、同じエージェントが書いた html を人が「HTML として開く」で開くと、その 1 回の操作で daemon を webui と同じ権限で操作されうる。前提は、html がその svg の `/fs-serve` の URL (エージェントの sid と path、webui の origin) を知っていること。sid はエージェント自身のもので、webui の URL はエージェントに渡している (DR-0039 の `ccmsg_url`) ので、知りうる (エージェントの側から確かめてはいない)
- webui の中のリンクからは、次の経路で同じことが起きた
  - 添付のリンク (markdown の `…/claude-ccmsg-<uid>/attachment/<名前>` のパス。`target="_blank"` で開く) が `.html` を指すと、普通のクリックで新しいタブに開き、スクリプトが動いた (両ブラウザ。WebKit は合成のクリックでだけ確かめた)
  - webui の origin の絶対 URL のリンク (markdown-view が `internal` として `target` 無しで描く) は、普通のクリックでは webui の Navigation API の intercept に取られて文書は読み込まれなかった (両ブラウザ。アドレスバーの URL だけが `/fs-serve?…` に変わる)。新しいタブを開く修飾キー付きのクリックでは読み込まれて動いた (Chromium。WebKit は合成のクリックの修飾キーでは新しいタブが開かず、未確認)
- 上の穴は「`Origin` 無しの要求が通る」こと自体が原因ではない。webui の中から開いた時の要求は同じ origin からの普通の遷移で、正規の操作と区別できない。原因は、利用者のファイル (信頼しない中身) を webui の origin から、文書として動く形で返していること
- 届くだけで作用する口 (要求が届くと状態が変わる・ファイルが書かれる・外へ送る口) は、ブラウザから `Origin` 無しで届く範囲には、コードを読んだ限り無い。`Origin` 無しで届くのは GET と HEAD (遷移と no-cors のサブリソース) で、GET の口はどれも読むだけ。例外は webui の client が読む `?userscript=on` で、その URL へ遷移させると、そのブラウザの userscript のスイッチ (localStorage) が on になる (作用は「保存済みの userscript を動かす」まで。実測はしていない)
- `fs-serve.ts` の応答のコメントは「framing を止める」と書くが、そのヘッダ (`X-Frame-Options`、CSP の `frame-ancestors`) は付けていない (コード)。webui の shell の応答にも無い (curl で確かめた。付いていたのは `Content-Type`、`Cache-Control`、`Vary`、`ETag` だけ)

## 前提の訂正: 今の webui は sandbox origin の文書を iframe でなく別タブで開く

issue は「sandbox だけ (CSP 無し) の iframe」と書くが、今の実装は違う。

- FileViewer の「HTML として開く」「生ダウンロード」は、`sandbox_grant` の URL を `window.open("", "_blank", "noopener,noreferrer")` で開いたタブに入れる (`packages/webui/src/client/components/FileViewer.tsx` の `SandboxActions`、[DR-0030](../decisions/DR-0030-sandbox-origin-serving.md) §7.2)
- その応答に daemon は `content-security-policy: sandbox allow-scripts allow-same-origin; default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors <許可 origin>; form-action 'none'; base-uri 'none'` を付ける (`packages/daemon/src/sandbox.ts` の `previewCsp`)。文書の origin は sandbox origin (opaque ではない)
- sandbox だけ (CSP 無し) の iframe は、[DR-0067](../decisions/DR-0067-svg-script-run.md) が検討中の svg の受け皿の対照の形で、今の webui には無い

## 口ごとの表 (コードを読んだこと)

daemon の HTTP の listener は 1 つの `fetch` で全部の口を分ける (`packages/daemon/src/http.ts`)。順番は、送信元の IP の allowlist → `Host` が sandbox origin なら sandbox の口で終わり → `Origin` の検査 → path ごとの口。`Origin` の検査は、ヘッダが無ければ通し、あれば自分の bind の origin (loopback なら `localhost`・`127.0.0.1`・`[::1]` の同じ port も)、`CCMSG_HTTP_ALLOW_ORIGIN`、tailscale の自動の追加、`ccmsg origins add` のファイルのどれかと一致する時だけ通す (`null` の文字は通さない)。

| 口 | method | `Origin` の検査 | 他の認証 | 届くだけで起きる作用 | ブラウザから `Origin` 無しで届くか |
|---|---|---|---|---|---|
| sandbox origin (`Host` が `ccmsg-files-<gid>.…`、どの path も) | GET / HEAD (他は 405) | しない (検査より前で返る) | URL の中の token (grant)、毎回 fs の containment を再検査 | 無し (ファイルを読んで返す) | 届く (sandbox origin の文書が自分の origin へ出す要求) |
| `/ws` | GET + upgrade | する | 無し (届いた接続は利用者として扱う。hello は role user に固定) | upgrade 後は webui と同じ op を全部受ける | 届かない。WebSocket の handshake には必ず `Origin` が付き、sandbox の中は `null`、sandbox origin の文書はその origin で、どちらも 403 |
| `POST /attachment` | POST | する | 無し | 添付の置き場にファイルを書く | 届かない。ブラウザの POST には `Origin` が付く。WebKit の sendBeacon が webui の origin を名乗る件 ([findings 2026-11-25-svg-script-run-sandbox](./2026-11-25-svg-script-run-sandbox.md)) は、今の webui の中に webui が作る sandbox の iframe が無いので該当しない |
| `GET /attachment/<名前>` | GET | する | 無し (名前は uuid v4 か `<sid>.att-<uuid>`) | 無し。拡張子で MIME を決め、`text/html`・`image/svg+xml`・`text/javascript` も inline で返す | 届く |
| `POST /webhook/<source>` | POST | する | `Authorization: Bearer <source の token>` | 登録された source の handler に渡す | 届かない (POST に `Origin` が付く。Bearer はブラウザの no-cors では付けられない) |
| `GET /fs-serve` | GET | する | session の containment / external の allowlist / workspace_folders の検査 | 無し。画像の拡張子だけ返し、`.svg` は `image/svg+xml` で inline | 届く |
| `GET /assets/*` | GET | する | 無し | 無し (webui の bundle) | 届く |
| その他の GET (webui の shell) | GET | する | 無し | 無し (どの path にも同じ html を返す)。client が `?userscript=on|off` を localStorage に書く | 届く |
| `/op` (module の POST) | POST | — | — | — | 届かない。HTTP の listener でなく UDS (`http.sock`) の上にある ([DR-0046](../decisions/DR-0046-module-op-over-http.md)) |

送信元の IP の allowlist は、どの口にも先に効く。ブラウザの要求は同じマシンの loopback から来るので、ここでは止まらない。

## 観測

### top の文書として開いた時

試験用の文書 (svg と html) は、次の 3 つだけを行う。

- 自分の `location.origin` を自分の origin への GET で知らせる
- localStorage の値を 1 つ読む (開く前に webui の origin で試験用の値を入れておいた)
- `/ws` に繋いで `hello` (role user) と `ping` を送り、応答を GET で知らせる

| 開き方 | Chromium | WebKit |
|---|---|---|
| `/fs-serve?…&path=<svg>` を直に開く | 動いた。origin は webui、localStorage を読めた、`/ws` は upgrade、`hello` と `ping` は ok | 同じ |
| `/attachment/<uuid>.html` を直に開く | 同じ | 同じ |
| `/attachment/<uuid>.svg` を直に開く | 同じ | 同じ |
| preview のタブの文書が `location.href` で `/fs-serve` の svg へ | 同じ | 同じ |
| preview のタブの文書が `a.click()` で `/fs-serve` の svg へ | 同じ | 同じ |
| preview のタブの文書が `location.href` で添付の html へ | 同じ | 同じ |
| preview のタブの文書が `window.open` で `/fs-serve` の svg へ | 開かず、daemon に要求は届かない | 同じ |

daemon に届いた要求のヘッダ。

| 要求 | Chromium | WebKit |
|---|---|---|
| 直に開いた文書の GET | `Origin` 無し、`Sec-Fetch-Site: none`、`Mode: navigate`、`Dest: document` | 同じ |
| preview のタブからの遷移の GET | `Origin` 無し、`Sec-Fetch-Site: cross-site`、`Mode: navigate`、`Dest: document`、`Referer` 無し (sandbox origin の応答の `referrer-policy: no-referrer`) | 同じ |
| 開いた文書からの `/ws` の upgrade | `Origin: <webui の origin>`、`Sec-Fetch-*` 無し、upgrade された | `Origin: <webui の origin>`、`Sec-Fetch-Site: same-origin`、`Mode: websocket`、`Dest: websocket`、upgrade された |

### webui の中のリンクから開いた時

本物の webui の文書に、markdown-view が描くのと同じ形のリンクを置いてクリックした。

| リンク | クリック | Chromium | WebKit |
|---|---|---|---|
| webui の origin の絶対 URL で `/fs-serve` の svg (`target` 無し) | 普通 | 文書は読み込まれない (Navigation API の intercept。URL だけ変わる) | 同じ (合成のクリック) |
| 同上 | 新しいタブの修飾キー | 新しいタブで動いた (`/ws` の `ping` まで ok) | 未確認 (合成のクリックの修飾キーでは新しいタブが開かない) |
| 添付のリンクで `.html` (`target="_blank"`) | 普通 | 新しいタブで動いた (`ping` まで ok) | 同じ (合成のクリック) |
| 同上 | 新しいタブの修飾キー | 同じ | 同じ (合成のクリック) |

WebKit の Playwright の実際のクリックは、どれも「`<html>` が pointer events を奪う」で届かなかったので、`MouseEvent` を dispatch する合成のクリックにした ([findings 2026-11-22](./2026-11-22-webkit-e2e-click-after-display-sleep.md) と同じ状態と見ている)。

## 何が起きるか (筋道)

1. エージェントの cwd の下の svg と html は、エージェントが追加の許可なしに書ける (containment root の中)
2. 人がその html を「HTML として開く」と、sandbox origin のタブで動く。その文書は CSP で webui の origin へのサブリソースと fetch を止められているが、自分のタブの遷移は止められていない
3. 文書が自分のタブを `/fs-serve?sid=<エージェントの sid>&path=<svg>&kind=contained` へ遷移させると、daemon は `Origin` 無しの GET を通し、svg を webui の origin から返す
4. svg のスクリプトは webui の origin で動き、`/ws` へ webui の `Origin` で繋ぐ。daemon はこれを利用者 (人) と区別できない
5. その接続は webui と同じ op を送れる。別のセッションへの送信、セッションの起動、permit の応答などが入る (どの op が通るかは、試した `hello` と `ping` 以外は未確認)

添付 (`/attachment`) の経路は、置き場にファイルがあることが前提。添付の置き場はエージェントの cwd の外なので、エージェントが自分で書けるかは Claude Code の権限の設定次第 (未確認)。人が受け取った html や svg を添付した場合は、それを開いた時に同じことが起きる。

## 止め方の案

推しは案 1。穴の原因は「信頼しない中身を webui の origin から文書として動く形で返す」ことで、webui の中のリンクから開く経路は同じ origin からの普通の遷移なので、要求の側の見分け (案 2・案 3) では止まらない。案 1 は応答の側で止めるので、届き方によらない。

| | 案 1: 利用者のファイルを返す口の応答で、文書として動かさない | 案 2: Fetch Metadata で cross-site の要求を断る | 案 3: `Origin` 無しの要求を口ごとに断る |
|---|---|---|---|
| 中身 | `/fs-serve` と `/attachment/<名前>` の応答に CSP の `sandbox` (allow 無し) と `default-src 'none'` 程度を付ける。`/attachment` の html・js など画像でない動く型は、DR-0030 Phase 3 (attachment の sandbox origin への移行) で sandbox origin へ移すか、`content-disposition: attachment` で返す | `Sec-Fetch-Site` が `cross-site` (と `same-site`) の要求を断る。webui の shell への遷移だけは通す | GET の口でも `Origin` が無ければ断る |
| 今回の穴 | 止まる見込み (top で開いても、文書は opaque origin でスクリプトが動かない) | preview のタブからの遷移は止まる。webui の中のリンクから開く経路 (`same-origin` / `none`) は止まらない | 止まるが、下の行のとおり使えない |
| ブラウザでない client (CLI、webhook の送り手、テストの Bun の fetch / WebSocket、curl) | 影響無し (応答のヘッダだけ) | 影響無し (`Sec-Fetch-*` を送らない) | 影響無し |
| webui 自身 | `<img src>` で svg を描く所に影響が無いかを確かめる必要がある (CSP は画像として読む時の描画には効かない見込み、未確認) | 影響無し | 壊れる。ブラウザは同じ origin の GET の遷移・`<img>`・`<script>` にも `Origin` を付けないので、shell・assets・画像が全部断られる |
| ブラウザの版の差 | CSP の `sandbox` は今のブラウザ全部が持つ | `Sec-Fetch-*` を送らない古いブラウザはブラウザでない client と同じ扱いになり、すり抜ける | 無し |

案 1 と案 2 は互いの前提に依らない (案 1 は応答の中身、案 2 は要求の出所) ので、両方を入れることはできる。案 2 を足すと、他のサイトから webui の口を `<img>` などで読ませる経路 (画像の有無や大きさが分かる) と、他のサイトからの webui の shell の framing を、まとめて断れる。ただし今回の穴は案 1 だけで止まる見込みなので、案 2 は別の判断になる。

webui の shell の framing は、shell の応答に `frame-ancestors` (webui 自身の origin と、DR-0067 が受け皿を置く所を考えて決める) を付ければ止まる。framing されて何ができるか (クリックを誘う重ね合わせ) は試していない。

## `http.ts` のコメントの直し方

`isAllowedOrigin` のコメントの「ブラウザは WS の handshake と fetch / XHR に必ず `Origin` を付けるので、無いのはブラウザでない client」は、WS の handshake と CORS の要求・GET でも HEAD でもない要求については合っているが、GET と HEAD の遷移と no-cors のサブリソース (`<img>`、`<script>`、no-cors の `fetch`) には当てはまらない。直す時は次の 2 つを書く。

- `Origin` が無いのは、ブラウザでない client か、ブラウザの GET / HEAD の遷移・no-cors のサブリソース
- この検査が守るのは `/ws` と GET でも HEAD でもない口で、GET の口は作用を持たないことと、利用者のファイルを文書として動かさない応答 (上の案 1) で守る

`fs-serve.ts` の「framing を止める」というコメントも、付けているヘッダ (`x-content-type-options: nosniff`) と合わせて直す。

## 未確認

- 案 1 の CSP を付けた時に、webui の FileViewer と markdown の `<img>` で svg・画像がこれまでどおり描かれるか
- `/ws` で `hello` と `ping` 以外の op (送信、起動、permit の応答) が、開いた文書から通るか (通らない理由はコードに見当たらない)
- エージェントが自分の sid と webui の URL を、実際のセッションの中で知れるか。エージェントが添付の置き場や sandbox origin の外の場所に書けるか
- WebKit の実際のクリック (修飾キー付きのクリックで新しいタブが開くか)。webui の中で普通のクリックの後に再読み込みした時 (Navigation API は reload を intercept しないので、文書が読み込まれる見込み)
- 口ごとの表のうち、preview のタブと sandbox の iframe の中からのサブリソースと no-cors の `fetch`・sendBeacon・form・WebSocket の実測 (試験の作りは用意したが、実行の途中で止まった。表の「届くか」はコードと [findings 2026-11-25-svg-script-run-sandbox](./2026-11-25-svg-script-run-sandbox.md) の観測から書いた)
- `?userscript=on` の遷移の実測
- webui の shell が他のサイトに framing された時に何ができるか
- 本物の Chrome・Safari・Firefox。sandbox origin が tailnet の名前 (loopback でない) にある時の、Chromium の Local Network Access の扱い (ここでは sandbox origin も webui も loopback)
- `/fs-serve` の応答ヘッダは、ブラウザで動いたことと `fs-serve.ts` のコードから書いた (curl で 200 の応答のヘッダを取った時は、試験用の session がまだ一覧に無く 404 だった)
