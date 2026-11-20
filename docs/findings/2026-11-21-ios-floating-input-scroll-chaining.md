# iOS でキーボード表示中、浮いた入力欄の上のスワイプがページごと動かす: 動いているのは見える範囲で、#app をそこに合わせる

- Date: 2026-11-21
- 対象: ccmsg v0.302.0 の webui (`html` / `#app`、`.session-input-panel` = セッション宛の入力の FAB のパネル、`ModalDialog` = GLOBALS の userscript の edit 等の dialog、`useDraggable`)。計測は playwright 1.66 の WebKit (Safari 27.2 相当) と Chromium、どちらも headless
- 動機: kawaz の iPad の Safari で、ソフトウェアキーボードが出ている時に FAB のパネルの textarea の中で上へスワイプすると、ページ全体が指について動き (上端の `#topbar` が画面外へ消える)、textarea の caret が文字と関係ない位置に描かれた。userscript の edit の dialog でも同じ。v0.302.0 はこれを touchmove の既定動作を止める JS で抑えたが、textarea の範囲選択のハンドル (選択の両端の丸) が動かせなくなった (kawaz の実機確認)
- 方法: 隔離 daemon に試験用の config dir (`sleep` の pid の `sessions/<pid>.json` と 30 往復の transcript) を読ませ、`/s/<sid>` を開いて測った。直す前は main (v0.302.0) から作った jj workspace の daemon、直した後は作業コピーの daemon で同じ fixture を読ませた。大きさは iPad 11 インチの縦 (834x1194) と横 (1194x834)、iPhone (430x932) を `isMobile` + `hasTouch` + DPR 2 で、加えて横の大きさのデスクトップ。キーボードは headless で出せないので、`addInitScript` で `window.visualViewport` を差し替えた偽物 (高さと `offsetTop` を試験から動かし、`resize` / `scroll` を送る) でキーボードが出た状態を作り、配置は実エンジンのレイアウトで測った

## 原因 (どの層で何が起きていたか)

