---
title: permit-project-permissions.test.ts の add の行の「削除」の試験が 1 回だけ mark が undefined で落ちた
status: open
category: bug
created: 2026-11-22
---

# permit-project-permissions.test.ts の add の行の「削除」の試験が 1 回だけ mark が undefined で落ちた

## 観測 (2026-11-22)

worker の workspace (svg の図の変更の作業中、その変更は permit に触れていない) の `just test` で、次の 1 件だけが落ちた。同じ workspace で流し直すと通った。

- `packages/daemon/test/permit-project-permissions.test.ts` の `an add item's 削除 takes its rules out and runs it; taking the mark off leaves the file`
- `Expected "run"` / `Received undefined`

この試験は、op を送った後に `u.pendingEvents()` から最後の `permit_state` の ev を取り、その marks の mark を見ている (`markOf`)。ev が届く前に読むと undefined になりうる。

## 分かっていないこと

- どの assert で落ちたか (行番号は残っていない)
- ev が op の返事より後に届くことがあるのか、ev が来ていない時に `pendingEvents()` が何を返すのか

## やること

- op の返事と `permit_state` の ev の順序 (daemon が ev を送る時機) を確かめる
- 試験は ev が届くのを待ってから読む形にする (タイマーで待たず、ev の到着を待つ)。期待は変えない
