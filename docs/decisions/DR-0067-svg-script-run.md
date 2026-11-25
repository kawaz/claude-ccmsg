# DR-0067: svg のコードブロックとファイルのスクリプトを、sandbox の中で実行する

- Status: Proposed
- Date: 2026-11-25

未実装。Decision は未決の問いの起草時の推しで通して書いてある。裁定の要る点は「未決」の Q1〜Q8 で、裁定が推しと違えば該当の節を書き直す。Q1 と Q8 は、依頼の「外部にも ccmsg のサーバにも通信できない sandbox」を今のブラウザでは満たし切れないことと、実行した svg が webui を固められることの扱いで、「目的」と「守ること」の文そのものを決めるので、先に決める。

## Context

webui は、markdown の `svg` のコードブロックと `.svg` のファイルを、img の data URL / img の URL で図として描く ([DR-0010](./DR-0010-timeline-markdown-rendering.md) §12)。img として読んだ svg はスクリプトが動かず、外の資源も読まない。動きのある図 (クリックで開く図、スクリプトで描く図) は止まった絵になる。

kawaz の依頼 (2026-11-25、[issue](../issue/2026-11-25-lean-highlight-and-svg-script-run.md) の 2): svg のブロックとファイルに「描画 | ソース | 実行」を付け、既定は描画、実行は覚えない。実行を選ぶと、外部にも ccmsg のサーバにも通信できない sandbox の中でスクリプトが動く。同じ人の別のツール dirview が同じ日にこの形 (受け皿の html を sandbox の iframe で開き、その中の sandbox の srcdoc に svg を入れる 2 段) を入れていて、ccmsg は sandbox origin ([DR-0030](./DR-0030-sandbox-origin-serving.md)) を持つので、受け皿をどこから配るかを決める。

依頼が挙げた、守ること (以下「依頼の 5 つ」):

1. svg のスクリプトは動く
2. その svg から、外部にも ccmsg のサーバ (daemon の HTTP・WebSocket) にも要求が出ない
3. その svg から、webui の DOM・localStorage・sessionStorage・cookie・他の origin の storage に触れない
4. 受け皿の文書の遷移や、入れ子の frame を使って、上の制限の外に出られない
5. 人が「実行」を選ばない限り、スクリプトは動かない (描画の既定の安全を弱めない)

決めるために測ったことは [findings 2026-11-25](../findings/2026-11-25-svg-script-run-sandbox.md)。Playwright の Chromium 159 と WebKit 27.2 で、受け皿の置き場 4 つと 1 段 / 2 段を比べた。この DR に効く結果:

- F1: svg のスクリプトにブラウザの中でできることは、受け皿の置き場では変わらなかった。変えたのは、svg を受け皿の文書に入れるか (1 段)、受け皿の中の sandbox の srcdoc に入れるか (2 段) と、CSP の有無。置き場で変わるのは、配る側のこと (応答の種類、cache、ヘッダを付けられるか) と、iframe の属性を落とした時の受け皿の origin
- F2: 1 段では、svg が自分の frame を遷移させて受け皿の CSP の外へ出られた。webui の文書には CSP が無いので、外部へも出られた
- F3: 2 段 + CSP では、HTTP と WebSocket の要求は 1 本も届かず、svg の選んだ URL への遷移はどれも止まり、webui の DOM・storage・cookie には触れなかった (両ブラウザ)
- F4: WebRTC の STUN の要求は、どの形でも届いた (両ブラウザ)。CSP の `webrtc 'block'` は効かなかった
- F5: WebKit では、`<link rel="preconnect">` の TCP の接続が届き、sandbox の中の `history.back()` / `history.go()` が top の履歴を戻した (webui を開く前のページまで戻れた)
- F6: iframe の `sandbox` 属性を付けなかった時、応答ヘッダに `sandbox allow-scripts` を持つ URL の受け皿と、`data:` の URL の受け皿は opaque origin のままで、webui の storage と DOM に触れなかった。srcdoc の受け皿は webui の origin で動いた。受け皿の中の iframe の属性も同時に落とすと、URL の受け皿は変わらず (応答ヘッダの `sandbox` を中の文書が継ぐ)、`data:` の受け皿では svg が新しい窓を開け、受け皿の frame を外部へ遷移させられた (webui の storage と DOM には触れないまま)
- F7: sandbox だけ (CSP 無し) の中からは、webui のサーバにも要求が出た。画像と no-cors の fetch の GET には `Origin` ヘッダが付かず (daemon は `Origin` の無い要求を通す)、WebKit では cookie が付き、sendBeacon の `Origin` が webui の origin になる場合があった
- F8: svg の中の無限ループの間、WebKit と Chromium の headless shell では webui のページの JS が走らず、webui が先に予約しておいた「iframe を外す」も走らなかった。5 秒で終わるループの後は元に戻った。channel `chromium` の Chromium では、ループの間も webui は動き、iframe を外せた
- F9: URL から配る受け皿を immutable で cache させると、本文が同じまま応答ヘッダの CSP だけを変えた後も、cache から読んだ文書には前の CSP が効いた (Chromium はどの開き方でも、WebKit は同じタブで開き直した時)。`no-cache` と ETag (304) では、304 の応答の CSP が効いた
- F10: frame の遷移を `frame-src` で検査するのは、その frame を持つ親の文書の CSP だった (両ブラウザ)。webui の文書に `frame-src data:` を置くと、1 段でも外部と webui の origin への遷移は止まり、`data:` への遷移だけが通った (遷移先は元の CSP を継ぐ)
- F11: 受け皿は渡された文字を html として読む。`<foreignObject>` の中の html のスクリプトは動き、根が svg でない文字も動き、svg の中に html の要素 (`<p>` など) があると、そこから後ろは svg の外の html になった。どれも sandbox と CSP の中で、要求は届かなかった。描画 (img) は XML として読むので、こうした svg は描画と実行で見え方が違った

