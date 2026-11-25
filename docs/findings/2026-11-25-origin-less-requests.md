# Origin 無しの要求は daemon のどの口に届き、何が起きるか (2026-11-26)

[issue 2026-11-25-origin-less-requests-reach-daemon](../issue/2026-11-25-origin-less-requests-reach-daemon.md) の調査。webui が表示する信頼しない文書 (エージェントが書いた html・svg) から、daemon の HTTP と WebSocket のどの口に要求が届き、届くことで何が起きるかを、コードを読んだことと実測とに分けて書く。見つかった穴は、`/fs-serve` と `/attachment` の応答に `Content-Security-Policy: sandbox` と `X-Content-Type-Options: nosniff` を付けて止めた ([DR-0004](../decisions/DR-0004-webui-architecture.md) §3)。直す前と後の両方の観測を書く。

- ブラウザ: Playwright 1.65.1 の Chromium 159.0.8154.6 (headless shell。PDF だけ channel `chromium` の同じ版) と WebKit 27.2 (どちらも headless)、bun 1.4.4、macOS
- daemon: 直す前は commit `61f06be1` (v0.422.0)、直した後はその直しを載せたもの。state・config・data・HOME・TMPDIR を一時ディレクトリに分けた隔離 daemon として `127.0.0.1:<port>` で動かした。`sandbox_origin_template` は `http://ccmsg-files-{gid}.localhost:<port>` (両ブラウザとも `*.localhost` を loopback に解決し、webui の origin とは site が別になる)
- daemon に届いた要求は、起動時に読み込ませた小さな preload で `Bun.serve` の `fetch` を包み、method・URL・ヘッダ (`Origin`、`Sec-Fetch-*`、`Referer`、`Host`)・応答の status を記録して判定した。daemon のコードは変えていない
- 試験用の session は、隔離 daemon に自分で作った sid で hello しただけのもので、cwd は一時ディレクトリの中の試験用のプロジェクト。人のセッション・本番の daemon・人のブラウザには触っていない

## 判明した事実

- **直す前は重い穴があった (両ブラウザ)**。`GET /fs-serve` は `.svg` を、`GET /attachment/<名前>` は `.html` と `.svg` を、webui と同じ origin から、文書としての実行を止めるヘッダ無しで返していた。これを top の文書として開くか iframe に入れると、中のスクリプトが webui の origin で動き、webui の localStorage を読め、`/ws` に正規の webui の `Origin` で繋がり、op が通った (確かめた op は `hello` と `ping`。webui と同じ権限なので、他の op も送れる見込み)
- そこへ人をたどり着かせる経路が、今の webui にある
  - preview のタブ (sandbox origin の文書。daemon が応答ヘッダで `sandbox allow-scripts allow-same-origin` と `default-src 'self'` などの CSP を付ける) の文書が、自分のタブを `location.href` の書き換えか `a.click()` で上の URL へ遷移させる。CSP はこの遷移を止めない。エージェントが自分の cwd の下に svg と html を書き、人がその html を「HTML として開く」で開けば、その 1 回の操作で足りた
  - Timeline の添付のリンク (`target="_blank"`) が `.html` を指すと、普通のクリックで新しいタブに開いて動いた
  - webui の origin の絶対 URL のリンク (markdown-view が `target` 無しで描く) は、普通のクリックでは webui の Navigation API の intercept に取られて文書が読み込まれない。新しいタブを開く修飾キー付きのクリックでは読み込まれて動いた
- 穴の原因は「`Origin` 無しの要求が通る」こと自体ではない。webui の中から開いた時の要求は同じ origin からの普通の遷移で、正規の操作と区別できない。原因は、人やエージェントが書いたファイル (信頼しない中身) を、webui の origin から文書として動く形で返していたこと
- **直した後は、上の経路のどれでもスクリプトが動かない (両ブラウザ)**。文書は 200 で届くが、スクリプトの印・localStorage の読み・`/ws` の upgrade は 0。webui の表示 (Files の画像、Timeline の添付の画像、テキスト・PDF・音声の添付のタブ、preview) は変わらない
- preview のタブの文書から webui の origin へ出る要求は、遷移を除いて全部 CSP で止まり、daemon に届かなかった (画像、スクリプト、CSS、fetch の GET / POST、sendBeacon、WebSocket、iframe、form。両ブラウザ)。届いたのは自分のタブの遷移だけで、`Origin` 無し、`Sec-Fetch-Site: cross-site`
- 届くだけで作用する口 (要求が届くと状態が変わる・ファイルが書かれる・外へ送る口) は、ブラウザから `Origin` 無しで届く範囲には無い (コード)。`Origin` 無しで届くのは GET と HEAD で、GET の口はどれも読むだけ。webui の client の側では、`?userscript=on` の URL へ遷移させると、そのブラウザの userscript のスイッチ (localStorage の `ccmsg.userscript`) が on になった (preview のタブから。両ブラウザ)。作用は「人が保存した userscript をそのブラウザで動かす」まで
- webui の shell は、他のサイトのページの iframe に入れられて動き、`/ws` に webui の `Origin` で繋がった (両ブラウザ)。shell の応答に `frame-ancestors` も `X-Frame-Options` も無い。何ができるか (クリックを誘う重ね合わせ) は試していない

