---
title: config dir の検出が、config dir でない .claude 始まりのディレクトリも返す
status: open
category: bug
created: 2026-11-12T21:57:30+09:00
last_read:
open_entered: 2026-11-12T21:57:30+09:00
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

# config dir の検出が、config dir でない .claude 始まりのディレクトリも返す

## 概要

config dir の検出が、`.claude` で始まる config dir でないディレクトリ (`.claude.json`、`.claude.json.lock`、`.claude-<面>.lock` 等) も返す。

観測 (2026-11-12、読むだけで確かめた): 開発機の HOME の直下で、`.claude.json`、`.claude.json.lock`、`.claude-personal.lock`、`.claude-emrd.lock.bak-<数字>` の実体がディレクトリだった (中身はどれも `.claude.json` と `backups`)。`.claude` 自体は通常のファイル。daemon の `detectConfigDirs` (packages/daemon/src/agents.ts の 46〜66 行あたり) の判定は「名前が `.claude` で始まり、ディレクトリである」だけなので、これらも config dir として返る。

## 背景

影響: これらには `projects/` が無いので、transcript の探索では readdir が 1 回ずつ失敗して飛ばされるだけ (害は読み出し 1 回ずつ)。config dir の一覧を別の用途 (配送先の判定、セッションの検索) に使う所で、config dir でないものが混ざって困る場面があるかは未調査。

分かっていないこと: これらのディレクトリを作っているのが Claude Code のどの動作か (ロックとバックアップの名残に見える)。

関連: docs/issue/2026-11-11-test-daemons-read-real-home.md (この調査の途中で見つかった)

## 受け入れ条件

- [ ] 判定を絞るか (例: `projects/` か `settings.json` を持つものだけ、名前が `.lock` や `.json` で終わるものを外す)、今のまま害が小さいとして閉じるかが決まる
- [ ] 絞るなら、config dir でないディレクトリが検出結果に入らないことをテストで固定する