## 目的

人が選んだ svg だけ、その中のスクリプトを動かして見られる。動かした svg は、見ている webui の中身を読むことも書き換えることもできず、HTTP と WebSocket で外とも daemon とも話せず、開いている画面を svg の選んだ行き先へ移せない。

守ること:

1. 人が実行を選んだ svg のスクリプトは動く
2. その svg から、外部にも ccmsg のサーバ (daemon の HTTP・WebSocket) にも、HTTP と WebSocket の要求が出ない
3. その svg から、webui の DOM・localStorage・sessionStorage・cookie・他の origin の storage に触れない
4. その svg が、自分の frame・受け皿の frame・top を svg の選んだ URL へ遷移させられず、新しい窓も開けない。遷移や入れ子の frame を使って 2・3 の外に出られない
5. 人が「実行」を選ばない限り、スクリプトは動かない (描画の既定の安全を弱めない)

守れないこと (今の Chromium と WebKit に、止める仕組みが無い):

- N1: svg が選んだ宛先への、HTTP でない接続の試み。WebRTC の STUN (両ブラウザ、F4) と、WebKit の preconnect の TCP の接続 (F5)
- N2: WebKit で、top の履歴を戻す・進めること (F5)。行き先は履歴に既にあるページで、svg は URL を選べない
- N3: 実行している間、webui のページを固めること (F8)。ブラウザが実行の frame を webui と同じプロセスで動かす時に起きる

この「目的」と「守ること」は、依頼の 5 つのうち 2 と 4 を、実測で満たせる所まで狭めて書いた形 (Q1 の (a) と Q8 の (a))。依頼の 2 (要求が出ない) と、依頼の「通信できない sandbox」は、N1 と両立しない。依頼の 4 を「svg が top の画面を動かせない」まで含めて読むなら、N2 と両立しない。N3 は依頼の 5 つに書かれていないが、見ている webui への作用になる。どの文にするかは Q1 と Q8 で決める。

手順に現れない保証:

- 実行を選んでいない svg のために、受け皿を作らない
- 実行の選択はどこにも残らない (再読み込み、別のセッションやファイルへの移動、吹き出しの描き直しで描画に戻る)
- 実行を止めた (切り替えを戻した、図を描いている部品が文書から外れた) svg のスクリプトは動き続けない

増やしたくないもの:

- **webui の origin の中でスクリプトが動く面**。webui の origin (daemon の許可 origin) を持つ文書の中で、webui の bundle でないスクリプトが動くこと。opaque origin の文書の中で動くものは含まない
- **daemon が配る新しい種類の応答**。daemon の HTTP が返す応答に、今の種類 (webui の shell、`/assets` の JS・CSS・mermaid の MJS と LICENSE、`/ws`、`/attachment`、`/fs-serve`、`/webhook`、sandbox origin のファイル) に無いものを足すこと
- **守りを webui の JS の注意深さに頼る所**。webui の JS の書き方を誤ると「守ること」が破れる箇所。ブラウザの仕組み (iframe の sandbox、CSP、origin) が代わりに守る形を優先する

## 前提

| 前提 | 満たさない時 |
|---|---|
| `data:` の URL の文書の origin は opaque (HTML の「determine the origin」は URL の origin を返し、`data:` の origin は opaque。iframe の属性の有無によらず実測) | 受け皿が webui の origin で動く。iframe の `sandbox` 属性だけが守りになる |
| srcdoc の文書は親の文書の CSP と sandbox の flag を継ぎ、`data:` の文書は遷移を始めた文書の CSP を継ぐ (仕様と実測) | 中の svg の文書に受け皿の CSP が掛からない |
| ブラウザが、frame の遷移をその親の文書か遷移を始めた文書の `frame-src` で検査する (実測は親の文書。仕様の文面は遷移を始めた文書と読める。2 段はどちらでも止まる) | 中の svg が自分の frame を遷移させて CSP の外へ出られる |
| ブラウザが、sandbox の中の文書に、top でない祖先の frame を遷移させない (Chromium 159・WebKit 27.2 で実測。HTML の仕様の「allowed by sandboxing to navigate」の文面はこれを止めていない) | 中の svg が受け皿の frame を遷移させようとできる。行き先は §4 の webui の文書の `frame-src` が縛る (`data:` と Terminal の gateway だけ。`data:` の文書は元の CSP を継ぐ) |
| webui の文書に、`script-src` を持つ CSP が無い (今は CSP 自体が無い。DR-0010 §13) | `data:` の受け皿がその CSP を継ぎ、インラインのスクリプトが動かなくなる。その時は受け皿の置き場を決め直す (Q2) |
| 見るブラウザは e2e の対象の Chromium と WebKit (Chrome、Safari) | どう動くかを確かめていない (Firefox では実測していない) |

## Decision

### 1. 受け皿の形

2 段にする。webui は、受け皿の html を `data:` の URL にして `sandbox="allow-scripts"` の iframe で開く。受け皿は、渡された svg を自分の中の `sandbox="allow-scripts"` の srcdoc の iframe に入れる。受け皿の文書には svg の文字を入れない。受け皿の html は webui の bundle の中の定数で、daemon は何も配らない。

