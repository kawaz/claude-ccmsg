---
title: セッション側から正規 1on1 room を作る手段がない
status: open
category: design
created: 2026-07-23T16:39:08+09:00
last_read:
open_entered: 2026-07-23T16:39:08+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 依頼元プロジェクト (claude-ccmsg dogfooding セッション)
---

# セッション側から正規 1on1 room を作る手段がない

## 概要

セッション側から kawaz (u1) との正規 1on1 room (kind='1on1') を作る手段が無い。
`create-room --members <自sid>` で room を自作しても kind が `1on1` にはならず、
グローバル ROOMS エリアに通常 room として表示されてしまう。

## 背景

2026-07-23 の実例: 新セッションが前セッションの 1on1 (r46) に post しようとして
`not_a_member` で拒否された。代替として `create-room --members <自sid>` で room
(r54) を自作したが、kind が 1on1 にならず通常 room として表示された
(kawaz 指摘 r55m21)。正規 1on1 (kind='1on1') は daemon 側の生成経路のみが
持っているらしい。

## 受け入れ条件

- [ ] セッション側から正規 1on1 (kind='1on1') を作成/取得できる手段が定まる
  (方向性は下記いずれか、もしくは組み合わせ):
  - (a) `create-room` に `--kind 1on1` 相当のオプションを許可 (u1 との
    1on1 に限定)
  - (b) セッション初回 post 時に daemon が自動で 1on1 を生成
  - (c) 既存 room の kind 変更 / archive を CLI から可能にする
- [ ] 上記いずれかの方針を選び実装する
- [ ] 既存の誤生成 room r54 の後始末 (archive) 手段も用意する

## TODO

<!-- wip 時のみ -->
