---
title: webui の画面内検索が live Range を CSS.highlights に登録していて、WebKit で重くなる可能性
status: open
category: bug
created: 2026-11-10T00:04:39+09:00
last_read:
open_entered: 2026-11-10T00:04:39+09:00
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

# webui の画面内検索が live Range を CSS.highlights に登録していて、WebKit で重くなる可能性

## 概要

webui の画面内検索 (rendered-text-search.ts) が live Range を CSS.highlights に登録している。編集モードの着色 PoC (2026-11-09、artifacts/editor-highlight-poc) の実測で、WebKit は live Range が多いと文書内のどこで DOM が変わっても描画が Range 数に超線形に重くなった (4281 本で 2.5 秒、8615 本で 9.7 秒。Chromium は約 33ms で差なし)。Safari で一致が多い検索中に Timeline が更新されるたびに重くなる可能性がある。

対処候補: StaticRange + 表示範囲だけの登録 (PoC と同じ方式)。実 Safari では未検証なので、まず実機で再現してから直す。

## 背景

編集モードの着色 PoC の実測から派生した懸念。検索側は PoC と違い live Range を使っているため、同じ症状が出るかを確認する。

## 受け入れ条件

- [ ] 実 Safari で、一致が多い検索中に Timeline が更新される状況を再現し、描画コストを計測する
- [ ] 再現した場合、StaticRange + 表示範囲だけの登録に直し、改善を計測で確認する

## TODO