## 前提の訂正: 今の webui は sandbox origin の文書を iframe でなく別タブで開く

issue は「sandbox だけ (CSP 無し) の iframe」と書くが、今の実装は違う。

- FileViewer の「HTML として開く」「生ダウンロード」は、`sandbox_grant` の URL を `window.open("", "_blank", "noopener,noreferrer")` で開いたタブに入れる (`packages/webui/src/client/components/FileViewer.tsx` の `SandboxActions`、[DR-0030](../decisions/DR-0030-sandbox-origin-serving.md) §7.2)
- その応答に daemon は `content-security-policy: sandbox allow-scripts allow-same-origin; default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors <許可 origin>; form-action 'none'; base-uri 'none'` を付ける (`packages/daemon/src/sandbox.ts` の `previewCsp`)。文書の origin は sandbox origin (opaque ではない)
- sandbox だけ (CSP 無し) の iframe は、[findings 2026-11-25-svg-script-run-sandbox](./2026-11-25-svg-script-run-sandbox.md) の対照の形で、今の webui には無い

## 口ごとの表 (コードを読んだこと)

daemon の HTTP の listener は 1 つの `fetch` で全部の口を分ける (`packages/daemon/src/http.ts`)。順番は、送信元の IP の allowlist → `Host` が sandbox origin なら sandbox の口で終わり → `Origin` の検査 → path ごとの口。`Origin` の検査は、ヘッダが無ければ通し、あれば自分の bind の origin (loopback なら `localhost`・`127.0.0.1`・`[::1]` の同じ port も)、`CCMSG_HTTP_ALLOW_ORIGIN`、tailscale の自動の追加、`ccmsg origins add` のファイルのどれかと一致する時だけ通す (`null` の文字は通さない)。

| 口 | method | `Origin` の検査 | 他の認証 | 届くだけで起きる作用 | ブラウザから `Origin` 無しで届くか |
|---|---|---|---|---|---|
| sandbox origin (`Host` が `ccmsg-files-<gid>.…`、どの path も) | GET / HEAD (他は 405) | しない (検査より前で返る) | URL の中の token (grant)、毎回 fs の containment を再検査 | 無し (ファイルを読んで返す) | 届く (sandbox origin の文書が自分の origin へ出す要求) |
| `/ws` | GET + upgrade | する | 無し (届いた接続は利用者として扱う。hello は role user に固定) | upgrade 後は webui と同じ op を全部受ける | 届かない。WebSocket の handshake には必ず `Origin` が付き、sandbox の中は `null`、sandbox origin の文書はその origin で、どちらも 403 |
| `POST /attachment` | POST | する | 無し | 添付の置き場にファイルを書く | 届かない。ブラウザの POST には `Origin` が付く |
| `GET /attachment/<名前>` | GET | する | 無し (名前は uuid v4 か `<sid>.att-<uuid>`) | 無し。拡張子で MIME を決めて inline で返す。直した後は `audio/*`・`video/*` 以外に CSP `sandbox`、全部に `nosniff` | 届く |
| `POST /webhook/<source>` | POST | する | `Authorization: Bearer <source の token>` | 登録された source の handler に渡す | 届かない (POST に `Origin` が付く。Bearer はブラウザの no-cors では付けられない) |
| `GET /fs-serve` | GET | する | session の containment / external の allowlist / workspace_folders の検査 | 無し。画像の拡張子だけ inline で返す。直した後は CSP `sandbox` と `nosniff` | 届く |
| `GET /assets/*` | GET | する | 無し | 無し (webui の bundle) | 届く |
| その他の GET (webui の shell) | GET | する | 無し | 無し (どの path にも同じ html を返す)。client が `?userscript=on|off` を localStorage に書く | 届く |
| `/op` (module の POST) | POST | — | — | — | 届かない。HTTP の listener でなく UDS (`http.sock`) の上にある ([DR-0046](../decisions/DR-0046-module-op-over-http.md)) |

送信元の IP の allowlist は、どの口にも先に効く。ブラウザの要求は同じマシンの loopback から来るので、ここでは止まらない。

## 観測: top の文書として開いた時

試験用の文書 (svg と html) は、次の 3 つだけを行う。

