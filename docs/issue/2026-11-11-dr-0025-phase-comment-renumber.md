---
title: コードのコメントに残る「DR-0025 Phase 1 / Phase 2」を、書き直した DR-0025 の節番号に付け替える
status: open
category: task
created: 2026-11-11T19:37:38+09:00
last_read:
open_entered: 2026-11-11T19:37:38+09:00
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

# コードのコメントに残る「DR-0025 Phase 1 / Phase 2」を、書き直した DR-0025 の節番号に付け替える

## 概要

DR-0025 は 2026-11-11 に今の実装に合わせて書き直され、Phase の分割表が無くなった (節は §1 workflow の phases / agents、§2 agent tree、§3 wire の形、§4 transcript_read、§5 読んでよい範囲、§6 webui の入口、§7 URL、§8 扱わないこと)。コードのコメントには「DR-0025 Phase 1」「DR-0025 Phase 2」という呼び方が 25 か所ほど残っていて、DR を開いても該当の節が見つからない。

## やること

- `rg -n -a 'DR-0025 Phase' packages hooks --glob '!*.bundle.js'` で出る箇所を、それぞれが言っている内容に合う節番号 (§1〜§8) に付け替える。動きは変えない (コメントだけ)
- 付け替える時に、コメントの中身が今の実装と合っているかも見る (2026-11-11 の検査で、コメントと実際の動きの食い違いが 3 か所見つかって直した。同じ類が残っていれば直す)
- protocol の src のコメントを変えた時は `bun hooks/bundle.ts --check` で bundle が変わらないことを確かめる

## 受け入れ条件

- [ ] `rg -a 'DR-0025 Phase' packages hooks --glob '!*.bundle.js'` が 0 件
- [ ] 付け替えた節番号が、書き直した DR-0025 の該当の節の内容と合っている
- [ ] 全テストと lint が通る
