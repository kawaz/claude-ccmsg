---
title: file 系 attachment のプレビュー表示 + プロジェクト外ファイルのグループ分け
status: open
category: design
created: 2026-08-02T08:51:22+09:00
last_read: 2026-08-12T13:20:30+09:00
open_entered: 2026-08-02T08:51:22+09:00
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

# file 系 attachment のプレビュー表示 + プロジェクト外ファイルのグループ分け

## 概要

kawaz r99m35 の後半要望 (前半の type 表示は v0.95.0 で出荷済み)。

1. TL の file 系 attachment (edited_text_file 等) を開いた時に、Read カード同様のファイルプレビューを出せるようにする。
2. その場合プロジェクト外ファイルの allowlist に追加しないと Files で見られないため対応が必要。
3. kawaz 原文「Read/Edit/Write で触ったのとは別の括りが欲しいかも。プロジェクト外の下に『Read/Edit/Write』と『attachments』とかでグループ化されてて欲しい」— Files ツリーのプロジェクト外セクションを由来別 (Read/Edit/Write vs attachments) にグループ分けする。

## 背景

fs-access の external allowlist (DR-0008/DR-0024) と session-status の allowlist fold に波及するため、別フェーズとして起票する。関連: v0.95.0 の ATTACHMENT_SPECS (transcript-model.ts)。

## 受け入れ条件

- [ ] file 系 attachment を開いた時に Read カード同様のプレビューが表示される
- [ ] プレビュー対象がプロジェクト外の場合も allowlist 経由で正しく閲覧できる
- [ ] Files ツリーのプロジェクト外セクションが由来別 (Read/Edit/Write vs attachments) にグループ分けされる
