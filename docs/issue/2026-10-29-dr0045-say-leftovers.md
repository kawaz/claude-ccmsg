---
title: DR-0045 の実装後に残った say まわりの 2 点
status: open
category: task
created: 2026-10-29T09:01:27+09:00
last_read:
open_entered: 2026-10-29T09:01:27+09:00
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

# DR-0045 の実装後に残った say まわりの 2 点

## 概要

DR-0045 の実装後に残った 2 点。

1. `<state dir>/say-read.json` の既読 id の集合は刈り込まないので単調に増える (1 id 数十 byte、年に数千件の見積り)。since より前を既読扱いにしているので古い id は捨ててよいはず。
2. 起動直後の追いつきの最中に compaction の再 push が重なると、まだ読んでいない古い say を鳴らしうる (未検証)。

## 背景

関連: DR-0045、docs/findings/2026-10-28-dr-0045-stage3-verify.md

## 受け入れ条件

- [ ] (1) say-read.json の既読 id を since より前について刈り込む
- [ ] (2) 追いつき中の compaction 再 push で古い say が鳴るかを検証し、鳴るなら防ぐ