1. 動いているのは背景の要素ではなく、見える範囲 (visual viewport) そのもの。iOS の Safari はキーボードが出ても layout viewport (初期包含ブロック。`100dvh` と `position: fixed` の基準) を縮めず、visual viewport だけを縮めて、その見える範囲を文書の中で動かせるようにする。dialog の modal (外を inert にする) は外の要素がイベントに反応するのを止めるだけで、viewport の移動は止めない
2. 動かせる幅は「初期包含ブロックの高さ − 見える範囲の高さ」で、文書の中身の高さや `overflow: hidden` では消えない。WebKit bug 240860 (NEW) で Simon Fraser が「visual viewport が小さい時はスクロールを許している (拡大時に閉じ込められないため)、ただし文書全体へ許してしまっている。理想は layout viewport の中だけ」と書く。外部の観測 (iOS 26.5 Simulator、leaperone/vibeface PR #95 の probe) では、キーボード表示で `visualViewport.height=377 offsetTop=337 scrollY=337`、アプリの高さを 377 に縮めても文書の高さは初期包含ブロックの 714 のままで、高さだけ合わせた版は「アプリが文書の上端に残り、見える範囲には空白」だった。meta/astryx issue #10718 (iOS 26.2 Simulator) は `innerHeight + offsetTop` が初期包含ブロックの 714 のまま保たれると書く
3. iOS 27 でも、キーボード表示中は「スクロールできない所から始めたスワイプ」が文書全体をパンする (WebKit bug 332417、2026-11-19、NEW: `html, body { overflow: hidden }`・中身があふれていない文書で、あふれていない textarea・スクロール範囲の無い箱・toolbar の上から始めたスワイプ。script で戻すと指に追従するパンと奪い合って揺れる)
4. 浮いた層の上のスワイプを層の中で止める CSS は無い。`overscroll-behavior` は仕様では中身があふれていないスクロールコンテナにも効くが、WebKit はあふれている箱でしか効かせない (bug 176454 comment 62)。`touch-action` は効く範囲がタッチした要素から最寄りのスクロールコンテナまでで、textarea は自身がスクロールコンテナなので、中身があふれているかで切り替えられない
5. 浮いた層 (FAB・パネル) は `position: fixed` で layout viewport の下端に置かれていたので、キーボードが出るとその下に隠れた。見える範囲が動けば、層は見える範囲に対して動く

## v0.302.0 の修正で外れた所

- touchmove の既定動作を止める (`useContainTouchPan`) のは、動き (原因 1) ではなくジェスチャを消す手で、textarea の範囲選択のハンドルのドラッグも同じ touchmove で動くので一緒に止まった。外した
- 「原因 2 の動きを止めれば caret のずれも出なくなる」は、動きを止める手段が JS のジェスチャ取り消ししか無いという前提に立っていた。見える範囲が動くこと自体は止めず、画面の方を見える範囲に置けば、動いても画面と見える範囲がずれない
- 残したもの: `html { overflow: hidden; overscroll-behavior: none }` (キーボードの無い時の文書のスクロールと rubber band を止める) と、浮いた層の子孫の `overscroll-behavior: contain` (中身があふれている textarea・dialog の本文が端まで行った後の連鎖を止める)。どちらもジェスチャを取り消さないので選択の邪魔をしない

## 直したこと (構造)

- 画面を見える範囲に置く (`packages/webui/src/client/visible-area.ts`、`App` が `useVisibleAreaFit` で購読): `visualViewport` の `resize` / `scroll` を外部との同期として Effect で購読し、キーボードが出ている間 (拡大していないのに、見える範囲が初期包含ブロックより狭いか下へずれている間) だけ、:root に `--visible-top` (= `offsetTop`)・`--visible-height` (= 見える範囲の高さ)・`--visible-bottom` (= キーボードに覆われている高さ、初期包含ブロック基準) を書く。キーボードが無い時・ピンチで拡大している時は書かず (書いていれば外し)、CSS の既定のまま
- `#app` は `position: fixed; top: var(--visible-top, 0px); height: var(--visible-height, 100dvh)`。見える範囲の位置と高さの両方に追従する (高さだけでは原因 2 の空白になる)
- `#app` に `contain: layout`: 中の `position: fixed` の要素 (FAB・パネル・TL のつまみ・画像の lightbox・メッセージのメニュー) の基準が #app になり、キーボードが出れば見える範囲 (= キーボードの上) に置かれる。キーボードが無い時は #app が画面と同じ箱なので配置は変わらない
- dialog は top layer なので #app の外 (layout viewport 基準)。`.modal-dialog { inset-block: var(--visible-top, 0px) var(--visible-bottom, 0px) }` と `max-height` / 狭い幅の `height` を `--visible-height` で見える範囲に合わせる。広い幅では見える範囲の真ん中、狭い幅では見える範囲いっぱい
- `useDraggable`: 位置を置き場の箱 (fixed の要素の `offsetParent`、ここでは #app) からの距離で読み、箱の中に clamp する (visual viewport の offset を足す計算をやめた。箱が見える範囲そのものになったので、足すと二重になる)。動かした後に箱が縮んだら (キーボードが出た)、ResizeObserver で位置を箱の中へ寄せ直す。動かしていない間は CSS の right/bottom で箱に付いて動く
- `window.scrollTo(0, 0)` で見える範囲を戻す手は採らない: 原因 3 の報告どおり、指で動かしている最中のパンと奪い合って揺れる。iOS がフォーカスした入力欄を見せるために見える範囲を下へずらした後 (`offsetTop > 0`) も、#app がそこへ付いて行くので戻す必要が無い

## 前後の表 (headless)

キーボード無し。直す前 (main) と直した後で、WebKit・Chromium の 4 つの大きさすべてで同じ値 (配置は client rect、小数 1 桁):

| 項目 | 834x1194 | 1194x834 | 430x932 |
|---|---|---|---|
| `#app` の上端 / 高さ | 0 / 1194 | 0 / 834 | 0 / 932 |
| 文書の `scrollHeight` / `clientHeight` | 1194 / 1194 | 834 / 834 | 932 / 932 |
| `--visible-*` | 無し | 無し | 無し |
| 開いたパネルの下端 (WebKit) | 1174.8 | 814.8 | 912.8 |
| 試しに開いた `.modal-dialog` の上端〜下端 (WebKit) | 534.4〜659.6 | 354.4〜479.6 | 0〜932 |

- `position: fixed` の要素すべての rect も直す前と同じ (WebKit・Chromium、834x1194 と 1194x834: `.tl-auto-open-float`・`.session-input-fab`)。違いは #app 自身が fixed になったことだけ

キーボードが出た状態 (visualViewport の偽物、高さを 40% 減らす)。`#app` の位置は WebKit と Chromium で同じ:

| 状態 | 834x1194 | 1194x834 | 430x932 |
|---|---|---|---|
| 見える範囲 (`offsetTop`=0) | 0〜716 | 0〜500 | 0〜559 |
| `#app` の上端〜下端 | 0〜716 | 0〜500 | 0〜559 |
| パネル (WebKit) | 444.1〜696.8 | 228.1〜480.8 | 272.1〜539.8 |
| 見える範囲 (`offsetTop`=120) | 120〜836 | 120〜620 | 120〜679 |
| `#app` の上端〜下端 | 120〜836 | 120〜620 | 120〜679 |
| パネル (WebKit) | 564.1〜816.8 | 348.1〜600.8 | 392.1〜659.8 |
| dialog (WebKit) | 415.4〜540.6 | 307.4〜432.6 | 120〜679 |
| キーボードを閉じた後の `#app` / `--visible-*` | 0〜1194 / 無し | 0〜834 / 無し | 0〜932 / 無し |

- パネル・dialog はどの場合も見える範囲の中 (キーボードの上)。Chromium も同じ (パネルの高さだけエンジンの描画差で 12px 違う)
- パネルを動かす (Chromium、デスクトップ、見える範囲 120〜620): 掴んで (-30, -40) 動かすとちょうどその分動く (始点のジャンプ無し)。下へ 2000px 引くと下端が #app の下端 620 で止まる
- 動かしたパネル (下端 804.8) のままキーボードを出す (Chromium): パネルが #app の中へ寄って下端 500、`offsetTop`=120 で下端 620 (= 見える範囲の下端)
- 実物の visual viewport (偽物でない): Chromium でピンチ拡大 (CDP `Input.synthesizePinchGesture`、scale 2、`offsetTop` 300) しても `--visible-*` は書かれず、`#app` は 0 / 1194 のまま。WebKit・Chromium で窓の高さを 1194 → 700 にすると、`#app` は 0 / 700 (`100dvh` が追従、`--visible-*` は無し)
- headless の WebKit では、デスクトップの大きさでマウスの click / drag で FAB を開く・パネルを動かすことができなかった (直す前の main でも同じ。パネルの drag で閉じる)。WebKit のドラッグは測っていない

## viewport の meta (`interactive-widget`)

- `interactive-widget=resizes-content` は、キーボードが出た時に layout viewport ごと縮める指定。効けば visual viewport と layout viewport が一致し、`offsetTop` 0・高さが初期包含ブロックと同じになるので、`visibleAreaOf` は null を返して `--visible-*` を書かなくなる (CSS の既定の `100dvh` が縮んだ layout viewport に合う)。Chrome 108+ / Firefox 132+ が対応
- Safari: WebKit bug 259770 (RESOLVED FIXED) の comment 11 (Apple の Tim Nguyen、2026-11-06) が「実装は iOS 27.3 beta、27.2 には無い」。27.3 beta でも `resizes-content` で入力がキーボードに隠れる報告がある (同 bug comment 13)
- 公開版の Safari が対応していないので足していない。`interactive-widget` 選定判断基準日: 2026-11-21。Safari 27.3 が出たら、`resizes-content` を足して iPad でキーボード表示中の `visualViewport.offsetTop` が 0 のままか・`--visible-*` が書かれないかを確かめ、書かれなければ visible-area.ts は外せる

## iPad の実機での確かめ方

1. Safari で webui を開き直す (古い CSS / JS が残らないよう、topbar の再読み込みか、アドレスバーからの再読み込み)
2. セッションを開き、右下の + (FAB) を押してパネルを開く。textarea をタップしてソフトウェアキーボードを出す。textarea は 1〜2 行だけにする
   - 直っていれば: パネルがキーボードのすぐ上に来る (下の端が隠れない)。`#topbar` は画面の上端に見えている
3. textarea の中で上へ、下へスワイプする
   - 直っていれば: 画面 (`#topbar`・TL・パネル) が見える範囲から外れない。iOS が見える範囲を動かした時に一瞬遅れて付いて来る揺れが出るかもしれない (未検証)、その時はどの程度か
   - caret は文字の位置に描かれたまま
4. textarea に 20 行ほど書いて中がスクロールできるようにし、同じくスワイプする
   - 直っていれば: textarea の中がスクロールする
5. パネルの中のボタン (送信等) や宛先の select の上から始めたスワイプでも、画面が見える範囲から外れないこと
6. パネルの枠 (textarea の外の余白) を掴んでドラッグし、パネルが動くこと。キーボードが出ている間は、キーボードの下へは行かずキーボードの上で止まること
7. textarea の中で長押しして caret を動かす・文字を選ぶ。選択の両端のハンドル (丸) を指で動かして範囲を広げ・縮められること (v0.302.0 で壊れていた所)
8. キーボードを閉じる (キーボードの閉じるボタン、またはパネルの外をタップ)
   - 直っていれば: 画面が元の高さに戻る (TL が画面の下端まで、FAB / パネルが画面の右下)
9. パネルを画面の下の方へ動かしてから textarea をタップしてキーボードを出す
   - 直っていれば: パネルがキーボードの上へ寄る
10. GLOBALS を開き、userscript の edit で dialog を開く。textarea をタップしてキーボードを出し、2〜8 と同じことをする (dialog がキーボードの上の範囲に収まること、選択のハンドルが動くこと)
11. キーボードを閉じた状態で、topbar やサイドバーの見出しなど、スクロールしない所を上下にスワイプする
    - 直っていれば: ページ全体が跳ねない (rubber band しない)
12. 二本指で拡大して、拡大したまま textarea をタップしてキーボードを出す
    - 拡大中は画面を見える範囲に合わせない (合わせると拡大のたびに組み直される)。キーボードの上に入力欄が見えるかと、拡大を戻した後に元の配置になるかを見る

## 残ること

- 見える範囲の移動そのもの (原因 2・3) は止めていない。#app が付いて行くので画面と見える範囲はずれない見込みだが、iOS のパンは別スレッドで描かれ、`visualViewport` の `scroll` は後から届くので、指で速く動かす間に画面が一瞬遅れて揺れる可能性がある (未検証。実機の手順 3 で見る)
- 拡大中にキーボードを出した時は合わせない (手順 12)。その間の配置は直す前と同じ
- `overscroll-behavior: none` を文書に付けているので、ブラウザのページの pull-to-refresh が効かなくなりうる (未検証)。再読み込みは topbar の再読み込みのボタンで行う
- caret のずれが見える範囲の移動で出ていたか (WebKit bug 176896 と同型か) は実機で未確認
- メッセージのメニュー (`.tl-msg-menu`、anchor positioning) は基準が #app になった。キーボードが無い時は #app が画面と同じなので配置は変わらない見込みだが、この fixture では ☰ が出ず測っていない
- 一次資料: WebKit bug 240860 / 332417 / 176454 / 259770 (bugs.webkit.org)、leaperone/vibeface PR #95 と meta/astryx issue #10718 (GitHub、iOS 26 Simulator の観測値)。`useDraggable` が頼る `offsetParent` は、WebKit・Chromium の headless で、`contain: layout` の祖先の中の fixed の要素ではその祖先、そういう祖先の無い fixed の要素では null を返すことを確かめた (仕様の文言との突き合わせは未確認。happy-dom は undefined を返すので null と同じに扱う)
