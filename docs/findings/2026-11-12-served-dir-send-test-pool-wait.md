# served dir への send のテストが macOS の CI で ended / scan_timed_out になったのは、test daemon の webui の bundle と圧縮が bun の pool を塞いでいたため

- Date: 2026-11-12
- 対象: `packages/daemon/test/send-message.test.ts` の `send_message through the daemon > a session in a dir another session announced is not reached; one in a dir CCMSG_CLAUDE_CONFIG_DIRS names is`、GitHub Actions の `ci (macos-latest)` (3 core)、bun v1.4.4
- 動機: このテストが macOS の CI だけで約 4% (97 本中 4 本) 落ち、`ended` か `no_peer_socket: scan_timed_out` を返した (docs/issue/2026-10-18-send-message-served-dir-test-flaky-macos-ci.md)。修正 (commit 0897723c) の根拠になった観測を、CI の log が消える前に原文で残す
- 方法: 調査用の計測を入れた版の CI の log (`gh run view <id> --log`) を読み、修正の前後の run の macOS でのこのテストの所要を集めた。手元の再現の数値は commit message からの引用

## 判明した事実

- テストが起こす daemon は HTTP を配らない (`CCMSG_HTTP_BIND=off`、`packages/daemon/test/helpers.ts` の `spawnDaemonProc` / `startTestDaemon`)。それでも修正前は、daemon の起動 (`run.ts` → `createWebuiApp()`) で webui の client の `Bun.build` と br / gzip の圧縮を無条件に始めていた
- 圧縮は node:zlib の非同期の形 (`packages/webui/src/encoded-asset.ts`、brotli は quality 11) で、出力ごとに `Promise.all` で並べて走る
- CI の macOS の runner では bun の pool の thread は 3 本だった (fs の探り針の最初の行 `pool threads 3 (the cores)`)
- 修正前の run 43045653045 では、HTTP を配らない 2 つの daemon の両方で、起動 75〜80ms 後の非同期の stat が 1046〜1104ms 待ち、直後の同期の stat は 0ms だった。同じ時に sample の `Bun Pool 0/1/2` は、ほぼ全サンプルで bun の中にいた (待機ではない)
- 同じ run の serving の daemon の hello は所在の導出に 1066ms かかったが、hello の始めに置いた 0ms の timer は 3ms しか遅れなかった。event loop は回っていて、非同期の読み込みだけが待っていた
- 修正前の run 43040718384 では、isolated の daemon の send の走査が `1005 ms into a 1000 ms budget (its timers fired 5 ms late in all)` で期限切れになった。テストが落ちた時と同じ仕組みで、期待値がもともと ended だったので、テストは中身を確かめないまま通っていた
- 同じ run で、別の process が `/private/tmp` の直下を 50ms ごとに引いた 3073 回のうち、100ms 以上かかった回は 0 回 (最長 40ms) だった。待ちはファイルシステム全体ではなく、daemon の process の中にあった
- `withinBudget` (`packages/daemon/src/time-budget.ts`) は timer が予定より遅れて鳴った時だけ期限を延ばす。timer が遅れずに読み込みだけが待つと、期限 1 秒 (`RUNS_SCAN_MS` / `INJECT_SCAN_MS`) はそのまま切れる。その場合、送り手には `ended` (liveRuns) か `no_peer_socket: scan_timed_out` (PeerInjector) と返る
- 修正 0897723c で、daemon は HTTP の listener が 1 つ以上立った時だけ webui の `prepare` を呼ぶようにした。HTTP を配らない daemon は bundle も圧縮もしない
- 修正後の 10 本の run では、macOS でのこのテストの所要は 389〜789ms で、落ちた run は 0 本。修正前に取り直した 38 本では 29 本が 1000ms を超えていた。bun は前後とも v1.4.4
- 修正の直前の版 (18daa96b、v0.252.0) から修正後の最初の版 (ac7b33ca、v0.253.0) までで daemon の変更は、0897723c のほかは secret の受け渡しの追加 (`secret-store.ts` ほか) だけ

## 推測のまま残っていること

