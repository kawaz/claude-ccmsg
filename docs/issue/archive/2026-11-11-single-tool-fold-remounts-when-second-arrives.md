---
title: TL で tool が 1 件だけの時に直接見せている中身が、2 件目が来ると fold に包まれて作り直される
status: resolved
category: bug
created: 2026-11-11T22:17:04+09:00
origin: 末尾のバブルの作り直しの調査で worker が見つけた (2026-11-11)
close_reason: implemented
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

- [x] 2 件目が来ても 1 件目の中身の DOM 要素と一時状態が保たれる (または畳み方の方針が決まっている)

## 裁定 (kawaz 2026-11-20)

c: tool が 1 件の時も最初から fold にする (「1 件なら直接見せる」をやめる)。2 件目が来ても包み直しが起きないので、一時状態は消えない。

## 対応 (2026-11-20)

- `FoldGroup` (webui の `components/timeline/folds.tsx`) は件数によらず `details.tl-fold-group` を描く。1 件だけの時に直接見せる分岐と、それを決めていた `foldGroupNeedsOuterFold` を消した。nav が開く fold を決める `foldPathsByOffset` (`fold-tree.ts`) も、fold group の全部の行にその group の fold を返す
- 閉じた fold の見出しは 1 件でも件数を名乗る (`1 items`、`1 thinking` 等。複数の時と同じ `foldGroupLabel`)。tool 名は見出しに出さず、開いた中の行に出る
- テスト: `timeline.dom.test.ts` の「Timeline fold group of a running turn」で、tool が 1 件の turn が最初から `1 items` の fold であること、fold と tool カードを開いてから live tail で 2 件目が来ても fold group と 1 件目のカードが同じ要素のまま開いていて、見出しが `2 items` になることを固定した (直す前は 1 つ目の assert で落ちる)
- 隔離 daemon と試験用の sid の live な transcript で、headless の Chromium で確かめた: 1 件の turn は閉じた `1 items` の fold、開いて中の要素 33 個に印を付けて 2 件目を push した後も、fold group と 1 件目のカードは同じ要素で開いたまま、印は 33 個とも残った
