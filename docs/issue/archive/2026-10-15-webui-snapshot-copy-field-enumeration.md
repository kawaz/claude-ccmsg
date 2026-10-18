---
title: webui が session_status の snapshot を field 列挙で写していて、field を足すたびに漏れる
status: resolved
category: design
created: 2026-10-15T05:51:35+09:00
last_read: 2026-10-18T12:53:11+09:00
open_entered: 2026-10-15T05:51:35+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T13:01:15+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","commit f8158c69"]
blocked_by:
origin: 自リポ TODO
---

# webui が session_status の snapshot を field 列挙で写していて、field を足すたびに漏れる

## 概要

webui で daemon の session_status snapshot を store に入れる箇所が 2 か所あり、どちらも snapshot の field を 1 つずつ列挙して写している。

- `packages/webui/src/client/ws.ts` の `ev: "session_status"` push の受け口
- `packages/webui/src/client/components/SessionView.tsx` の `session_status_subscribe` 応答の受け口

DR-0039 段 6 で snapshot に `subagents` を足した時、両方で `subagents` が落ち、Status タブの subagent 一覧が出なかった (隔離環境の /verify で発見、両方に足して直した)。ws.ts 側は test (`packages/webui/test/ws.test.ts` の session_status push) で固定したが、SessionView 側の写しには test が無い。

## 背景

protocol の `SessionStatusSnapshot` に field を足すたびに、型検査では検出されない手作業の写しが 2 か所要る。optional field なので抜けても型が通る。

## 提案

- 受け口で snapshot を schema で読んだ値をそのまま store に渡す (列挙をやめる)、または
- 写しを 1 つの関数にまとめ、`SessionStatusSnapshot` の全 key を網羅することを型で強制する

採否と形は当事者が裏取りしてから決める。

関連: DR-0039 §6、DR-0020。

## 受け入れ条件

- [x] snapshot に field を足しても受け口の修正が要らない、または漏れが型検査・test で検出される
- [x] SessionView 側の受け口にも test がある
