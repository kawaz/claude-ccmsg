---
title: エージェント向け ccmsg 宛先の案内を v1 plugin に置く
status: open
category: design
created: 2026-10-13T15:45:43+09:00
last_read:
open_entered: 2026-10-13T15:45:43+09:00
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

# エージェント向け ccmsg 宛先の案内を v1 plugin に置く

## 概要

DR-0037 (v0.163.0) でエージェント間の送信は `SendMessage({to: "ccmsg:<sid>"})` になったが、v1 plugin にはエージェント向けの案内が無い (skill 無し、SessionStart hook は文脈を注入しない)。返信は封筒の `from` をそのまま `to` に書けば済むが、初手で相手を探す導線 (`ccmsg peers` の `addresses` → `ccmsg:<sid>` / `ccmsg:path:<dir>`) をエージェントが知る面が `ccmsg peers --help` しか無い。

候補:

- (a) v1 plugin に skill を置く (v2 の `ccmsg:ccmsg` skill と名前が衝突しない名前で)
- (b) SessionStart hook の additionalContext で 2〜3 行の案内を注入する
- (c) rules 側 (claude-rules-personal) に書く

裁定待ち。

## 背景

DR-0037 の実装後、宛先の指定方法を知る面が CLI の help に限られていることが判明した。

## 受け入れ条件

- [ ] 案内の置き場 (a / b / c) が裁定される
- [ ] 裁定した面にエージェントが `ccmsg peers` → `addresses` → `SendMessage` の導線を読める形で載る
