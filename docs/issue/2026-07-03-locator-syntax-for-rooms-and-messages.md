---
title: room / message / participant のロケータ記法
status: idea
category: design
created: 2026-07-03T22:44:44+09:00
last_read:
open_entered:
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

# room / message / participant のロケータ記法

## 概要

kawaz 発案のロケータ記法メモ (2026-07-03、一次資料 `docs/research/2026-06-29-kawaz-design-statements.md` §7 に逐語あり)。

room ID 自体は形式ルールなし (DR-0003 で確定) だが、その上の表記レイヤとして型マーカー付きロケータを用意するアイデア:

- `#rXXXX` = room 参照
- `#rXXXX-mNN` = room XXXX の mid NN
- `#rXXXX-uNN` = room XXXX の参加者 uid NN
- `#mNN` = スレ内リンク (同一 room 文脈での mid 省略形)

原文には「`#tNN` スレ内リンク」もあり `t` が何を指すかは kawaz に未確認 (`u` の typo の可能性もあるが推測で確定しない)。

## 背景

用途アイデア:

- webui でリンクとして辿れる
- 参加者ロケータから member イベントの repo・ws・cwd を使ってプロジェクトを Finder・VSCode・ブラウザ (gh リポ) で開く
- AI への指示で「`#rXXXX-m10-15` 読んで」のような範囲参照

MVP スコープ外、webui/SKILL 設計時に再訪。

## 受け入れ条件

- [ ] `#tNN` の `t` が何を指すか kawaz に確認
- [ ] webui / SKILL 設計時にロケータ記法の採否を判断
