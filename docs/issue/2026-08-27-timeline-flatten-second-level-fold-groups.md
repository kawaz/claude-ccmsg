---
title: TL の fold 構造の簡素化 (2 段目グルーピング廃止)
status: open
category: task
created: 2026-08-27T10:38:40+09:00
last_read:
open_entered: 2026-08-27T10:38:40+09:00
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

# TL の fold 構造の簡素化 (2 段目グルーピング廃止)

## 概要

Timeline の fold 構造を簡素化する。現在 fold 内は「thinking / peer-message /
ccmsg 等のバブルだけ個別表示、間の連続 item は『N items』の 2 段目 folding に
まとめる」2 層構造だが、この 2 段目のグルーピングを廃止し、fold 内の全 item を
最初から個別の 1 行 item として展開表示する (例: `▶︎ 10:24:33 Bash Re-check ...`
/ `▶︎ 10:24:40 queue-operation: remove` のように時刻+種別+要約の行が並ぶ)。
外側 1 段目の fold (`▶︎ 1 thinking + 5 items`) は維持する。

## 背景

kawaz 指示 (r151m38、2026-08-27)。kawaz 曰く「ここ無駄に複雑な処理になってたので
だいぶシンプルになる」— グルーピング判定ロジックの削除が主。

着手タイミング: ネイティブメッセージバブル統合
(2026-08-27-timeline-native-cross-session-message-bubbles) が Timeline.tsx /
transcript-model.ts を編集中のため、その land 後に着手する。

## 受け入れ条件

- [ ] fold 内の 2 段目グルーピングロジックが削除されている
- [ ] fold 内の全 item が個別の 1 行 item (時刻+種別+要約) として表示される
- [ ] 外側 1 段目の fold 表示 (`▶︎ N thinking + M items` 等) は維持されている
