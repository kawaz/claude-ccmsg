# DR-0067: svg のコードブロックとファイルのスクリプトを、sandbox の中で実行する

- Status: Proposed
- Date: 2026-11-25

未実装。Decision は未決の問いの起草時の推しで通して書いてある。裁定の要る点は「未決」の Q1〜Q7 で、裁定が推しと違えば該当の節を書き直す。Q1 は「守ること」の 2 つ目を今のブラウザでは満たし切れないことの扱いで、先に決める。

## Context

webui は、markdown の `svg` のコードブロックと `.svg` のファイルを、img の data URL / img の URL で図として描く ([DR-0010](./DR-0010-timeline-markdown-rendering.md) §12)。img として読んだ svg はスクリプトが動かず、外の資源も読まない。動きのある図 (クリックで開く図、スクリプトで描く図) は止まった絵になる。

kawaz の依頼 (2026-11-25、[issue](../issue/2026-11-25-lean-highlight-and-svg-script-run.md) の 2): svg のブロックとファイルに「描画 | ソース | 実行」を付け、既定は描画、実行は覚えない。実行を選ぶと、外部にも ccmsg のサーバにも通信できない sandbox の中でスクリプトが動く。同じ人の別のツール dirview が同じ日にこの形 (受け皿の html を sandbox の iframe で開き、その中の sandbox の srcdoc に svg を入れる 2 段) を入れていて、ccmsg は sandbox origin ([DR-0030](./DR-0030-sandbox-origin-serving.md)) を持つので、受け皿をどこから配るかを決める。

決めるために測ったことは [findings 2026-11-25](../findings/2026-11-25-svg-script-run-sandbox.md)。Playwright の Chromium 159 と WebKit 27.2 で、受け皿の置き場 3 つと 1 段 / 2 段を比べた。この DR に効く結果:

- F1: 受け皿の置き場は結果を変えなかった。変えたのは 1 段か 2 段かと、CSP の有無
- F2: 1 段では、svg が自分の frame を遷移させて受け皿の CSP の外へ出られた。webui の文書には CSP が無いので、外部へも出られた
- F3: 2 段 + CSP では、HTTP と WebSocket の要求は 1 本も届かず、試した遷移はどれも止まり、webui の DOM・storage・cookie には触れなかった (両ブラウザ)
- F4: WebRTC の STUN の要求は、どの形でも届いた (両ブラウザ)。CSP の `webrtc 'block'` は効かなかった
- F5: WebKit では、`<link rel="preconnect">` の TCP の接続が届き、sandbox の中の `history.back()` / `history.go()` が top の履歴を戻した (webui を開く前のページまで戻れた)
- F6: 受け皿の応答ヘッダの `sandbox allow-scripts` は、iframe の `sandbox` 属性が無くても効いた。srcdoc の受け皿は、属性が無いと webui の origin で動いた
- F7: sandbox だけ (CSP 無し) の中からは、webui のサーバにも要求が出た。画像と no-cors の fetch の GET には `Origin` ヘッダが付かず (daemon は `Origin` の無い要求を通す)、WebKit では cookie が付き、sendBeacon の `Origin` が webui の origin になる場合があった
- F8: svg の中の無限ループで、WebKit ではどの形でも webui のページが応答しなくなった

## 目的

人が選んだ svg だけ、その中のスクリプトを動かして見られる。動かした svg が、見ている webui にも、その先の daemon にも、外にも作用しない。

守ること:

1. svg のスクリプトは動く
2. その svg から、外部にも ccmsg のサーバ (daemon の HTTP・WebSocket) にも要求が出ない
3. その svg から、webui の DOM・localStorage・sessionStorage・cookie・他の origin の storage に触れない
4. 受け皿の文書の遷移や、入れ子の frame を使って、上の制限の外に出られない
5. 人が「実行」を選ばない限り、スクリプトは動かない (描画の既定の安全を弱めない)

