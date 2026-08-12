---
title: ネットワーク online/offline 変化で停止セッションを起こす
status: resolved
category: request
created: 2026-08-12T12:22:23+09:00
last_read:
open_entered: 2026-08-12T12:22:23+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T12:48:59+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.101.0 で実装 (kawaz r119m10 の最小設計どおり)。route monitor による event-driven 検知 + scutil ローカル probe、offline→online 遷移で session-errors の api-error fold が立っているセッションの subscribe stream に ev:net_online を 1 回配信。実 daemon 統合テストで対象限定・1 回性・再停止時の再通知を実測確認。本番 daemon は v0.101.0 自動 upgrade 済みで次の復旧から有効"]
blocked_by:
origin: 自リポ TODO
---

# ネットワーク online/offline 変化で停止セッションを起こす

## 概要

ホストのネットワーク online/offline 変化イベントをトリガーに、API エラーで停止中の
セッション (worker/セッション) を自動的に再開させる機能。

kawaz 原文: 「ポストのネットワークのonline/offlineの変化イベントで停止中のセッションを
起こしてやる機能が欲しいですね」

## 背景

モバイル回線・スリープ等でホストの接続が切れると worker/セッションが API 503 で
停止し、回線復帰後も止まったままになる。現状は統括が手動で SendMessage して再開
させている。今セッションで d-impl のスリープ 3 回、w-tl-d2 の 503 が発生した実績あり。

## 受け入れ条件

- [ ] ネットワーク online 復帰を検知できる
- [ ] 「API エラーで停止中」のセッションを特定できる
- [ ] 該当セッションを自動的に再開できる (誤爆なく)

## 設計論点

- (a) online 検知の経路: daemon がホストの network 変化イベントを監視する手段
  (macOS の SCNetworkReachability / route monitor 等)
- (b) 「停止中」の判定: API error で idle になっているセッション一覧をどう得るか
  (idle_notification の failureReason 等)
- (c) 起こし方: 該当セッションへの resume メッセージ送出。誰が送るか
  (daemon 自身が送るか、統括セッションへ通知して統括が送るか)
- (d) 誤爆防止: 意図的に停止させたセッションを誤って起こさない判定

## 方向確定 (kawaz 裁定)

kawaz: 「APIエラーで止まってるセッション限定でネット復旧通知的なのを簡潔に投げれば
十分。実際、手動でピリオド1個送って復帰とかやってるわけだし」。

大掛かりな resume 機構ではなく、以下の最小設計でよい:

1. ホストの online 復帰を検知
2. API エラーで停止中のセッションに限定
3. 簡潔な復旧通知メッセージを 1 発投げる

論点 (c)(d) はこの裁定でほぼ解消 (誤爆先が「API エラー停止中」に限定されるため)。
