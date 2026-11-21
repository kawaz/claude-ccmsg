---
title: TL の fold の見出しを押すたびに、選択の閉じ込めが文書全体の style を 2 回計算し直させる
status: open
category: bug
created: 2026-11-21
---

# TL の fold の見出しを押すたびに、選択の閉じ込めが文書全体の style を 2 回計算し直させる

## 観測 (2026-11-21、v0.307.0、headless chromium、隔離 daemon と合成 fixture)

条件: 合成の SESSIONS の行 200 件と、合成の transcript (300 turn) の Timeline 2 つを開いた画面 (約 6.9 万要素)、CPU 6 倍遅延。

- TL の thinking / tool の fold の見出しを 1 回押すと、style の計算 (UpdateLayoutTree) が 76,702 要素と 76,683 要素の 2 回走る。計算は合わせて約 1 秒で、押してから最初の Commit まで 1.36〜1.56 秒
- 規則 `:has(details[open]...)` を外しても変わらない (別の issue `archive/2026-11-21-has-details-open-rules-restyle-whole-document.md` の原因とは別)
- style の invalidation の記録 (trace の `disabled-by-default-devtools.timeline.invalidationTracking`) には、`HTML` の `data-select-contained` の付け外しによる invalidation と、全部の details の `SLOT details-content` (1,114 個) の配置のやり直しが出る

## 仕組み

1. 見出しの mousedown で `selectstart` が発火する
2. `selectionHostOf` が、見出しを含む吹き出しの本文 (`.tl-bubble-body`) を閉じ込め先として返す
3. `useSelectionContainment` が `:root` に `data-select-contained` を付ける
4. app.css の `:root[data-select-contained] { user-select: none; -webkit-user-select: none }` が root の継承される値を変え、文書全体の style を計算し直させる
5. pointerup の時点で選択は畳まれているので属性が外れ、同じ計算がもう 1 回起きる

押しただけ (選択していない) でも、この 2 回が起きる。

## 確かめ方

`:root[data-select-contained] { user-select: auto !important; -webkit-user-select: auto !important }` を差し込んで root の値が変わらないようにすると、同じ押下は style の計算が 78〜175 要素・約 5ms になり、最初の Commit までは約 0.29 秒 (1.4 秒から) になった。サイドバーの fold の押下には影響しない (Timeline の外では閉じ込めないため)。

## 直す時に保つこと

- [DR-0010](../decisions/DR-0010-timeline-markdown-rendering.md) §9: 項目の中で始まった選択は、選択範囲を調節している間その項目の外へ広げない (マウスの drag・タッチのハンドル・Shift+矢印)。JS は Selection を書き戻さない
- 項目の中のコピーは今どおり