- 自分の `location.origin` を自分の origin への GET で知らせる
- localStorage の値を 1 つ読む (開く前に webui の origin で試験用の値を入れておいた)
- `/ws` に繋いで `hello` (role user) と `ping` を送り、応答を GET で知らせる

| 開き方 | 直す前 (Chromium・WebKit) | 直した後 (Chromium・WebKit) |
|---|---|---|
| `/fs-serve?…&path=<svg>` を直に開く | 動いた。origin は webui、localStorage を読めた、`/ws` は upgrade、`hello` と `ping` は ok | 200 で届き、スクリプトは動かない (印 0、upgrade 0) |
| `/attachment/<uuid>.html` を直に開く | 同上 | 同上 |
| `/attachment/<uuid>.svg` を直に開く | 同上 | 同上 |
| preview のタブの文書が `location.href` で `/fs-serve` の svg へ | 同上 | 同上 |
| preview のタブの文書が `a.click()` で `/fs-serve` の svg へ | 同上 | 同上 |
| preview のタブの文書が `top.location` で `/fs-serve` の svg へ | (直す前は試していない) | 同上 |
| preview のタブの文書が `location.href` で添付の html へ | 動いた (同上) | 同上 |
| preview のタブの文書が `window.open` で `/fs-serve` の svg へ | 開かず、daemon に要求は届かない | 同じ |

daemon に届いた要求のヘッダ (直す前と後で同じ)。

| 要求 | Chromium | WebKit |
|---|---|---|
| 直に開いた文書の GET | `Origin` 無し、`Sec-Fetch-Site: none`、`Mode: navigate`、`Dest: document` | 同じ |
| preview のタブからの遷移の GET | `Origin` 無し、`Sec-Fetch-Site: cross-site`、`Mode: navigate`、`Dest: document`、`Referer` 無し (sandbox origin の応答の `referrer-policy: no-referrer`) | 同じ |
| 直す前に、開いた文書からの `/ws` の upgrade | `Origin: <webui の origin>`、`Sec-Fetch-*` 無し、upgrade された | `Origin: <webui の origin>`、`Sec-Fetch-Site: same-origin`、`Mode: websocket`、`Dest: websocket`、upgrade された |

## 観測: webui の中のリンクから開いた時

本物の webui の文書に、markdown-view が描くのと同じ形のリンクを置いてクリックした (Playwright の実クリックと、`MouseEvent` を dispatch する合成のクリックの両方)。

| リンク | クリック | 直す前 | 直した後 |
|---|---|---|---|
| webui の origin の絶対 URL で `/fs-serve` の svg (`target` 無し) | 普通 | 文書は読み込まれない (Navigation API の intercept。URL だけ変わる)。両ブラウザ | 同じ |
| 同上 | 新しいタブの修飾キー | 新しいタブで動いた (Chromium。WebKit は確かめていない) | 新しいタブに 200 で届き、動かない (両ブラウザの実クリック) |
| 添付のリンクで `.html` (`target="_blank"`) | 普通 | 新しいタブで動いた (両ブラウザ) | 新しいタブに 200 で届き、動かない (両ブラウザ) |
| 同上 | 新しいタブの修飾キー | 同上 | 同上 |

合成のクリックの修飾キーでは、WebKit は新しいタブを開かなかった。

## 観測: preview のタブの文書から webui の origin へ出る要求 (直した後)

preview のタブ (daemon の CSP 付き) の文書から、webui の origin (`/fs-serve`、`/`、`/attachment`、`/webhook/…`、`/ws`) へ手段ごとに出した。

| 手段 | Chromium | WebKit |
|---|---|---|
| `<img>`、`<script src>`、`<link rel=stylesheet>` | error、daemon に届かない | 同じ |
| `fetch` (no-cors の GET、CORS の GET、no-cors の POST で `/attachment` と `/webhook`) | reject、届かない | 同じ |
| `navigator.sendBeacon` (`/attachment` へ) | `true` を返すが、届かない | 同じ |
| WebSocket | error、届かない | `SecurityError`、届かない |
| `<iframe src>` | 要求は届かない | 同じ |
| form の送信 (`/attachment` へ POST) | 届かない | 同じ |
| `location.href`・`a.click()`・`top.location` の遷移 | 届く (`Origin` 無し、`cross-site`、200) | 同じ |
| `window.open` | `null`、届かない | 同じ |
| `?userscript=on` の shell への遷移 | 届き、webui が読み込まれて localStorage の `ccmsg.userscript` が `on` になった | 同じ |

## 観測: webui の shell を他のサイトの iframe に入れた時 (直した後)

