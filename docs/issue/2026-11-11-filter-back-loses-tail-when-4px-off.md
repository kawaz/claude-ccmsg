---
title: 🔐 のフィルタの末尾から「TL に戻る」を押すと、末尾に残らず 4 万 px 上に残ることがある
status: open
category: bug
created: 2026-11-11T21:39:59+09:00
last_read:
open_entered: 2026-11-11T21:39:59+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 「TL に移動」の実装の検証中に worker が変更前の版と並べて見つけた (2026-11-11)
---

# 🔐 のフィルタの末尾から「TL に戻る」を押すと、末尾に残らず 4 万 px 上に残ることがある

## 概要

🔐 のフィルタの末尾から「TL に戻る」を押すと、末尾に残らず 4 万 px 上に残ることがある。

### 観測 (2026-11-11、隔離 daemon、約 7.5MB の fixture、許可依頼 3 件、headless Chromium 1280x900)

- 手順: /s/<sid>/timeline/head?filter=permit を開き、末尾の「TL に戻る」(.tl-filter-back) が出てから 800ms 待って scrollHeight - scrollTop - clientHeight を測る。「TL に戻る」を押し、URL から filter が消えてから 1500ms 待ってもう一度測る。3 回繰り返す
- 結果 ([押す前の最下部からのずれ, 押した後のずれ]): 「TL に移動」を足す前の版 (v0.245.0) は [0, 0] / [0, 0] / [4, 41902]、足した後の版は [0, 0] / [0, 0] / [4, 41859]。どちらも 3 回目だけ、押す前の時点で最下部から 4px ずれていて、押した後は末尾に残らなかった。サンプルは 3 回ずつ
- 末尾に残らない仕組み (コードで確認): isAtBottom の許容は 1px (packages/webui/src/client/components/timeline-autoscroll.ts の epsilon = 1)。useFilterScroll.ts はこの判定が偽の時に末尾として保たず、画面の一番上の data-notif のバブルを保つので、フィルタを外した後はそのバブルの位置 (4 万 px 以上上) に残る

## 背景

「TL に移動」の実装の検証中に worker が変更前の版と並べて見つけた (2026-11-11)。

### 分かっていないこと

- フィルタ画面を head で開いた時に、なぜ最下部から 4px ずれることがあるのか (どの要素が後から 4px 伸びたのかは測っていない)
- 🔔 のフィルタでも起きるか
- 実機 (headless でない) でどのくらいの頻度で起きるか

### 候補 (未検証)

- フィルタに入った時の末尾の保持は useScrollHold の ResizeObserver で、見ているのは scroller と .tl-lines。フィルタ中の .tl-lines は flex-grow: 1 なので、その外の要素が後から伸びても末尾への寄せが再適用されない、という筋。裏付けは無い

### 切り分けに要る観測

- 4px ずれた回で、フィルタ画面の描画の後に高さが変わった要素 (ResizeObserver か、描画ごとの各要素の getBoundingClientRect の記録)
- 🔔 のフィルタでの同じ手順

## 受け入れ条件

- [ ] 末尾で 🔐 のフィルタに入り「TL に戻る」を押すと、押す前の最下部からのずれの大小によらず末尾に残る
