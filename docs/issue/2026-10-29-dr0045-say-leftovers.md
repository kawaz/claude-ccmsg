---
title: DR-0045 の実装後に残った say まわりの 3 点
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

# DR-0045 の実装後に残った say まわりの 3 点

## 概要

DR-0045 の実装後に残った 3 点。

1. live でないセッション (module 無し / 終了済み) の TL では、読んでいない say も 🔕「既読」の文字で出る。未読は live のセッションだけという DR-0045 §7 の定義どおりだが「既読」は事実と食い違う。webui はセッションが live かを知らないので、文字を出さないか live の情報を渡すかの判断が要る。
2. `<state dir>/say-read.json` の既読 id の集合は刈り込まないので単調に増える (1 id 数十 byte、年に数千件の見積り)。since より前を既読扱いにしているので古い id は捨ててよいはず。
3. 起動直後の追いつきの最中に compaction の再 push が重なると、まだ読んでいない古い say を鳴らしうる (未検証)。

## 背景

関連: DR-0045、docs/findings/2026-10-28-dr-0045-stage3-verify.md

## 受け入れ条件

- [ ] (1) live でないセッションの say の表示を、事実と食い違わない形にする
- [ ] (2) say-read.json の既読 id を since より前について刈り込む
- [ ] (3) 追いつき中の compaction 再 push で古い say が鳴るかを検証し、鳴るなら防ぐ
