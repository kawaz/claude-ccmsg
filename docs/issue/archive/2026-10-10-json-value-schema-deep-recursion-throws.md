---
title: json-value-schema-deep-recursion-throws
status: resolved
category: bug
created: 2026-10-10T14:24:05+09:00
last_read: 2026-10-18T15:30:06+09:00
open_entered: 2026-10-10T14:24:05+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T16:10:59+09:00
discard_reason:
pending_reason:
close_reason: ["done: JsonValue の入れ子に 256 段の上限 (実 transcript 約 320 万行の最深 16 段が根拠) を設け、超えた値は「JSON nested deeper than 256 levels」の型付き失敗として返す。値の種類でスキーマを選ぶ形にして union の指数的な再走査をなくした。20,000 段の配列を含む行が失敗として返り、前後の行は読めることをテストで固定。DR-0038 §3 に追記。commit krkzzuuy"]
blocked_by:
origin: reviewer-sol-high (2026-10-10)
---

# json-value-schema-deep-recursion-throws

## 概要

`packages/protocol/src/json-value.ts` の JsonValueSchema (`v.lazy` の再帰) は transcript の `toolUseResult` や未知行の field を全深度走査する。20,000 階層の配列を含む行で `RangeError: Maximum call stack size exceeded` が parseWith の外へ throw し、DR-0038 §1「失敗は値で返す」・§3「その行だけ失敗」に反する (10,000 階層は ok)。

## 背景

reviewer-sol-high のレビュー (2026-10-10) で指摘。実機の transcript にこの深さは未確認なので優先度は低い。

## 対応候補

- 深さ制限を持つ JsonValue スキーマ
- parseWith で RangeError だけを型付き失敗にする (万能ケアにならない範囲で)

## 受け入れ条件

- [x] 20,000 階層の配列を含む行が throw でなく型付き失敗として返る
- [x] 同じ transcript 内の他の行は影響を受けない
