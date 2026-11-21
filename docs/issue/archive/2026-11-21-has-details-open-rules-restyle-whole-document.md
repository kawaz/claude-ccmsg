---
title: Timeline 向けの :has(details[open]) の規則が、サイドバーを含むどの details の開閉でも、その中身全部の style を計算し直させる
status: resolved
category: task
created: 2026-11-21
close_reason: implemented
---

# Timeline 向けの :has(details[open]) の規則が、サイドバーを含むどの details の開閉でも、その中身全部の style を計算し直させる

## 観測 (2026-11-21、v0.306.0、headless chromium、隔離 daemon と合成 fixture)

`packages/webui/src/public/app.css` で `:has(details[open]:not(details:not([open]) details))` を使う Timeline 向けの 4 規則は、どこかの `<details>` が開閉するたびに、Chrome にその details の子孫を全部 style の計算に掛け直させる。:has の引数の中で祖先の `[open]` を見ているため (開閉した details の中の details は「閉じた details の中にあるか」が変わりうる)。サイドバーの SESSIONS の fold を開いた時 (CPU 6 倍遅延、Timeline を 2 つ保持して約 6.8 万要素) の main thread の内訳:

| 項目 | ms |
|---|---|
| Document::recalcStyle | 106 (7039 要素) |
| Paint | 64 |
| PaintArtifactCompositor::Update | 61 |
| HitTest | 32 |
| Document::updateStyle | 32 |

この 4 規則を CSSOM で外すと、style の対象は 7039 要素から 43 要素に減り、1 回の開閉は 368ms から 264ms (6 倍遅延) に縮んだ。等速では 1 回の開閉は 40〜64ms。

## やること

- 4 規則がそれぞれ何を表しているかを確かめ、判定を `.tl-item` の中に閉じる、または Timeline 側で class を付ける形に置き換えられるかを調べる
- 置き換えた後に同じ条件で計測し直し、見た目が変わらないことを確かめる

## 結果 (2026-11-21)

4 規則はどれも「項目 (`.tl-item`) が、見えている開いた details を持つか」を判定している:

- 閉じた項目の jsonl のトグルを出さない
- jsonl 表示中に閉じた項目の元の行を出さない
- 閉じた項目の ☆ を出さない
- 「N items」の fold の中で、開いた項目の下にだけ空きを取る

「見えている開いた details を持つ」は「項目の中で一番外側の details のどれかが開いている」と同じなので、判定する details の外側を構造だけで書いた `details[open]:not(.tl-item details details)` に置き換えた (項目は入れ子にならない。説明は app.css の規則の注記)。class を付ける形にはしなかった: 項目の中の details は Timeline の fold の store を通るもの・markdown の `<details>`・目次などがあり、開閉を項目へ集める仕組みが要るため。

### 見た目

- 4 規則が効く場面 (閉じた項目と開いた項目の hover、jsonl 表示中の開閉、「N items」の中の開いた項目) を、置き換えの前後で同じ手順でスクリーンショットに撮り、5 枚とも画素の差は 0
- 置き換えの前後の選択子で、項目ごとの判定を実画面の 6 つの状態 (fold group・thinking・markdown の details の開閉の組み合わせ、約 1,400 項目) で突き合わせ、食い違いは 0
- 閉じた details の中の開いた details を持つ項目 (閉じたまま) を含む 9 つの形を、Chromium と WebKit で前後の選択子とも同じ答えになることを確かめた。happy-dom はこの形を前後どちらの選択子でも正しく判定できないので、DOM の試験 (`timeline-item-open-css.dom.test.ts`) からは外してある

### 計測 (隔離 daemon、合成の行 200 件 + Timeline 2 view、約 6.9 万要素、CPU 6 倍遅延)

開閉 1 回の style の対象要素数と、押してから最初の Commit まで。TL の fold の行は、選択の閉じ込め (下) の影響を CSS で打ち消して測った:

| 開閉 | 前: 要素 / ms | 後: 要素 / ms |
|---|---|---|
| SESSIONS の owner を開く | 3,783 / 244 | 26 / 207 |
| SESSIONS の owner を閉じる | 8 / 149 | 6 / 147 |
| TL の thinking を開く | 102 / 286 | 102 / 288 |
| TL の tool を開く | 175 / 289 | 175 / 287 |
| TL の fold group (2 項目) を開く | 62 / 283 | 60 / 284 |

効くのは中身の多い details の開閉 (サイドバーの fold、項目の多い fold group) で、中身の少ない TL の fold は前から小さい。

### 別に見つけたもの

TL の fold を押すと、選択の閉じ込め (`useSelectionContainment`) が `:root[data-select-contained]` を付け外しし、`user-select` が継承されるため文書全体 (約 7.7 万要素) の style の計算が 2 回走る (6 倍遅延で 1 回の押下が約 1.4 秒、打ち消すと約 0.29 秒)。この issue の規則とは別の原因で、統括に報告済み。
