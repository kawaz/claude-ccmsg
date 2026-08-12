---
title: TL の in-view search 実態調査 — HighlightedPlainText がスタブ
status: resolved
category: bug
created: 2026-08-12T10:09:22+09:00
last_read: 2026-08-12T10:12:31+09:00
open_entered: 2026-08-12T10:09:22+09:00
wip_entered: 2026-08-12T10:13:34+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T10:40:21+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.100.9 (D1) で根治。スタブは CSS Custom Highlight 移行 (ae2e3a1) の残骸で無害・削除済み。真因は ja 翻訳による描画テキスト差し替えで M が DOM から脱落・焼き付く件、マッチ計数を SearchUnit + matchingUnitKeysOf のモデル側純関数に分離して解消 (実測: ↓×6 で M 不変 9)","derived-issue: tl-search-translated-thinking"]
blocked_by:
origin: 自リポ TODO
---

# TL の in-view search 実態調査 — HighlightedPlainText がスタブ

## 概要

Timeline.tsx:274 の `HighlightedPlainText` が `void ctx; return text` のスタブで、plain テキスト側のハイライトが描画されない。200 commit 以上前から同状態 (今回の D0 とは無関係)。ただし MarkdownView の `highlightWords` 経路は別実装で、[N/M] カウンタの動作状況も worker 間で観測が割れている (tl-scroll-design は「DOM ref を数えて動く」、w-tl-d0 は「ハイライトも N/M も出ない」)。実機で「どこまで動いていて何が死んでいるか」を確定させてから修正方針を決める。

## 背景

D1 (検索マッチのモデル化、findings 2026-08-12-timeline-windowing-design) と同時に扱うのが自然。

## 受け入れ条件

- [ ] 実機検証で plain テキスト側ハイライト・MarkdownView の highlightWords 経路・[N/M] カウンタそれぞれの動作状況を確定させる
- [ ] 確定結果に基づき修正方針 (D1 と同時実施が妥当か等) を決定する

## TODO

<!-- wip 時のみ -->

- [ ] D1 worker が実態マトリクス確定 → モデル化 + 修理を実施中 (2026-08-12)。
