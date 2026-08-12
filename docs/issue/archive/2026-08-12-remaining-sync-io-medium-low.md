---
title: daemon の残存同期 IO (medium/low) の解消
status: resolved
category: task
created: 2026-08-12T08:39:53+09:00
last_read:
open_entered: 2026-08-12T08:39:53+09:00
wip_entered: 2026-08-12T08:47:38+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T09:03:33+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.100.5 で virtual-sessions/agent-transcripts/fs-access/origins-file/session-status/transcript の残存同期IOをfs.promises化 (transcriptはwatchコールバック用の同期経路を分離し再入ガード不要設計を維持)","readAgentToolUseIdsはsession-status-snapshot-sync-ioの管轄へ移管","canonicalizeExternalPathはfold再設計案件として同issueで扱う"]
blocked_by:
origin: 自リポ TODO
---

# daemon の残存同期 IO (medium/low) の解消

## 概要

findings `2026-08-12-blocking-io-audit-full` の「非同期化する」medium 8 件 / low 5 件のうち、
high として個別対応済み (fsRead/fsWrite v0.100.3、snapshot 経路は
`session-status-snapshot-sync-io`、Timeline は `timeline-crossline-incremental`) を除いた
残りをまとめて解消する。

## 背景

- virtual-sessions の同期スキャン (最大 4MB 読み込み)
- readAgentToolUseIds の同期 API
- fsEdit/fsCreate/fsDelete に残る lstatSync/openSync sniff/unlinkSync
- resolveContained/resolveRoot/validateRepoRoot の realpathSync 等

まとめて機械的に `fs.promises` 化できるものが多い。優先度と経路は findings
`2026-08-12-blocking-io-audit-full` の表が正本。

## 受け入れ条件

- [ ] findings の表にある medium/low 項目のうち、上記個別 issue でカバーされていないものを全て非同期化
- [ ] 非同期化後も既存テストが green

## TODO

<!-- wip 時のみ -->

着手 (2026-08-12)。findings の表を正本に機械的 fs.promises 化を worker へ委譲。

- [ ] findings の表を再確認し、対象項目を洗い出す
- [ ] virtual-sessions の同期スキャンを fs.promises 化
- [ ] readAgentToolUseIds を非同期 API 化
- [ ] fsEdit/fsCreate/fsDelete の lstatSync/openSync/unlinkSync を非同期化
- [ ] resolveContained/resolveRoot/validateRepoRoot の realpathSync を非同期化
