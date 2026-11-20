# webui の brotli を gzip の後に 1 つずつ作ると、HTTP を配る daemon の起動直後の非同期の fs の待ちが消える

- Date: 2026-11-20
- 対象: `packages/webui/src/index.ts` (assets の読み込みと brotli)、`packages/webui/src/encoded-asset.ts`、`packages/daemon/src/server.ts` (fallback の prepare)、bun v1.4.4、手元の macOS (10 core)
- 動機: docs/issue/archive/2026-11-12-http-daemon-webui-prepare-holds-fs-pool.md。HTTP を配る daemon は起動直後に webui の bundle と br / gzip の圧縮を始め、その間 daemon の非同期の fs の読み込みが pool を待っていた。裁定 (kawaz 2026-11-20) は「起動直後は gzip だけで配り、brotli は出来たら切り替える」

## 判明した事実

- 起動直後の待ちの元は brotli だった。段ごとに分けて非同期の stat を 5ms ごとに引くと (UV_THREADPOOL_SIZE=3)、`Bun.build` の間の最大の待ちは 3〜4ms、gzip (19 個の出力を並べて) の間は 2〜3ms、brotli (19 個を並べて) の間は 156〜336ms だった
- brotli を 1 つずつ (前の 1 つが終わってから次) にすると、同じ条件で待ちの最大は 0〜8ms になった。全体の時間は並べた時の約 1.05 秒から約 1.75〜2.1 秒に延びた
- Worker の中で同期の brotli を走らせた時も待ちの最大は 2〜5ms で、1 つずつの pool と差がなかった
- bun 1.4.4 の `CompressionStream("brotli")` は動き、bundle の entry (733,411 bytes) を 992ms で 183,747 bytes にした。node:zlib の quality 11 (TEXT mode、size hint 付き) と同じ大きさで、その間の 5ms の timer の遅れは最大 1ms (event loop は止まらない)。品質を指定する口は無い (options を渡しても例外にならず、効くかは確かめていない)。Bun 自身の API (`Bun` の下) に brotli は無い (`deflateSync` / `gzipSync` / `zstd*` だけ)
- 直した daemon では、最初の GET / (gzip) は listener が立ってから 65〜100ms で返り、修正前 (br、1106〜2038ms、外れ値 4161ms) より約 1 秒早い。brotli が出来るのは prepare から約 2.4 秒後で、その後の GET / は br で返る
- 直した daemon では、起動から 4 秒の間の非同期の stat の最大の待ちは pool 3 本で 3〜9ms、既定 (10 本) で 3〜9ms。修正前は pool 3 本で 177〜372ms、既定で 11〜294ms

## 推測のまま残っていること

- UV_THREADPOOL_SIZE=1 でも、19 個を並べた brotli の全体の時間は約 1.04 秒で 3 本の時と変わらず、待ちの最大も 19ms と 3 本の時 (232〜336ms) より小さかった。zlib の非同期の圧縮が UV_THREADPOOL_SIZE で大きさの決まる pool と同じ所で走るのかは、この結果と合わない。bun のソースでは確かめていない。待ちが pool の thread の取り合いなのか、CPU の取り合いなのかも分けていない
- 計測は 10 core の機械で pool の本数だけを絞ったもの。CI の 3 core の runner では CPU も 3 つしかなく、1 つずつの brotli が 1 core を約 2 秒使い続ける。その間の待ちは測っていない
- 同じ機械で別の worker のテストが並んで走っていた。修正前の既定の 1 本 (GET / が 4161ms、待ちの最大 294ms) はその負荷によると見ているが、確かめていない

## 実用的な示唆 / ベストプラクティス

- process に 1 つの pool で走る重い計算は、並べて投げると pool の thread を数だけ取り、同じ pool の非同期の fs の読み込みを待たせる。急がないものは 1 つずつ流すと thread を 1 本しか取らない
- 圧縮のように「ある方が良いが無くても答えられる」ものは、答えに要る分 (gzip) を先に済ませて配り始め、残り (brotli) は後から作って切り替える。切り替える前後で中身 (identity の bytes) は同じにし、ETag は coding ごとに分ける

## 検証の詳細

### 計測の方法

- 隔離した daemon (`packages/daemon/test/helpers.ts` の `startTestDaemon`、state dir は一時 dir) を `CCMSG_HTTP_BIND=127.0.0.1:0`、`CCMSG_TEST_FS_PROBE=4000:0` で起こす。fs の探り針 (`packages/daemon/src/fs-probe.ts`) が、起動から 4 秒の間 20ms ごとに非同期の stat の時間を daemon.log に書く (slow を 0ms にして全部の回を出す)
- listener が立った後 (daemon の ping に答えた後) すぐに GET / (`Accept-Encoding: gzip, deflate, br`) を投げ、返るまでの時間と content-encoding を取る。探り針が終わった後にもう 1 度 GET / を投げ、content-encoding を取る
- 修正後は daemon.log の `http: the fallback has prepared (N ms)` から brotli が出来るまでの時間を取る
- pool の本数は daemon の env の UV_THREADPOOL_SIZE で 3 にした回と、付けない既定 (10 core) の回を、それぞれ 5 回

### 前後の表 (daemon、起動から 4 秒の非同期の stat の待ち、ms)

