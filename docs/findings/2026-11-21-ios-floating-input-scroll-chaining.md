# iOS で浮いた入力欄の上のスワイプがページごと動かす: キーボード表示中の文書の動きと、あふれていない textarea の連鎖

- Date: 2026-11-21
- 対象: ccmsg v0.301.0 の webui (`.session-input-panel` = セッション宛の入力の FAB のパネル、`ModalDialog` = GLOBALS の userscript の edit 等の dialog、`html` / `#app`)。計測は playwright 1.66 の WebKit (Safari 27.2 相当、headless)
- 動機: kawaz の iPad の Safari で、ソフトウェアキーボードが出ている時に FAB のパネルの textarea の中で上へスワイプすると、textarea の中身がスクロールできない (行が少ない) 時はページ全体が指について動き (上端の `#topbar` が画面外へ消え、全体が約 58px 上にずれた)、textarea の caret が文字と関係ない位置に描かれた。textarea の中がスクロールできる時は textarea の中のスクロールになった。userscript の edit の dialog でも同じ
- 方法: 隔離 daemon に試験用の config dir (`sleep` の pid の `sessions/<pid>.json` と 30 往復の transcript) を読ませ、`/s/<sid>` を WebKit で開いて測った。大きさは iPad 11 インチの縦 (834x1194) と横 (1194x834)、iPhone (430x932) を `isMobile` + `hasTouch` + DPR 2 で、加えて横の大きさのデスクトップ (wheel を使うため)。直す前は作業前の commit の daemon、直した後は作業コピーの daemon で同じ fixture を読ませた

## 原因 (どの層で何が起きていたか)

1. 文書 (document) 自体はあふれていない。キーボードの無い状態では `document.scrollingElement` の `scrollHeight` と `clientHeight` はどの大きさでも等しく (下の表)、`window.scrollTo(0, 200)` しても `scrollY` は 0 のまま。`#app` の `100dvh` と safe-area の padding (border-box) は文書を溢れさせていない。統括の仮説の「padding 等で document の高さが viewport を超えている」は headless では否定 (safe-area の inset は headless で 0 なので、実機の safe-area の分は未検証。ただし box-sizing: border-box なので padding は高さを増やさない)
2. iOS では、ソフトウェアキーボードが出て visual viewport が layout viewport より小さくなると、WebKit は `overflow: hidden` を無視して文書全体を動かせるようにする (WebKit bug 240860、Status NEW。Simon Fraser の引用: 拡大時に閉じ込められないため visual viewport が小さい時はスクロールを許している、理想は layout viewport の中だけを動かせること。Firefox と Chromium はこの時も止める)。iOS 26 でも同じ症状の報告がある (bug 311821: body の `getBoundingClientRect().top` が -84px なのに scrollTop は 0、`window.scrollTo(0, 0)` は効かない)。つまりキーボードが出ている間は「文書があふれていないから動かない」が成り立たない
3. textarea の中身があふれていない時、その上の縦のスワイプを受ける箱が層の中に無く、スクロールは連鎖して 2 の動かせる文書へ渡る。textarea には `overscroll-behavior` の縦の指定が無かった (`#layout *` の横の contain だけ。算出値 `contain/auto`)。そして仕様 (CSS Overscroll Behavior 1) では `overscroll-behavior` は中身があふれていないスクロールコンテナにも効くが、WebKit はあふれている箱でしか効かせない (bug 176454 comment 62。Blink の Intent to Ship "Respect overscroll-behavior on non-scrollable scroll containers" は、全ブラウザがこの扱いだと書く)。だから CSS で contain を付けても、この場面では iOS で止まらない
4. `touch-action` は効く範囲が「タッチした要素から最寄りのスクロールコンテナまで」で、textarea は自身が `overflow-y: auto` のスクロールコンテナなので、パネルの `touch-action: none` は textarea の上のタッチに効かない (パネルの CSS が textarea を `touch-action: auto` に戻してもいる)。textarea の中身があふれているかで touch-action を切り替える手は CSS に無い
5. caret のずれ: 入力にフォーカスしたまま、fixed の層の下で visual viewport / 文書が動いた時に WebKit が caret の位置を古い layout viewport で計算する既知の描画のずれ (bug 176896 は iOS 11 で直った同型の不具合。今回の形が同じ原因かは実機で未確認)。2 の動きを止めれば出る場面が無くなる見込み

