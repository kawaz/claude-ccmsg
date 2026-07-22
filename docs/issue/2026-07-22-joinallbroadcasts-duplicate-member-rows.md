---
title: daemon 再起動毎に joinAllBroadcasts が broadcast room jsonl へ duplicate member rows を蓄積する
status: open
category: bug
created: 2026-07-22T16:43:44+09:00
last_read:
open_entered: 2026-07-22T16:43:44+09:00
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

# daemon 再起動毎に joinAllBroadcasts が broadcast room jsonl へ duplicate member rows を蓄積する

## 概要

daemon 再起動のたびに、session re-hello (`isNewEntry=true`) が `joinAllBroadcasts` 経由で broadcast room の jsonl に MemberEvent を再追記してしまう。subscriber からは `isSuppressedForBroadcastStream` により見えないが、jsonl ファイル自体には同一 member の重複行が再起動回数分蓄積し続けるデータ品質バグ。

## 背景

`daemon-startup-notification-noise` issue (`docs/issue/2026-07-12-daemon-startup-notification-noise.md`) の調査 (2026-07-22、opus47-high worker の実測) の副産物として発見。daemon restart 毎の session re-hello が `joinAllBroadcasts` を通ることで、既存 member であっても無条件に MemberEvent が jsonl へ追記される。

## 受け入れ条件

- [ ] re-hello (再起動による既存メンバーの再参加) 時、既存 member との重複判定を行い、重複であれば jsonl への追記をスキップする
- [ ] 新規 member の join では引き続き正しく MemberEvent が記録される
- [ ] 既存の broadcast room jsonl に蓄積した重複 member 行への対処方針を決める (要 issue 内で追記検討: 既存データはそのままか、クリーンアップ手段を用意するか)

## TODO

<!-- wip 時のみ -->
