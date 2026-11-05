---
title: preload の setDefaultTimeout(15_000) が最初に走るテストファイルにしか効かず、2 番目以降は 5000ms のまま
status: open
category: bug
created: 2026-11-02T18:10:00+09:00
last_read:
open_entered: 2026-11-02T18:10:00+09:00
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

# preload の setDefaultTimeout(15_000) が最初に走るテストファイルにしか効かず、2 番目以降は 5000ms のまま

## 概要

`packages/testkit/src/test-env.ts` (bunfig.toml の `[test] preload`) は `setDefaultTimeout(15_000)` を呼び、注釈で「One timeout for every test」と言っている。bun 1.4.2 では、これが最初に走るテストファイルにしか効かない。2 番目以降のファイルの test は bun の既定の 5000ms で timeout する。

そのため、テストファイルを単独で走らせると 15 秒、`just test` / `just coverage` の中で走らせると 5 秒になり、同じ test の期限が実行の仕方で変わる。[launch-tool-test-first-run-timeout](./2026-11-02-launch-tool-test-first-run-timeout.md) で「単独なら通る、全体では 5000ms で落ちる」と見えた理由の 1 つがこれだった ([findings](../findings/2026-11-02-launch-tool-test-first-run-timeout.md))。

## 再現 (観測、bun 1.4.2、macOS)

一時ディレクトリに次の 3 つを置く:

- `setDefaultTimeout(15_000)` だけを呼ぶ preload `pre.ts`
- bunfig.toml: `[test] preload = ["./pre.ts"]`
- `a.test.ts` / `b.test.ts` / `c.test.ts`: どれも `await Bun.sleep(6000)` をする test を 1 つだけ持つ

| 実行 | a | b | c |
|---|---|---|---|
| `bun test` | pass | 5000ms で timeout | 5000ms で timeout |
| `bun test c.test.ts b.test.ts a.test.ts` (走る順は a → b → c のまま) | pass | 5000ms で timeout | 5000ms で timeout |
| `bun test --timeout 15000` | pass | pass | pass |

## 背景

対処の方針は決めていない。対処すると全テストの実効の期限が変わる (今は 2 番目以降のファイルが 5 秒で走っている) ので、その影響も含めて判断する。

## 受け入れ条件

- [ ] 各テストファイルの実効の期限が、preload の注釈 (または対処後に正本とする設定) と一致することを観測で確かめる
