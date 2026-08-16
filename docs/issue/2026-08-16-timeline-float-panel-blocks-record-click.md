---
title: timeline フロートパネルが項目クリックを塞ぐ
status: open
category: bug
created: 2026-08-16T15:40:26+09:00
last_read:
open_entered: 2026-08-16T15:40:26+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: dump-file-impl worker (実機検証中に発見)
---

# timeline フロートパネルが項目クリックを塞ぐ

## 概要

timeline のフロートパネル(アクションパネル)を開いた状態だと、パネルが timeline 項目に重なりクリックでの record 選択ができない。fork も dump(選択起点) も「先に項目を選んでからパネルを開く」順序を強制される。dump の選択起点操作が増えたため以前より当たりやすくなった。

## 背景

dump-file-impl worker の実機検証中に発見(2026-08-16)。改善案の例:

- パネル表示中も下の項目をクリック可能にする
- パネルを開いたまま選択変更できるレイアウト

## 受け入れ条件

- [ ] パネルを開いた状態でも timeline 項目のクリック選択ができる
