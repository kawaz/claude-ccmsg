---
title: session-status-snapshot-sync-io
status: resolved
category: bug
created: 2026-08-12T08:30:19+09:00
last_read:
open_entered: 2026-08-12T08:30:19+09:00
wip_entered: 2026-08-12T09:03:46+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T09:26:51+09:00
discard_reason:
pending_reason:
close_reason: ["implemented:v0.100.6で実装。mtime-cache(三点一致gate)+snapshot経路の非同期化+pushChain直列化。実測で定常状態のファイルオープン系0回。canonicalizeExternalPathはfold再設計案件として残件記録済み"]
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

DR-0029 確認済み (2026-08-12): 「まとめ処理」= 時間窓集約・複数ジョブの運命共同体化を指す (§まとめ処理節)。mtime ベースキャッシュはメモ化であり束ねも遅延もしないため承認不要と判断。実装は remaining-sync-io-medium-low (同一ファイル session-status.ts を触る) の完了後に直列で着手する。

## 受け入れ条件

- [x] DR-0029 の「まとめ処理は kawaz 承認必須」への該当有無を確認し、必要なら承認を得る
- [x] `readAgentTree` / `discoverWorkspaceFolders` の同期 IO (readdirSync/readFileSync/statSync) を非同期化
- [x] mtime ベースキャッシュ導入で push ごとの再走査コストを削減

## TODO

<!-- wip 時のみ -->

実装着手 (2026-08-12、v0.100.5 の直列後続)。

### 実装結果 (2026-08-12、未 commit)

- 新規 `packages/daemon/src/mtime-cache.ts`: stat の (mtimeMs, size, ino) 一致で memo 化する
  LRU 上限つきキャッシュ。mtime 単独だと同一ミリ秒内の書き換えを見逃すため 3 点で判定
- 非同期化した範囲: `snapshot` 本体、`readAgentTree` / `loadAgentMeta` / `readAgentToolUseIds` /
  `readTeammateModels` / `discoverWorkspaceFolders` / `readWorkflowDrilldown`。呼び出し元は
  `getSessionStatus` / `subscribeSessionStatus` / session-dump の `loadStatusBundle`
- `pushSnapshot` は `fs.watch` コールバックから await できないため、`LiveSessionStatus.pushChain`
  でセッション単位に直列化。順序保証のみで coalesce/debounce は入れていない (= DR-0029 の
  「まとめ処理」には当たらない)
- 実測 (subagent 20 + workflow member 10 + workspace 1 の fixture、`fs.promises` を計装):
  1 snapshot あたり cold 168 回 (readdir 4 / readFile 42 / open 21 / stat 99 / realpath 2) →
  warm 98 回 (stat のみ、readdir / readFile / open / realpath はすべて 0)。cold の数値が
  従来の push ごとのコストに相当し、かつ従来はこれが全部同期だった

### 残件

- `canonicalizeExternalPath` (`foldLine` → `addExternalFile` 内の `realpathSync`) はスコープ外。
  `foldLine` は `scanTranscript` のライン走査ループ・session-dump の同期 fold ループ・多数の
  テストから同期呼び出しされる状態機械で、async 化は fold 全体の再設計になる。snapshot 経路の
  IO 根治とは別種の作業なので分離した
- `readAgentToolUseIds` と `loadAgentMeta` が同じ agent transcript を二重に stat している
  (warm 98 回のうち約 20 回)。stat を渡し合えば削れるが責務が別なので据え置き
