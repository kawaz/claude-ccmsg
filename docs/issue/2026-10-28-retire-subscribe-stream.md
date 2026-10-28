---
title: subscribe (Monitor 常駐の受信経路) と notify を module 経由に付け替えて廃止する
status: open
category: design
created: 2026-10-28T09:06:13+09:00
last_read:
open_entered: 2026-10-28T09:06:13+09:00
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

# subscribe (Monitor 常駐の受信経路) と notify を module 経由に付け替えて廃止する

## 概要

`ccmsg subscribe` は mods 以前にセッションが Monitor tool で常駐させ、daemon の `ev:"notify"` (`ccmsg notify --self|--sid --text`) と `net_online` を jsonl で受ける経路。DR-0039 で module が `session.append` / prompt 注入を持った今、subscribe を回しているセッションは無く、`notify` は受け手が居なければ捨てられるだけ。

残っている送り手は各リポの justfile の push task 末尾 (`ccmsg notify --self "Monitor で just watch を起動して"`、reference justfile/push-watch が canonical と書く) と webhook 由来の cache keepalive。DR-0039 は「subscribe / notify は本 DR では残す」とし後始末は未決。

案: `notify` の配送先を module の経路 (daemon → sidecar → `session.append` か prompt) に付け替え、`subscribe` と `net_online` を廃止、rules-personal の reference `justfile/push-watch` と各 justfile の文言を追従。

決めること: `notify` を残す (CLI から自セッションに一言入れる口は justfile に便利) か、`say` / `send` で代替するか。着手は kawaz の判断。

## 背景

DR-0039 で module が `session.append` / prompt 注入を持ち、Monitor 常駐の受信経路が不要になった。

## 受け入れ条件

- [ ] `notify` の扱い (残す / `say`・`send` で代替) が決まっている
- [ ] `subscribe` と `net_online` が廃止されている
- [ ] reference `justfile/push-watch` と各 justfile の文言が追従している
