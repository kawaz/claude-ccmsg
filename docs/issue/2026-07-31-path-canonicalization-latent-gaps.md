---
title: パス正規化の潜在ギャップ 2 件 (symlink 綴り / peers.cwd の生綴り)
status: open
category: bug
created: 2026-07-31T23:47:03+09:00
last_read: 2026-08-12T08:12:55+09:00
open_entered: 2026-07-31T23:47:03+09:00
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

# パス正規化の潜在ギャップ 2 件 (symlink 綴り / peers.cwd の生綴り)

## 概要

C32d 403 修正 (v0.88.3) の調査中に worker が実測で発見した潜在バグ 2 件。

1. daemon `fs-access.ts` の `fsStatBatch` (:809-819 付近) は realpath 済み containment root と入力パスを生文字列 prefix 比較するため、symlink を挟む綴り (例: `/tmp/...` = `/private/tmp` への symlink) の絶対パスが contained 判定されず `null` (リンク化されない) になる。実測: `/tmp` 配下 cwd のセッションで `[null]`、realpath 綴りなら contained。
2. peers の `cwd` は hello が名乗った生綴りのまま、`repo_root` だけ daemon が realpath 済みという非対称があり、`repo_root` を名乗らないセッションでは生 cwd が client 側 containment root になるため同種の 403 を再発させうる。

どちらも 2026-07-31 時点の kawaz 報告経路には該当せず未修正。

## 背景

C32d (403 応答の調査・修正、v0.88.3) の過程で worker が周辺コードを読んだ際に発見。
関連: DR-0008 / DR-0024。`docs/findings/2026-07-31-blocking-io-audit.md` とは別件。

## 受け入れ条件

- [ ] 両方とも daemon 側で realpath 統一する方向で修正 (external allowlist の `/var` ↔ `/private/var` 統一と同じ発想)
- [ ] symlink を挟む cwd (`/tmp/...` 等) からの fsStatBatch でも containment 判定が正しく行われることを実測で確認
- [ ] `repo_root` 未申告セッションでも peers.cwd の containment 判定が realpath 経由で一貫することを確認