- 修正前に落ちた 4 本 (40256865972、40667786519、41413717708、42721104070) は、どれも fs の探り針と sample を入れる前の run。落ちた run そのものの pool の様子は捕まえていない。「失敗 ← pool の待ち」は、次の 3 点から推したもの
  - 仕組みが同じ: timer が遅れずに走査が 1 秒を越えた。40667786519 では sidecar の名乗りから peer-inject まで 1041ms、43040718384 では 1005ms
  - 失敗の所要 (1330〜2294ms) が遅い側の山に入る
  - 修正後に遅い側の山が消えた
- CI の pool の 3 本が走らせていたのが `Bun.build` と brotli / gzip だとは、sample に記号が無い (`??? (in bun)`) ので直接は言えない。根拠は次の 2 つ
  - 修正前後の比較: 手元で UV_THREADPOOL_SIZE=3 にした再現と、CI の所要の変化
  - HTTP を配らない daemon の sample に `Bundler` という thread があったこと。この thread が `Bun.build` を呼んだ時だけ立つかは未検証
- `Bun.build` そのものがこの pool で走るかは、bun のソースで確かめていない。pool の大きさの決まり方 (UV_THREADPOOL_SIZE か core の数) は commit 44784603 の message にある bun 1.4.4 のソースの読み (`src/threading/work_pool.rs`、`src/bun_core/util.rs` の `get_thread_count`) による
- 手元の再現の待ち (159〜223ms、441ms) は CI の約 1 秒より小さい。差の理由 (core の速さ、他の負荷) は測っていない

## 実用的な示唆 / ベストプラクティス

- process に 1 つの thread の pool を占める重い仕事 (bundle、圧縮) は、それを使う経路 (HTTP の listener) がある時だけ始める。非同期の fs の読み込みは同じ pool で待たされ、event loop が回っていても期限付きの読み込みが切れる
- 期限付きの読み込みの期限切れを、本当に無い時と同じ答え (`ended`) にする所は、期限切れを log に出す。出さないと、期待値が ended のテストは中身を確かめないまま通る (43040718384)
- 「非同期の読み込みが遅い」時は、直後の同期の読み込み、event loop の timer の遅れ、別の process からの同じ読み込みの 3 つと比べると、pool の待ち / event loop の停止 / ファイルシステムの待ちを分けられる
- HTTP を配る daemon (本番の既定) では、起動直後の約 1 秒に同じ待ちが残る。docs/issue/2026-11-12-http-daemon-webui-prepare-holds-fs-pool.md で扱う

## 残した計測と、再発した時に分かること

| 計測 | 場所 | いつ動くか | 再発した時に分かること |
|---|---|---|---|
| 段の時計と、遅い時の daemon.log の出力 | `packages/daemon/test/helpers.ts` の `stageClock`、served dir のテスト | このテストで常時。出すのは 1500ms 超の時だけ | どの段 (起動 / 名乗り / hello / send / 後始末) に時間が乗ったか |
| fs の探り針 (`CCMSG_TEST_FS_PROBE`) | `packages/daemon/src/fs-probe.ts`、served dir のテストが env で渡す | env がある時だけ (今はこのテストだけ) | 非同期の stat だけが待ったか (直後の同期は速いか)。pool の thread の数 |
| 遅い hello の warn | `packages/daemon/src/server.ts` の `slowHelloText` (`HELLO_SLOW_MS` 500)、`repo-derive.ts` の `timedLocationIo` | 本番で常時。出すのは 500ms 以上の時だけ | hello のどの読み込みが待ったか、0ms の timer が遅れたか (event loop の停止か) |
| 走査の期限切れ・読めなかった record の log | `server.ts` の `session runs: not read in time` / `not read whole`、`session-runs.ts` の `LeftOut`、`peer-inject.ts` の `scan_timed_out` の内訳 | 本番で常時。出すのは外れた時だけ | `ended` / `no_peer_socket` が本当に無い時か期限切れか、読めた件数、timer の遅れ |
| 前半の send の走査が何も外していないことの assert | `helpers.ts` の `reportLeftOutReads`、served dir のテスト | このテストで常時 | 前半が期限切れのまま中身を確かめずに通る形を、失敗として見せる |
| 配送できなかった時の daemon.log の出力 | served dir のテスト | 失敗時だけ | serving と isolated の両方の daemon の log |

## 消した計測

