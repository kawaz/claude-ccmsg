---
title: peer-inject の同一セッション宛て連続 post の到着順が非保証
status: open
category: bug
created: 2026-09-28T14:36:12+09:00
last_read:
open_entered: 2026-09-28T14:36:12+09:00
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

# peer-inject の同一セッション宛て連続 post の到着順が非保証

## 概要

peer-inject の同一セッション宛て連続 post の到着順が非保証。post ごとに独立した非同期 send なので入れ替わり得る (未観測)。sid ごとに send を直列化するのが候補。関連: packages/daemon/src/peer-inject.ts、DR-0034

## 背景

同一 sid 宛てに複数の post が短時間に発行されるケースで、各 post が独立した非同期 send として発火するため、送信順と到着順が一致する保証がない。現時点では実際の入れ替わりは未観測だが、実装上の保証が無いことは確認済み。

## 受け入れ条件

- [ ] 同一 sid 宛て連続 post の到着順が送信順と一致することを保証する (例: sid ごとに send を直列化するキュー導入)
- [ ] 上記の担保を検証するテストがある

## TODO

<!-- wip 時のみ -->
