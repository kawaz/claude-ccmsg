---
title: daemon-spawn-env.test.ts の daemon の停止の待ちを、タイマーでなく接続が閉じるのを待つ形にする
status: resolved
category: task
created: 2026-11-22
close_reason: implemented
---

# daemon-spawn-env.test.ts の daemon の停止の待ちを、タイマーでなく接続が閉じるのを待つ形にする

`packages/cli/test/daemon-spawn-env.test.ts` は、CLI が spawn した (この test の子プロセスでない) daemon を止める時、`stopDaemon` の中の `waitExited` で、間隔を伸ばしながら `kill(pid, 0)` を繰り返して止まるのを待っている。

同じ形の `daemon-detach.test.ts` は、SIGTERM を送る前に `daemon.sock` に繋いでおき、プロセスが終わって kernel が接続を閉じるのを待ってから一時ディレクトリを消す形に直した (止まる途中の daemon と削除が競って一時ファイルが残った件、2026-11-22)。`daemon-spawn-env.test.ts` は `perTestTmpDir` の afterEach が、止まったのを見た後に消すので同じ競合は起きないが、待ち方がタイマーなので同じ部品に揃える。

## やること

- `daemon-detach.test.ts` の「接続が閉じるのを待つ」部品を helpers に出し、`daemon-spawn-env.test.ts` の `stopDaemon` もそれを使う
- 試験の期待は変えない
