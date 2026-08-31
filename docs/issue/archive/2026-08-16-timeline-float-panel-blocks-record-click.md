---
title: timeline フロートパネルが項目クリックを塞ぐ
status: resolved
category: bug
created: 2026-08-16T15:40:26+09:00
last_read:
open_entered: 2026-08-16T15:40:26+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-31T13:25:51+09:00
discard_reason:
pending_reason:
close_reason: ["implemented:v0.123.1 で修正。パネル開時に TL 本文を padding-right (実測幅) で押しのけて遮蔽を解消 + .tl-lines 内クリックではパネルを畳まない判定を追加 (timeline-side-panel.ts)。隔離 daemon + ブラウザ実測で「パネル開のまま項目クリック → 選択変更・パネル維持」を確認、受け入れ条件達成"]
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

## 経過 note

v0.110.0 で assistant バブルの hover ツールバー(☰ ハンバーガー)から fork/dump を項目単位で開けるようになり、「先に項目を選んでからパネルを開く」順序強制は回避経路ができた(☰ を開く操作自体がその項目の明示選択になる)。ただし float パネル自体が timeline 項目に重なってクリックを塞ぐ問題そのものは未解決(パネル表示中の下の項目クリックは依然不可)。受け入れ条件は未達のまま。