2 は、今の Chromium と WebKit では満たし切れない (F4、F5)。HTTP と WebSocket の要求については満たす。4 は、WebKit で sandbox の中から top の履歴を戻せることだけが残る (F5)。残る経路の扱いは Q1。

手順に現れない保証:

- 実行を選んでいない svg のために、受け皿の文書を読みに行かない
- 実行の選択はどこにも残らない (再読み込み、別のセッションやファイルへの移動、吹き出しの描き直しで描画に戻る)
- 実行を止めた (切り替えを戻した、表示から外れた) svg のスクリプトは動き続けない

増やしたくないもの:

- **webui の origin の中でスクリプトが動く面**。webui の origin (daemon の許可 origin) を持つ文書の中で、webui の bundle でないスクリプトが動くこと。opaque origin の文書の中で動くものは含まない
- **daemon が配る新しい種類の応答**。daemon の HTTP が返す応答に、今の種類 (webui の shell と `/assets`、`/ws`、`/attachment`、`/fs-serve`、`/webhook`、sandbox origin のファイル) に無いものを足すこと
- **守りを webui の JS の注意深さに頼る所**。webui の JS の書き方を誤ると「守ること」が破れる箇所。ブラウザの仕組み (iframe の sandbox、応答ヘッダの CSP、origin) が代わりに守る形を優先する

## 前提

| 前提 | 満たさない時 |
|---|---|
| ブラウザが、sandbox の中の文書に、top でない祖先の frame を遷移させない (Chromium 159・WebKit 27.2 で実測。HTML の仕様の「allowed by sandboxing to navigate」の文面はこれを止めていない) | 中の svg が受け皿の frame を遷移させられる。frame の遷移を検査するのが親の文書の CSP だけなら (今の両ブラウザ)、webui の文書には CSP が無いので、守ること 2・4 が破れる。Q3 |
| ブラウザが、frame の遷移をその親の文書か遷移を始めた文書の `frame-src` で検査する (実測は親の文書。仕様の文面は遷移を始めた文書と読める。2 段はどちらでも止まる) | 中の svg が自分の frame を遷移させて CSP の外へ出られる |
| srcdoc の文書が、親の文書の CSP と sandbox の flag を継ぐ (仕様と実測) | 中の文書に受け皿の CSP が掛からない |
| webui を配るサーバが、受け皿の応答にヘッダを付けられる (daemon が配るので付けられる) | CSP が meta だけになり、`sandbox` と `frame-ancestors` を指定できない。受け皿を守るのが iframe の属性だけになる |
| 見るブラウザは e2e の対象の Chromium と WebKit (Chrome、Safari) | どう動くかを確かめていない (Firefox では実測していない) |

## Decision

### 1. 受け皿の形

2 段にする。webui は、webui の origin の URL から配る受け皿の html を `sandbox="allow-scripts"` の iframe で開く。受け皿は、渡された svg を自分の中の `sandbox="allow-scripts"` の srcdoc の iframe に入れる。受け皿の文書には svg の文字を入れない。

受け皿の置き場ごとの、「守ること」を満たす仕組み (2 段の時。F1 のとおり、守ること 1〜4 の満たし方は置き場で変わらない):

| 守ること | 仕組み | (a) webui の origin の URL | (b) sandbox origin の URL | (c) webui が作る srcdoc |
|---|---|---|---|---|
| 1 動く | CSP の `script-src 'unsafe-inline'` と sandbox の `allow-scripts` | 満たす | 満たす | 満たす (webui の文書に CSP が無い間だけ。文書の CSP は srcdoc が継ぎ、dirview の実測では、ビューアの CSP の下の srcdoc で svg のスクリプトは動かなかった) |
| 2 要求が出ない | 受け皿の CSP (中の srcdoc が継ぐ) の `default-src 'none'`・`connect-src 'none'` ほか | HTTP・WebSocket は満たす。WebRTC と WebKit の preconnect は満たせない | 同じ | 同じ |
| 3 webui に触れない | sandbox の opaque origin | 満たす | 満たす (加えて site が別) | 満たす |
| 4 遷移で出られない | 中の遷移は受け皿の CSP の `frame-src 'none'`、上の frame と top の遷移は sandbox | 満たす。WebKit の `history.back()` / `history.go()` は止められない | 同じ | 同じ |
| 5 選ぶまで動かない | 既定は img。実行を選んだ時だけ iframe を作る | 満たす | 満たす | 満たす |

