---
title: webui の session_status の購読が読み込み直後の subscribe ×2 → unsubscribe ×1 で切れ、以後 push が来ない
status: resolved
category: bug
created: 2026-10-26T18:04:59+09:00
last_read: 2026-10-28T09:14:00+09:00
open_entered: 2026-10-26T18:04:59+09:00
wip_entered: 2026-10-28T09:15:21+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-28T10:07:30+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","finding/2026-10-28-session-status-subscribe-order"]
blocked_by:
origin: 自リポ TODO
---

# webui の session_status の購読が読み込み直後の subscribe ×2 → unsubscribe ×1 で切れ、以後 push が来ない

## 概要

webui で Timeline (`/s/<sid>/timeline/head`) を読み込んだ直後、session_status の購読が切れ、以後 `ev:"session_status"` が app の WS に届かない。状態行も Status タブも、読み込み直すまで古い値のままになる。

## 現象 (観測済み)

playwright の `page.on('websocket')` の framesent / framereceived で記録した。時刻は goto からの経過。

- 28ms > `session_status_subscribe` sid=<sid> request_id q4
- 28ms > `session_status_subscribe` sid=<sid> request_id q8
- 49〜57ms < 両方の応答 (snapshot)
- 52ms > `session_status_unsubscribe` sid=<sid> request_id q11

その後、daemon 側で status が変わっても (DR-0041 の session_override で request_override を変更)、app の WS には `ev:"session_status"` が 1 件も届かなかった (20 秒待って 0 件)。

同じページから別に WS を開き、hello (user) → `session_status_subscribe` → 変更、と送ると、その WS には `ev:"session_status"` が届いた。daemon は push している。

## 原因の候補 (未確定)

`packages/webui/src/client/components/SessionView.tsx` の購読の effect は deps に statusSource を含む。peers の到着で statusSource が null → 文字列に変わると effect が張り直される。後始末は `subscribed.then(() => ws.sessionStatusUnsubscribe(sid))` で、1 回目の subscribe の応答を待ってから unsubscribe を送る。daemon は同じ接続の購読を重ねて持たない (同 effect のコメントにある「Set 的に重複排除、unsubscribe は無条件にその sid を切る」)。そのため、遅れて届いた unsubscribe が 2 回目の購読ごと消した、と読める。effect の張り直しの順序の確認が要る。

## 再現手順

1. 隔離 daemon を起動し、hooks module 付きのセッションを 1 本つなぐ (`.claude/skills/verify/SKILL.md` の手順)
2. playwright で `/s/<sid>/timeline/head` を開き、WS の framesent を記録する
3. 外から session_status が変わる操作をする (op session_override、または turn を回す)
4. app の WS に `ev:"session_status"` が来ず、表示が変わらないことを見る

## DR-0041 と独立である根拠

- SessionView.tsx の購読の effect と、daemon の `session_status_subscribe` / `unsubscribe` の扱いには、DR-0041 の実装で手を入れていない (DR-0041 の webui の変更は ws.ts の op 追加、状態行・FAB・Status の表示に限る)
- 送受信の列 (subscribe ×2 → unsubscribe ×1) は、ページの読み込みと peers の到着だけで起き、override の操作の前に出ている
- daemon の push は、別の WS の購読には届いた

## 背景

- `docs/findings/2026-10-26-request-override-verify.md` の「本機能の外で見つかったこと」
- DR-0020 (Status / session_status の購読)
- DR-0041 §5 (表示がこの不具合で読み込み直すまで変わらない)

## 受け入れ条件

- [ ] 読み込み直後に subscribe が重複して unsubscribe が 1 回走っても、購読が維持され session_status の push が届き続ける
