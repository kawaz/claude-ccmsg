---
title: TL の in-view search 実態調査 — HighlightedPlainText がスタブ
status: open
category: bug
created: 2026-08-12T10:09:22+09:00
last_read:
open_entered: 2026-08-12T10:09:22+09:00
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

- [ ] {次に手を付けるサブタスク}
