---
title: テストが起こした daemon がテスト終了後も残り続ける (subscribe-duplicate ほか)
status: resolved
category: bug
created: 2026-10-09T10:11:22+09:00
last_read: 2026-10-18T14:48:01+09:00
open_entered: 2026-10-09T10:11:22+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T15:08:38+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","done:テストが起こした daemon を test run の寿命に結んだ。一時ディレクトリの残留は test-tmpdir-leak-on-pass に分離"]
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

## 結果

### 真因 (実機で確かめた)

1. bun test (1.4.2) は `process.on("exit")` / `beforeExit` を発火しない。素の `bun` では発火するが、bun test では test が pass / fail / timeout のどれでも発火しなかった。helpers.ts の spawnDaemonProc が登録していた exit 時の kill は一度も動いていなかった。
2. テストが daemon を止める前に落ちると、daemon (bun test の直接の子) が残る。startTestDaemon の後で assert が落ちる一時テストで再現し、親が pid 1 に付け替わって残った。webhook / user-prompt のように setup が spawn の後で throw した回がこれに当たる。
3. CLI 経由で起こした daemon は、CLI が detached で spawn する孫で bun test は知らない。test が timeout すると finally の `daemon stop` が走らず、bun の「dangling process の kill」も届かず残る (一時テストで再現)。timeout した test の直接の子は bun が kill する (再現)。
4. 2026-10-15 10:03〜11:29 の ccmsg-wh ×9 / ccmsg-si ×5 は、両テストを変更した DR-0036 段 C の作業時間帯と重なり、setup が spawn の後で throw した回と整合する (推定。その回のログは無く未検証)。

### 直し方

preload (packages/testkit/src/test-env.ts) が UNIX socket を listen し、`CCMSG_TEST_LIFELINE` で daemon に渡す。daemon は listen の前にそこへ繋ぎ、切れたら shutdown する (packages/daemon/src/test-lifeline.ts)。run の終了・失敗・SIGINT・SIGKILL のどれでも kernel が接続を切る。daemon は自分の shutdown の始めに line を離すので、最後のテストの後にまだ繋がっている daemon は止めなかったテストのものとして run を落とし、state dir を並べる。env が無い本番の daemon は何もしない。helpers.ts の exit 時 kill は動かないので消した。規約は docs/TESTING.md の決定性の節。

### 受け入れ条件の確認

- `just test` を 2 回続けて流し、どちらも 4047 pass / 0 fail。前後でこのリポの daemon の `daemon run` は 0 本
- bun test を daemon (直接の子と CLI の孫) を持ったまま SIGKILL / SIGINT し、両方とも即座に消えた
- packages/daemon/test/test-lifeline.test.ts: lifeline の持ち主を SIGKILL すると daemon が graceful に終わる、daemon を止めずに終わる run が exit 1 で state dir を並べて落ち、その daemon も消える。daemon 側の接続と run 終了時の検査をそれぞれ外すと落ちることを確かめた
- 一時ディレクトリの片付けは、daemon の残留とは別の原因 (pass した run でも残る) なので test-tmpdir-leak-on-pass に分けた