「増やしたくないもの」と前提での違い:

| | (a) webui の origin の URL | (b) sandbox origin の URL | (c) webui が作る srcdoc |
|---|---|---|---|
| webui の origin でスクリプトが動く面 | 増えない。受け皿の URL を直に開いても、応答ヘッダの `sandbox` で opaque origin になる (F6) | 増えない (origin が別) | iframe の `sandbox` 属性を落とすと、受け皿が webui の origin で動く (F6) |
| daemon が配る応答 | `/assets` の下に、文書として開ける html が 1 つ増える | sandbox origin の経路に、grant に結びつかない応答が増える (DR-0030 §5 の「配信 1 経路のみ」を広げる) | 増えない |
| JS の注意深さに頼る所 | 無い。iframe の属性を落としても応答ヘッダが守る | 無い | iframe の属性 1 つと、受け皿のスクリプトの検査 |
| 前提 | webui の文書の CSP の有無によらない | `sandbox_origin_template` を設定した環境だけで使える | webui の文書に CSP が無いこと |

(a) にする。守りが 2 つ (iframe の属性、応答ヘッダの CSP) ともブラウザの仕組みで、片方を落としても破れない。webui の文書に後から CSP を入れても変わらず、環境によって機能の有無が変わらない。代わりに `/assets` の html が 1 つ増える。(b) が (a) に足すものは実測で見つからなかった (site が別でも、WebKit では中の無限ループで webui が固まる。F8)。裁定は Q2。

### 2. 受け皿の配り方と CSP

受け皿は webui の配信 (`packages/webui/src/index.ts`) が `/assets/svg-run.<中身の hash>.html` で返す。中身は build で決まる定数で、要求によって変わらない。`cache-control` は bundle と同じ immutable。daemon の HTTP の振り分け (`http.ts`)・op・protocol は変えない。

応答ヘッダ:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

- CSP は meta でなく応答ヘッダで渡す。`sandbox` と `frame-ancestors` は meta では使えない
- `sandbox allow-scripts`: iframe の属性によらず、受け皿を opaque origin にする (F6)。URL を直に開いた時も同じ
- `frame-src 'none'`: 中の svg の文書が自分の frame を遷移させるのを止める。srcdoc の iframe は作れる
- `script-src 'unsafe-inline'`: svg の中のスクリプトとイベント属性を動かす。受け皿の本体のスクリプトをハッシュで許すと、同じ source list の `'unsafe-inline'` が効かなくなり svg が動かない (CSP の仕様と dirview の実測)。受け皿の文書には svg を入れないので、`'unsafe-inline'` で受け皿に入り込むスクリプトは無い
- `img-src data: blob:` / `font-src data:`: svg の中に埋めた画像とフォントだけを許す。外の画像・フォント・`<use href>` は読めない (§5)
- `webrtc 'block'`: 今の Chromium と WebKit では効かない (F4)。付けても受け皿は動くので、ブラウザが対応した時に塞がるよう入れておく
- `frame-ancestors 'self'`: 受け皿を frame に入れられるのを、同じ origin の文書だけにする
- `'unsafe-eval'` は入れない (Q5)。`media-src` は書かず、音声と動画は `default-src 'none'` で読めない (Q7)

このヘッダと §3 の受け皿の形は、findings の案 D として、通信・遷移・storage・渡し方の試しを流してある。

### 3. 受け皿と webui の約束

受け皿のスクリプト:

