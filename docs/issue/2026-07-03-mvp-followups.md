---
title: MVP (v0.0.1) からの引き継ぎ残課題 3 点
status: open
category: task
created: 2026-07-03T23:09:37+09:00
last_read:
open_entered: 2026-07-03T23:09:37+09:00
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

# MVP (v0.0.1) からの引き継ぎ残課題 3 点

## 概要

MVP 実装 (v0.0.1) からの引き継ぎ残課題 3 点。いずれも MVP blocker ではない。

## 背景

1. **Linux での flock 再検証**: `packages/daemon/src/flock.ts` は `bun:ffi` で
   `libSystem.B.dylib` の `flock(2)` を呼ぶ macOS 前提実装。platform 分岐は
   用意済みだが Linux (`libc.so.6`) は未検証
   (`docs/findings/2026-07-03-bun-uds-compile-verification.md` 参照)。
2. **version mismatch 経路の自動テスト**: `ensure-daemon` のコードパスは
   実装済みだが、二版の daemon が必要なため自動テスト未カバー。テスト用
   シームを本番コードに足さない方針とのトレードオフを検討して手段を決める。
3. **CLI に `leave` サブコマンド追加**: daemon 側 op は実装済み
   (`docs/decisions/DR-0003-wire-protocol.md` §4)、CLI 未提供。dogfood で
   必要が観測されたら追加。

## 受け入れ条件

- [ ] Linux 環境で `flock.ts` の `libc.so.6` 経路を実機検証する (または
      検証不要と判断した根拠を記録する)
- [ ] version mismatch 経路のテスト方針 (本番コードへのシーム追加 vs
      他の検証手段) を決めて実施する
- [ ] CLI に `leave` サブコマンドを追加する (または dogfood で不要と
      判明した場合はその判断を記録する)
