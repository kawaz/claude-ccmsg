---
title: truncated-ccmsg-message-partial-parse-vs-dr0038
status: open
category: design
created: 2026-10-10T12:46:59+09:00
last_read:
open_entered: 2026-10-10T12:46:59+09:00
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

# truncated-ccmsg-message-partial-parse-vs-dr0038

## 概要

`tryParseTruncatedCcmsgMessage` (daemon、本文に埋め込まれた ccmsg event の途中で切れた断片を部分ごとに読み直して救う処理) は DR-0038 §6 「失敗した入力を部分ごとに読み直して分類しない」とぶつかる。段 B (2026-10-10) では触らず残した。

本文に埋め込まれた ccmsg event を扱う段で、次のどちらにするか決めて直す。

- (a) 断片を救わず読めない行として落とす
- (b) 切り詰め自体を無くす (埋め込む側で全文を入れる)

## 背景

DR-0038 §6 との矛盾。段 B のスコープ外として残置した。

## 受け入れ条件

- [ ] (a) / (b) のどちらかを決定し、DR-0038 §6 と整合する形に直す
