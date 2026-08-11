---
title: Timeline cross-line 処理の差分化
status: open
category: design
created: 2026-08-12T08:30:32+09:00
last_read:
open_entered: 2026-08-12T08:30:32+09:00
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

# Timeline cross-line 処理の差分化

## 概要

findings `2026-08-12-blocking-io-audit-full` の medium 指摘: `Timeline.tsx:3014-3066` の
`pairQueuedTurns` / `offsets` / `groupTimelineLines` 等が live-tail の 1 行ごとに全行走査している。
per-line parse 自体は `incremental-line-map.ts` で差分化済みだが、その後段の cross-line 処理が
未差分化のまま残っている。

## 背景

`store.ts:917` の `lines` 連結が O(N) コピーかつ再計算トリガになっており、上記の全行走査と
合わせて行数が増えるほど CPU コストが線形以上に増える。これは DOM 描画規模の問題
(`timeline-virtual-scroll` issue) とは独立したコストで、仮想スクロールを導入しても解消しない。

## 受け入れ条件

- [ ] `pairQueuedTurns` / `offsets` / `groupTimelineLines` 等 cross-line 処理の差分化方式を設計する
- [ ] `store.ts:917` の `lines` 連結 O(N) コピーの解消方針を含める
- [ ] `timeline-virtual-scroll` issue と設計を併せて検討する (着手時)

## TODO

<!-- wip 時のみ -->