- 起動した時、`self.origin === "null"` かつ `parent !== window` でなければ何もしない
- `MessageChannel` を作り、`parent.postMessage({ type: "ready" }, <受け皿の URL の origin>, [port])` で片方の port を親に渡す。targetOrigin が webui の origin なので、port を受け取れるのは webui の origin の文書だけ
- 手元の port で `{ type: "render", svg }` を 1 回だけ受け、中の iframe (`sandbox="allow-scripts"`、`srcdoc`) を作る。2 回目以降は読まない
- window の message は聞かない。svg が受け皿に送る message には意味が無い

webui:

- 「実行」が選ばれた時に iframe を作る。属性は `sandbox="allow-scripts"`、`referrerpolicy="no-referrer"`、`src` (受け皿の URL)、`title`。`allow` は付けない
- window の message のうち、`event.source` がその iframe の window で、`{ type: "ready" }` と port 1 つを持つものだけを受け (形はスキーマで読む。[DR-0038](./DR-0038-json-is-parsed-by-schema.md))、port に svg を 1 回書く。受け皿の origin は `"null"` なので、`event.origin` では見分けない
- webui が受け皿から受けるのは `ready` だけ。svg が top に送る message は `event.source` が違うので捨てる

svg を MessagePort で渡すのは、届く先を「`ready` を送った受け皿の文書」にブラウザが固定するため。window の `postMessage` で渡すと、受け皿の origin が opaque なので targetOrigin に `"*"` を書くしかなく、svg (会話の中身) の届く先を webui の JS の検査で守ることになる。

### 4. 大きさと止め方

- svg の大きさに新しい上限は置かない。コードブロックの svg は既に webui が持っている文字で、5 MiB の svg を渡して動いた (実測)
- `.svg` のファイルは `fs_read` の中身を渡す。`fs_read` が 512 KiB で切り詰めた時は、実行のタブを押せなくして理由を出す (描画は `/fs-serve` の img なので今までどおり)
- 選択が実行でなくなった時 (他のタブを選ぶ、図を描いている部品が文書から外れる) に iframe を文書から外す。外すと中のスクリプトは止まる (実測)。外した iframe は使い回さず、もう一度選ぶと作り直す
- 実行の選択は、ブロックごとの state に持ち、保存せず、URL に書かない

### 5. 外の資源

svg の中から、外の画像・フォント・CSS・スクリプト・`<use href>` は読めない。断つのは受け皿の CSP で、守ること 2 から決まる。描画 (img) でも外の資源は読まれないので、図の見え方は描画と実行で揃う。`data:` と `blob:` の画像、`data:` のフォントは読める。

### 6. 付ける所と切り替え

- `svg` のコードブロック (`SvgFigure`): `MarkdownView` を通る全部。Timeline の吹き出し、Files の markdown のプレビュー、Timeline の中に出すファイルの中身 (`InlineFileViewer`)、本文を書く欄の md のプレビュー (`ComposePreview`)
- `.svg` のファイルのビューア (`FileViewer` の画像の表示): 今は img だけなので、「描画 | ソース | 実行」を足す。ソースは `fs_read` の中身
- mermaid と数式には付けない
- 入れる順: コードブロックを先に入れ、ファイルのビューアは次の版で足す (Q4)。受け皿と §3 の約束は同じものを使う

切り替えは、今の「描画 | ソース」の部品 (`FenceFigure` の `Tabs`、Timeline の小さなタブ) に「実行」を 1 区画足す。新しい見た目は作らない。

- 既定は描画。実行は覚えない (§4)
- 描画できない svg (img の読み込みが失敗するもの) は、描画と同じく実行も押せない。svg でない html を動かす口にしない
- 実行の間は、図の場所に iframe を置き、タブの下に知らせの行を出す。文言は Q1 の裁定で決まる。起草時の案: 「スクリプトを実行している。この画面の内容と保存したデータは読めず、HTTP の通信はできない」
- 受け皿の `ready` が来るまでは「準備中…」。時間切れは作らない
- 下地は描画と同じ白

### 7. 図の大きさ

