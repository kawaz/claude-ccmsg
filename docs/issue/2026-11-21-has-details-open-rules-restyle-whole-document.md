---
title: Timeline 向けの :has(details[open]) の規則が、サイドバーの開閉でも文書全体の style を計算し直させる
status: open
category: task
created: 2026-11-21
---

# Timeline 向けの :has(details[open]) の規則が、サイドバーの開閉でも文書全体の style を計算し直させる

## 観測 (2026-11-21、v0.306.0、headless chromium、隔離 daemon と合成 fixture)

`packages/webui/src/public/app.css` にある `:has(... details[open] ...)` を使う Timeline 向けの 4 規則は、どこかの `<details>` が開閉するたびに文書全体を対象に style の計算をやり直させる。サイドバーの SESSIONS の fold を開いた時 (CPU 6 倍遅延、Timeline を 2 つ保持して約 6.8 万要素) の main thread の内訳:

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
