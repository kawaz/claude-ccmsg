# older で読み切った後の画面内タブ切替のフリーズ: 原因の切り分け、v0.213.0 の修正の検証、スクロール位置の保持の統合

- Date: 2026-11-05
- 前提: [Timeline の older を先頭まで読んだ時のタブの重さの計測](2026-11-05-older-tab-freeze.md) の続き。修正 (scroll のイベントで位置を持ち、移動の時に要素を読まない。v0.213.0 に入った) はそちらの §3
- 対象: Chrome for Testing 1243 (playwright の Chromium、headless) と playwright の WebKit (headless)、1280x900
- 比べたビルド:
  - 修正前: v0.212.1 (移動の直前に `querySelectorAll("*")` の全要素の `scrollTop` / `scrollLeft` を読む `capture`)
  - 修正後: v0.213.0 (位置を view の root の capture 相の scroll イベントで記録し、表示に戻った時に書き戻す)
  - 統合後: v0.213.0 の上で、保持するセッションの表示を sid の順に描いて DOM の中で動かさないようにし、位置の記録と書き戻しを削った版 (`sessionViewMountOrder`)
- 方法:
  - 実 daemon の URL (`/s/b4f3e54c-…/timeline/head`、transcript 11 MB) を読むだけで開いた。older を先頭まで押し、画面内タブ (Terminal / Files / Status) をクリックした。修正前は実 daemon が v0.212.1 の時に、修正後は v0.213.0 になってから同じ手順で計った
  - 同じ条件でビルドを入れ替えて比べるため、隔離 daemon (verify skill の手順、`HOME` も一時ディレクトリ) の `$HOME/.claude-fixture/projects/` に同じ transcript の写しを置いた。localStorage の pin でそのセッションを開いた (peer が無いので Terminal タブは出ない。Files / Status で計った)
  - long task は PerformanceObserver、CPU の内訳は CDP の Profiler。WebKit は long task を取れないので、クリックしてから次の描画までの時間で見た
  - スクロール位置の保持は、隔離 daemon に transcript の写しを 3 本 (A / B / C) 置いて確かめた。A の TL で fold を開き、中の横スクロールする要素 (`pre.md-code`) の `scrollLeft` を 29 にして、セッションとタブを行き来した後の値を読んだ

## 結果の要約

- 修正後は、kawaz の手順 (older で読み切る → 画面内タブをクリック) で固まらない。実 daemon で、Timeline から Terminal へのクリックが 108,748 ms から 265 ms、Files へが 109,881 ms から 267 ms、Status へが 102,170 ms から 165 ms になった
- 固まる仕組みは 2 つが重なったもの:
  - 移動のたびに全要素の `scrollTop` を読む処理があった
  - Chromium では、閉じた `<details>` (Timeline の fold) の中の要素で `scrollTop` を読むと、1 回ごとに document 全体の layout が走る (先頭まで読んだ TL で 1 回 85 ms、それ以外の要素は 3,000 回で 2 ms)
  - 閉じた fold の中の要素が 1,188 個あるので、85 ms × 1,188 ≈ 100 秒。WebKit では 1 回 0.15 ms で、固まらない
- 修正後もスクロール位置が戻らない場面が残っている。別のセッションから戻った時、そのスクロール要素が今表示していないタブにあると、位置は 0 になる (例: A の TL の中をスクロール → A の Status → B → A の Status → A の Timeline)。修正前の版でも同じく 0 で、修正で増えた穴ではない。統合後はこの場面も保たれた (§4)
- 統合後のタブ切替とセッションの切替の所要時間は v0.213.0 と同じ水準 (§6)。セッションから戻る時の long task の合計だけが、Chromium で約 250 ms 多く出た

## 1. 修正前の再現 (実 daemon、v0.212.1、Chromium)

| 操作 | DOM ノード | クリックが返るまで | 最長の long task |
|---|---|---|---|
| 初回の読み込み (head) | 2,660 | — | 75 ms |
| older 2 回 (先頭) | 14,770 | — | 371 ms |
| Timeline → Terminal | 14,736 | 108,748 ms | 108,294 ms |
| Terminal → Timeline | 14,773 | 802 ms | 731 ms |
| Timeline → Files | 15,317 | 109,881 ms | 109,587 ms |
| Files → Timeline | 15,317 | 672 ms | 615 ms |
| Timeline → Status | 15,559 | 102,170 ms | 102,058 ms |
| Status → Timeline | 15,559 | 971 ms | 614 ms |

Timeline → Terminal の 110 秒の profile では、自己時間 108,057 ms が bundle の 1 関数に集中していた。bundle の該当箇所を読むと、SessionView の `capture` (`BEFORE_NAVIGATION_EVENT` の listener、呼び出し元は `dispatchEvent`) だった。他のタブから Timeline へ戻る向きは軽い。他のタブを見ている間は TL のパネルが `display: none` で、中の要素を読んでも layout が要らないため。