## 直したこと

- `html { overflow: hidden; overscroll-behavior: none; }` (app.css): 文書がスクロールしないことを CSS で宣言する。何かがはみ出しても文書にスクロールを生やさず、あふれていない区画の上のスワイプでページ全体が跳ねない (WebKit は `overscroll-behavior: none` を、スクロールしない文書の rubber band を止めるのにも効かせる: WebKit commit 487c9df、bug 244232)。キーボード表示中の動き (原因 2) はこれでは止まらない
- `.session-input-panel, .session-input-panel *, .modal-dialog, .modal-dialog * { overscroll-behavior: contain; }` (app.css): 浮いた層の中のスクロール領域が端まで行っても層の外へ連鎖させない。中身があふれている textarea・dialog の本文が端に着いた後のスワイプはこれで止まる (iOS は bug 233788 で `overscroll-behavior` を実装済み、あふれている箱では効く)
- `useContainTouchPan` (`packages/webui/src/client/useContainTouchPan.ts`) を入力パネル (`SessionInputComposer`、開いている間) と `ModalDialog` に付けた: 層の上で始まった 1 本指のスワイプの最初の touchmove で、タッチした要素から層までに「その向きへまだ動ける、利用者がスクロールできる箱」があるかを見て、無ければそのジェスチャの touchmove の既定動作を止める。ある時・2 本指 (ピンチ)・層の外のタッチには触れない。最初の判定をジェスチャの終わりまで保つ (ブラウザはスクロールを始めた後は touchmove を cancel させない)
  - JS で止める理由: 原因 3・4 のとおり、iOS の WebKit で「あふれていない textarea の上のスワイプ」を層の中で止める CSS が無い。位置やスクロール量を JS で書き戻す手 (body を fixed にして scroll 位置を戻す類) は採らず、既定動作の取り消しだけにした (Design rationale はファイル冒頭)

## 前後の表

文書 (キーボード無し、どの大きさでも同じ):

| 項目 | 直す前 | 直した後 |
|---|---|---|
| `scrollHeight` / `clientHeight` (834x1194) | 1194 / 1194 | 1194 / 1194 |
| `scrollHeight` / `clientHeight` (1194x834) | 834 / 834 | 834 / 834 |
| `scrollHeight` / `clientHeight` (430x932) | 932 / 932 | 932 / 932 |
| `window.scrollTo(0, 200)` 後の `scrollY` | 0 | 0 |
| `html` の `overflow-y` | visible | hidden |
| `html` の `overscroll-behavior` (x/y) | auto/auto | none/none |

浮いた層 (4 つの大きさで同じ値):

| 項目 | 直す前 | 直した後 |
|---|---|---|
| パネル `.session-input-panel` の `overscroll-behavior` | contain/auto | contain/contain |
| パネルの textarea の `overscroll-behavior` | contain/auto | contain/contain |
| `dialog.modal-dialog` の `overscroll-behavior` | contain/auto | contain/contain |
| userscript の textarea の `overscroll-behavior` | contain/auto | contain/contain |
| パネルの textarea (中身があふれていない、110/110) の上で指を 30px 上へ: touchmove が止められたか | いいえ | はい |
| パネルの textarea (40 行、733/110、先頭) の上で同じ | いいえ | いいえ (textarea がスクロールする) |
| userscript の textarea (雛形のまま、574/574 等) の上で同じ | いいえ | はい |
| userscript の textarea (80 行、1453/574、先頭) の上で同じ | いいえ | いいえ |
| デスクトップの wheel をパネルの textarea の上で回した後の `scrollY` / `visualViewport.offsetTop` | 0 / 0 | 0 / 0 |

