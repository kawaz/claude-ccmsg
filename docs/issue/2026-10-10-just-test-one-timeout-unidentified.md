---
title: just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)
status: open
category: bug
created: 2026-10-10T11:57:40+09:00
last_read:
open_entered: 2026-10-10T11:57:40+09:00
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

# just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)

## 概要

just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)。2026-10-10 02:xx、段 A (transcript スキーマ) の worker が bun install 直後に /verify 用の隔離 daemon 2 つを並走させながら実行した 1 回目だけ。その後 worker 2 回 + 統括 3 回の `bun test` (daemon 無し) は 3916 pass で再現せず。出力は取り損ねていて test 名・ファイル不明。仮説: daemon 2 つ + playwright の並走による CPU 競合で 5 秒を超えた (未検証)。次に timeout を見たら `bun test 2>&1 | tee` でログを取り、test 名と並走していたプロセスを記録する。

## 受け入れ条件

- [ ] timeout 再発時にログを取得し、test 名と並走プロセスを記録する