別のサイト (`http://localhost:<別の port>`) のページに、webui の shell (`http://127.0.0.1:<port>/`) の iframe を置いた。shell の GET は `Origin` 無し、`Sec-Fetch-Site: cross-site`、`Sec-Fetch-Dest: iframe` で届いて 200、iframe の中の webui は `/ws` に `Origin: <webui の origin>` で繋がり、upgrade された (両ブラウザ)。

## 直し方を決めた実測

別の試験用サーバで、同じファイルをヘッダの組ごとに返して比べた (Chromium の headless shell、Chromium の channel `chromium`、WebKit)。

| ファイル | 使い方 | ヘッダ無し | `nosniff` + CSP `sandbox` | `nosniff` + CSP `sandbox; default-src 'none'` |
|---|---|---|---|---|
| svg (スクリプト入り) | top / iframe | スクリプトが動く | 動かない | 動かない |
| svg | `<img>` | 描画される | 描画される | 描画される |
| html (スクリプト入り) | top / iframe | スクリプトが動く | 動かない (本文は表示) | 動かない (本文は表示) |
| png | top / `<img>` | 描画される | 描画される | 描画される |
| テキスト | top | 表示される | 表示される | 表示される |
| PDF | top (channel `chromium`) | PDF ビューアで描画 | 同じ (スクリーンショットで比べた) | 同じ |
| wav | top | 再生できる | Chromium は読み込まない (readyState 0、networkState 3)。WebKit は再生できる | Chromium は読み込まない。WebKit は error 4 |
| wav | 同じ origin のページの `<audio>` | 再生できる | 再生できる | 再生できる |

この表から、`nosniff` と CSP `sandbox` を全部の型に付け、`audio/*` と `video/*` だけ `nosniff` のままにした (`packages/daemon/src/served-file-headers.ts`)。音声・動画は `nosniff` の下でスクリプトを動かす文書にならず、`sandbox` を付けると Chromium でタブで開いた時に読み込まれなくなる。採らなかった候補は次のとおり。

| 候補 | 採らなかった理由 |
|---|---|
| `default-src 'none'` を足す | 目的 (スクリプト・storage・`/ws`) は `sandbox` だけで止まる。足すと WebKit でタブの音声が読めなくなる |
| html・svg などを `Content-Disposition: attachment` にする | 添付の html をタブで開く今の表示がダウンロードに変わる。`sandbox` なら表示はそのままでスクリプトだけ止まる |
| `Cross-Origin-Resource-Policy: same-origin` | 目的の 3 つには効かない。他のサイトから画像の有無や大きさを読む経路を断つものなので、別の判断にする |
| framing を止めるヘッダ (`frame-ancestors`) | iframe に入れられても `sandbox` でスクリプトが止まった |
| 要求の側で `Sec-Fetch-Site: cross-site` を断る | preview のタブからの遷移は止まるが、webui の中のリンクから開く経路 (`same-origin` / `none`) は止まらない |
| `Origin` 無しの要求を断る | ブラウザは同じ origin の遷移・`<img>`・`<script>` にも `Origin` を付けないので、shell・assets・画像が全部断られる |

## 残っていること

- webui の shell が他のサイトの iframe に入れられて動く。shell の応答に `frame-ancestors` を付ければ止まる (付ける値は、webui 自身の origin と、webui が自分を iframe に入れる所があるかで決める)。今回の直しには入れていない
- `?userscript=on` の遷移で、どのサイトのページからでも、そのブラウザの userscript のスイッチを on にできる。作用は人が保存した userscript を動かすまで。今回の直しには入れていない

## 未確認

- `/ws` で `hello` と `ping` 以外の op (送信、起動、permit の応答) が、直す前に開いた文書から通ったか (通らない理由はコードに見当たらない)
- エージェントが自分の sid と webui の URL を、実際のセッションの中で知れるか。エージェントが添付の置き場に書けるか (Claude Code の権限の設定次第)
- webui の中で、絶対 URL のリンクを普通にクリックした後に再読み込みした時 (Navigation API は reload を intercept しないので、文書が読み込まれる見込み。直した後はスクリプトが動かない)
- webui が自分で作る sandbox だけ (CSP 無し) の iframe の中からの要求 (WebKit の sendBeacon が webui の origin を名乗る件で `POST /attachment` が通るか)。今の webui にはこの形の iframe が無い
- webui の shell が他のサイトの iframe に入れられた時に、人のクリックを誘って何ができるか。他のサイトの iframe の中の webui の storage が、人の webui のものと分かれるか (Chromium の storage partitioning)
- 動画 (`video/*`) をタブで開いた時 (音声の wav でだけ確かめた)
- 本物の Chrome・Safari・Firefox。sandbox origin が tailnet の名前 (loopback でない) にある時の、Chromium の Local Network Access の扱い (ここでは sandbox origin も webui も loopback)