- touchmove の判定は、WebKit の中で `document.createTouch` / `createTouchList` から作った TouchEvent を textarea に送り、`defaultPrevented` を読んだ (合成のイベントは何もスクロールさせないので、ブラウザがどこを動かすかではなく webui の判定を実エンジンの大きさで確かめたもの)
- 直した後も TL (`.timeline-view`) は wheel で 3110 → 2710 とスクロールし、文書の `scrollY` は 0 のまま
- headless ではキーボードが出ないので、visual viewport が縮んだ状態 (原因 2) は再現できない。iPad の実機で見る手順は下

## viewport の meta (`interactive-widget`)

- `interactive-widget=resizes-content` は、キーボードが出た時に layout viewport (初期包含ブロック) ごと縮める指定で、効けば visual viewport と layout viewport の差が無くなり、原因 2 の動き自体が起きなくなる (`100dvh` の `#app` と fixed の層がキーボードの上に収まる)。Chrome 108+ / Firefox 132+ が対応
- Safari: WebKit bug 259770 (RESOLVED FIXED) の comment 11 (Apple の Tim Nguyen、2026-11-06) が「実装は iOS 27.3 beta、27.2 には無い」。Safari Technology Preview 255 (webkit.org、2026-10-22) に `resizes-content` の `innerHeight` の修正がある。27.3 beta でも `resizes-content` で入力がキーボードに隠れる報告がある (同 bug comment 13)
- 公開版の Safari が対応していないので足していない。`interactive-widget` 選定判断基準日: 2026-11-21。Safari 27.3 が出たら、`resizes-content` を足して iPad で原因 2 が消えるかを確かめる価値がある

## iPad の実機での確かめ方

1. Safari で webui を開き直す (古い CSS / JS が残らないよう、topbar の再読み込みか、アドレスバーからの再読み込み)
2. セッションを開き、右下の + (FAB) を押してパネルを開く。textarea をタップしてソフトウェアキーボードを出す。textarea は 1〜2 行だけにする
3. textarea の中で上へ、下へスワイプする
   - 直っていれば: ページは動かない (`#topbar` は画面の上に留まる)。caret は文字の位置に描かれたまま
   - 直っていなければ: ページ全体が指について上下し、`#topbar` が画面外へ消える。caret が文字から離れる
4. textarea に 20 行ほど書いて中がスクロールできるようにし、同じくスワイプする
   - 直っていれば: textarea の中がスクロールし、先頭・末尾に着いた後さらにスワイプしてもページは動かない
5. パネルの中のボタン (送信等) や宛先の select の上から始めたスワイプでもページが動かないこと
6. パネルの枠 (textarea の外の余白) を掴んでドラッグし、パネルが動くこと (D&D が壊れていないこと)。キーボードが出ている間はキーボードの上へ動かせること
7. textarea の中で長押しして caret を動かす・文字を選ぶ・選択のつまみを動かすことができること (touchmove を止める判定がこれらを邪魔していないこと)
8. GLOBALS を開き、userscript の edit で dialog を開く。textarea をタップしてキーボードを出し、2〜7 と同じことをする (雛形のままなら中はスクロールしない)
9. キーボードを閉じた状態で、topbar やサイドバーの見出しなど、スクロールしない所を上下にスワイプする
   - 直っていれば: ページ全体が跳ねない (rubber band しない)

## 残ること

- キーボードが出ている間、パネルの下側 (送信のボタン等) がキーボードに隠れる位置にある時、これまではパネルの上のスワイプでページを動かして見えるようにできた。直した後はパネルの上のスワイプではページは動かないので、パネルを掴んでキーボードの上へ動かすか、TL の端でのスワイプ (TL から連鎖した分はこれまでどおり文書を動かす) で見る。層の外 (TL・サイドバー等) で始めたスワイプは今回止めていない
- `overscroll-behavior: none` を文書に付けたので、ブラウザのページの pull-to-refresh (Safari / Chrome の引っ張って再読み込み) が効かなくなりうる (未検証)。再読み込みは topbar の再読み込みのボタンで行う
- 原因 2・5 の実機での裏取り (キーボード表示中に `visualViewport.offsetTop` が動くこと、caret のずれがこの動きで出ること) は headless でできないので未検証
