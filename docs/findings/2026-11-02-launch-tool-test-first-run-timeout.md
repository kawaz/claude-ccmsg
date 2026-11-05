# launch-tool.test.ts の 5000ms timeout の真因

- Date: 2026-11-02
- 対象: ccmsg v0.211.0 (`main@origin` = d564bc64)、bun 1.4.2、macOS (Darwin 25.5.0)
- 動機: [issue 2026-11-02-launch-tool-test-first-run-timeout](../issue/2026-11-02-launch-tool-test-first-run-timeout.md)。`packages/daemon/test/launch-tool.test.ts` の「a subagent's launch past the wait is told to it, and logged when it cannot be」が `just test` / `just coverage` で `timed out after 5000ms` になる
- 方法:
  - test に一時的な計装 (各段の時刻と、`releaseGates` が読んだ時のディレクトリの中身を stderr に出す) を入れて単独で繰り返し実行した。計装は commit していない
  - 起動コマンドと同じ mock を daemon と同じ `Bun.spawn` (stdin に Blob、`detached: true`) で起こし、50ms 後に FIFO があるかを数えるスクリプトを回した
  - bun の `setDefaultTimeout` が preload からどのファイルに効くかを、6 秒眠るだけの test 3 ファイルで確かめた

## 真因

| 層 | 何が起きているか | 証拠 |
|---|---|---|
| 症状 | test が `timed out after 5000ms` で落ちる | 下の「再現」 |
| 1 | test は `await Promise.all(ctx.daemon.launches)` で、起動コマンドが `launch_timeout_seconds` (既定 10 秒) で止められるまで待っていた | 計装: `releaseGates found 0` の後、`launches done` まで 9952ms |
| 2 | `releaseGates` が FIFO を 1 つも見つけず、起動コマンドを放していなかった。FIFO は起動コマンド自身が起動後に `mkfifo` で作る。test は daemon が `running` を返した直後 (`launchToolWaitMs` = 50ms の後) にディレクトリを読むが、50ms の内に起動コマンドが `mkfifo` まで進む保証は無い | 計装: `releaseGates found 0: gated,gated.script`。起動から 50ms 後に FIFO が無かったのは 30 回中 2 回 (3 回の計測とも同じ)、起動から FIFO ができるまで最大 280ms |
| 3 | timeout が 15 秒でなく 5 秒なのは、preload (`packages/testkit/src/test-env.ts`) の `setDefaultTimeout(15_000)` が bun 1.4.2 では最初に走るテストファイルにしか効かないため。launch-tool.test.ts は単独なら最初のファイルなので 15 秒で、10 秒待った後に pass する | 下の「preload の timeout」 |

同じ形の待ちは「a launch past the wait is answered running, and its outcome is told when it ends」にもある。FIFO を見逃すと起動コマンドは 10 秒で止められ、`h.nextUser()` に届く知らせが exit_code 143 のものになるので、単独では 10 秒後の assert で、全体では 5000ms の timeout で落ちる (単独の実行で 1 回観測、10280ms で fail)。

「1 回目だけ落ちる」は観測では規則になっていない。単独の実行でも、直す前は 30 回中 11 回が 5 秒を超えた (FIFO を見逃した回)。起動コマンドが 50ms を超える回の割合が 1 回目の実行で高い理由は未特定 (未検証)。

## 再現

| 条件 | 結果 |
|---|---|
| 直す前、test ファイル単独で 30 回 | 11 回が 5 秒超 (10〜20 秒)、うち 1 回 fail。最大 20440ms |
| 直す前、起動コマンドの頭に `sleep 0.3` を足して単独 (= 50ms の内に FIFO ができない状態を作る) | 「…outcome is told when it ends」が 10286ms で fail、全体 20.55s |
| 同じく `sleep 0.3` を足し、別のテストファイルの後に走らせる (`bun test agent-transcripts.test.ts launch-tool.test.ts`) | 2 つの test がどちらも `timed out after 5000ms` (5012ms / 5004ms)。issue の症状と同じ |
| 直した後、test ファイル単独で 30 回 | 0 fail、最大 642ms |
| 直した後、起動コマンドの頭に `sleep 0.3` を足して単独 | 4 pass、1193ms |
| 直した後、全体の `bun test` を別プロセスで並走させながら、`agent-transcripts.test.ts` の後に走らせる (= 5000ms の期限) を 15 回 | 0 fail、最大 1115ms |
| 直した後、`just test` を 3 回連続 (別の作業コピーの `just push` の test 段と重なった時間を含む、load average 7〜11) | 3 回とも 4613 pass / 0 fail (83.33s / 81.98s / 81.64s) |

`just test` の 3 回の前に bun のキャッシュは消していない。直す前の失敗はキャッシュの冷え具合ではなく起動コマンドの起動の速さで決まり、キャッシュの温まった単独の実行でも再現したため。

## preload の timeout

`setDefaultTimeout(15_000)` だけを持つ preload と、6 秒眠る test を 1 つずつ持つ `a` / `b` / `c` の 3 ファイル:

| 実行 | a | b | c |
|---|---|---|---|
| `bun test` | pass | 5000ms で timeout | 5000ms で timeout |
| `bun test c b a` (走る順は a → b → c のまま) | pass | 5000ms で timeout | 5000ms で timeout |
| `bun test --timeout 15000` | pass | pass | pass |

preload の注釈 (「One timeout for every test」) と実際が食い違っている。今回の直しはこれに依らない (直した後の test は 1 秒未満で終わる) ので、[issue 2026-11-02-bun-preload-default-timeout-first-file-only](../issue/2026-11-02-bun-preload-default-timeout-first-file-only.md) に分けた。

## 直し方

FIFO を test が起動の前に作り、起動コマンドはその FIFO を読むだけにした。test の書き込みは FIFO を開く時に読み手 (起動コマンド) が開くのを待つので、起動コマンドの起動がどれだけ遅くても、放す前に放してしまうことが無い。各 test の起動は 1 つなので FIFO も 1 つで足りる (起動コマンドごとに FIFO を作るのは、同時に複数を走らせる session-launcher-integration.test.ts の都合)。test の主張と assert は変えていない。

## 未検証

- 直す前に「1 回目の `just test` で落ちやすい」理由 (起動コマンドの起動が 50ms を超えやすい状況が 1 回目に寄るか)
