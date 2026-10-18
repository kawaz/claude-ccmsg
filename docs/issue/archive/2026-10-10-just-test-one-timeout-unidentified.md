---
title: just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)
status: resolved
category: bug
created: 2026-10-10T11:57:40+09:00
last_read: 2026-10-18T14:08:36+09:00
open_entered: 2026-10-10T11:57:40+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T14:24:24+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","done:真因を観測で特定し、実物の翻訳を daemon を立てる test から外した (commit lmptxuyq)"]
blocked_by:
origin: 自リポ TODO
---

# just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)

## 概要

just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)。2026-10-10 02:xx、段 A (transcript スキーマ) の worker が bun install 直後に /verify 用の隔離 daemon 2 つを並走させながら実行した 1 回目だけ。その後 worker 2 回 + 統括 3 回の `bun test` (daemon 無し) は 3916 pass で再現せず。出力は取り損ねていて test 名・ファイル不明。仮説: daemon 2 つ + playwright の並走による CPU 競合で 5 秒を超えた (未検証)。次に timeout を見たら `bun test 2>&1 | tee` でログを取り、test 名と並走していたプロセスを記録する。

## 2 回目の発生 (2026-10-13 16:3x)

worker unify-ccmsg-address の `just test` 1 回目が 3985 pass / 1 fail / 1 error (189.62 s)。直後の `bun test` と 2 回目の `just test` は 0 fail (133 s)。test 名は今回も出力未保存で不明。

共通点: 1 回目だけ落ちる、落ちた回は 40〜60 s 遅い (10-10 は 127 s vs 100 s)。

次に worker を出す時は委譲プロンプトに「`just test` は必ず `2>&1 | tee <一時ベース>/just-test-N.log` で記録する」を入れる。

## 3 回目の発生 (2026-10-15、test 名を特定)

`bun test --coverage` (just coverage と同じ手順) の 1 回目で `packages/daemon/test/translate-e2e.test.ts` の "daemon translate replies with a real en→ja mixed-text result" が 5000ms で timeout。直前に Unhandled error "connection closed before response" (test/helpers.ts:520 replyLine ← requestOk ← translate-e2e.test.ts:25)。直後の 2 回目・3 回目の coverage 実行と、その前の coverage 無しの `bun test` は全件 pass。macOS、bun 1.4.2。変更していたのは webui のみ (Timeline の分解) で daemon には触れていない。

共通点: 1 回目だけ落ちる。今回は daemon 側の変更が無い状態で起きたので、変更起因ではない。

## 4 回目の発生 (2026-10-15、DR-0039 段 2 の worker)

`just test` の 1 回目で `packages/daemon/test/translate-e2e.test.ts` の "daemon translate replies with a real en→ja mixed-text result" が 5000ms で timeout (5026.62ms)。直前に Unhandled error between tests "connection closed before response" (test/helpers.ts:520 replyLine ← requestOk ← translate-e2e.test.ts:25)。3 回目と同じ test・同じ形。

- 1 回目: 4188 pass / 1 fail [142.23s]
- 直後の 2 回目の `just test`: 4189 pass / 0 fail [130.38s]
- その後の `just coverage`: 0 fail
- 環境: macOS、bun 1.4.2
- 変更: hooks module・CLI・daemon の hello (classic hook の全廃)。translate の経路には触れていない
- ログ: worker の一時ディレクトリの just-test-s2-1.log (worker 終了後に消える)

共通点: 1 回目だけ落ちる、落ちた回は 10 s ほど遅い。3 回目・4 回目とも translate-e2e の同一 test で、translate の経路に無関係な変更中に起きたため変更起因ではない。

## 5 回目の観測 (2026-10-18)

`bun test packages/daemon packages/cli` の 1 回目で translate-e2e の "daemon translate replies with a real en→ja mixed-text result" が 5017ms で timeout。直前に "connection closed before response"。

直後に translate-e2e.test.ts 単体を 3 回続けて回した結果:

| 回 | 所要 | 結果 |
|---|---|---|
| 1 | 5.05 秒 | timeout で fail |
| 2 | 2.79 秒 | pass |
| 3 | 1.30 秒 | pass |