実行の iframe は、切り替える直前の描画の img と同じ幅と高さで置く。中身がそれより大きくなった時は iframe の中でスクロールする。受け皿から高さの知らせは受けない。

切り替えで箱の大きさが変わらないので、DR-0010 §12 の「切り替えで位置を保つ」がそのまま成り立ち、svg が高さを変え続けても Timeline は動かない。webui が受け皿から受ける message も `ready` だけで済む。dirview は中で測った高さを受け皿経由で知らせて iframe を伸ばす。違いは Q6。

### 8. 版をまたぐ前提

「前提」の上 3 つはブラウザの振る舞いで、版が上がると変わりうる。e2e の試験 (§9) で、Chromium と WebKit の今の版の振る舞いとして固定する。試験が落ちた時は、変わった振る舞いを findings に足し、この DR の前提を見直す。

今の版でブラウザごとに違う所:

| 項目 | Chromium 159 | WebKit 27.2 |
|---|---|---|
| WebRTC の STUN | 出る | 出る |
| `<link rel="preconnect">` の接続 | 確かめられなかった | 出る |
| sandbox の中の `history.back()` / `history.go()` | top は動かない | top の履歴が戻る |
| svg の中の無限ループ | headless shell では webui が固まり、channel `chromium` では固まらない | webui が固まる |
| sandbox だけの時の webui のサーバへの要求 | cookie 無し。GET の画像と no-cors の fetch は `Origin` ヘッダ無し | cookie 付き。GET は同じく `Origin` ヘッダ無しで、sendBeacon の `Origin` が webui の origin になる場合がある |

### 9. 検証の計画

e2e (`packages/webui/e2e/`、Chromium と WebKit、部品のカタログのページ) で確かめること。要求が届いたかは、試験が立てた記録するだけのサーバの記録で見る (ブラウザの request のイベントには CSP で止められた要求も出る)。

- 実行を選ぶと、svg の `<script>`・イベント属性・アニメーションが動く
- 中からの `fetch`・XHR・WebSocket・画像・`sendBeacon` が、記録のサーバにも試験用の daemon にも届かない
- 中から自分の frame を遷移させても (`location`、meta refresh、リンク、`window.open(url, "_self")`)、遷移先の要求が届かない
- 中から `parent.location` と `top.location` に代入すると例外になり、受け皿の frame と top は動かない (前提の固定)
- 中から `localStorage`・`top.document` に触れると例外になる
- 実行のタブを戻すと iframe が文書から無くなり、中の定期の message が止まる
- 受け皿を読めない時 (試験が受け皿の URL を 404 にする) は「準備中…」のままで、タブを戻せる
- 受け皿の URL を直に開いても、何も描かれない

配信の unit test:

- 受け皿の応答に §2 のヘッダが全部ある
- 受け皿の中身が要求によって変わらない

「持たない」「増やさない」「変えない」を壊す変更を止める試験の観点:

- 実行を選ぶまで、文書に実行の iframe が無く、受け皿の URL への要求が出ない
- 再読み込みの後は描画に戻る。localStorage と URL に実行の選択が無い
- mermaid と数式の箱に実行の区画が無い
- 受け皿の文書の中に svg の要素が無い (svg は中の iframe にだけある。1 段にしない)
- iframe の `sandbox` 属性を外して受け皿を開いても、中から webui の storage に触れない (応答ヘッダが守っていることの固定)
- webui は、受け皿からの `ready` 以外の message と、`event.source` が実行の iframe でない message で何もしない
- protocol の op と daemon の HTTP の振り分けに追加が無い

WebRTC・WebKit の preconnect・WebKit の履歴は、今は止められないので試験で固定しない。

## 未決

各問いは、原意図、選択肢ごとの意味の違い、起草時の推しの順に書く。

### Q1. 止められない経路 (WebRTC、WebKit の preconnect と履歴) をどう扱うか