- sample (`packages/testkit/src/sample.ts`): macOS で両 daemon の thread を 5ms ごとに 30 秒まで取った。pool の 3 本が待機でなく計算していたことは分かったが、記号が無く中身までは分からない。また、3 core の runner で daemon を 5ms ごとに止めて測りたい時間を乱すので消した
- /private/tmp の監視 (`packages/testkit/src/tmp-lookup-monitor.ts`、`tmp-lookup-probe.ts`): macOS の test run の間じゅう、別の process が `/private/tmp` の直下を 50ms ごとに引いた。待ちが `/private/tmp` のファイルシステムでなく daemon の process の中にあることが分かり (43040718384 と 43045653045 で 100ms 超 0 回)、要らなくなった

## 検証の詳細

### 原因の連鎖

1. テストの daemon は HTTP を配らないが、修正前は起動の時に webui の `Bun.build` と br / gzip の圧縮を始めていた
2. 圧縮 (と bundle) は bun の pool を使う。CI の macOS では pool の thread は 3 本で、起動から約 1 秒、全部が埋まる
3. その間、daemon の非同期の fs の読み込み (hello の所在の導出の stat、send の state file の走査) が pool を待つ。同期の読み込みと event loop は待たない
4. timer は遅れずに鳴るので、`withinBudget` は期限を延ばさない。走査が期限 1 秒を越え、送り手に `ended` / `no_peer_socket: scan_timed_out` と返る

### run 43045653045 (v0.252.0、修正前、テストは 2137.19ms で通過)

段の時計:

```
served dir test stages (ms): 2133 ms in all: harness made 1, isolated started 89, isolated run connected 0, isolated run hello 12, isolated run named 1, isolated sender hello 3, isolated send 2, serving started 191, serving run connected 0, serving run hello 1113, serving run named 1, serving sender hello 362, serving send 289, frame read 0, serving run closed 0, serving stopped 37, isolated run closed 0, isolated stopped 32, harness disposed 1
```

isolated の daemon.log:

```
2026-11-11T15:12:47.244Z [info] listening on /tmp/ccmsg-run-usirI2/ccmsg-t-VATCGo/s/daemon.sock (v0.252.0)
2026-11-11T15:12:47.245Z [info] fs probe: for 5000 ms from the start, a round each 20 ms, slow at 100 ms; pool threads 3 (the cores)
2026-11-11T15:12:47.245Z [info] op http listening on /tmp/ccmsg-run-usirI2/ccmsg-t-VATCGo/s/http.sock
2026-11-11T15:12:47.276Z [info] sidecar bbbbbbbb-2222-4333-8444-555555555555.run1 named no terminal
2026-11-11T15:12:48.423Z [warn] fs probe: an async stat of /tmp/ccmsg-run-usirI2/ccmsg-t-VATCGo/s/.fs-probe took 1104 ms (a sync one right after, 0 ms), 75 ms into the probe
2026-11-11T15:12:48.718Z [warn] fs probe: an async stat of /tmp/ccmsg-run-usirI2/ccmsg-t-VATCGo/s/.fs-probe took 274 ms (a sync one right after, 0 ms), 1199 ms into the probe
2026-11-11T15:12:48.895Z [warn] fs probe: an async stat of /tmp/ccmsg-run-usirI2/ccmsg-t-VATCGo/s/.fs-probe took 155 ms (a sync one right after, 0 ms), 1494 ms into the probe
```

serving の daemon.log:

```
2026-11-11T15:12:47.459Z [info] listening on /tmp/ccmsg-run-usirI2/ccmsg-t-3LCltV/s/daemon.sock (v0.252.0)
2026-11-11T15:12:47.459Z [info] fs probe: for 5000 ms from the start, a round each 20 ms, slow at 100 ms; pool threads 3 (the cores)
2026-11-11T15:12:47.459Z [info] op http listening on /tmp/ccmsg-run-usirI2/ccmsg-t-3LCltV/s/http.sock
2026-11-11T15:12:48.585Z [warn] hello bbbbbbbb-2222-4333-8444-555555555555 took 1070 ms: transcript search 3 ms, cwd 0 ms, repo root 0 ms, location 1066 ms (stat /private/tmp/.jj 1 ms, stat /private/tmp/.git 4 ms, stat /private/.jj 1 ms, stat /private/.git 7 ms, stat /.jj 318 ms, stat /.git 735 ms); a 0 ms timer set as it began fired 3 ms late
2026-11-11T15:12:48.586Z [warn] fs probe: an async stat of /tmp/ccmsg-run-usirI2/ccmsg-t-3LCltV/s/.fs-probe took 1046 ms (a sync one right after, 0 ms), 80 ms into the probe
2026-11-11T15:12:48.587Z [info] sidecar bbbbbbbb-2222-4333-8444-555555555555.run1 named no terminal
2026-11-11T15:12:48.929Z [warn] fs probe: an async stat of /tmp/ccmsg-run-usirI2/ccmsg-t-3LCltV/s/.fs-probe took 323 ms (a sync one right after, 0 ms), 1146 ms into the probe
2026-11-11T15:12:49.238Z [info] peer-inject 187d32440855e7077d7a0b6d8fa4008e/1 -> bbbbbbbb-2222-4333-8444-555555555555.1465 (send_message): delivered
```

