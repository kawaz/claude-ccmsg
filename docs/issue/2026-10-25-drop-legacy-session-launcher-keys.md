---
title: session_launcher の旧キー許容を外す
status: open
category: task
created: 2026-10-25T12:53:34+09:00
last_read:
open_entered: 2026-10-25T12:53:34+09:00
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

# session_launcher の旧キー許容を外す

## 概要

新 daemon は session_launcher の旧キー shell / templates / timeout_seconds を移行期間として無視して読む (DR-0018 §3.1 の移行期間の扱い、`packages/daemon/src/config.ts` の `SessionLauncherSchema` と `noteLegacyLauncherKeys`)。旧版の ccmsg のセッションが居なくなったら、この許容を外す。

## 背景

旧版の config を持つ環境でも新 daemon が起動できるよう、3 つのキーを受け入れて起動時に ignoring legacy keys の行を出している。旧版のセッションが残っている間だけ必要な暫定措置。

## 受け入れ条件

- [ ] 旧版の ccmsg のセッションが居なくなったことを確認する
- [ ] 3 つのキー (shell / templates / timeout_seconds) の受け入れと、起動時の ignoring legacy keys の行を外す
- [ ] 関連テストを外す
- [ ] DR-0018 §3.1 の移行期間の項と runbook (`docs/runbooks/session-launcher-setup.md`) の注記を消す
- [ ] kawaz の config から旧キーを消す (同時に行う)