「守ること」を満たす仕組み (2 段の時。svg にできることは置き場で変わらない。F1):

| 守ること | 仕組み |
|---|---|
| 1 動く | 受け皿の CSP の `script-src 'unsafe-inline'` と、sandbox の `allow-scripts` |
| 2 要求が出ない | 受け皿の CSP (中の srcdoc が継ぐ) の `default-src 'none'`・`connect-src 'none'` ほか |
| 3 webui に触れない | sandbox の opaque origin (中の文書)、`data:` の文書の opaque origin (受け皿) |
| 4 遷移させられない | 中の文書の遷移は受け皿の CSP の `frame-src 'none'`、上の frame と top の遷移・新しい窓は中の iframe の sandbox、受け皿の frame の行き先は webui の文書の `frame-src` (§4) |
| 5 選ぶまで動かない | 既定は img。実行を選んだ時だけ iframe を作る |

受け皿の置き場の違い:

| | (a) webui の origin の URL | (b) sandbox origin の URL | (c) webui が作る srcdoc | (d) `data:` の URL |
|---|---|---|---|---|
| daemon が配る応答 | `/assets` に、文書として開けてスクリプトの動く `text/html` が増える (今の `/assets` は JS・CSS・mermaid の MJS と LICENSE) | sandbox origin の経路に、grant に結びつかない応答が増える (DR-0030 §5 の「配信 1 経路のみ」を広げる) | 増えない | 増えない |
| webui が作る iframe の `sandbox` 属性を落とした時 | 変わらない (応答ヘッダの `sandbox`) | 変わらない | 受け皿が webui の origin で動く。止めるのは受け皿のスクリプトの検査だけ | 受け皿は opaque origin のまま (URL の scheme で決まる)。svg は受け皿の中の iframe の sandbox の下のままで、守ることは破れない |
| 受け皿の中の iframe の `sandbox` 属性を落とした時 | 変わらない (応答ヘッダの `sandbox` を中の文書が継ぐ) | 変わらない | 確かめていない | 変わらない (外の iframe の属性の sandbox を中の文書が継ぐ) |
| 両方を落とした時 | 変わらない | 変わらない | webui の origin で動く | 守ること 4 が破れる: svg が新しい窓を開け、受け皿の frame を遷移させられる (後者は §4 の `frame-src` が止める)。webui の storage と DOM には触れないまま |
| CSP の渡し方 | 応答ヘッダ (`sandbox`・`frame-ancestors` も使える) | 応答ヘッダ | 文書の中の meta | 文書の中の meta (`sandbox`・`frame-ancestors` は使えない) |
| CSP を変えた時 | URL の版に応答ヘッダが入っていないと、cache の古い CSP の文書が使われる (F9) | 同じ | bundle と一緒に替わる | bundle と一緒に替わる |
| 使える環境 | どこでも | `sandbox_origin_template` を設定した環境だけ | どこでも | どこでも |
| webui の文書に `script-src` を持つ CSP を入れた時 | 変わらない | 変わらない | 動かなくなる | 動かなくなる |

「増やしたくないもの」の 3 つを、定義を変えずに全部保てる置き場は無かった。(a) と (b) は、守りを全部ブラウザの仕組みに置けるが、daemon が配る応答の種類を 1 つ増やす。(d) は応答を増やさず、webui の origin で動く面も増やさないが、svg を縛る sandbox を webui の JS が付ける 2 つの属性 (webui の iframe と、受け皿の定数の中の iframe) に置き、2 つとも落とした時に破れる。1 つだけなら破れない。

(d) にする。応答が増えず、cache される応答が無いので F9 も起きない。属性を 2 つとも落とす変更は §11 の試験で止める。代わりに、CSP は meta でしか渡せず、webui の文書に `script-src` を持つ CSP を入れる時には置き場を決め直すことになる。どの「増やしたくないもの」を譲るかの裁定は Q2。

### 2. 受け皿の中身と CSP

受け皿は次の html を `data:text/html;charset=utf-8,` の URL にしたもの。中身は build で決まる定数で、svg ごとに変わらない。

