---
title: TL の fold の見出しを押すたびに、選択の閉じ込めが文書全体の style を 2 回計算し直させる
status: resolved
category: bug
created: 2026-11-21
close_reason: implemented
---

# TL の fold の見出しを押すたびに、選択の閉じ込めが文書全体の style を 2 回計算し直させる

## 観測 (2026-11-21、v0.307.0、headless chromium、隔離 daemon と合成 fixture)

条件: 合成の SESSIONS の行 200 件と、合成の transcript (300 turn) の Timeline 2 つを開いた画面 (約 6.9 万要素)、CPU 6 倍遅延。

- TL の thinking / tool の fold の見出しを 1 回押すと、style の計算 (UpdateLayoutTree) が 76,702 要素と 76,683 要素の 2 回走る。計算は合わせて約 1 秒で、押してから最初の Commit まで 1.36〜1.56 秒
- 規則 `:has(details[open]...)` を外しても変わらない (別の issue [has-details-open-rules-restyle-whole-document](./2026-11-21-has-details-open-rules-restyle-whole-document.md) の原因とは別)
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

- [DR-0010](../../decisions/DR-0010-timeline-markdown-rendering.md) §9: 項目の中で始まった選択は、選択範囲を調節している間その項目の外へ広げない (マウスの drag・タッチのハンドル・Shift+矢印)。JS は Selection を書き戻さない
- 項目の中のコピーは今どおり

## 結果 (2026-11-21)

閉じ込めの入れどきを、選択が始まった時 (`selectstart`) から、選択が広がり始めた時に移した。閉じ込め先は今どおり `selectstart` の場所で決めて覚えておき、押したまま pointer が動いた最初の `pointermove`、または選択が畳まれていない状態になった時 (ダブルクリックの語・長押し・Shift+矢印) に入れる。押しただけ (fold の見出しのクリック) では `:root` の属性を付け外ししない。

閉じ込めの範囲を `:root` から見えている Timeline だけに狭める案も測ったが、style の対象は 78,571 要素から 70,267 要素に減るだけだった (Timeline 自体が文書の大半)。採らなかった。

### 計測 (合成の行 200 件 + Timeline 2 つ、約 6.9 万要素、headless chromium)

値は、文書全体の style の計算の回数 / 対象要素数の合計 / style の計算の時間 / 押してから最初の Commit まで (ms):

| 操作 | 等速 前 | 等速 後 | 6 倍遅延 前 | 6 倍遅延 後 |
|---|---|---|---|---|
| fold の見出しを押す | 2 / 157,105 / 250 / 346 | 0 / 82 / 7 / 16 | 2 / 157,098 / 2,012 / 1,381 | 0 / 99 / 44 / 108 |
| 本文のドラッグ選択 | 1 / 78,547 / 120 / 184 | 1 / 78,555 / 126 / 15 | 1 / 78,571 / 853 / 1,283 | 1 / 78,571 / 989 / 229 |
| ダブルクリックの語選択 | 3 / 235,691 / 350 / 575 | 1 / 78,605 / 119 / 133 | 3 / 235,723 / 2,737 / 4,398 | 1 / 78,617 / 997 / 1,095 |

ドラッグ選択は、閉じ込めを入れる 1 回の計算が残る (押した時から、動いた最初の一歩に移った)。

### 振る舞い

前後のコードで同じ手順を Chromium と WebKit で回し、14 の確認 (コードの塊の中から押し、同じ行の右端・下の項目・サイドバー・右下の角・上の項目の 5 か所へ 1 歩と 12 歩で動かして離す、本文から 2 か所、コードの中のコピー、選択の後の見出しのクリック) の答えが、前後ですべて同じだった。コードの塊から始めた drag は、WebKit では 10 通りすべてコードの中に収まった。Chromium では右端・下の項目・サイドバー・右下の角 (1 歩) の 7 通りが収まり、上の項目へ動かした 2 通りと右下の角へ 12 歩で動かした 1 通りは項目の外まで選ばれた。この 3 通りは前のコードでも同じ答えで、この変更で生じたものではない。本文から始めた 2 つは前後とも外まで選ばれたが、押した位置が本文の字の外だった可能性があり、測り方を含めて未確認。
