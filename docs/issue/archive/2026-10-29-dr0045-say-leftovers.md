---
title: DR-0045 の実装後に残った say まわりの 2 点
status: resolved
category: task
created: 2026-10-29T09:01:27+09:00
last_read:
open_entered: 2026-10-29T09:01:27+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-12T21:57:11+09:00
discard_reason:
pending_reason:
close_reason: ["done","dr/DR-0045"]
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

- [x] (1) say-read.json の既読 id を since より前について刈り込む
- [x] (2) 追いつき中の compaction 再 push で古い say が鳴るかを検証し、鳴るなら防ぐ

## 結果

1. say-read.json が単調に増える点: 既読 id はセッションごとに持つ形 (`packages/daemon/src/session-ids.ts`) になっていて、daemon の起動時に `pruneNotificationState` (`packages/daemon/src/server.ts`) が、動いていないセッションの分を `dropSayReadOf` で落とす。受け入れ条件の文は「since より前を刈る」だが、方式を「セッション単位で刈る」に読み替えて満たした扱いにする。残り: agents の poll が有効な時しか走らない。1 本の長く続くセッションの分は、そのセッションが終わるまで残る。
2. 追いつき中の再 push で古い say が鳴る点: v0.262.0 で直した。追いつきの最中に push された行の作用 (say と許可依頼の発声、「! で実行」の終了の知らせ) は着地まで溜め、着地の時点でファイルから読んだ行に無いものだけを新しい行として扱う (`transcript-relay.ts` の `relayAfterCatchUp`)。修正前は再現のテストで古い say と古い許可依頼が実際に鳴った (4 件 fail)。再 push するのは Claude Code の compaction (残した assistant の行を同じ uuid で送り直す)。残り: 追いつきが失敗した時・最中にセッションが live でなくなった時は溜めた分を捨てる (新しい say / 許可依頼も鳴らない、daemon.log に 1 行)。daemon の再起動直後に hello より前に来た push は対象外。「say / permit の行そのものが残されて再 push される」場面は実物では未観測 (残される区間に tool_use の行が入ることは確認済み)。決まりの正本は DR-0045 §6 と DR-0040 §6。
