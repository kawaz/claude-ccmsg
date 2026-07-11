---
title: CCMSG_SID 未設定投稿が u1 (ユーザ) 名義に化けるのを防ぐ
status: open
category: bug
created: 2026-07-12T01:05:45+09:00
last_read:
open_entered: 2026-07-12T01:05:45+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
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

## 改善候補 (未確定、採否は担当セッションに委ねる)

- agent 文脈での SID 無し post を hard-fail 化する
- 警告を stderr でなく応答 payload (post のレスポンス JSON 等) に昇格し、agent から見える形にする
- (c) hook が書く state ファイル (`sessions/<sid>.json`) から sid を推定するフォールバック — ただし CLI からは自分がどのセッション由来か判別する情報が env 以外に無いため、単独では成立しない可能性が高い。tty 判定や `CLAUDECODE` 系 env の存在検査と組み合わせる場合の補助案として記録 (出典: main セッション (9e0f2326) が同問題を実地で踏んだ際の検討)

## 受け入れ条件

- [ ] SID 未設定時の `from:u1` 誤配信を防ぐ、または agent が確実に気づける形に改善する方針が決まる
- [ ] 方針に沿った実装 (hard-fail / 応答昇格 / 他案) が適用される

## TODO

<!-- wip 時のみ -->
