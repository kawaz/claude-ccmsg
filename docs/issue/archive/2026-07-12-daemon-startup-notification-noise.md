---
title: デーモン先起動のたびに既存セッションへ通知が飛んでうるさい — 先起動時の通知を抑止し lazy ensure に任せる
status: resolved
category: bug
created: 2026-07-12T18:14:39+09:00
last_read: 2026-07-22T16:25:37+09:00
open_entered: 2026-07-12T18:14:39+09:00
wip_entered: 2026-07-22T16:27:59+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-23T07:05:55+09:00
discard_reason:
pending_reason:
close_reason: ["done:kawaz裁定 SN-Q1=c — v0.67系 subscribe no-backlog化 + ev:room_cursors集約で既に解消済みだった","done:isolated daemon実測で daemon起動/入れ替え/SessionStart単体から session subscriberへ通知が流れる経路が現行コードに存在しないことを確認","done:member/leaveはDR-0013 §2.3で suppress済み、reconnectも無音","done:SessionStartのdaemon pre-warmはlazy ensureに任せる方針で撤廃済み(v0.71.6)","done:broadcast room新規作成時のkind+title配信は正当な設計仕様として維持"]
blocked_by:
origin: cache-warden (クロスプロジェクト起票)
---

# デーモン先起動のたびに既存セッションへ通知が飛んでうるさい — 先起動時の通知を抑止し lazy ensure に任せる

## 概要

kawaz からの dogfooding フィードバック (2026-07-12、cache-warden セッションの room #r8-m1 原文):

> デーモン先起動のたびに前セッションに通知飛ぶのやっぱすげー無駄でうるさいからやめて。どうせ何かアクションするたびにdaemon自動起動チェックとか入れ替えとかかってにやってくれるんでしょ？

新セッション開始や daemon 起動・入れ替えのタイミングで、既存セッションの subscribe stream に member/title 等のイベントが流れて Monitor 通知としてユーザに届く。ユーザ体感では「新しいことが起きるたびに旧セッションが騒ぐ」ノイズになっている。

kawaz の意図と思われる方向: CLI が呼ばれた時の ensure (チェック + 自動起動 + version 入れ替え) は既にあるのだから、SessionStart 等での先回り起動やそれに伴う既存セッション向けブロードキャストは不要では、というもの。

## 背景

この起票は **部外者セッション (cache-warden)** からの現象報告であり、ccmsg 自体の実装は把握していない。以下は鵜呑みにせず当事者側で裏取りしてから採否を決めてほしい:

- どのイベント種別 (member join / title / daemon restart 由来の何か) が、どの契機 (SessionStart / daemon 先起動 / version 入れ替え) で、誰に配信されているかは未確認
- member join 通知自体は「room に入れられた」ことを知る正当な用途があるはずなので、抑止対象の切り分け (daemon 起動起因の通知 vs room 操作起因の通知、あるいは通知の severity / バッチ化での緩和) は実装当事者の判断に委ねる
- 「先回り起動 (SessionStart 等) 自体を削るか」「先回り起動は残しつつそれに伴う既存セッションへの通知だけ抑止するか」の 2 方向があり得るが、どちらが適切かも当事者側の判断

## 進捗 (2026-07-22)

kawaz 優先指示で最優先着手。opus47-high worker が調査中:

- ノイズ源 (daemon 起動・入れ替え起因で既存 subscriber に届くイベント) の実測特定
- no-backlog 化 (v0.67 系) 後もまだ漏れているものの切り分け → 根治
- 並行で cwd 検索 AND 化 (webui、別 worker) も走行中

## 受け入れ条件

- [ ] daemon 先起動 (SessionStart / 自動起動 / version 入れ替え) に起因する通知が、既存セッションに対して飛ばなくなる
- [ ] room 操作 (実際のメッセージ投稿等) に起因する正当な通知は維持される
