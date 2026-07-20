---
title: ja(host) 翻訳の webui 側バッチ化 (thinking bundling)
status: open
category: task
created: 2026-07-17T17:19:07+09:00
last_read:
open_entered: 2026-07-17T17:19:07+09:00
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

# ja(host) 翻訳の webui 側バッチ化 (thinking bundling)

## 概要

元は 5 条件のフォローアップだったが、うち 4 件は land 済み:

- [x] miniSummaryLines の ctx 消費表示 — `session-status-view.ts` の `formatContextUsage`
- [x] 全文日本語段落の翻訳 skip — `translate.ts` の `shouldSkipParagraph` (段落単位でさらに効率化、目的達成)
- [x] thinking の select 機能撤去
- [x] miniSummaryLines の活動中 teammates 表示 — `formatTeammatesLine`

残る 1 件に issue を絞る: **webui が表示中の thinking を 1 リクエストに束ねるバッチ化**。

下位層 (daemon translate op の `texts: string[]` 受入、Swift helper の
`session.translations(from:)`) は実装済み。webui 側 `translate.ts` が
`request([paragraph])` の 1 段落 1 リクエストのままで、複数 thinking が
並ぶと 400-900ms × N の直列遅延が出る。

## 受け入れ条件

- [ ] 表示中の翻訳対象段落を、複数 thinking 跨ぎで 1 回の translate op に束ねて送信する
- [ ] 結果を元の thinking / 段落位置に正しく復元する
- [ ] 部分失敗時は該当段落のみ原文 fallback する
- [ ] `hostTextCache` と共存する (キャッシュ済み段落は batch に含めない)

## TODO

`translate.ts` に、保留中の段落を短時間 (例 20ms) 蓄積してから 1 batch で
flush する集約層を追加する。`Timeline.tsx` 側の呼び出し API は不変。
