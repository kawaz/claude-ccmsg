---
title: fold group の開閉で peer ccmsg バブルが消える
status: open
category: bug
created: 2026-07-29T12:09:15+09:00
last_read:
open_entered: 2026-07-29T12:09:15+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# fold group の開閉で peer ccmsg バブルが消える

## 概要

TL の fold group (「1 thinking + 1 ccmsg + ...」) を開閉 toggle した直後、中の peer ccmsg バブルが DOM から消える。Timeline 全体の再 render (新規イベント到着等) で復活する。

## 背景

worker 実測 (2026-07-29, v0.82.0)。

原因は特定済み: `PeerCcmsgLineView` (packages/webui/src/client/components/Timeline.tsx:1465-1467 付近) が dedup 用の `ctx.seenCcmsg` (Set) を render 中に read + mutate している。この Set は Timeline の render pass ごとに新規生成される前提だが、`FoldGroup` の `setOpen` は子コンポーネント局所の再 render なので Timeline 本体は再実行されず、前回 render で自分が入れた key が残った Set を見て `return null` する。

Timeline.tsx:3297-3299 のコメント「sub-tree の再 render は親 render の一環なので実害なし」の前提が、子局所 state 更新 (setOpen) では成立していない。同種の経路 (`useCategoryOpen` 等) にも同じ構造がある可能性。

## 受け入れ条件

- [ ] fold group の開閉 toggle で peer ccmsg バブルが消えない
- [ ] 修正方向 (dedup を parse/分類フェーズに移す、または seenCcmsg のリセット構造を修正) のいずれかで実装
- [ ] 同種の経路 (`useCategoryOpen` 等) に同じ構造がないか確認

## 解決時の記録先

バグ修正のみなら commit message で足りる。
