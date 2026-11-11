---
title: peers の vcs.workspace を jj の記録にある workspace 名から取る (今はディレクトリ名)
status: open
category: design
created: 2026-11-11T21:48:11+09:00
last_read:
open_entered: 2026-11-11T21:48:11+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 一覧のモデルの 1 段目の実装で worker が気づいた (2026-11-11)
---

# peers の vcs.workspace を jj の記録にある workspace 名から取る (今はディレクトリ名)

## 概要

セッションの一覧の `vcs.workspace` (と `ws`) は、jj の workspace の名前をそのディレクトリ名から取っている。`jj workspace add <dir> --name <name>` でディレクトリ名と違う名前を付けた workspace では、jj の言う名前とずれる。jj の default workspace と git の main worktree には `vcs.workspace` を出していない。

## 観測 (2026-11-11)

- jj は workspace ごとの記録 `.jj/working_copy/checkout` (protobuf) に workspace 名を持っている。worker の workspace では `peer-model-stage1`、リポの main の作業コピーでは `main` が入っていた
- 同じ日に、ディレクトリ `ws-baseline` に `--name permit-jump-baseline` で作った workspace があった (ディレクトリ名と jj の名前が違う実例)
- git の linked worktree でも同じずれがある。ディレクトリ名が `1234-5678-topic` の worktree の `.git` は `gitdir: …/.bare/worktrees/1234-topic` を指していて、git の言う worktree 名は `1234-topic` (v0.246.0 の実 daemon の `ccmsg peers` で見た cwd。`vcs.workspace` はディレクトリ名の方になる)

## 決めること

- jj の内部の記録 (protobuf、形式は jj の版で変わりうる) を daemon が読むか。読むなら default workspace にも名前が付き、`--name` のずれも無くなる。読まないなら今の「ディレクトリ名」の決まり (DR-0003 §3) のまま
- git の worktree の名前を gitdir の末尾 (`worktrees/<name>`) から取るか
- 子プロセスを起こさない決まり (repo-derive.ts) は保つ

## 関連

- docs/decisions/DR-0003-wire-protocol.md §3 (daemon が cwd から導く欄)
- docs/issue/2026-11-11-peer-model-workspace-vcs-repo.md (一覧のモデルの整理。2 段目で ws を消す時に一緒に決めるとよい)

## 受け入れ条件

- [ ] jj の記録を読むか読まないかが決まり、DR-0003 §3 に反映されている
