---
title: OS 再起動後、Claude セッションを開くまで daemon が起動せず web UI に繋がらない
status: open
category: request
created: 2026-10-01T14:49:06+09:00
last_read:
open_entered: 2026-10-01T14:49:06+09:00
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

# OS 再起動後、Claude セッションを開くまで daemon が起動せず web UI に繋がらない

## 概要

OS 再起動後、Claude セッションを開くまで claude-ccmsg daemon が起動せず web UI に繋がらない。

観測 (2026-10-01):

- 14:17:51 JST に daemon.log に `graceful shutdown (signal)` (OS shutdown の SIGTERM)
- uptime から 14:18 頃に再起動
- 14:44 のセッション SessionStart hook (`hooks/session-start.ts` の `daemon start`) まで daemon 不在
- launchd には kawaz/ccmsg の `com.github.kawaz.ccmsg` しか無く、claude-ccmsg の unit は無い

## 背景

DR-0002 の「launchd/systemd 登録は行わない。将来必要が観測されたら opt-in で追加 [保留]」が発動した事例。

## 提案

`ccmsg service install` 相当の opt-in 登録を追加する (reference `cli-daemon-subcommands` の体系に沿う)。

要確認:

- launchd 常駐と hook 起動の二重起動を、単一インスタンス保証が捌けるか
- 既定 (登録なし) は維持し、「意識せず使える」要件を崩さないか

## 受け入れ条件

- [ ] 実装方針の裁定 (kawaz)
- [ ] opt-in 登録コマンドの設計と実装
- [ ] launchd 常駐 + hook 起動の併存で二重起動しないことの確認

## TODO

<!-- wip 時のみ -->
