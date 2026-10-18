---
title: tsconfig で noUncheckedIndexedAccess を有効にする
status: open
category: design
created: 2026-10-13T12:48:19+09:00
last_read: 2026-10-18T17:35:01+09:00
open_entered: 2026-10-13T12:48:19+09:00
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

# tsconfig で noUncheckedIndexedAccess を有効にする

## 概要

tsconfig で `noUncheckedIndexedAccess` が無効なため `arr[i]` の型が `T` になり、DR-0038 §5「値が無い場合を型で表して分岐で扱う」が配列・index signature の添字アクセスでは機械的に強制されない。

## 背景

2026-10-13、§5 の lint 全体化の worker が指摘。`arr[i]!` を外しても型の上では同じ意味になっていた。有効にすると本番とテストの両方に広く波及するので、別作業として検討する。
