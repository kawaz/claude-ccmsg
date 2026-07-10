---
title: subscribe の daemon 再起動透過化 (自動再接続) — upgrade のたびに全セッションへ Monitor 張り直し nag が飛ぶノイズの解消
status: resolved
category: design
created: 2026-07-10T22:22:50+09:00
last_read:
open_entered:
wip_entered: 2026-07-10T22:22:50+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-10T22:45:29+09:00
discard_reason:
pending_reason:
close_reason: ["implemented: サイレント自動再接続 (no-spawn / since 維持 / restarting フィルタ / backoff 250ms-5s 無期限) を実装、実バイナリ subprocess テストで daemon 再起動跨ぎの透過性と no-spawn 契約を固定"]
blocked_by:
origin: 自リポ TODO
---

# subscribe の daemon 再起動透過化 (自動再接続) — upgrade のたびに全セッションへ Monitor 張り直し nag が飛ぶノイズの解消

## 概要

現状 bump→push→plugin 更新→新 client 接続で daemon が自動 upgrade 再起動し、restarting broadcast で全セッションの subscribe stream (Monitor) が終了、UserPromptSubmit hook が毎回張り直しを nag する。

対応方針: subscribe を daemon 切断/restarting で exit させず自動再接続する。

- (a) since 状態を維持して再 subscribe (重複配信なし)
- (b) restarting(reason=upgrade) イベントは stdout に流さず黙って再接続
- (c) 再接続は no-spawn (意図的な daemon stop を resurrection しない)、backoff 上限 5s で無期限リトライ
- (d) 旧バイナリ subscribe が新 daemon に繋いでも newer-wins (v0.3.1) で flap しない

## 背景

kawaz 指摘 (2026-07-10 verbatim):

> アップデートされるとccmsg起動し直せとか全セッションに通知くる感じ?頻繁だと他セッションがうるさそうなのでしばらくバージョンバンプ無しでローカルdaemonをでだ再起動管理するとかでも良いかもしれん?難しいならいいけど

現行は daemon の自動 upgrade 再起動のたびに subscribe (Monitor) が切断され、全セッションで張り直しの nag が発生する。頻繁な bump サイクルだとこのノイズが顕著になる。

## 受け入れ条件

- [x] daemon 再起動を跨いで subscribe プロセスが生存し、跨ぎ前後の post が漏れ・重複なく stdout に出ることをテストで保証
- [x] daemon stop 中に daemon が spawn されないこと (no-spawn 再接続、意図的な stop を resurrection しない)
- [x] restarting(reason=upgrade) イベントは stdout に流さず黙って再接続する
- [x] since 状態を維持した再 subscribe で重複配信が起きない
- [x] backoff 上限 5s で無期限リトライすること
- [x] 旧バイナリ subscribe が新 daemon に繋いでも newer-wins (v0.3.1) で flap しないこと
- [x] DR-0002 §4 との整合を確認し、必要なら追補する

## TODO

- [x] DR-0002 §4 を読み、現行の restarting broadcast 仕様と本方針の整合性を確認
- [x] subscribe 側の再接続ロジック (since 維持 / no-spawn / backoff) の設計
- [x] daemon 側 restarting(reason=upgrade) イベントの扱い変更 (stdout 非表示化)
- [x] newer-wins (v0.3.1) との相互作用を確認するテストケース設計
- [x] daemon 再起動を跨ぐ E2E テストの実装