sample (thread ごとの頻出の stack の先頭、括弧内はサンプル数):

```
isolated DispatchQueue_1: com.apple.main-thread (serial) (245): kevent64 (in libsystem_kernel.dylib) 243, __psynch_cvwait (in libsystem_kernel.dylib) 1, ??? (in <unknown binary>) 1
isolated Bun Pool 0 (245): ??? (in bun) 218, __ulock_wait2 (in libsystem_kernel.dylib) 24, _platform_memset (in libsystem_platform.dylib) 2
isolated Bun Pool 1 (245): ??? (in bun) 245
isolated Bun Pool 2 (245): ??? (in bun) 219, __ulock_wait2 (in libsystem_kernel.dylib) 23, log2 (in libsystem_m.dylib) 2
isolated Bundler (245): kevent64 (in libsystem_kernel.dylib) 245
serving DispatchQueue_1: com.apple.main-thread (serial) (240): kevent64 (in libsystem_kernel.dylib) 236, ??? (in bun) 3, _platform_memmove (in libsystem_platform.dylib) 1
serving Bun Pool 0 (240): ??? (in bun) 239, _platform_memmove (in libsystem_platform.dylib) 1
serving Bun Pool 1 (240): ??? (in bun) 237, _platform_memset_pattern16 (in libsystem_platform.dylib) 2, _platform_memmove (in libsystem_platform.dylib) 1
serving Bun Pool 2 (240): ??? (in bun) 192, __ulock_wait2 (in libsystem_kernel.dylib) 45, log2 (in libsystem_m.dylib) 1
serving Bundler (240): kevent64 (in libsystem_kernel.dylib) 240
```

(他の thread は JIT / Heap / JSC の helper と mi-scavenger で、ほぼ全サンプルが `__psynch_cvwait` / `__ulock_wait` の待機)

同じ run の /private/tmp の監視:

```
/private/tmp lookups (every 50 ms; /private/tmp held 1 entries at the start, 2 at the end):
  0 of 2768 rounds took 100 ms or more; the longest: /private/tmp 15 ms async, 5 ms sync; /private 0 ms; the run dir 0 ms
```

考察:

- 2 つの daemon とも、起動から約 1 秒の間、非同期の stat だけが待っていた (同期は 0ms)
- main thread は kevent64 で待っていた (event loop は回っていた)
- pool の 3 本は計算していた

### run 43040718384 (commit 885d8068、修正前、テストは 3097.15ms で通過)

```
isolated daemon.log: 2026-11-11T14:43:15.151Z [warn] session runs: not read in time, left out: /private/tmp/ccmsg-run-Dfsurl/pi-cfg-ohUAok/sessions: 0 of 1 files read, 1005 ms into a 1000 ms budget (its timers fired 5 ms late in all)
served dir test stages (ms): 3096 ms in all: harness made 1, isolated started 112, isolated run connected 0, isolated run hello 49, isolated run named 1, isolated sender hello 18, isolated send 1027, serving started 332, serving run connected 0, serving run hello 30, serving run named 1, serving sender hello 18, serving send 1486, frame read 0, serving run closed 0, serving stopped 12, isolated run closed 0, isolated stopped 7, harness disposed 1
```

```
/private/tmp lookups (every 50 ms; /private/tmp held 1 entries at the start, 1 at the end):
  0 of 3073 rounds took 100 ms or more; the longest: /private/tmp 40 ms async, 3 ms sync; /private 0 ms; the run dir 3 ms
```

