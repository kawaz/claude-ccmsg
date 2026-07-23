---
title: Terminal iframe に hyoui fab の回避位置パラメータを追加
status: blocked
category: request
created: 2026-07-23T12:19:42+09:00
last_read:
open_entered:
wip_entered:
blocked_entered: 2026-07-23T12:19:42+09:00
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by: hyoui 側のパラメータ仕様確定 (r53 を watch)
origin: r53m1 (hyoui セッション、kawaz 指示)
---

# Terminal iframe に hyoui fab の回避位置パラメータを追加

## 概要

Terminal タブで hyoui embed の fab と ccmsg の＋ボタンが右下で重なる問題。
hyoui 側が fab 初期位置をエッジ相対のクエリパラメータで指定可能にする実装中で、
仕様確定後に r53 で共有される。

ccmsg 側の対応は `buildTerminalEmbedUrl`
(`packages/webui/src/client/terminal-gateway-store.ts`、現状 `embed=1&resize=1` に集約済み)
へ回避位置パラメータを追加するだけ。

## 背景

- 回避位置の目安は「右下から left 方向 ~80px または bottom ~80px」
  (ccmsg FAB 初期位置 right/bottom 1.2rem + サイズ 3.2rem との重なり回避)
- r53m2 で ccmsg 側の FAB 情報は hyoui セッションへ返信済み
- blocked: hyoui 側のパラメータ仕様確定待ち (r53 を watch)

## 受け入れ条件

- [ ] hyoui 側のクエリパラメータ仕様が確定している
- [ ] `buildTerminalEmbedUrl` に回避位置パラメータを追加し、fab と＋ボタンの重なりが解消される
