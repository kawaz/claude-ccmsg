---
title: 隠れている SessionView 配下への store 変更通知を止める
status: open
category: design
created: 2026-10-14T15:31:33+09:00
last_read: 2026-10-18T14:26:34+09:00
open_entered: 2026-10-14T15:31:33+09:00
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

# 隠れている SessionView 配下への store 変更通知を止める

## 概要

webui の store を useSyncExternalStore + selector にした後 (v0.168 予定) も、cache 中で隠れている SessionView 配下の Timeline (x3) は peers / rooms / says / connStatus の変化で再描画する。store-selector worker の計測では、開いていない別セッションの peer 変更 1 回で 612 render。Timeline が描画に peers・rooms を使うため。

## 案

- 隠れている間はそのセッション表示の配下へ変更通知を止める store (購読を保留し、表示に戻った時に最新 snapshot で 1 回だけ通知) を SessionView から context で配る
- 代案: SessionView 側で Timeline を memo で包む

## 受け入れ条件

- [ ] 隠れている SessionView 配下の Timeline が store 変更で再描画されない
- [ ] 表示に戻った時に最新 snapshot へ追従する
