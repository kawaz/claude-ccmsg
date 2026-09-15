---
title: room の member 情報の `cwd` が直前の Bash ツールの一時 cwd を拾う
status: resolved
category: bug
created: 2026-09-15T11:57:36+09:00
last_read:
open_entered: 2026-09-15T11:57:36+09:00
wip_entered: 2026-09-15T16:58:10+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-15T17:20:00+09:00
discard_reason:
pending_reason:
close_reason: ["dr/DR-0003","implemented","done:0.153.0 で修正 (commit 788ad1ea)。真因は CLI が hello に process.cwd() を載せていたこと。所在の出所を CCMSG_CWD 明示 → session state file (SessionStart hook が CLAUDE_PROJECT_DIR / event cwd で書く) → CLAUDE_PROJECT_DIR の 3 つに限定、post / create-room / UserPromptSubmit は所在を名乗らず、daemon は空 cwd の hello で登録済み所在を保持。release 済み、daemon は newer-wins で置き換わった (pid 76651)。v2 は kawaz/ccmsg の session-cwd-from-hook-event-drifts (v1.0.2)"]
blocked_by:
origin: 依頼元セッション (emrd 統括 sid d9a14568) からの報告
---

# room の member 情報の `cwd` が直前の Bash ツールの一時 cwd を拾う

## 概要

emrd 統括セッション (sid d9a14568) の報告 (2026-09-15、事象は 2026-09-10 10:38 JST、room r294 の member イベント): kawaz 側が create-room した時の member 情報の `cwd` が `…/github.com/emeradaco` (直前の Bash `cd … && direnv exec . gh issue view …` の一時 cwd) になっていた。セッションの実体 (`ccmsg peers` の cwd) は `kawaz123/emrd-workboard/main` で正しい。自分で create-room した room (r295 / r296 / r302 / r305 / r306) は正しい cwd。`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` 設定済み。

## 背景

### 仮説 (未検証)

daemon が member 情報を組み立てる時、plugin の hook が報告する「event-time cwd」(hooks/session-start.ts のコメントにある、hook プロセス自身の cwd と乖離しうる値) を採っており、Bash ツールが cd した直後の hook ではその一時 cwd になる。

### 方針 (kawaz の意図)

セッションの所在は固定値 (`CLAUDE_PROJECT_DIR`、または hello 時に登録した cwd) から取る。hooks が cwd を何から取っているか (pwd / hook 入力の cwd / `CLAUDE_PROJECT_DIR`) を確認して固定値に寄せる。

### 裏取り

r294 の member イベント (2026-09-10T01:38:05Z、sid d9a14568) と前後の hook ログ。

### 関連

- v2 (`kawaz/ccmsg`) issue `session-cwd-from-hook-event-drifts` (同じ設計判断)

## 受け入れ条件

- [x] member 情報の `cwd` の取得元を特定し、固定値 (`CLAUDE_PROJECT_DIR` 等) から取るよう修正する
- [ ] r294 のような「直前の Bash 一時 cwd を拾う」再現がなくなることを確認する (本番 daemon を新版に入れ替えた後、統括が確認)

## 対応 (commit 788ad1ea)

実際に効いていた経路は CLI の `resolveSessionIdentity` が hello に `process.cwd()` を載せていたこと。所在の出所を `CCMSG_CWD` / hook が書く session state file / `CLAUDE_PROJECT_DIR` の 3 つに限り、SessionStart 以外の hook は所在を名乗らず、所在を名乗らない hello に対しては daemon が登録済みの所在 (cwd/repo/ws/repo_root/branch の 5 つで 1 組) を保つようにした。正本は DR-0003 §3 「所在の正本」。

## TODO

<!-- wip 時のみ -->
