---
title: テストが起こした daemon がテスト終了後も残り続ける (subscribe-duplicate ほか)
status: open
category: bug
created: 2026-10-09T10:11:22+09:00
last_read: 2026-10-18T14:48:01+09:00
open_entered: 2026-10-09T10:11:22+09:00
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

# テストが起こした daemon がテスト終了後も残り続ける (subscribe-duplicate ほか)

## 概要

テストが起こした daemon が、テストの終了後も残り続けていた (2026-10-09 に観測し、統括が止めた)。残っていたのは 3 つで、環境変数の state dir から出どころが分かる。

1. `packages/cli/test/subscribe-duplicate.test.ts` の `ccmsg-dup-*` を state dir にした `daemon run` が 2 つ (別々の `just test` の実行時刻のもの)
2. `packages/daemon/test/session-input.test.ts` の `ccmsg-si-*` の daemon が 1 つ (10/8 の実行時。その後このテストには後始末が足されているので再発するかは未確認)

subscribe-duplicate のほうは `just test` のたびに残る可能性が高い。

## 調べること

- subscribe-duplicate のテストが daemon をどう起こし、どこで止めているか (テストが失敗・timeout した時も含めて止まるか)
- `daemon run` を子として起こしている場合、親のテストプロセスが終わっても子が残る経路が無いか

## 直し方の方針

テストが起こした daemon は afterEach / afterAll で必ず止め、止まったことを確かめる。テストの一時ディレクトリも片付ける (temp-files rule)。

## 受け入れ条件

- [ ] `just test` を 2 回続けて流した後に、リポの `packages/daemon/src/index.ts` を起動したプロセスが残っていない (`ps` で確かめる)
- [ ] subscribe-duplicate / session-input とも、失敗・timeout 時を含めて daemon と一時ディレクトリが片付く
