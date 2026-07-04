---
title: daemon 側で subscribe 稼働を検出する (ps 走査からの置き換え)
status: idea
category: design
created: 2026-07-04T09:25:05+09:00
last_read:
open_entered:
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

# daemon 側で subscribe 稼働を検出する (ps 走査からの置き換え)

## 概要

UserPromptSubmit hook の subscribe 稼働検出は、現在 ps による ppid chain 走査
(プロセスツリーに `ccmsg subscribe` がいるかどうかを見る) で実装している。
中央 daemon 型のアーキテクチャとしては、daemon 自身に問い合わせる方が本来素直:
daemon は subscribers (各接続の identity.sid) を保持しており、live な subscribe
接続を正確に把握している。resume 等でプロセスが別プロセス化しても、接続 close は
即座に daemon 側へ反映される。

## 背景

現行の ps ppid chain 走査は、プロセスツリー構造に依存した間接的な検出手段であり、
以下のリスクを持つ:

- プロセスツリーの形が変わる状況 (resume で別プロセス化する等) で誤検出・取りこぼしが起こりうる
- daemon が正確に把握している情報 (live subscribe 接続) を使わず、外部プロセスから推測している

実現には protocol 拡張が必要になる見込み:

- 案1: `peers` 応答に per-peer `subscribed` bool を追加する
- 案2: 専用の query op を新設する

DR-0003 の追補になる規模の変更のため、plugin-scaffold 実装時点 (2026-07-04) では
scaffolding の対象外として見送り、将来の改善候補としてここにフラグを立てておく。
dogfood 運用の中で ps 走査の誤検出・取りこぼしが実際に観測されたら、この issue の
優先度を上げて着手する。

## 受け入れ条件

- [ ] daemon 側で subscribe 接続の有無を問い合わせる protocol 拡張を設計する (DR-0003 追補)
- [ ] UserPromptSubmit hook 側を新 protocol 経由の検出に置き換える
- [ ] ps ppid chain 走査を置き換え後に削除する
