---
title: protocol v2 に汎用 kv op を追加
status: open
category: request
created: 2026-09-08T11:05:51+09:00
last_read:
open_entered: 2026-09-08T11:05:51+09:00
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

# protocol v2 に汎用 kv op を追加

## 概要

v2 に汎用 kv op (kv_read / kv_write / kv_delete + topic kv:<ns>) を追加する。用途は DR-0033 §7 のテーマ永続化 (ユーザデフォルト / デバイス固有)。案の正本は DR-0033 §7.1、main ws (protocol 担当) が op 表と ccmsg-protocol リポ (TypeBox) に反映する。合意経緯: r281m8/m9

## 背景

DR-0033 §7 のテーマ永続化 (ユーザデフォルト / デバイス固有) を実現するために、protocol v2 に汎用の key-value 操作が必要という結論に至った。案の正本は DR-0033 §7.1。

## 受け入れ条件

- [ ] DR-0033 §7.1 の案に沿って op 表 (kv_read / kv_write / kv_delete) が定義される
- [ ] topic 命名 `kv:<ns>` が反映される
- [ ] ccmsg-protocol リポの TypeBox スキーマに反映される

## TODO

<!-- wip 時のみ -->
