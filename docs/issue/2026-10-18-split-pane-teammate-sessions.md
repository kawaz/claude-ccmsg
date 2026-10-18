---
title: split pane の teammate を ccmsg のセッションとしてどう扱うか
status: open
category: design
created: 2026-10-18T14:02:37+09:00
last_read:
open_entered: 2026-10-18T14:02:37+09:00
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

# split pane の teammate を ccmsg のセッションとしてどう扱うか

## 概要

split pane の teammate を ccmsg のセッションとしてどう扱うか。agent teams が有効で teammateMode が tmux / iTerm2 の split pane を選ぶと、name 付きの Agent の子は別プロセス・別 sid の teammate になる。leader の module からは `$.agent.list()` に `id===teammateId` で running/idle として見えるが、agentId 付きの `turn.*` は起きず、`$.session.append({agentId})` は no running loop で拒否される (DR-0039 §6 の直送の宛先にならない)。teammate のプロセスは自分の sid で ccmsg の sidecar を起こすが、daemon の agents poll (`claude agents`) に載らないので "dropped: its harness is gone (not listed)" で捨てられ、peers / send の宛先にもならない。

決めること:

1. daemon が teammate のプロセスを別セッションとして受けるか (argv の `--parent-session-id` / team config の members から leader と結び付けられるか要調査)
2. webui で leader のセッションに「このセッションの teammate」として見せるか
3. readSubagents (module 読み込み時に `$.agent.list()` の running を一覧にする) が split pane の teammate も拾う件 (観測では split pane は `id===teammateId`、in-process は `id!==teammateId` だが API の約束ではない)

## 背景

根拠: `docs/findings/2026-10-18-subagents-teammate-vs-subagent.md`。

## 受け入れ条件

- [ ] 上記 3 点の方針が裁定され、DR か実装 issue に落ちている