## 2. 1 回の `scrollTop` の読みの重さ (閉じた details の中と外)

先頭まで読んだ状態で、表示中のセッションの要素を「閉じた `<details>` の中 (summary を除く)」と「それ以外」に分けて `scrollTop` を読んだ時間 (実 daemon の URL)。

| エンジン | 閉じた details | その中の要素 | その中を 100 回読む | それ以外 (約 1.3 万個) を 3,000 回読む |
|---|---|---|---|---|
| Chromium | 390 | 1,188 | 8,480 ms (1 回 84.8 ms) | 2 ms |
| WebKit | 390 | 1,188 | 15 ms (1 回 0.15 ms) | 0 ms |

- 読むたびに layout をやり直すのは、Chromium で閉じた details の中の要素の時だけ。1 回の重さは document の大きさに比例する (head の 2,150 ノードでは、修正前の切替の long task は 120 ms)
- [前の findings](2026-11-05-older-tab-freeze.md) §3 の「1 要素あたり約 26〜33 ms」は、document の順に先頭から読んだ平均で、閉じた fold の中か外かを分けていない。ここでの分け方では、重いのは閉じた fold の中の要素だけだった
- Chromium が閉じた details の中身をどう隠しているか (content-visibility 相当の仕組みで、読むたびに強制更新している、等) は、Chromium のソースを読んでいないので未確認

## 3. 修正の前後

### 実 daemon (Chromium、older で先頭まで、DOM 約 1.48 万)

クリックが返るまで (ms) / 最長の long task (ms)。

| 切替 | 修正前 (v0.212.1) | 修正後 (v0.213.0) |
|---|---|---|
| Timeline → Terminal | 108,748 / 108,294 | 265 / 113 |
| Terminal → Timeline | 802 / 731 | 651 / 590 |
| Timeline → Files | 109,881 / 109,587 | 267 / 117 |
| Files → Timeline | 672 / 615 | 596 / 548 |
| Timeline → Status | 102,170 / 102,058 | 165 / 124 |
| Status → Timeline | 971 / 614 | 607 / 556 |

### 隔離 daemon (同じ transcript の写し)

クリックが返るまで (ms) / 最長の long task (ms)。WebKit はクリックしてから次の描画まで (ms)。

| 条件 | Timeline → Files | Files → Timeline | Timeline → Status | Status → Timeline |
|---|---|---|---|---|
| 修正前、Chromium、先頭まで (DOM 14,234) | 101,154 / 101,098 | 546 / 525 | 102,680 / 102,669 | 566 / 534 |
| 修正後、Chromium、先頭まで | 97 / 0 | 511 / 475 | 66 / 0 | 525 / 496 |
| 修正前、Chromium、head のまま (DOM 2,150) | 173 / 120 | 47 / 0 | 135 / 116 | 63 / 0 |
| 修正後、Chromium、head のまま | 72 / 0 | 51 / 0 | 50 / 0 | 47 / 0 |
| 修正前、WebKit、先頭まで (DOM 13,882) | 335 | 415 | 290 | 469 |
| 修正後、WebKit、先頭まで | 140 | 407 | 76 | 421 |

修正後に、先頭まで読んだ TL から別のセッション B の TL へ移ると 51 ms (long task 62 ms)、B から戻ると 954 ms (long task 519 ms) だった。修正前のセッション間の移動は計っていない (`capture` はセッション間の移動の前にも走っていた。コードで確認)。

- 残っている重さは、Timeline が見えるようになる時の 0.5〜1 秒。profile ではほぼ全部が native (layout) で、`display: none` から戻した約 1.4 万ノードを layout し直す分。読んだ量に比例する

## 4. スクロール位置の保持

A の TL の中の `pre.md-code` の `scrollLeft` を 29 にしてから、各操作の後に読んだ値。Chromium と WebKit は全ての欄で同じ値だった。

| 操作 | 修正前 (v0.212.1) | 修正後 (v0.213.0) | 統合後 |
|---|---|---|---|
| A の中でタブ往復 (Timeline → Status → Timeline) | 29 | 29 | 29 |
| A → B → 戻る (Timeline のまま) | 29 | 29 | 29 |
| A → B → C → A (リンク、Timeline のまま) | 29 | 29 | 29 |
| A → C → A の Status → A の Timeline | 0 | 0 | 29 |
| A の Status → B → A の Status → A の Timeline | 0 | 0 | 29 |

統合後の確認 (Chromium・WebKit、各場面の後に読んだ値):

- A の中のタブ往復: 29
- A → B → 戻る: 29
- A → B → C → A: 29
- A → C → A の Status → A の Timeline: 29
- A の Status → B → A の Status → A の Timeline: 29 (この場面で A の表示の要素が DOM から外れないことを `session-view-mount-order.dom.test.ts` で固定した)

位置が 0 になる理由:

1. App は保持しているセッションの表示 (LRU、最大 3) を、使った順に並べて描く。別のセッションから戻ると、戻った表示の `<main>` が DOM の中で動く
2. 要素が動くと、中の全てのスクロール位置はブラウザが捨てる。Chromium・WebKit とも、v0.212.1 から書き戻しだけを削った版で確認した (「A → B → 戻る」が 0 になった)
3. 修正前・修正後とも、書き戻しは表示が active になった瞬間に一度だけ走る。その時に隠れているタブのパネル (`display: none`) の要素には、`scrollTop` / `scrollLeft` を書いても位置が付かない。だから、戻った時に表示していないタブの中の位置は 0 のまま

統合後は、表示を sid の順に描いて DOM の中で動かさない。祖先を `display: none` にして戻すだけなら、スクロール位置はブラウザが保つ。単独のページで Chromium・WebKit とも確認し (`scrollTop` 500 → 隠している間 0 → 戻すと 500)、隠す時も戻す時も scroll イベントは出なかった。なので、位置の記録も書き戻しも要らない。

Status タブ自体のスクロール位置は、どのビルドでも別のセッションから戻ると 0 だった (修正前の観測: 261 → 0)。セッションを離れると Status の購読を止めて snapshot を捨て、戻ると「読み込み中」から描き直すため。上の件とは別の振る舞い。

## 5. v0.213.0 の記録と書き戻しのコードから読める性質 (計測していない、統合で削った)

- 記録の Map は、active になる時に DOM から外れた要素を消すだけ。表示中のまま TL の行が描き直されると、スクロールした要素が外れても Map に残り、外れた subtree ごと次に active になるまで保持される
- 書き戻しは、記録のある要素全部に `scrollTop` / `scrollLeft` を書く。その要素が今は閉じた fold の中にあると、§2 と同じく Chromium で書き込みのたびに layout が走るはず。記録されるのは実際にスクロールした要素だけなので数は少ないが、1 つ 85 ms 程度の見込み

## 6. 統合後と v0.213.0 の所要時間 (隔離 daemon、older で先頭まで)

各 3 回。Timeline へのタブの戻りは「クリックが返るまで (ms) / 最長の long task (ms)」。セッションの戻りは、ページの中で `navigation.navigate` を呼んでから 2 フレーム後 (ms) / long task の合計 (ms)。WebKit は long task を取れない。

| 操作 | エンジン | v0.213.0 | 統合後 |
|---|---|---|---|
| Files → Timeline (同じセッション) | Chromium | 502〜538 / 469〜500 | 500〜542 / 467〜505 |
| Files → Timeline (同じセッション) | WebKit | 399〜428 | 392〜420 |
| B → 先頭まで読んだセッション | Chromium | 674〜679 / 620〜624 | 677〜736 / 854〜909 |
| B → 先頭まで読んだセッション | WebKit | 934〜960 | 953〜999 |
| 先頭まで読んだセッション → B | Chromium | 29〜32 | 28〜29 |

- 同じセッションの中のタブの戻りは、どちらも書き戻しが走らないので同じ
- セッションの戻りで、v0.213.0 の書き戻しのループは `scrollTop` を書くたびに layout を強いる。profile (各 1 回) では、v0.213.0 は書き戻しのループに 444 ms、統合後は Timeline の末尾寄せ (`ScrollHold.toBottom`) に 450 ms、どちらも同じ layout をしていた。main thread の合計 (idle を除く) は 959 ms と 961 ms で同じ
- 2 フレーム後までの時間は同じ水準だが、Chromium の long task の合計は統合後が約 250 ms 多かった (3 回とも)。v0.213.0 では layout が描画前の 1 つの task にまとまり、統合後は描画の後の effect の task に分かれて出る。合計の差がどの task から来ているかは特定していない

## 判断に効く含み

- 固まる件は v0.213.0 で直っている。実 daemon で kawaz の手順を 3 タブとも計り、108 秒 → 0.3 秒以下
- セッションをまたぐと位置が戻らない場面 (§4 の下 2 行) は、修正前からある。原因は書き戻しの方式ではなく、表示の要素が DOM の中で動くこと。統合後は表示を動かさず、記録も書き戻しも持たない
- Timeline が見えるようになるたびの 0.5〜1 秒は、読んだ量に比例する DOM を持つことによる。[push ごとの重さの issue](../issue/2026-11-05-timeline-push-cost-after-older.md) と同じ根 (読んだ分を全部実体化して持つ) から来ている
- 修正前の計測で 1 度だけ、Timeline → Files の切替の最中に Chromium のレンダラが落ちた (`Target crashed`)。同じ手順の 2 回目は 101 秒で戻り、落ちなかった。落ちた原因は見ていない

## 未検証

- Firefox (手元の playwright と Firefox の版が合わず起動しなかった)
- 実ブラウザ (headed、拡張機能あり) と iPad Safari での同じ手順
- §5 の 2 点 (統合で該当のコードは無くなった)
- §6 の long task の合計の差の出どころ
- 修正前のセッション間の移動の所要時間
