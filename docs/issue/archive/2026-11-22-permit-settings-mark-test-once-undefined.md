---
title: permit-project-permissions.test.ts の add の行の「削除」の試験が 1 回だけ mark が undefined で落ちた
status: resolved
category: bug
created: 2026-11-22
close_reason: implemented
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

## 結果 (2026-11-22)

見立て (ev が返事より後に届く) は外れていた。

- daemon は apply の返事より前に ev を送る (`permit_permission_apply` で `broadcastPermitState` の後に `send(conn, { ok: ... })`)。同じ接続の順序は保たれ、試験は ping で順序を揃えている
- 本当の原因は `broadcastPermitState` が、直前に push した ev と JSON が同じ時に push を省くこと。`applied_at` は `nowIso()` のミリ秒なので、「削除 (ファイル無しで changed: false)」の直後の「適用」が同じミリ秒に入ると ev が同一になり、push が無く `pendingEvents()` が空で mark が undefined になる
- 元の試験を 40 回流して 3 回落ちることを確かめた (どれも `Received: undefined`)

直し方: `markOf` が、ev の push を待つ代わりに `subscribe` をもう一度送り、その返事に続く現在の状態 (`permit_state`) を読む。subscribe は idempotent で、常に今の状態を送る。期待の値は変えていない。直した後は 40 回流して全部通り、`just test` も通った。permit の他の試験に同じ読み方 (op の後に `pendingEvents()` で状態を取る) は無い (他は push が無いことの確認)。
