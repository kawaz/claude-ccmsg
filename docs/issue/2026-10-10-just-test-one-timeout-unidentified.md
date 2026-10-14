---
title: just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)
status: open
category: bug
created: 2026-10-10T11:57:40+09:00
last_read:
open_entered: 2026-10-10T11:57:40+09:00
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

## 受け入れ条件

- [ ] timeout 再発時にログを取得し、test 名と並走プロセスを記録する
