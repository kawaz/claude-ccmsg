---
title: llm gateway の stats の tokens object が wire に写らず webui のトークン集計が常に 0
status: open
category: bug
created: 2026-10-11T20:26:13+09:00
last_read:
open_entered: 2026-10-11T20:26:13+09:00
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

# llm gateway の stats の tokens object が wire に写らず webui のトークン集計が常に 0

## 概要

llm gateway の stats は model ごとの token 数を `tokens: {input, output, "input.cache_creation", "input.cache_read", …}` の object で送っている (実機 2026-10-11)。wire の `input_tokens` / `output_tokens` / `cache_*_input_tokens` は一度も埋まらず、webui の llm-stats-view の token 集計は常に 0。

## 背景

段 D では daemon の stats スキーマを v.object で書き、tokens を読まずに今の振る舞いを保った。直すなら daemon の stats スキーマに tokens を足して wire へ写す。wire の field 名を gateway に合わせるか、tokens object をそのまま持たせるかは要判断。

## 受け入れ条件

- [ ] daemon の stats スキーマが tokens を読む
- [ ] webui の llm-stats-view の token 集計が実機の値を表示する
- [ ] wire の field 名の方針 (gateway に合わせる / tokens object を持たせる) を決めて反映する
