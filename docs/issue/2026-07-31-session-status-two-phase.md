---
title: session_status の 2-phase 化検討 (同一接続内の cold scan 待ちの解消)
status: open
category: design
created: 2026-07-31T12:58:04+09:00
last_read: 2026-09-02T17:09:34+09:00
open_entered: 2026-07-31T12:58:04+09:00
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

# session_status の 2-phase 化検討 (同一接続内の cold scan 待ちの解消)

## 概要

v0.88.1 (DR-0029 high #3) で daemon の dispatch を接続ごと FIFO チェーン化し、
cold scan が「daemon 全体を止める」→「その接続内の後続 op だけ待たせる」に改善した。

残る限界: 同一接続 (webui 1 タブ) では大きい transcript の cold scan 後ろに
自分の後続 op が並ぶ。解消には session_status(_subscribe) を session_search と
同じ 2-phase 返信 (accept 即返し + request_id 付き event) にする必要があり、
protocol と webui 双方の変更が要る。

## 背景

DR-0029、docs/findings/2026-07-31-blocking-io-audit.md からの派生検討。
着手判断の前に「同一接続内の待ち時間の実測」を取ること
(実測なしで protocol を広げない、kawaz 裁定 2026-07-31)。

## 受け入れ条件

- [ ] 同一接続内での cold scan 待ち時間を実測し、体感/実害の有無を確認する
- [ ] 実測結果を踏まえ、2-phase 化に着手するか見送るかを裁定する
- [ ] 着手する場合、session_search と同型の protocol 拡張案 (accept + request_id event) を設計する

## TODO

<!-- wip 時のみ -->

- [ ] {次に手を付けるサブタスク}
