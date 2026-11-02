---
title: launch-tool.test.ts の subagent launch テストが just test の 1 回目だけ 5000ms で timeout する
status: open
category: bug
created: 2026-11-02T17:30:34+09:00
last_read:
open_entered: 2026-11-02T17:30:34+09:00
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

# launch-tool.test.ts の subagent launch テストが just test の 1 回目だけ 5000ms で timeout する

## 概要

`packages/daemon/test/launch-tool.test.ts` の「a subagent's launch past the wait is told to it, and logged when it cannot be」が `just test` の 1 回目だけ 5000ms の timeout で落ちる。単独実行 / 2 回目は通る。push の coverage gate が落ちる実害がある。

2026-11-02 に 3 回観測:

- launch-prompt-stdin の test-6-pre
- peers-strict の全体実行
- push の coverage gate 2 回 (ログは tail しか残っておらず、同じ段で落ちたことだけ分かっている)

archive の `2026-10-10-just-test-one-timeout-unidentified` で名前の分からなかった 1 件と同じ症状の可能性がある。

## 背景

原因の切り分け候補 (いずれも未検証):

- `daemon.launchToolWaitMs` と FIFO の待ちの相互作用
- warm 前の初回の bun 起動コスト
- 並列実行の負荷

テストは触らない ([[test-integrity]])。真因を特定して実装側を直す。

## 受け入れ条件

- [ ] 原因を観測で特定する (推測で断定しない。失敗時のログを tee で残す)
- [ ] `just test` を連続で複数回 (cold を含む) 実行して 5000ms timeout が再現しない
- [ ] push の coverage gate が通る
