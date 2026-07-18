# translate-helper の並列度実測

- Date: 2026-07-19
- Related: [DR-0023](../decisions/DR-0023-daemon-local-translation.md), [2026-07-17 macOS Translation PoC](./2026-07-17-macos-translation-poc.md)
- Environment: macOS 26.5.2 (25F84), macOS SDK 26.5, Apple Swift 6.3.3, arm64, en→ja model installed

## 判明した事実

1. **現行 helper (1 session + `while let line = readLine()` 直列) は N 個の並列リクエストを直列処理する。** N=16 のとき daemon から一気に stdin に流し込んでも、応答は等間隔 (~700ms) で 1 個ずつ返り、total は 11.2s (= N × 700ms 相当) だった。arrivals 順は入力順と一致していた。
2. **helper 内での並列化 (Task + `withTaskGroup`) は total を改善しない。** 同一 session を Task 並列で叩く Variant A では total 11.2s (現状比 -0.7%)。arrivals 順が乱れただけで実効的な並列化は発生していない。
3. **`TranslationSession` を複数インスタンス化 (session pool) しても改善しない。** pool size 2/4/8 いずれも total は 11.1-11.9s、現状と誤差レベルの差。first response は逆に 615-975ms へ後退 (pool 初期化と round-robin の分散オーバーヘッド)。
4. **helper プロセスを複数立ち上げて負荷分散すると悪化する。** 2 プロセスに N=16 を折半すると total 20.1s (現状比 +79%)、4 プロセスも同水準。同一マシンで並列に走らせても翻訳時間は増えるだけで減らない。
5. **1 リクエストに N 個 text を詰めた batch (`translations(from:)` 1 呼び出し) と、1 text × N リクエストの直列は同じスループット。** N=16 でどちらも per-item ~560-580ms、total 8.9-9.3s (batch は request/response の overhead が 1 回で済むぶん 20% 弱速い)。
6. **Translation.framework は プロセス / マシン単位で翻訳処理を serialize している。** session を分けても、プロセスを分けても総所要時間が変わらず、プロセス分けは context switch 分だけ悪化する挙動から、Neural Engine / 共有翻訳エンジン側で単一 worker が待ち行列を捌いていると推定される。API 側 (session、Task、プロセス) で並列度を上げる余地は無い。
7. **並列送信のもとで現状の直列 readLine は「先頭段落が最も早く返る」性質を持つ。** N=16 で first response は 302ms、Variant B (pool) は 726ms。段落を UI に順次表示する UX では現状のほうが体感が良い。

## 実用的な示唆 / ベストプラクティス

- **helper の並列化は実装しない (= 現状維持)**。DR-0023 の 1 op = 1 段落 (r34 mid=15) の設計は helper 側での並列度に依存していない。
- **理由**: Translation.framework がプロセス/デバイス側で serialize しているため、helper 内で session / Task / process を増やしても total は変わらない。追加した並列化コード (Actor Writer、Dispatcher、TaskGroup 管理) の複雑さと first-response の悪化だけが残る (design-priority.md「悪くする変更を入れない」)。
- **1 op = 1 段落は保つ**。1 request に 8 段落詰め込むと 4-8s wedge のあいだ daemon はキャンセル手段なく待たされる。1 op = 1 段落なら watchdog (input length に比例) を段落単位で発火でき、次段落の受信は独立に進む。
- **並列送信は保つ (webui 側 `Promise.all(paragraphs.map(...))`)**。helper が直列でも、request 発火が並列なら「先頭段落から順に arrive する」効果があり、UI に段落単位で流し込める。webui が段落間で await にすると first response が入力順の 1 番目に固定される (= 現状) が、それは並列送信でも変わらない (先頭が最初に完成するのが実測値だから)。
- **将来 Translation.framework が並列化されたら再実測する**。同じベンチスクリプト (`scratchpad/bench.ts`) で回帰確認できる。
- **kawaz 指摘 (r34 mid=15)** への回答: 直列 readLine は「並列化サボり」ではなく **Translation.framework 側の制約に合わせた設計** で、並列化しても総所要時間は変わらず (むしろ first response が遅くなる)。helper 内での並列度向上は現状の Apple の翻訳エンジン API では不可能。

## 検証の詳細

### 検証マトリクス

