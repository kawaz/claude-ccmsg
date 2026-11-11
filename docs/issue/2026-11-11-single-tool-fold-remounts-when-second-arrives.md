---
title: TL で tool が 1 件だけの時に直接見せている中身が、2 件目が来ると fold に包まれて作り直される
status: open
category: bug
created: 2026-11-11T22:17:04+09:00
last_read:
open_entered: 2026-11-11T22:17:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 末尾のバブルの作り直しの調査で worker が見つけた (2026-11-11)。直していない
---

# TL で tool が 1 件だけの時に直接見せている中身が、2 件目が来ると fold に包まれて作り直される

## 概要

観測 (2026-11-11、隔離 daemon、headless):

- tool の呼び出しが 1 件だけの時は fold を作らず、中身を直接見せている (div.tl-guided-content。1 件だけなら直接見せる決まり)
- そこに次の tool の行が加わると、details.tl-line.tl-fold-group で包む形に替わり、元の 1 件の DOM 要素は作り直される (印を付けた 25 要素のうち残ったのは 0)
- 見え方も変わる: 直接見えていた中身が、閉じた fold の中へ移る

影響:

- 1 件目の中身に対する一時状態 (開いていた項目、選択、コピーの表示等) が消える
- 読んでいる最中に中身が畳まれる

## 背景

末尾のバブルの作り直し (docs/issue/archive/2026-11-06-timeline-tail-bubble-remount-loses-transient-state.md) の調査で見つかった別原因の作り直し。そちらは直した。こちらは未対応。

## 受け入れ条件

決めること:

- 1 件だけなら直接見せる決まりを保ったまま、2 件目が来た時に 1 件目の要素を保つ (同じ並び・同じ key で包み方だけ変える) か
- 2 件目が来た時に畳むこと自体を変えるか (読んでいる最中に畳まれるのがよいか)

- [ ] 2 件目が来ても 1 件目の中身の DOM 要素と一時状態が保たれる (または畳み方の方針が決まっている)