- 他のテストと並走しない単体でも 1 回目だけ 5 秒を超え、回すほど速くなる。CPU 競合より translate helper (Translation.framework) の冷えた状態からの初回の遅さが疑わしい
- 未検証: helper の起動と初回翻訳の時間は分けて測っていない
- この直前の `just test` 2 回 (101 秒、82 秒) では translate-e2e は通っていた
- 環境: macOS、bun 1.4.2
- 変更: daemon のテスト基盤 (in-process daemon) と server.ts の createDaemon の切り出し。translate の経路は触れていない (translate-e2e は子プロセスの daemon のまま)

## 受け入れ条件

- [ ] timeout 再発時にログを取得し、test 名と並走プロセスを記録する

## 真因 (2026-10-18、計装とログで特定)

translate-e2e の 5 秒は、ほぼ全部が Translation.framework の推論 1 回の待ち。推論は OS の on-device モデル (modelmanagerd 配下の 3B の翻訳用モデル) を OS の他の利用者と共有していて、OS 自身の文章解析 (mediaanalysisd → textunderstandingd の TextPersonExtraction、この日は 11:13 / 12:14 / 13:14 / 14:13 に始まり 2〜3 分続いた) が走っている間は、1 文の翻訳が 0.5 秒から 10〜30 秒になる。初回のコストではない。

計装 (test 本体を段ごとに測る一時スクリプト、他の負荷なし):

| 段 | 時間 |
|---|---|
| daemon の起動 (connect できるまで) | 54〜56 ms |
| connect / hello | 0 ms / 4〜5 ms |
| translate 1 回 (helper の起動 + prepareTranslation + 推論) | 1198〜1637 ms |
| うち helper の起動と空の batch の往復 | 8〜9 ms |
| うちモデルの読み込み (modelmanagerd のログ、約 6〜13 秒使われないと外れる) | 0.11〜0.21 s |

再現 (14:14:26 開始の just test の 1 回目で translate-e2e が 5008 ms で timeout)。modelmanagerd のログの推論 request の時間:

| 時刻 | 所要 | 利用者 |
|---|---|---|
| 14:15:04 → 14:15:33 | 29.19 s | OS の文章解析 |
| 14:15:23 → 14:15:33 | 10.49 s | translate-helper.test の実物の翻訳 (30 秒の期限で pass) |
| 14:15:40 → 14:16:04 | 23.64 s | OS の文章解析 |
| 14:15:43 → 14:16:00 | 16.99 s | translate-e2e の翻訳 (5 秒で timeout) |

13:15〜13:16 の同じ時間帯にも他の just test の翻訳が 12.5 / 30.6 / 13.2 / 13.7 秒かかっていた。それ以外の時間の翻訳はほぼ 0.5 秒前後。

「1 回目だけ落ちる」は、OS の解析が数分で終わり、100 秒前後かかる just test の 2 回目はその後に走るため、と読める (過去 5 回の発生時刻とは突き合わせていない。debug レベルのログが約 3 時間しか残らないため。未検証)。CPU の負荷 (load average 27) だけでは翻訳は遅くならなかった (1.2〜1.6 秒)。

他の負荷が見えないのに 3.5〜3.7 秒かかった翻訳が 3 件あった (13:16:27 / 13:41:12 / 13:49:42)。入力の長さも依頼元も分からず、原因は未特定。

## 直し方 (commit lmptxuyq)

推論の時間はこのプロセスの外 (OS の共有モデルの混み具合) で決まるので、test の外で温めても避けられず、5 秒の期限に意味がない。実物の翻訳を 1 件にまとめた:

- translate-e2e: spawn した daemon への翻訳の可否の問い合わせ (空の batch) が、daemon の既定のパスで helper を見つけて受け入れることだけを確かめる (65 ms)
- translate-helper.test の実物の翻訳: daemon と同じ service (既定のパス・常駐する子・JSONL の id の対応・daemon の parser) を通す。期限 25 秒は service の watchdog に渡し、test の期限はそれより 5 秒長くして、遅い時は service の「timed out」で落ちるようにした
- helper の終了 (exit 0) と stderr が空であることの確認は、推論を使わない空の batch の test (9 ms) に移した
- daemon の translate op の返し方は translate-op.test の stub が持つ

直した後の just test は 4037 pass / 0 fail (84.46 s)。

## 残ること

- 実物の翻訳の test は OS の解析と重なると最大 30 秒台 (観測 30.6 秒) かかりうるので、25 秒の期限を超える可能性は残る
- daemon 本体の watchdog (短い入力で 11 秒) も同じ理由で、OS の解析中は webui の翻訳を「詰まった」と判断して helper を kill しうる。test でなく製品側の課題なので別に扱う