- 原意図: 実行した svg から、外部にも ccmsg のサーバにも要求が出ない (守ること 2)。受け皿の遷移などで制限の外に出られない (守ること 4)
- 実測 (F4、F5):
  - WebRTC: 両ブラウザで、svg のスクリプトが指定した宛先に STUN の UDP が届く。運べるデータの量は確かめていない (宛先のホスト名と port は svg が選べる)
  - WebKit の preconnect: svg が指定した宛先に TCP の接続が届く
  - WebKit の履歴: svg が top の履歴を戻せる。webui を開く前のページまで戻れた。戻る先は履歴にあるページだけで、戻った後の文書は svg のものではない
  - どれも受け皿の置き場によらない。webui の DOM・storage・cookie は読めない (F3) ので、運び出せるのは svg 自身に書かれた文字と、sandbox の中から見える環境の値
- 選択肢:
  - (a) 入れる。守ること 2 を「HTTP と WebSocket の要求が出ない」に狭め、止められない経路をこの DR と実行中の知らせの行に書く: 応答に写った第三者の入力が svg に文字を埋め、人が実行を選ぶと、その文字が外へ運ばれうる。markdown のリンクを人が押した時に URL の文字が外へ出るのと同じ線 (描いた瞬間には到達せず、人の操作で到達する。DR-0010 §5) の上にあるが、リンクと違って行き先が見えない
  - (b) 入れて、実行を選んだ時に確認を 1 つ挟む (できてしまうことを書いたボタン): 知らずに押すことは減る。実行のたびに 1 操作増え、読まずに押す操作になりやすい
  - (c) WebKit では実行の区画を出さない: 履歴と preconnect は WebKit だけなので消える。WebRTC は Chromium に残る。iPad の Safari で実行が使えなくなる
  - (d) 入れない。ブラウザが WebRTC を止める仕組みを持つまで待つ: 守ること 2 は破れない。動く図は見られないまま
- 推し: (a)。webui の中身は読まれないので、運び出されうるのは人が実行を選んだ svg に既に書かれていた文字に限られる。知らせの行は事実どおりに書く (「外部と通信できない」とは書かない)
- dirview の受け皿も同じ CSP と同じ 2 段で、知らせの文は「外部やこのサーバとは通信できない」。dirview では試していないが、同じ経路が残るはず。揃えるかは dirview の側で決める

### Q2. 受け皿の置き場

- 原意図: ccmsg は sandbox origin を持つので、受け皿をそちらで配るかを決める (issue)
- 選択肢 (§1 の 2 つの表):
  - (a) webui の origin の URL: `/assets` に html が 1 つ増える。守りは iframe の属性と応答ヘッダの 2 つで、どの環境でも使える
  - (b) sandbox origin の URL: 受け皿の origin が webui と別になる。sandbox origin を設定した環境でしか実行を使えず、sandbox origin の経路に grant の無い応答を足す
  - (c) webui が作る srcdoc: 配るものが増えない。iframe の属性を落とすと webui の origin で動き、webui の文書に CSP を入れると動かなくなる
- (a) と (b) を両方持ち、sandbox origin があればそちらを使う形は取らない。守ること 1〜4 の満たし方は同じで (F1)、試験と配信の経路だけが 2 倍になる
- 推し: (a)

### Q3. webui の文書に、frame の遷移先を縛る CSP を入れるか

- 原意図: 守りを webui の JS の注意深さに頼らず、ブラウザの仕組みで持つ。「前提」の 1 つ目 (sandbox の中から祖先の frame を遷移させられない) は仕様の文面に無く、今のブラウザの振る舞いに依っている
- 選択肢:
  - (a) 入れない。前提を e2e で固定する (§9): 前提が崩れた版では試験が落ちる。落ちるまでの間に本物のブラウザが先に変わると、中の svg が受け皿の frame を遷移させられる
  - (b) webui の shell の応答に `Content-Security-Policy: frame-src 'self' <Terminal の gateway の origin>` を付ける: 前提が崩れても、受け皿の frame の遷移先は webui の origin と gateway に限られる (実測: 親に `frame-src` があると、1 段でも外部への遷移は止まる)。webui の origin の html (shell) への遷移は残る。gateway の origin は config から来るので、ヘッダを要求ごとに組む
  - (c) (b) の `'self'` を受け皿の URL に絞る: 受け皿の frame はどこへも遷移できなくなる。path まで書いた source が遷移の検査でどう比べられるかは確かめていない