- 文書の先頭 (他の要素より前) に meta の CSP を置く:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'
```

- `<meta name="referrer" content="no-referrer">` と、§3 のスクリプト 1 つ

指令の役:

- `frame-src 'none'`: 中の svg の文書が自分の frame を遷移させるのを止める。srcdoc の iframe は作れる
- `script-src 'unsafe-inline'`: svg の中のスクリプトとイベント属性を動かす。受け皿の本体のスクリプトをハッシュで許すと、同じ source list の `'unsafe-inline'` が効かなくなり svg が動かない (CSP の仕様と dirview の実測)。受け皿の文書には svg を入れないので、`'unsafe-inline'` で受け皿に入り込むスクリプトは無い
- `img-src data: blob:` / `font-src data:`: svg の中に埋めた画像とフォントだけを許す (§7)
- `form-action 'none'`: form の送信を止める。sandbox に `allow-forms` を足した対照で、この指令が送信を止めることを確かめた (sandbox だけでも送信は止まる)
- `webrtc 'block'`: 今の Chromium と WebKit では効かない (F4)。付けても受け皿は動くので、ブラウザが対応した時に塞がるよう入れておく
- `'unsafe-eval'` は入れない (Q5)。`media-src` は書かず、音声と動画は `default-src 'none'` で読めない (Q7)

meta の CSP では `sandbox` と `frame-ancestors` を指定できない。sandbox を付けるのは、webui の iframe の属性と、受け皿の中の iframe の属性の 2 つ (§1 の表の (d) の列)。`frame-ancestors` が無いので、同じ `data:` の URL は誰でも自分のページの frame に入れられるが、受け皿は渡された svg を描くだけで、webui のものを何も持たない。

### 3. 受け皿と webui の約束

受け皿のスクリプト:

- 起動した時、`self.origin === "null"` かつ `parent !== window` でなければ何もしない
- `MessageChannel` を作り、片方の port を `parent.postMessage({ type: "ready" }, "*", [port])` で親に渡す。`ready` は中身を持たず、宛先の window は親に決まっている (受け皿は親の origin を知らないので、targetOrigin は `"*"`)
- 手元の port で `{ type: "render", svg }` (svg は文字) を 1 回だけ受け、中の iframe (`sandbox="allow-scripts"`、`srcdoc`) を作る。2 回目以降は読まない
- window の message は読まない

svg を受け皿に渡せるのは、受け皿が作った port を受け取った文書 (受け皿の親) だけになる。別の窓・別の frame・中の svg が受け皿の window に何を送っても、受け皿は読まない (実測: 同じ origin の別の窓と別の frame から、port 付きの `render` を送り付けても描かれなかった)。

webui:

- 「実行」が選ばれた時に iframe を作る。属性は `sandbox="allow-scripts"`、`referrerpolicy="no-referrer"`、`src` (受け皿の `data:` の URL)、`title`。`allow` は付けない
- window の message のうち、`event.source` がその iframe の window で、`{ type: "ready" }` と port 1 つを持つものだけを受け (形はスキーマで読む。[DR-0038](./DR-0038-json-is-parsed-by-schema.md))、port に svg を書く。書くのは iframe 1 つにつき 1 回で、2 つ目の `ready` は捨てる。受け皿の origin は `"null"` なので、`event.origin` では見分けない
- webui が受け皿から受けるのは `ready` だけ。svg が top に送る message (port を付けた偽の `ready` を含む) は、`event.source` が実行の iframe の window でないので捨てる

webui のこの検査を誤った時に起きるのは、同時に実行している別の svg の port に svg の文字を書くこと (svg の文字が別の svg に読まれる) で、守ること 2〜4 は変わらない。

svg を MessagePort で渡すのは、届く先を「`ready` を送った受け皿の文書」にブラウザが固定するため。window の `postMessage` で渡すと、受け皿の origin が opaque なので targetOrigin に `"*"` を書くしかなく、svg (会話の中身) の届く先を webui の JS の検査で守ることになる。

### 4. webui の文書の frame-src

webui の shell の応答に、次のヘッダを付ける (Terminal の gateway が未設定の環境では `data:` だけ)。

```
Content-Security-Policy: frame-src data: <Terminal の gateway の origin>
```

- 中の svg は、今の Chromium と WebKit では受け皿の frame (webui の文書の子) を遷移させられない。これは仕様の文面の保証でなく、今の実装の振る舞い (「前提」)。このヘッダは、その振る舞いが変わった時にも、受け皿の frame の行き先を `data:` の URL と gateway に限る。`data:` へ遷移した文書は元の CSP を継ぐ (F10)
- frame の遷移を検査するのが親の文書の CSP でも (今の実装)、遷移を始めた文書の CSP でも (仕様の文面)、止まる。後者なら、中の文書が継いだ `frame-src 'none'` が止める
- sandbox の属性を 2 つとも落とした受け皿 (§1 の表の (d) の「両方を落とした時」) でも、このヘッダの下では、受け皿の frame の外部への遷移は止まった (実測)。新しい窓は止まらない
- `'self'` は書かない。書くと、webui の origin の html (CSP を持たない shell) へ遷移できる行き先が残る
- `frame-src` だけの policy は、スクリプトや通信を制限しない (`default-src` を書かない)。webui が今 iframe を使うのは Terminal のタブだけ (`TerminalPanel`)。sandbox origin の HTML の表示 (DR-0030) は別のタブで開く
- gateway の origin は daemon の config (`terminal_gateway_url`) にある。webui の配信は今 config を受け取らないので、shell の応答にヘッダを付ける所に渡す

裁定は Q3。

### 5. 実行に渡す文字

- 実行に渡すのは、webui が `DOMParser` (`image/svg+xml`) で読めて、根が svg の名前空間の `svg` 要素だった文字 (根に `xmlns` が無い時は描画と同じく補う)。そうでない文字は、描画できない svg と同じく実行のタブを押せない
- この確認は、svg でないものに実行の区画を出さないためのもので、守りではない。受け皿は渡された文字を html として読むので、`<foreignObject>` の中の html と、svg の中に書かれた html の要素から後ろは、html として動く (F11)。動く場所は svg のスクリプトと同じ sandbox と CSP の中
- `.svg` のファイルは `fs_read` の中身を渡す。`fs_read` が 512 KiB で切り詰めた時 (`truncated`) は、実行のタブを押せなくして理由を出す (描画は `/fs-serve` の img なので今までどおり)
- svg の大きさに新しい上限は置かない。コードブロックの svg は既に webui が持っている文字で、5 MiB の svg を渡して動いた (実測)

### 6. 止め方

- 選択が実行でなくなった時 (他のタブを選ぶ、図を描いている部品が文書から外れる) に iframe を文書から外す。外すと中のスクリプトは止まる (実測)。外した iframe は使い回さず、もう一度選ぶと作り直す
- 実行の選択は、ブロックごとの state に持ち、保存せず、URL に書かない
- 中のスクリプトが終わらないループに入った時、webui から止められるかはブラウザによる (N3、Q8)

### 7. 外の資源と見え方

svg の中から、外の画像・フォント・CSS・スクリプト・`<use href>` は読めない。断つのは受け皿の CSP で、守ること 2 から決まる。`data:` と `blob:` の画像、`data:` のフォントは読める。

実行の見え方は、スクリプトが何もしなくても描画と同じとは限らない。描画は svg を XML として読み、実行は html として読む。図形・文字・`<style>`・`<foreignObject>` の html・埋めた `data:` の画像は同じ画素になったが、大文字の要素名と、svg の中の html の要素を持つ svg は違う絵になった (F11)。

### 8. 付ける所と切り替え

- `svg` のコードブロック (`SvgFigure`): `MarkdownView` を通る全部。Timeline の吹き出し、Files の markdown のプレビュー、Timeline の中に出すファイルの中身 (`InlineFileViewer`)、本文を書く欄の md のプレビュー (`ComposePreview`)
- `.svg` のファイルのビューア (`FileViewer` の画像の表示): 今は img だけなので、「描画 | ソース | 実行」を足す。ソースは `fs_read` の中身
- mermaid と数式には付けない
- 入れる順: コードブロックを先に入れ、ファイルのビューアは次の版で足す (Q4)。受け皿と §3 の約束は同じものを使う

切り替えは、今の「描画 | ソース」の部品 (`FenceFigure` の `Tabs`、Timeline の小さなタブ) に「実行」を 1 区画足す。新しい見た目は作らない。

- 既定は描画。実行は覚えない (§6)
- 描画できない svg (img の読み込みが失敗するもの) と、§5 の確認を通らない文字は、実行を押せない
- 実行の間は、図の場所に iframe を置き、タブの下に知らせの行を出す。文言は Q1 と Q8 の裁定で決まる。起草時の案: 「スクリプトを実行している。この画面の中身と保存したデータは読めず、HTTP の通信はできない」
- 受け皿の `ready` が来るまでは「準備中…」。時間切れは作らない
- 下地は描画と同じ白

### 9. 図の大きさ

実行の iframe は、切り替える直前の描画の img と同じ幅と高さで置く。中身がそれより大きくなった時は iframe の中でスクロールする。受け皿から高さの知らせは受けない。

切り替えで箱の大きさが変わらないので、DR-0010 §12 の「切り替えで位置を保つ」がそのまま成り立ち、svg が高さを変え続けても Timeline は動かない。webui が受け皿から受ける message も `ready` だけで済む。dirview は中で測った高さを受け皿経由で知らせて iframe を伸ばす。違いは Q6。

### 10. 版をまたぐ前提

「前提」のうちブラウザの振る舞いに依る行は、版が上がると変わりうる。e2e の試験 (§11) で、Chromium と WebKit の今の版の振る舞いとして固定する。試験が落ちた時は、変わった振る舞いを findings に足し、この DR の前提を見直す。

今の版でブラウザごとに違う所:

| 項目 | Chromium 159 | WebKit 27.2 |
|---|---|---|
| WebRTC の STUN | 出る | 出る |
| `<link rel="preconnect">` の接続 | 確かめられなかった | 出る |
| sandbox の中の `history.back()` / `history.go()` | top は動かない | top の履歴が戻る |
| svg の中の終わらないループ | headless shell では webui が固まり、channel `chromium` では固まらず iframe を外せる | webui が固まる |
| sandbox だけの時の webui のサーバへの要求 | cookie 無し。GET の画像と no-cors の fetch は `Origin` ヘッダ無し | cookie 付き。GET は同じく `Origin` ヘッダ無しで、sendBeacon の `Origin` が webui の origin になる場合がある |
| immutable の応答の CSP を変えた後 | どの開き方でも cache の前の CSP が効く | 同じタブで開き直すと cache の前の CSP が効く |

### 11. 検証の計画

e2e (`packages/webui/e2e/`、Chromium と WebKit、部品のカタログのページ) で確かめること。要求が届いたかは、試験が立てた記録するだけのサーバの記録で見る (ブラウザの request のイベントには CSP で止められた要求も出る)。

- 実行を選ぶと、svg の `<script>`・イベント属性・アニメーションが動く
- 中からの `fetch`・XHR・WebSocket・画像・`sendBeacon` が、記録のサーバにも試験用の daemon にも届かない
- 中から自分の frame を遷移させても (`location`、meta refresh、リンク、`window.open(url, "_self")`)、遷移先の要求が届かない
- 中から `parent.location` と `top.location` に代入すると例外になり、受け皿の frame と top は動かない (前提の固定)
- 中から `localStorage`・`top.document` に触れると例外になる
- `<foreignObject>` の中の html のスクリプトからも、要求が届かず、storage に触れない
- 実行のタブを戻すと iframe が文書から無くなり、中の定期の message が止まる
- 根が svg でない文字と、描画できない svg は、実行のタブを押せない
- `.svg` のファイルのビューア (`FileViewer` の画像の分岐) に「描画 | ソース | 実行」が出て、512 KiB を超えて `fs_read` が切り詰めたファイルでは、実行のタブを押せず理由が出る (Q4 でファイルを入れる版)

配信の unit test:

- webui の shell の応答に §4 のヘッダがあり、gateway を設定した時はその origin が入る

「持たない」「増やさない」「変えない」を壊す変更を止める試験の観点:

- 実行を選ぶまで、文書に実行の iframe が無い
- 再読み込みの後は描画に戻る。localStorage と URL に実行の選択が無い
- mermaid と数式の箱に実行の区画が無い
- 受け皿の文書の中に svg の要素が無い (svg は中の iframe にだけある。1 段にしない)
- 実行の iframe の `src` は `data:` の URL で、実行を選んでも webui のサーバへの要求が増えない (受け皿を配る応答を足さない)
- webui の iframe の `sandbox` 属性を外して受け皿を開いても、受け皿の文書からも中の svg からも webui の storage と DOM に触れず、中の svg は新しい窓を開けず、top と受け皿の frame を遷移させられない (`data:` の文書の origin と、中の iframe の sandbox が守っていることの固定)
- webui が作る実行の iframe に `sandbox="allow-scripts"` があり、受け皿の中の文書から `window.open` が `null` を返す (属性 2 つがどちらも付いていることの固定)
- webui は、`ready` 以外の message、`event.source` が実行の iframe でない message、同じ iframe からの 2 つ目の `ready` で何もしない
- 2 つの svg を同時に実行した時、それぞれの受け皿に自分の svg だけが届く
- 同じ origin の別の frame から受け皿の window へ `render` を送り付けても、描かれない
- Terminal のタブの iframe が、§4 のヘッダの下で今までどおり開く
- protocol の op と daemon の HTTP の振り分け先に追加が無い

N1・N2・N3 は、今は止められないので試験で固定しない。

## 未決

各問いは、原意図、選択肢ごとの意味の違い、起草時の推しの順に書く。

### Q1. 止められない経路 (N1・N2) と、目的の文

- 原意図: 依頼の 5 つの 2 (外部にも ccmsg のサーバにも要求が出ない) と 4 (制限の外に出られない)。依頼の言い方では「外部にも ccmsg のサーバにも通信できない sandbox」
- 実測 (F4、F5):
  - WebRTC: 両ブラウザで、svg のスクリプトが指定した宛先に STUN の UDP が届く。運べるデータの量は確かめていない (宛先のホスト名と port は svg が選べる)
  - WebKit の preconnect: svg が指定した宛先に TCP の接続が届く
  - WebKit の履歴: svg が top の履歴を戻せる。webui を開く前のページまで戻れた
  - どれも受け皿の置き場によらない。webui の DOM・storage・cookie は読めない (F3) ので、運び出せるのは svg 自身に書かれた文字と、sandbox の中から見える環境の値
- 選択肢と、選んだ時の文:

| | 目的の文 | 守ること 2 | 守ること 4 | 守れないこと |
|---|---|---|---|---|
| (a) 入れて、文を狭める | 上の「目的」のとおり (HTTP と WebSocket で話せない、svg の選んだ行き先へ移せない) | HTTP と WebSocket の要求が出ない | svg の選んだ URL へ遷移させられない | N1・N2 を書く。実行の知らせの行にも書く |
| (b) 入れて、実行のたびに確認を挟む | (a) と同じ文に、「人は、止められない経路を読んでから動かす」が加わる | (a) と同じ | (a) と同じ | (a) と同じ。確認のボタンの文に書く |
| (c) 入れるが、WebKit では実行の区画を出さない | (a) と同じ文で、対象が Chromium だけになる | (a) と同じ | (a) に加えて、top の履歴も動かせない (Chromium では止まる) | N1 のうち WebRTC だけ |
| (d) 入れない | 依頼のまま (文は変えない)。svg のスクリプトは動かない | — | — | 無い |

- 意味の違い:
  - (a): 応答に写った第三者の入力が svg に文字を埋め、人が実行を選ぶと、その文字が N1 の経路で外へ運ばれうる。markdown のリンクを人が押した時に URL の文字が外へ出るのと同じ線 (描いた瞬間には到達せず、人の操作で到達する。DR-0010 §5) の上にあるが、リンクと違って行き先が見えない
  - (b): 知らずに押すことは減る。実行のたびに 1 操作増え、読まずに押す操作になりやすい
  - (c): iPad の Safari で実行が使えなくなる。ブラウザを見分ける処理が要る
  - (d): 守れないことは無い。動く図は見られないまま
- 推し: (a)。webui の中身は読まれないので、運び出されうるのは人が実行を選んだ svg に既に書かれていた文字に限られる。知らせの行は事実どおりに書く (「外部と通信できない」とは書かない)
- dirview の受け皿も同じ CSP と同じ 2 段で、知らせの文は「外部やこのサーバとは通信できない」。dirview では試していないが、同じ経路が残るはず。揃えるかは dirview の側で決める

### Q2. 受け皿の置き場

- 原意図: ccmsg は sandbox origin を持つので、受け皿をそちらで配るかを決める (issue)。「増やしたくないもの」の 3 つを増やさない
- 選択肢 (§1 の表):
  - (a) webui の origin の URL (`/assets` の html): 「daemon が配る新しい種類の応答」が 1 つ増える。守りは iframe の属性と応答ヘッダの 2 つ。CSP を応答ヘッダで渡すので、URL の版に応答ヘッダを含めるか、immutable にしない (F9)。webui の文書の CSP によらない
  - (b) sandbox origin の URL: 同じく応答が 1 つ増える (grant に結びつかない)。sandbox origin を設定した環境でしか実行を使えない。コードブロックの svg はファイルでないので、今の grant の配信 (ファイルを配る) には載らない
  - (c) webui が作る srcdoc: 応答は増えない。iframe の属性を落とすと webui の origin で動く
  - (d) `data:` の URL: 応答は増えず、webui の iframe の属性を落としても opaque origin。CSP は meta だけで、sandbox は属性 2 つに置く。webui の文書に `script-src` を持つ CSP を入れると動かなくなる
- (a) と (b) を両方持つ形、(d) を既定にして (a) を控えに持つ形は取らない。svg にできることは同じで (F1)、試験と守りの経路だけが増える
- 3 つの「増やしたくないもの」を全部保てる選択肢は無い。どれを譲るかの裁定になる:
  - (a)・(b) を選ぶ: 「daemon が配る新しい種類の応答」を 1 つ増やす。守りは応答ヘッダにあり、webui の JS がどの属性を落としても破れない (実測)
  - (d) を選ぶ: 「守りを webui の JS の注意深さに頼る所」が残る。sandbox の属性 2 つのうち 1 つが付いていれば破れず、2 つとも落とすと守ること 4 が破れる (実測)。守ること 2 と 3 は、その時も CSP と opaque origin が守る
  - (c) を選ぶ: 属性 1 つを落とすと webui の origin で動く
- 推し: (d)。応答を増やさず、属性 1 つの誤りでは破れない。2 つとも落とす変更は、試験 (中の文書から新しい窓を開けないこと、webui の iframe に `sandbox` があること) で止める。応答ヘッダで守る形を優先するなら (a) で、その時は受け皿の URL の版に応答ヘッダを含める

### Q3. webui の文書に、frame の行き先を縛る CSP を入れるか

- 原意図: 守りを webui の JS の注意深さに頼らず、ブラウザの仕組みで持つ。sandbox の中から祖先の frame を遷移させられないことは、仕様の文面に無く、今のブラウザの振る舞いに依っている (「前提」)。試験で固定しても、変わったことに後から気づけるだけで、守ること 4 を仕組みで保つことにはならない
- 選択肢:
  - (a) 入れない。前提を e2e で固定するだけ: 前提が崩れた版では、試験が落ちて気づくまでの間、中の svg が受け皿の frame を外部へ遷移させられる (webui の文書に CSP が無いので)
  - (b) `frame-src data: <gateway の origin>` (§4): 前提が崩れても、受け皿の frame の行き先は `data:` (元の CSP を継ぐ) と gateway だけ。sandbox の属性を 2 つとも落とした時の、受け皿の frame の外部への遷移も止まる (実測)。webui の shell の応答にヘッダが 1 つ増え、gateway の origin を配信に渡す。webui が iframe を足す時は、このヘッダにも足す
  - (c) `frame-src 'self' <gateway の origin>` (Q2 で受け皿を webui の origin の URL にした時は `'self'` が要る): 外部へは出られないが、webui の origin の html (CSP を持たない shell) へ遷移できる。遷移先は sandbox の中の opaque origin で動き、daemon へ `Origin` の無い GET を出せる
  - (d) (c) の `'self'` を受け皿の URL に絞る: path まで書いた source が遷移の検査でどう比べられるかを確かめていない
- 推し: (b)。Q2 を (d) にすると `'self'` が要らず、shell への遷移も残らない。Q2 が (a) になった時は (c) か (d) になる

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
  - (b) `'unsafe-eval'` を足す: 動く範囲が広がる。通信と遷移は他の指令と sandbox で止まっているので、守ること 2〜4 は変わらないはず (`eval` を許した形は実測していない)
- 推し: (a)。要る svg が出てから足す

### Q6. 実行の図の高さ

- 原意図: 切り替えで見ている位置を見失わない (DR-0010 §12)。dirview と揃える (issue)
- 選択肢:
  - (a) 描画の img と同じ大きさで固定し、はみ出す分は iframe の中でスクロール (§9): 切り替えでも実行中も箱が動かない。スクリプトで大きくなる図は、箱の中でスクロールして見る
  - (b) 中で測った高さを受け皿経由で知らせて iframe を伸ばす (dirview の形): 大きくなる図が全部見える。svg は好きな高さを知らせられるので上限 (dirview は 10000px) で丸める。高さが変わるたびに Timeline の位置を保ち直す。webui が受ける message が 1 種類増える
- 推し: (a)

### Q7. 軽い確認 (推しのまま進めてよいか)

- svg は MessagePort で渡す (§3)。window の `postMessage` で svg を送らない
- `webrtc 'block'` を、効かない今から CSP に入れておく (§2)
- `media-src` は書かない (dirview は `data: blob:` を許す。許した時に何が読めるかを確かめていないので外す。svg に埋めた音声と動画は鳴らない・映らない)
- 描画できない svg と、根が svg でない文字は、実行を押せない (§5)
- 実行の知らせの行は常に出す (畳まない)

### Q8. 実行している svg が webui を固めること (N3)

- 原意図: 依頼の 5 つは、webui の DOM と storage に触れないこと (3) までを挙げ、webui を固めることには触れていない。固まると、見ている人は webui を使えなくなる
- 実測 (F8) と一次資料:
  - WebKit と Chromium の headless shell では、svg の終わらないループの間、webui の JS が走らない。webui が先に予約した「iframe を外す」も走らないので、webui の側から止められない。5 秒で終わるループなら、終わった後に元に戻る
  - channel `chromium` の Chromium では、ループの間も webui は動き、iframe を外せた
  - 受け皿を webui と別の site から配っても、WebKit と headless shell では固まった
  - 実行の frame を別のプロセスで動かすようページの側から決める仕組みは見つけていない。HTML の仕様は、終わらないスクリプトの打ち切りをブラウザの裁量に置く ("User agents may impose resource limitations on scripts")。svg は DOM を使うので Worker には入れられない
- 選択肢:
  - (a) 「守れないこと」に置く (N3): 固まった時は人が再読み込みする。実行は覚えないので、開き直せば描画に戻る
  - (b) 実行を別のタブか別の窓で開く: 別のプロセスになるかはブラウザ次第で、確かめていない。図を本文の中で見られない
  - (c) 入れない: 固まることは無い。動く図は見られないまま
- 推し: (a)。知らせの行に「固まった時は再読み込み」と書くかは Q1 の文言と合わせて決める

## 要る実測

- M1: 本物の Safari (macOS、iPad) と Chrome で、§1 の (d) の受け皿に findings と同じ試しをする。N1・N2・N3 が同じか、Chromium の preconnect が届くか
- M2: WebKit で、人の操作 (user activation) を伴う top の遷移・新しい窓・ダウンロードが止まるか (findings の実測の間は画面が消えていて、WebKit のクリックが届かなかった)
- M3: WebRTC で運べるデータの量 (TURN の username、宛先のホスト名への埋め込み) と、TCP の TURN で daemon の port に接続できるか。Q1
- M4: 名前解決だけの経路 (`dns-prefetch`、WebRTC や preconnect の宛先のホスト名の解決) で、問い合わせが外へ出るか。観測の手段を用意していない。Q1
- M5: 途中の proxy が webui の shell の応答の `Content-Security-Policy` を落とす・書き換える場合。§4 の守りが消える。受け皿の CSP は webui の bundle の中の文字で、応答ヘッダとしては proxy を通らない
- M6: path まで書いた `frame-src` の source が、frame の遷移でどう比べられるか。Q3 の (d)
- M7: 2 つ以上の svg を同時に実行した時に、互いの文書に触れられないこと (別々の opaque origin のはずだが、試していない)
- M8: `<foreignObject>` の中の html と `data:` / `blob:` の組み合わせのうち、試していないもの (`blob:` の Worker、`data:` のスクリプトの `import()`、CSS の `url(data:…)` の中の svg のスクリプト)

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| 1 段 (svg を受け皿の文書に入れる) | svg が自分の frame を遷移させて受け皿の CSP の外へ出られる (F2)。webui の文書に `frame-src` を置けば外部へは出られないが、守りが webui の文書の CSP だけになる |
| sandbox の iframe だけで、CSP を付けない | 外部にも webui のサーバにも要求が出る。daemon の `Origin` の検査を通る要求が中から出せる (F7) |
| svg を `image/svg+xml` の文書として、中の iframe に `data:` の URL で入れる (XML として読ませ、描画と見え方を揃える) | 受け皿の CSP の `frame-src` に `data:` を許すことになり、中の文書が `data:` の文書へ遷移できる (遷移先は CSP を継ぐ)。svg の文書に入れたスクリプトの読まれ方を確かめていない |
| svg を webui の文書に直に入れる (inline の `<svg>`) | スクリプトが webui の origin で動く (DR-0010 §12 が img にした理由) |
| 中の文書の先頭で `RTCPeerConnection` を消す | 入れ子の srcdoc の iframe は CSP の下でも作れてスクリプトが動き (実測)、その文書は消す前の `RTCPeerConnection` を持つ。塞ぐには要素の作り方を全部包むことになり、守りが JS の注意深さになる |
| 受け皿の本体のスクリプトをハッシュで許す | 同じ source list の `'unsafe-inline'` が効かなくなり、svg が動かない |
| 実行を別のタブで開く (DR-0030 の HTML の表示と同じ形) | 図を本文の中で見られない。WebRTC は残る。タブが別なら webui の履歴には触れず、固まりもしないはずだが、確かめていない |
| 実行の選択を覚える (mermaid の描画 / ソースのように) | 守ること 5。開いただけでスクリプトが動く |
| svg を window の `postMessage` で受け皿に渡す | 受け皿の origin が opaque で targetOrigin を書けない (§3) |
| svg を受け皿の URL に入れて渡す | 受け皿が svg ごとに変わり、定数でなくなる。`data:` の URL の中の svg は受け皿の文書の一部になり、1 段と同じになる |
| 外の画像やフォントを読めるようにする | 守ること 2。読む時に外へ要求が出る |

## Consequences

- daemon が配る応答の種類は増えない。webui の shell の応答に `Content-Security-Policy: frame-src …` が付く。protocol と op は変わらない
- 「守れないこと」が 3 つ残る (N1・N2・N3)。依頼の「外部にも ccmsg のサーバにも通信できない」は、HTTP と WebSocket に限って成り立つ (Q1)
- WebKit では、実行した svg が webui の履歴を戻せ、開いていた画面から離れさせられる (N2)
- svg の終わらないループで、WebKit では webui のタブが固まる (N3)。実行は覚えないので、再読み込みすれば描画に戻る
- webui の文書に `script-src` を持つ CSP を入れる時は、受け皿の置き場を決め直す (Q2)
- webui が iframe を足す時は、shell の `frame-src` にも足す。足し忘れると、その iframe は読み込まれない
- sandbox の属性 (webui の iframe と、受け皿の中の iframe) を 2 つとも落とす変更で、守ること 4 が破れる。1 つなら破れない (Q2)
- 実行の見え方は、描画と同じとは限らない (§7)
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