計測条件: warmup として 1 段落を先行送信し model load 完了後にベンチ開始。samples は英文 100 chars 前後の短文 16 種を round-robin。1 request = 1 text。同一マシン上で連続実行。

| Strategy | N=4 total (ms) | N=8 total (ms) | N=16 total (ms) | first response (ms) | per-req 中央値 (ms) |
|---|---|---|---|---|---|
| **Current** (1 session, serial readLine) | 2117 | 4629 | 11232 | 302 (N=16) | ~580-700 |
| Variant A (1 session, Task-parallel) | 2134 | 4628 | 11153 | 531 (N=16) | ~700 |
| Variant B (session pool = 4, Task-parallel) | 2105 | 4574 | 11104 | 726 (N=16) | ~700 |
| Session pool = 2 | 2139 | 4703 | 11256 | 534 (N=16) | ~700 |
| Session pool = 8 | 2121 | 4858 | 11900 | 975 (N=16) | ~700 |
| 2 processes (負荷折半) | 3921 | 8795 | 20077 | ~1000 (per-proc warmup 込み) | - |
| 4 processes | - | 9513 | - | ~1127 | - |
| Batch (1 req N texts, `translations(from:)`) | 2101 | 4593 | 8985 | 8985 (batch 全体) | 525-575 /item |
| Sequential (前 request の response 待ち) | 2123 | 4642 | 9267 | - | 584 (N=16) |

読み方:
- 現状と Variant A/B の total は誤差レベル (±1%)。並列化ゼロ。
- pool サイズを増やすと逆に総時間が増える (init と round-robin overhead)。
- プロセス並列は 1.8x 悪化。全マシンで直列。
- Batch は request/response 往復が 1 回で済むぶん多重 request より 20% 弱速い (per-item 560 vs 700ms)。ただし DR-0023 addendum の理由 (wedge 時の粒度、watchdog、キャンセル性) で 1 op = 1 段落を選んでいるので採用しない。

### N=16 の arrivals タイムライン (現状)

```
r0: arrive=+254ms latency=254ms
r1: arrive=+625ms latency=625ms
r2: arrive=+1501ms latency=1501ms
r3: arrive=+2092ms latency=2092ms
r4: arrive=+2665ms latency=2665ms
r5: arrive=+3194ms latency=3194ms
r6: arrive=+3866ms latency=3866ms
r7: arrive=+4650ms latency=4650ms
r8: arrive=+5493ms latency=5493ms
r9: arrive=+6332ms latency=6332ms
r10: arrive=+6961ms latency=6961ms
r11: arrive=+7775ms latency=7775ms
r12: arrive=+8586ms latency=8586ms
r13: arrive=+9615ms latency=9615ms
r14: arrive=+10411ms latency=10411ms
r15: arrive=+11336ms latency=11336ms
```

入力順に等間隔 (~700ms interval)。

### N=16 の arrivals タイムライン (Variant A: Task parallel, 1 session)

```
r0: arrive=+429ms  r1: +773ms  r3: +1358ms  r4: +1933ms  r5: +2417ms
r6: +3089ms  r8: +3910ms  r7: +4686ms  ... (以降 total 11319ms まで)
```

順序は乱れるが末尾は同時刻。並列化されていない。

### なぜ複数プロセスで悪化するか (推測)

Translation.framework は XPC 経由で system service (`translationd` 相当) にリクエストを送っていると考えられる。複数プロセスから同時に投げても system service 側の queue で serialize され、加えて XPC 往復と context switch のコストが乗るため、単一プロセスから連続で投げるより遅くなる。

### ベンチコード

- helper 並列送信ベンチ: `scratchpad/bench.ts` (id-multiplexed 並列)
- シーケンシャル送信: `scratchpad/bench-sequential.ts`
- 複数プロセス: `scratchpad/bench-multiproc.ts`
- 1-request-N-texts バッチ: `scratchpad/bench-batch.ts`
- Variant A helper: `scratchpad/main-parallel-task.swift`
- Variant B helper: `scratchpad/main-parallel-pool.swift`

いずれも scratchpad (`/private/tmp/claude-501/-Users-kawaz--local-share-repos-github-com-kawaz-claude-ccmsg/fef5e6c9-cf46-4361-855e-fd204f82222d/scratchpad/`) に置いた。リポには含めない (再計測時は同じ手順で作り直せる)。