- 推し: (a)。今の両ブラウザで止まっていて、変われば試験で気づける。(b) は webui 全体の応答に手を入れるので、入れるなら別の DR で webui の CSP として決める

### Q4. `.svg` のファイルのビューアを最初の版に入れるか

- 原意図: svg のブロックとファイルに「描画 | ソース | 実行」を付ける (issue)
- 選択肢:
  - (a) コードブロックとファイルを同じ版で入れる: ファイルのビューアは今 img だけで、ソースの表示と切り替えの部品を足す所から要る
  - (b) コードブロックを先に入れ、ファイルは次の版: 受け皿と約束は同じなので、後から足しても受け皿は変わらない
- 推し: (b)。エージェントに図を頼む使い方はコードブロックで足りる。ファイルのビューアの切り替えは、ソースの表示 (編集できる表示との関係) を決めてから足す

### Q5. `eval` を許すか

- 原意図: svg のスクリプトは動く (守ること 1)
- 選択肢:
  - (a) 許さない: `eval`・`new Function` を使う svg (図のライブラリを丸ごと埋めたもの等) は動かない。dirview と同じ
  - (b) `'unsafe-eval'` を足す: 動く範囲が広がる。通信と遷移は他の指令と sandbox で止まっているので、守ること 2〜4 は変わらない (`eval` を許した形は実測していない)
- 推し: (a)。要る svg が出てから足す

### Q6. 実行の図の高さ

- 原意図: 切り替えで見ている位置を見失わない (DR-0010 §12)。dirview と揃える (issue)
- 選択肢:
  - (a) 描画の img と同じ大きさで固定し、はみ出す分は iframe の中でスクロール (§7): 切り替えでも実行中も箱が動かない。スクリプトで大きくなる図は、箱の中でスクロールして見る
  - (b) 中で測った高さを受け皿経由で知らせて iframe を伸ばす (dirview の形): 大きくなる図が全部見える。svg は好きな高さを知らせられるので上限 (dirview は 10000px) で丸める。高さが変わるたびに Timeline の位置を保ち直す。webui が受ける message が 1 種類増える
- 推し: (a)

### Q7. 軽い確認 (推しのまま進めてよいか)

- svg は MessagePort で渡す (§3)。window の `postMessage` と `"*"` は使わない
- `webrtc 'block'` を、効かない今から CSP に入れておく (§2)
- `media-src` は書かない (dirview は `data: blob:` を許す。許した時に何が読めるかを確かめていないので外す。svg に埋めた音声と動画は鳴らない・映らない)
- 描画できない svg は実行も押せない (§6)
- 実行の知らせの行は常に出す (畳まない)

## 要る実測

