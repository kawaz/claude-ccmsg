---
title: config dir の検出が、config dir でない .claude 始まりのディレクトリも返す
status: resolved
category: bug
created: 2026-11-12T21:57:30+09:00
origin: 自リポ TODO
close_reason: implemented
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

- [x] 判定を絞るか (例: `projects/` か `settings.json` を持つものだけ、名前が `.lock` や `.json` で終わるものを外す)、今のまま害が小さいとして閉じるかが決まる
- [x] 絞るなら、config dir でないディレクトリが検出結果に入らないことをテストで固定する

## 対応

判定を絞った。`detectConfigDirs` は `.claude*` のうち `sessions/` か `projects/` をディレクトリとして持つものだけを返す。

- 証拠の選び方は [findings](../../findings/2026-11-19-config-dir-markers.md)。開発機の本物の config dir 3 つは両方を持ち、偽物 5 つはどちらも持たない (中身は `.claude.json` と `backups/` だけ)。一時 HOME で、`claude agents --json` が `CLAUDE_CONFIG_DIR` の指す dir に偽物と同じ形を残し、対話起動は入力の前に `sessions/` を作ることを確かめた。`settings.json` は使っている config dir に必ずあるとは限らないので証拠にしない。名前の形では、名前が面の形で中身が偽物と同じ dir を見分けられないので採らない
- daemon が config dir から読むのは `sessions/` と `projects/` だけなので、どちらも無い dir を外しても読めなくなる物は無い。印は呼ぶたびに探し直すので、後から `sessions/` ができた dir は次の回で拾われる
- テスト: `packages/daemon/test/detect-config-dirs.test.ts`
- [DR-0034](../../decisions/DR-0034-peer-socket-injection.md) §2 の受け持つ config dir の記述を合わせた
