---
title: session_launcher の旧キー許容を外す
status: resolved
category: task
created: 2026-10-25T12:53:34+09:00
last_read:
open_entered: 2026-10-25T12:53:34+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-12T22:56:47+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","done:v0.264.0 で旧キーの受け口を外した"]
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

## 解決の記録

- v0.264.0 で外した。`packages/daemon/src/config.ts` の session_launcher のスキーマから旧キー shell / templates / timeout_seconds の受け口と、起動時に ignoring legacy keys を出す処理を消した。外した後は、旧キーも他の知らないキーと同じく config が読めず daemon は起動しない (エラーは `session_launcher.shell: Invalid key: Expected never but received "shell"`。複数あっても最初の 1 つだけが出る)。`config.test.ts` の 1 件で固定。
- 待っていた条件の確認 (2026-11-12): 接続中のセッションの module の版 (`ccmsg peers` の ccmsg_version) の最小は 0.240.0 で、許容を入れた v0.194.0 より新しい。daemon.log の ignoring legacy keys の最後は 2026-10-30。
- kawaz の config から旧キーを消す項目: 本番が読む `~/.config/ccmsg/config.ts` に旧キーの行は無い (2026-11-12 に確認)。v0.264.0 の daemon はこの config で起動している。旧キーが残っているのは読まれないバックアップ (`config.ts.bak-20261102`) だけで、これを config.ts に戻すと daemon は起動しなくなる。
- 文書: DR-0018 §3.1 の移行期間の項と括弧書き、`docs/runbooks/session-launcher-setup.md` の注記を消した。