- M1: 本物の Safari (macOS、iPad) と Chrome で、§1 の (a) の受け皿に findings と同じ試しをする。WebKit の履歴・preconnect と WebRTC が同じか、Chromium の preconnect が届くか
- M2: WebKit で、人のクリックを伴う top の遷移・新しい窓・ダウンロードが止まるか (findings の実測の間は画面が消えていて、WebKit のクリックが届かなかった)
- M3: WebRTC で運べるデータ (TURN の username、宛先のホスト名への埋め込み) と、TCP の TURN で daemon の port に接続できるか。Q1
- M4: 本物の Chrome と Safari で、svg の中の無限ループの間に webui が操作できるか。Consequences
- M5: path まで書いた `frame-src` の source が、frame の遷移でどう比べられるか。Q3 の (c)

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| 1 段 (svg を受け皿の文書に入れる) | svg が自分の frame を遷移させて受け皿の CSP の外へ出られる (F2)。webui の文書に CSP が無いので外部へも出られる |
| sandbox の iframe だけで、CSP を付けない | 外部にも webui のサーバにも要求が出る。daemon の `Origin` の検査を通る要求が中から出せる (F7) |
| svg を `image/svg+xml` の文書として `blob:` / `data:` の iframe で開く | 文書に CSP を付ける場所が無い。継ぐのは webui の文書の CSP だけで、今は何も無い (仕様の読み。実測していない) |
| svg を webui の文書に直に入れる (inline の `<svg>`) | スクリプトが webui の origin で動く (DR-0010 §12 が img にした理由) |
| 中の文書の先頭で `RTCPeerConnection` を消す | 入れ子の srcdoc の iframe は CSP の下でも作れてスクリプトが動き (実測)、その文書は消す前の `RTCPeerConnection` を持つ。塞ぐには要素の作り方を全部包むことになり、守りが JS の注意深さになる |
| 受け皿の本体のスクリプトをハッシュで許す | 同じ source list の `'unsafe-inline'` が効かなくなり、svg が動かない |
| 実行を別のタブで開く (DR-0030 の HTML の表示と同じ形) | 図を本文の中で見られない。WebRTC は残る。タブが別なら webui の履歴には触れないはずだが、確かめていない |
| 実行の選択を覚える (mermaid の描画 / ソースのように) | 守ること 5。開いただけでスクリプトが動く |
| svg を受け皿の URL の query で渡す | svg の文字が要求の URL として daemon に届き、受け皿の応答の URL が svg ごとに変わる |
| svg を受け皿の URL の fragment で渡す | 確かめていない。MessagePort で足りる |
| webui が svg を srcdoc の文字に埋めて渡す | §1 の (c) の形になる |
| 受け皿の有無を、開く前に fetch で確かめる (dirview) | 受け皿は webui と同じ build から配るので、無い配信が無い |
| 外の画像やフォントを読めるようにする | 守ること 2。読む時に外へ要求が出る |

## Consequences

- webui の配信に、文書として開ける html が 1 つ増える。直に開いても opaque origin で、何も描かない
- protocol・op・daemon の HTTP の振り分けは変わらない。`sandbox_origin_template` の有無で機能は変わらない
- 守ること 2 は HTTP と WebSocket に限って成り立つ。WebRTC (両ブラウザ) と preconnect (WebKit) で、svg が選んだ宛先に接続の試みが届く (Q1)
- WebKit では、実行した svg が webui の履歴を戻せ、開いていた画面から離れさせられる (Q1)
- svg の中の無限ループで、WebKit では webui のタブが固まる (F8)。実行は覚えないので、再読み込みすれば描画に戻る
- スクリプトで大きくなる図は、箱の中でスクロールして見る (Q6)
- `eval` を使う svg と、音声・動画を埋めた svg は動かない (Q5、Q7)
- ブラウザの版が上がって「前提」が変わると、e2e が落ちる
- 実行の図の中をクリックした後のキーの操作は iframe の中に届き、webui には届かない (Terminal の iframe と同じ)

## 関連

- [issue 2026-11-25](../issue/2026-11-25-lean-highlight-and-svg-script-run.md) — 依頼の正本 (2. svg のスクリプトの実行)
- [findings 2026-11-25](../findings/2026-11-25-svg-script-run-sandbox.md) — 受け皿の形ごとの実測、一次資料から読んだこと、未確認
- [DR-0010](./DR-0010-timeline-markdown-rendering.md) §12 — svg のコードブロックの描画と「描画 | ソース」の箱、切り替えで位置を保つ決まり
- [DR-0030](./DR-0030-sandbox-origin-serving.md) — sandbox origin の配信
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — 外から来る値をスキーマで読む
- dirview のリポの `docs/DESIGN-ja.md` (svg の実行、受け皿) と `docs/findings/2026-11-25-svg-script-runner.md`
