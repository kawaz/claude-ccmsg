---
title: "just test で webui の bundle を作るテスト 2 件が 5 秒の timeout で落ちた (1 回目だけ)"
status: open
category: bug
created: 2026-11-24
origin: "自リポ TODO (worker の just test の記録)"
---

# just test で webui の bundle を作るテスト 2 件が 5 秒の timeout で落ちた (1 回目だけ)

## 観測

2026-11-24、worker が自分の workspace で `just test` を 2 回続けて流した。変更の中身は 2 回とも同じ。

- 1 回目: 6772 pass / 2 skip / 2 fail、全体 126.88 秒
  - `createWebuiApp > the shell points at a content-hashed bundle and requires revalidation` が 5001.02ms で timeout
  - `brotli after gzip > gzip before the brotli is made, br after, the same content in both, and each coding its own etag` が 5002.74ms で timeout
  - どちらも `packages/webui/test/app.test.ts` の周りの、bundle を作るテスト
- 2 回目: 6774 pass / 2 skip / 0 fail、全体 105.37 秒
- 同じ変更を取り込んだ push の ci (main の workspace) は 1 回で通った (6774 pass / 0 fail)

1 回目は 2 回目より全体で 21 秒ほど遅い。

## 未特定

- 落ちた原因。bundle を作る処理が 5 秒を超えた理由は分かっていない
- 1 回目の時に同じ機械で何が走っていたか。この日は別の worker が並行して隔離 daemon・playwright・テストを動かしていたが、落ちた瞬間に重なっていたかは記録が無い
- 新しく作った workspace の 1 回目に固有か (bundle の cache が無い等)、負荷に依るか

## 特定に要る観測

- 落ちた回の、その 2 件の所要時間の内訳 (bundle を作る処理そのものか、その前後か)
- 同じ workspace で cache を消してから流した時に再現するか
- 落ちた時刻の、機械の他のプロセスの負荷

## 再現と測定 (2026-11-24、M1 Max (P core 8・E core 2)、bun 1.4.4、他の worker なし)

2 件の所要は bun test の junit の報告 (`--reporter=junit`) から取った。

| 条件 | 回数 | 落ちた回 | 2 件の所要 |
|---|---|---|---|
| 新しく作った workspace の 1 回目の `just test` | 1 | 0 | 全体 99.66 秒 |
| 同じ workspace の 2 回目 (`just test` と同じ手順 + junit) | 1 | 0 | 2.75 秒、2.78 秒。全体 99.81 秒 |
| 新しく作った workspace の 1 回目に `app.test.ts` だけ | 2 | 0 | 2.82〜2.89 秒 |
| `app.test.ts` だけ、続けて | 3 | 0 | 2.76〜2.84 秒 |
| `app.test.ts` だけ、忙しいループ (bash の `while :`) 16 本を並べた負荷の下 | 2 | 0 | 4.24〜4.44 秒 |
| 同じ、24 本 | 2 | 2 (2 件とも) | 5.00 秒で timeout |
| 同じ、32 本 | 2 | 2 (2 件とも) | 5.00 秒で timeout |

- 新しい workspace の 1 回目に固有の遅さは無かった。全体の時間も 2 件の時間も 2 回目と同じ
- 負荷を掛けると、issue と同じ形 (2 件とも 5001〜5002ms) で毎回落ちる。core 数 (10) の 1.6 倍の 16 本では 4.2〜4.4 秒で通り、2.4 倍の 24 本で落ちる
- issue の日の 1 回目が 2 回目より 21 秒遅かったことは、並行していた worker の負荷と整合する。ただしその時刻の負荷の記録は無く、未特定のまま

## 2 件の時間の内訳

2 件はどちらも、webui の app の prepare (bundle を作り、gzip し、brotli を作る) を 1 回まるごと待つ。「the shell points at …」は同じ process で最初に prepare を呼ぶ試験 (process に 1 回の memo なので、最初の 1 件が全部を払う)、「brotli after gzip」は子の process で prepare を待つ。prepare と同じ段を 1 つの process で順に測った:

| 負荷 (忙しいループ) | Bun.build | gzip | brotli (quality 11、20 個の出力 計 2.0MB を 1 つずつ) |
|---|---|---|---|
| 0 本 (4 回) | 42〜60ms | 19〜20ms | 2175〜2189ms |
| 16 本 (2 回) | 92〜110ms | 36〜40ms | 3344〜3460ms |
| 24 本 (2 回) | 68〜85ms | 41〜51ms | 4945〜5008ms |
| `taskpolicy -b` (E core に寄せる) (2 回) | 328〜411ms | 106〜128ms | 10753〜10873ms |

所要のほぼ全部が、1 本の thread で回る brotli (quality 11) だった。

## 版ごとの比較 (同じ測り方、`app.test.ts` だけ、1 回ずつ)

| 版 | 負荷 0 本 | 16 本 | 24 本 |
|---|---|---|---|
| 0897723c (brotli を全部並べて投げていた版) | 1.02 秒 | 2.01 秒 | 2.77 秒 (通る) |
| 7eece5ee (brotli を gzip の後に 1 つずつ作る版) | 2.19〜2.20 秒 | 3.17〜3.23 秒 | 4.57〜5.10 秒 (落ちる) |
| main (mermaid・Temml が入り、出力が 1.6MB から 2.0MB に) | 2.76〜2.89 秒 | 4.24〜4.44 秒 | 5.00 秒 (落ちる) |

## 原因

1. 2 件はどちらも、5 秒の timeout の中で quality 11 の brotli を約 2.2 秒 (負荷の無い P core) 回す。brotli は 1 つずつ作るので 1 本の thread で、機械の他の仕事と CPU を取り合うと、その分だけそのまま延びる
2. 忙しいループが core 数の 2.4 倍 (24 本) あると、brotli だけで 5 秒に届く (4.9〜5.0 秒)。2 件は 2.8 秒に対して 5 秒で、余裕は約 1.8 倍しかない
3. brotli を 1 つずつにした変更 (7eece5ee) で、2 件の CPU の仕事が約 1 秒から約 2.2 秒になり、その後の bundle の増加で 2.8 秒になった。並べて投げていた版は同じ 24 本の負荷で 2.77 秒で通る
4. 「1 回目だけ」は、新しい workspace や cache の冷えではなかった (上の表)。1 回目に重なっていた他の負荷によると見ているが、その時の負荷は記録が無く確かめられない

## 合わせて見つけたこと: brotli-later.fixture.ts の止めが効いていない

`brotli-later.fixture.ts` は、`Reflect.set(zlib, "brotliCompress", …)` で brotli を放すまで止めてから app を読み込むつもりだが、止まっていない。`encoded-asset.ts` の `import { brotliCompress } from "node:zlib"` の束縛は差し替わらない。

- 差し替えた関数を数える写しで、prepare の間の呼び出しは 0 回だった (quality を変える写しでも prepare の時間は変わらなかった)
- `Reflect.set` の後で、default の `zlib.brotliCompress` と `import * as ns from "node:zlib"` の `ns.brotliCompress` は別の物になる
- 試験の「before」が gzip になるのは、brotli が gzip の直後から走り、終わるまで 2 秒以上かかる間に問い合わせが先に済むからにすぎない

## 関連

- [2026-10-10-just-test-one-timeout-unidentified](./archive/2026-10-10-just-test-one-timeout-unidentified.md) は、同じ「1 回目だけ落ちる」の形だが、落ちたのは翻訳の実物のテストで、原因も直しも別