考察:

- isolated の send は走査が期限切れのまま `ended` を返し、期待値 (`ended`) と一致して通った
- timer の遅れは 5ms で、process は動いていた
- 同じ時間帯、別の process の `/private/tmp` の lookup は最長 40ms だった

### run 43032030563 (commit e6eceecb、修正前、テストは 1911.47ms で通過)

```
served dir test stages (ms): 1911 ms in all: harness made 0, isolated started 81, isolated run named 8, isolated sender hello 2, isolated send 5, serving started 187, serving run named 1342, serving sender hello 2, serving send 254, frame read 0, serving run closed 0, serving stopped 15, isolated run closed 0, isolated stopped 12, harness disposed 1
```

考察: 遅い側の山の 1 秒余りは、serving の run の名乗りの段 (1342ms) に乗っていた。isolated の同じ段は 8ms。

### run 43038044547 (v0.251.0、修正前、テストは 3102.21ms で通過)

```
served dir test stages (ms): 3101 ms in all: harness made 1, isolated started 137, isolated run connected 0, isolated run hello 77, isolated run named 0, isolated sender hello 6, isolated send 8, serving started 360, serving run connected 0, serving run hello 2025, serving run named 2, serving sender hello 201, serving send 260, frame read 0, serving run closed 1, serving stopped 9, isolated run closed 0, isolated stopped 11, harness disposed 2
2026-11-11T14:26:30.540Z [warn] hello bbbbbbbb-2222-4333-8444-555555555555 took 2003 ms: transcript search 1 ms, cwd 83 ms, repo root 0 ms, location 1918 ms (stat /private/tmp/.jj 1727 ms, stat /private/tmp/.git 175 ms, stat /private/.jj 7 ms, stat /private/.git 6 ms, stat /.jj 0 ms, stat /.git 2 ms); a 0 ms timer set as it began fired 88 ms late
```

考察:

- 待った読み込みは、43045653045 では `/.jj` と `/.git`、ここでは `/private/tmp/.jj` だった。どの path を待つかは決まっておらず、その時に pool を待った読み込みが遅くなる
- timer の遅れ (88ms) は、読み込みの待ち (1727ms) より 1 桁小さい

### run 40667786519 (v0.208.0、修正前、テストは 1329.67ms で失敗)

serving の daemon.log (テストが配送できなかった時に出したもの):

```
2026-10-28T09:56:11.069Z [info] listening on /tmp/ccmsg-run-wy3Slj/ccmsg-t-0xpj2n/s/daemon.sock (v0.208.0)
2026-10-28T09:56:11.069Z [info] op http listening on /tmp/ccmsg-run-wy3Slj/ccmsg-t-0xpj2n/s/http.sock
2026-10-28T09:56:11.103Z [info] sidecar bbbbbbbb-2222-4333-8444-555555555555.run1 named no terminal
2026-10-28T09:56:12.144Z [info] peer-inject a78fc9766c2e89f6d7a43c48286277b5/1 -> bbbbbbbb-2222-4333-8444-555555555555.1533 (send_message): unavailable (no_peer_socket: scan_timed_out)
```

```
(fail) send_message through the daemon > a session in a dir another session announced is not reached; one in a dir CCMSG_CLAUDE_CONFIG_DIRS names is [1329.67ms]
```

考察:

- run の名乗りから peer-inject の判定まで 1041ms で、`INJECT_SCAN_MS` (1000ms) を越えた
- この版には fs の探り針も timer の遅れの log も無い。`withinBudget` は timer が 50ms 以上遅れた時だけ期限を延ばすが、判定は 1000ms をわずかに越えた所で出ている。期限は延びておらず、timer の遅れは 50ms 未満だったことになる
- 同じ run の `agents.test.ts` の 3 件の 5000ms 切れは別の原因 (docs/findings/2026-11-11-macos-autofs-home-slows-bun-child.md)

### 手元の再現 (commit message からの引用)

