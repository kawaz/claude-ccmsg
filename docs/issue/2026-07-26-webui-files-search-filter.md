---
title: Files panel にファイル名検索機能を追加
status: open
category: request
created: 2026-07-26T07:53:03+09:00
last_read:
open_entered: 2026-07-26T07:53:03+09:00
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

# Files panel にファイル名検索機能を追加

## 概要

webui の Files panel (`FileTree.tsx` / `FilesPanes.tsx`) にファイル名検索機能を追加する。

要件:

1. パス内文字列の部分一致検索
2. 複数ワード (空白区切り) で AND 絞り込み
3. UI は「Search files by name」的なシンプルな入力欄

## 背景

r55m67 リクエスト。現状の Files panel (`packages/webui/src/client/components/FileTree.tsx`) はディレクトリを展開して初めて中身が `fs_list` で取得される遅延ロード式ツリー (DR-0008) で、未展開のディレクトリ配下は状態を持たない。パス文字列の検索を実装するには、この遅延ロード構造と検索範囲 (すでに読み込み済みのサブツリーのみ検索するか、検索時に必要な範囲を先読みするか) の関係を設計段階で詰める必要がある。

## 受け入れ条件

- [ ] Files panel に「Search files by name」的な検索入力欄がある
- [ ] 入力文字列がパス (相対パス) 内に部分一致するファイル/ディレクトリのみ表示される
- [ ] スペース区切りの複数ワードは AND 条件で絞り込まれる
- [ ] 既存の遅延ロード方式 (未展開ディレクトリ未取得) との整合が取れている (検索時の先読み方針を含む)

## TODO

<!-- wip 時のみ -->
