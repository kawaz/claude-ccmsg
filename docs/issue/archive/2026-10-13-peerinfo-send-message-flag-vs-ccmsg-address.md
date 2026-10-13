---
title: PeerInfo.send_message と ccmsg:<sid> 宛先の役割整理
status: resolved
category: design
created: 2026-10-13T15:45:03+09:00
last_read: 2026-10-13T16:21:31+09:00
open_entered: 2026-10-13T15:45:03+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-13T16:26:40+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","dr/DR-0037"]
blocked_by:
origin: 自リポ TODO
---

# PeerInfo.send_message と ccmsg:<sid> 宛先の役割整理

## 概要

`PeerInfo.send_message` (同じ config home なら harness の名前で SendMessage できる印) の意味が、DR-0037 の `ccmsg:<sid>` 宛先 (config home をまたいで SendMessage で届く) と重なる。`peers` の `addresses` が入った今 (v0.163.0)、`send_message` を残す意味を整理し、webui の表示と CLI の出力でどちらを案内するかを決める。

## 背景

`send_message` を残す意味の候補は、harness 直の名前解決が使える (速い) ことと、文面が本物であること。`ccmsg:<sid>` は config home をまたいで届く。両者の使い分けを利用者の語彙で案内できる形に揃えたい。

## 受け入れ条件

- [ ] `send_message` を残すか、`addresses` に統合するかの裁定
- [ ] webui の表示と CLI の出力で案内する宛先の方針決定
