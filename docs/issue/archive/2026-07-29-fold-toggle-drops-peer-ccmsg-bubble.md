---
title: fold group の開閉で peer ccmsg バブルが消える
status: resolved
category: bug
created: 2026-07-29T12:09:15+09:00
last_read:
open_entered: 2026-07-29T12:09:15+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-29T13:23:45+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.82.2 で修正 (commit 3fe0863a)。dedup 判定を render 中の Set mutation から分類フェーズの純関数 ccmsgRenderTargets に移して根治。修正前ビルドとの並行実機比較で消失0->維持を確認、同種経路の横断確認は他0件。副次的に in-view search のカウント不一致も解消"]
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
