---
title: TL 末尾のバブルは後から行が足されると作り直され、一時状態が消える
status: open
category: bug
created: 2026-11-06T14:40:04+09:00
last_read:
open_entered: 2026-11-06T14:40:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: permit-bang-run worker
---

# TL 末尾のバブルは後から行が足されると作り直され、一時状態が消える

## 概要

TL 末尾のバブルは後から行が足されると作り直され、ボタンの送信中 / 送った時刻 / 「コピーしました」などの一時状態が消える。

## 現象

観測 (2026-11-06 permit-bang-run worker): permit バブルが TL の末尾にある時に「! で実行」を押すと、その後 TL に行が足された時点でバブルの DOM 要素が作り直され (ボタンの要素が替わったことを確認)、送った時刻の表示や送信中の状態が消える。

原因は Timeline のスロット描画で末尾のバブルの key / 位置が変わること (未特定、worker の読み)。「コピーしました」の表示や添付の読み込み中にも同じことが起きるはず (未検証)。

## 影響

二度押しの判断材料が消える。

## 対処の候補

- 末尾のバブルの key を行の位置でなく行の uuid 等の安定した値にする
- 一時状態を要素ではなく store に持つ

## 関連

- DR-0040 §11
- findings `2026-11-06-permit-bang-run.md`

## 受け入れ条件

- [ ] TL に行が足されても末尾のバブルの DOM 要素と一時状態が保たれる
