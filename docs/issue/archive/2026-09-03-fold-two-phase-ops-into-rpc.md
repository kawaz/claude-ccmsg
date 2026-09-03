---
title: 2-phase op を「Promise が長い RPC」に畳む
status: resolved
category: task
created: 2026-09-03T10:55:56+09:00
last_read: 2026-09-03T11:49:43+09:00
open_entered: 2026-09-03T10:55:56+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-03T12:15:04+09:00
discard_reason:
pending_reason:
close_reason: ["dr/DR-0029", "implemented"]
blocked_by:
origin: 自リポ TODO
---

# 2-phase op を「Promise が長い RPC」に畳む

## 概要

v0.136.0 で全要求に request_id が付き応答が相関されるようになったため
(DR-0029 addendum)、「accept 即返し + request_id 付き result イベント」という
2-phase の型は不要になった。現在 acceptTwoPhase 経由の op (session_search /
session_launch / session_kill / session_dump_file / translate 等) は単に
未着手で残っているだけで、後方互換のために残しているのではない
(kawaz r259m33: 後方互換は原則実装しない、host 単位で丸ごと進化)。

各 op を「await して 1 応答で返す」形に畳み、acceptTwoPhase と result イベント型、
webui ws.ts の sendTwoPhase 経路を撤去する。translate のように部分結果を段階的に
流す op はイベント配信として残す (それは 2-phase ではなく stream)。

## 背景

DR-0029 addendum で request_id による応答相関が全要求に付いたことで、
2-phase op が解決していた「非同期応答をどう相関させるか」という問題は
汎用の request_id 機構で既に解決済みになった。2-phase の型を個別 op に
残す理由がなくなっている。

## 受け入れ条件

- [ ] acceptTwoPhase と `*_result` イベント型が protocol / daemon / webui から消える (stream 用途を除く)
- [ ] 各 op が 1 応答で返り、webui / CLI が Promise で受ける
- [ ] 既存テストは応答形の変更に追従、全 green
