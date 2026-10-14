---
title: テスト群の第三者レビュー指摘 (test-suite-review-fresh-eyes) を直す
status: open
category: bug
created: 2026-10-14T14:18:27+09:00
last_read: 2026-10-14T16:08:21+09:00
open_entered: 2026-10-14T14:18:27+09:00
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

# テスト群の第三者レビュー指摘 (test-suite-review-fresh-eyes) を直す

## 概要

`docs/findings/2026-10-14-test-suite-review-fresh-eyes.md` の指摘を直す。規約は `docs/TESTING.md`。

### high

1. webui の component / hook の配線が 0 カバレッジ。happy-dom (GlobalRegistrator を bunfig の preload) で preact の render をマウントする基盤を `webui/test` に 1 本置く。最初の対象は SessionInputComposer (storage event → 入力欄) と Timeline の effect (issue `webui-timeline-decomposition-and-hook-tests` と連動)
2. (済 d3b34fa329eb。残: `cli/test/sidecar.test.ts:108` の `Bun.sleep(1)` は「バイトを別々の write で届ける」ための間隔で観測待ちではないが、coalesce で vacuous pass し得る。sidecar 側に読み取りの区切りを観測する口が無いため未対応) `broadcast.test.ts:577-601, 635-651` の「起きないこと」を `Bun.sleep` で主張する negative テストを、marker の round-trip で順序づける形にする
3. (済 385c4f956ae0) `webui/test/ws.test.ts:182, 537, 1034` の実時間待ち。ws.ts に clock を注入 (hooks の `Engine.clock` と同型) して決定的にする

### medium

4. (済 7578f3cdfff8) `llm-stats-op` / `llm-usage-op` の固定ポート 18941 / 18921 を port 0 にする
5. (済 17257a95fa93) `ws.test.ts` の送信フレームを index で固定している 37 箇所を、op で引く helper にする
6. `session-input.test.ts` の readiness テストを fs.watch から poll 経路に差し替えた件 (v0.166.1 で CI 対策として入れた) は実装の都合で緩めた典型。issue `sidecar-should-not-resolve-its-own-pid` の案 A (bind 時の名乗りを契機) で fs.watch 依存ごと解消し、テストは名乗り経路で書き直す

### 残り (7)〜(12)

findings を参照: 文字列 JSON assert、storedDraftChange の null 経路テスト削除、daemon 328 回起動の速度、stubDaemon の手組み、helper 重複、チャット参照。

## 背景

テスト群の第三者レビューで挙がった指摘。テストを実装の都合で緩めた箇所と、配線が未検証の箇所が中心。

## 受け入れ条件

- [ ] high (1) が解消している
- [ ] medium (6) が解消している
- [ ] (7)〜(12) が findings に沿って解消している