| 版 | pool | 回 | 回数 | 最大 | p50 | p90 | p99 | 100ms 以上 | 20ms 以上 | 最初の GET / | その coding | 後の coding | 全部出来るまで |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 前 | 3 | 0 | 160 | 372 | 0 | 0 | 150 | 2 | 2 | 1182 | br | br | - |
| 前 | 3 | 1 | 162 | 217 | 0 | 0 | 182 | 2 | 4 | 1224 | br | br | - |
| 前 | 3 | 2 | 154 | 271 | 0 | 0 | 240 | 2 | 2 | 1247 | br | br | - |
| 前 | 3 | 3 | 129 | 266 | 0 | 8 | 205 | 5 | 7 | 2038 | br | br | - |
| 前 | 3 | 4 | 159 | 177 | 0 | 2 | 103 | 2 | 5 | 1188 | br | br | - |
| 前 | 既定 | 0 | 187 | 11 | 0 | 0 | 11 | 0 | 0 | 1156 | br | br | - |
| 前 | 既定 | 1 | 185 | 21 | 0 | 0 | 4 | 0 | 1 | 1106 | br | br | - |
| 前 | 既定 | 2 | 187 | 27 | 0 | 0 | 11 | 0 | 1 | 1124 | br | br | - |
| 前 | 既定 | 3 | 173 | 29 | 0 | 4 | 12 | 0 | 1 | 1125 | br | br | - |
| 前 | 既定 | 4 | 148 | 294 | 1 | 6 | 40 | 1 | 4 | 4161 | br | br | - |
| 後 | 3 | 0 | 189 | 3 | 0 | 0 | 3 | 0 | 0 | 77 | gzip | br | 2454 |
| 後 | 3 | 1 | 190 | 3 | 0 | 0 | 2 | 0 | 0 | 79 | gzip | br | 2391 |
| 後 | 3 | 2 | 189 | 5 | 0 | 0 | 3 | 0 | 0 | 74 | gzip | br | 2469 |
| 後 | 3 | 3 | 189 | 7 | 0 | 0 | 7 | 0 | 0 | 94 | gzip | br | 2519 |
| 後 | 3 | 4 | 188 | 9 | 0 | 0 | 3 | 0 | 0 | 81 | gzip | br | 2443 |
| 後 | 既定 | 0 | 187 | 9 | 0 | 1 | 6 | 0 | 0 | 66 | gzip | br | 2455 |
| 後 | 既定 | 1 | 189 | 5 | 0 | 0 | 4 | 0 | 0 | 100 | gzip | br | 2447 |
| 後 | 既定 | 2 | 190 | 5 | 0 | 0 | 3 | 0 | 0 | 86 | gzip | br | 2432 |
| 後 | 既定 | 3 | 189 | 3 | 0 | 0 | 2 | 0 | 0 | 65 | gzip | br | 2439 |
| 後 | 既定 | 4 | 190 | 3 | 0 | 0 | 1 | 0 | 0 | 95 | gzip | br | 2434 |

- 「回数」は 4 秒の間に探り針が回った回数。待ちが長いと回数が減る (前の pool 3 の回 3 は 129 回)
- 「最初の GET /」は listener が立った後に投げた GET / が返るまで。前は bundle と gzip と brotli の全部を待ち、後は bundle と gzip だけを待つ
- 「全部出来るまで」は prepare から brotli が全部出来るまで (後だけ。daemon.log の `the fallback has prepared`)

### 段ごとの待ち (daemon の外、1 process の中)

`Bun.build` (daemon と同じ設定)、19 個の出力の gzip (並べて)、brotli (並べて / 1 つずつ / Worker の中で同期) を順に走らせ、各段の間に非同期の stat を 5ms ごとに引いた。出力は 19 個、合計 1,635,598 bytes、最大 733,411 bytes。

| UV_THREADPOOL_SIZE | 段 | 時間 (ms) | 非同期の stat の最大の待ち (ms) |
|---|---|---|---|
| 3 | Bun.build | 46〜60 | 3〜4 |
| 3 | gzip を並べて | 16〜18 | 2〜3 |
| 3 | brotli を並べて | 1042〜1082 | 156〜336 |
| 3 | brotli を 1 つずつ | 1747〜2079 | 0〜8 |
| 3 | brotli を Worker の中で同期 | 1763 | 2 |
| 2 | brotli を並べて | 1138 | 232 |
| 1 | brotli を並べて | 1035 | 19 |
| 1 | brotli を 1 つずつ | 1795 | 1 |
| 1 | brotli を Worker の中で同期 | 2551 | 5 |
| 既定 (10) | brotli を並べて | 1062 | 33 |

### 切り替えの性質のテスト

`packages/webui/test/brotli-later.fixture.ts` は node:zlib の `brotliCompress` を、放すまで本物を呼ばない形に差し替えてから app を読み込む。brotli を止めている間の GET (shell、bundle の entry、スタイルシート) は gzip、放して prepare が済んだ後は br で、どちらも identity の bytes と同じ sha256 になる。shell の gzip の ETag は、止めている間は 304、br に切り替わった後は 200 (br の body と別の ETag)。gzip だけを受ける client には切り替えの後も gzip で返る (`packages/webui/test/app.test.ts` の「brotli after gzip」)。
