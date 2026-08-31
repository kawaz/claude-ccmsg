---
title: Timeline でネイティブ (SendMessage/ListAgents) クロスセッションメッセージをバブル表示
status: resolved
category: design
created: 2026-08-27T10:05:36+09:00
last_read:
open_entered: 2026-08-27T10:05:36+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-31T12:58:42+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","done:v0.118.0 で実装済み、packages/webui/src/client/transcript-model.ts:2110 PEER_MESSAGE_TAGS で確認"]
blocked_by:
origin: 自リポ TODO
---

# Timeline でネイティブ (SendMessage/ListAgents) クロスセッションメッセージをバブル表示

## 概要

Claude Code ネイティブのクロスセッションメッセージ (SendMessage/ListAgents) を ccmsg webui
Timeline のエージェント間通信バブルとして表示する。

## 背景

ネイティブ機能は本文 inline 配送で read ステップ不要という UX 優位があり併用が予想されるが、
kawaz からはやり取りが一切見えない (ccmsg room に乗らない)。

kawaz 案 (r151m27): 受信側 transcript には
`<cross-session-message from="uds:..." from-name="..." from-mode="...">` タグ付き user-turn
レコードとして残るので、transcript 解析 (transcript-model の segment 分類) に新種のマッチ
パターンを追加し、既存のエージェント間通信メッセージバブルの見た目に落とし込めば良い。
送信側は SendMessage の tool_use レコードから対で拾える見込み。

実機確認済みの実例: 2026-08-27 に本セッション (sid 78f7a78b... 由来の worktree main ws) ↔
使い捨て probe セッション間で往復し、受信形式が上記タグ形式であることを確認。

## 受け入れ条件

- [x] Timeline 上でネイティブ送受信メッセージが from-name 付きのエージェント通信バブルとして表示される
