---
title: session-status-snapshot-sync-io
status: open
category: bug
created: 2026-08-12T08:30:19+09:00
last_read:
open_entered: 2026-08-12T08:30:19+09:00
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

# session-status-snapshot-sync-io

## 概要

snapshot() 経路の同期 IO 根治。findings `2026-08-12-blocking-io-audit-full` の high #1/#2:

- `session-status.ts:981` `snapshot()` の `readAgentTree` が `subagents/` と `workflows/` を `readdirSync` ×3 階層 + meta ごと `readFileSync`/`statSync`
- `session-status.ts:1036` `discoverWorkspaceFolders` が push ごとに cwd 直下 `readdirSync` + `*.code-workspace` を毎回パース

status push (transcript 1 行ごと、`fs.watch` コールバック内) で毎回走る現在最大の残件。

## 背景

`2026-08-12-blocking-io-audit-full` findings の続き。非同期化 + mtime ベースキャッシュ (`origins-file.ts` の型を踏襲) が自然な解だが、キャッシュ導入が DR-0029 の「まとめ処理は kawaz 承認必須」に当たるかの確認を先に行うこと。

## 受け入れ条件

- [ ] DR-0029 の「まとめ処理は kawaz 承認必須」への該当有無を確認し、必要なら承認を得る
- [ ] `readAgentTree` / `discoverWorkspaceFolders` の同期 IO (readdirSync/readFileSync/statSync) を非同期化
- [ ] mtime ベースキャッシュ導入で push ごとの再走査コストを削減

## TODO

<!-- wip 時のみ -->