| commit | 条件 | 結果 |
|---|---|---|
| 44784603 | UV_THREADPOOL_SIZE=3 にして、FIFO の読み込み 3 本で pool を塞ぐ | 非同期の stat が 1003ms 待ち、同期は 0.06ms |
| 0897723c (修正前) | UV_THREADPOOL_SIZE=3 で served dir のテスト | 両 daemon の fs の探り針が起動 65〜104ms 後に 159〜223ms の待ち、sample の pool の 3 本は bun の中で計算 |
| 0897723c (修正後) | 同じ条件 | 待ちは 0、pool は待機 |

docs/issue/2026-11-12-http-daemon-webui-prepare-holds-fs-pool.md には、UV_THREADPOOL_SIZE=3 で webui の app を作った直後からの非同期の stat の最大の待ちが bun 1.4.4 で 441ms、bun 1.4.2 で 174ms、既定 (10 core) で 19〜23ms とある。

### 修正前後の所要 (macOS、このテスト)

修正の直前の 9 本 (調査用の計測を入れた版):

| run | 版 / commit | 所要 (ms) |
|---|---|---|
| 43023307090 | v0.246.0 | 2142.51 |
| 43025820072 | v0.247.0 | 1025.29 |
| 43029668277 | v0.248.0 | 2900.05 |
| 43030371736 | v0.249.0 | 2138.31 |
| 43032030563 | e6eceecb | 1911.47 |
| 43035897982 | v0.250.0 | 1755.15 |
| 43038044547 | v0.251.0 | 3102.21 |
| 43040718384 | 885d8068 | 3097.15 |
| 43045653045 | v0.252.0 | 2137.19 |

その前の 29 本 (v0.226.2〜v0.245.0 の Release の run、`gh run list` の新しい順):

```
608.60 2175.32 998.46 2234.15 1934.92 2103.21 1830.56 2601.46 2543.15 726.36 544.58 2221.82 1982.82 696.65 2046.87 2295.90 783.42 2232.52 1329.04 2125.77 1907.61 1573.32(fail) 2203.27 1369.60 1785.04 697.30 973.43 457.04 2197.94
```

修正後の 10 本:

| run | 版 / commit | 所要 (ms) |
|---|---|---|
| 43115892950 | v0.253.0 | 601.14 |
| 43116620241 | v0.254.0 | 432.27 |
| 43119593073 | v0.255.0 | 789.20 |
| 43127858156 | v0.256.0 | 494.31 |
| 43192469415 | v0.257.0 | 510.02 |
| 43196514880 | v0.258.0 | 477.81 |
| 43200852862 | v0.259.0 | 529.08 |
| 43205737238 | v0.260.0 | 493.65 |
| 43207155597 | 23c10fd7 | 389.04 |
| 43207756784 | e09af62c | 675.40 |

集計:

| | 本数 | 1000ms 以下 | 800ms 以下 | 落ちた本数 |
|---|---|---|---|---|
| 修正前 (上の 38 本) | 38 | 9 | 7 (18%) | 1 (42721104070) |
| 修正後 | 10 | 10 | 10 | 0 |

- 修正後の ubuntu の所要は 378〜454ms
- 修正後の run のうち 43200852862 (ubuntu) と 43205737238 (macOS) は、別のテスト `the HTTP fallback's prepare > a daemon that listens for HTTP prepares it once, after the listener is up` で落ちた (`Expected: > 2` / `Received: -1`、23c10fd7 で直した)
- bun は修正前後のどの run も v1.4.4 (`bun-version: latest` が v1.4.4 を取っていた)

### 裏付けの強さ

- 通った本数だけで見ると弱い
  - 修正前の失敗率 4/97 (4.1%) のまま 10 本続けて通る確率は (1 − 4/97)^10 ≈ 0.66
  - 0 本の失敗から言える失敗率の 95% の上限は 1 − 0.05^(1/10) ≈ 26%
  - 失敗率 4.1% を 5% の水準で否定するには 72 本、1% の水準なら 110 本続けて通る必要がある
- 所要の分布で見ると強い
  - 修正前の分布 (800ms 以下が 38 本中 7 本) のまま 10 本とも 800ms 以下になる確率は (7/38)^10 ≈ 4×10⁻⁸
  - 「約 6 割が遅い側の山」(commit e6eceecb の message) から見積もっても 0.4^10 ≈ 1×10⁻⁴
- 修正前に落ちた 4 本の所要 (1330〜2294ms) はどれも 1000ms を超える側にあり、その遅い側の山が修正後に消えた
