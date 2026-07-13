---
title: CCMSG_SID 未設定投稿が u1 (ユーザ) 名義に化けるのを防ぐ
status: resolved
category: bug
created: 2026-07-12T01:05:45+09:00
last_read: 2026-07-13T13:53:14+09:00
open_entered: 2026-07-12T01:05:45+09:00
wip_entered: 2026-07-13T14:00:00+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-13T14:08:34+09:00
discard_reason:
pending_reason:
close_reason: ["implemented:v0.25.0 (c24b5ea6)","dr/DR-0003","CLI write系5opがidentity無しでhard-fail、CLAUDE_CODE_SESSION_IDを自動採用、--as-userを削除","skills/ccmsg/SKILL.mdに「write系はsession identity必須」節+「room運用の作法」節を追加","根拠:r10 mid=9(kawaz裁定)、実装:worker=u1-fix、team-lead監査済み"]
blocked_by:
origin: 依頼元プロジェクト
---

# CCMSG_SID 未設定投稿が u1 (ユーザ) 名義に化けるのを防ぐ

## 概要

`CCMSG_SID` が未設定のセッションが post すると `from:u1` (= ユーザ名義) で配信され、受信側の送信元判定 (「`from:u1` のみが実際のユーザ発言」という前提) が狂う。stderr 警告のみでは agent がこの誤配信に気づけない。

## 背景

実例: room r2 の `mid2` / `mid4` は main ws セッションからの投稿だったが、`CCMSG_SID` が付いておらず `u1` 名義で配信された。受信側 (ccmsg skill を参照する agent) は `from:"u1"` をユーザ発言と信頼する運用のため、この誤配信は「ユーザが言ってもいないことをユーザ発言として扱う」事故に直結する。

一次資料:
- room r2 の mid1-5 (誤配信の実例)
- ccmsg skill の「CCMSG_SID を必ず付ける」節 (現状の対策が warning に留まっている根拠)

## 方針 (kawaz r10 裁定、2026-07-12)

1. **CLI から u1 発行経路を塞ぐ** — `--as-user` フラグ廃止、`CLAUDE_SESSION_ID` env 削除。u1 発行は webui backend の `hello role="user"` 経由のみ
2. **write 系 5 op (post / create-room / next-room / leave / notify) は identity なしで hard-fail** — sid が取れなければ CLI が exit 1 + stderr にエラーメッセージ (env 3 種と `--as-session` を明示)
3. **`CLAUDE_CODE_SESSION_ID` を自動採用** — 優先度は `--as-session > CCMSG_SID > CLAUDE_CODE_SESSION_ID > null` (空文字は undefined 扱い)
4. **subscribe だけは u1 fallback を許容** — 素のターミナルから kawaz が観測する経路として温存、CLI は stderr に警告を出す
5. **create-room UX 改善** — 呼び出し元 session を members 先頭に自動 include、`--exclude-self` で opt-out、`--members` に `u1` を含めたら reject

## 受け入れ条件

- [x] SID 未設定時の `from:u1` 誤配信を防ぐ、または agent が確実に気づける形に改善する方針が決まる (上の 5 項目)
- [x] 方針に沿った実装が適用される (CLI / daemon include_self / SKILL / DR-0003 §3 / tests、`just ci` 712 pass)

## TODO

- [x] `packages/protocol/src/index.ts` に `CreateRoomRequest.include_self` を追加
- [x] `packages/daemon/src/server.ts` の `create_room` が `include_self=false` で呼び出し元 sid の自動追加を抑制
- [x] `packages/cli/src/index.ts` の identity 判定を `resolveSessionIdentity` に改名、`--as-user` / `CLAUDE_SESSION_ID` を削除、`CLAUDE_CODE_SESSION_ID` を自動採用、write ops を hard-fail 化
- [x] CLI `create-room` が呼び出し元 sid を members 先頭に自動 include、`--exclude-self` で opt-out、`--members u1` を reject
- [x] `skills/ccmsg/SKILL.md` に「write 系は session identity 必須」節と「create-room の呼び出し元自動 include」節を追加
- [x] `docs/decisions/DR-0003-wire-protocol.md` §3 を revise (env 優先度・write hard-fail・subscribe u1 fallback・Alternatives 追記)
- [x] `packages/cli/test/cli.test.ts` に回帰 test 5 種追加 (write hard-fail / u1 members reject / auto-include / --exclude-self / CLAUDE_CODE_SESSION_ID 拾える / CLAUDE_SESSION_ID 拾わない / subscribe stderr 警告)
- [x] `packages/cli/test/reconnect.test.ts` の `--as-user` 削除で壊れた 2 test を修正 (sid 環境変数を空にして u1 fallback 経路に乗せる)
- [x] hooks / webui コメントの CLAUDE_SESSION_ID 参照を CLAUDE_CODE_SESSION_ID に置換
- [x] commit landing 後に `/local-issue:update ... close` で resolved 遷移 (親セッションの担当)
