---
title: launch-tool.test.ts の subagent launch テストが just test の 1 回目だけ 5000ms で timeout する
status: resolved
category: bug
created: 2026-11-02T17:30:34+09:00
last_read:
open_entered: 2026-11-02T17:30:34+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-05T14:48:59+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","finding/2026-11-02-launch-tool-test-first-run-timeout"]
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

## 原因と修正 (2026-11-02)

原因: test 側の同期の欠け。待ちを超える起動の test 2 件 (「…outcome is told when it ends」と「a subagent's launch past the wait…」) は、daemon が `launchToolWaitMs` (50ms) の後に `running` を返した直後に、起動コマンドが自分で `mkfifo` する FIFO をディレクトリから探して放していた。50ms の内に起動コマンドがそこまで進まないと (起動から 50ms 後に FIFO が無かったのは 30 回中 2 回、負荷が高いほど増える) 何も放さず、起動コマンドは `launch_timeout_seconds` (10 秒) で止められるまで待つ。5000ms で落ちたのは、preload の `setDefaultTimeout(15_000)` が最初に走るテストファイルにしか効かないため (単独なら 15 秒で、10 秒待って pass する。別に [bun-preload-default-timeout-first-file-only](./2026-11-02-bun-preload-default-timeout-first-file-only.md))。製品側の実装には原因が無かった。

修正 commit: zwmsnzkt (630f9e1d)。FIFO を test が起動の前に作り、起動コマンドはそれを読むだけにした。test の書き込みは読み手が開くまで待つので、起動の遅さに依らない。主張と assert、timeout は変えていない。

証拠と再現の表は [findings 2026-11-02-launch-tool-test-first-run-timeout](../findings/2026-11-02-launch-tool-test-first-run-timeout.md)。直した後の `just test` は 3 回連続で 4613 pass / 0 fail。
