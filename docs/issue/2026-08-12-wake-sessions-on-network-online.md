---
title: ネットワーク online/offline 変化で停止セッションを起こす
status: open
category: request
created: 2026-08-12T12:22:23+09:00
last_read:
open_entered: 2026-08-12T12:22:23+09:00
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
