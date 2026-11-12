---
title: webui の画面内検索が live Range を CSS.highlights に登録していて、WebKit で重くなる可能性
status: blocked
category: bug
created: 2026-11-10T00:04:39+09:00
last_read:
open_entered: 2026-11-10T00:04:39+09:00
wip_entered:
blocked_entered: 2026-11-13T00:26:26+09:00
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by: [timeline-push-cost-after-older]
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

## 計測の結果 (2026-11-12)

数値と方法の正本は `docs/findings/2026-11-12-in-view-search-range-cost.md`。

1. 疑いは WebKit で確かめられた。live な Range を CSS Custom Highlight に登録していると、文書のどこで DOM が変わっても次のフレームが登録数に比例して遅れる。リポの外の実験ページで 1000 個あたり約 28ms、500〜12000 個でほぼ直線 (超線形は再現しなかった)。作るだけで登録しなければ遅れない。Chromium は 12000 個まで遅れない。
2. 実アプリ (headless の WebKit、本文 1700 個が全部 mount された fixture) で、一致 5000 個の時に live の登録が足している時間は、TL の外の DOM 変更 +115ms、push +200ms、↓ +300ms、打鍵 +190ms。一致 1000 個では TL の外の DOM 変更で +26ms だけ。
3. StaticRange に替えるだけでは足りない。箱の外の変更と本文の書き換えでは遅れが消えるが、ハイライトのある箱に子を足す変更 (TL の push と同じ形) では live と同じだけ遅れる (実アプリの push は static 1430ms / live 1460ms)。効くのは「表示範囲の分だけ登録する」方 (計測からの推定で、直した形は測っていない)。直す時は StaticRange と表示範囲だけの登録を両方入れる。
4. 今は直さない理由。同じ fixture で、検索と関係ない重さが 1 操作ごとに WebKit で約 1〜2 秒、Chromium で 3〜4 秒あり、ハイライトの分 (最大 0.3 秒) を直しても体感がほぼ変わらない (推定)。TL の基礎コスト (`docs/issue/2026-11-05-timeline-push-cost-after-older.md`) を先に追い、基礎コストが下がった後にこの issue を再開する。
5. 受け入れ条件の「実 Safari」は、この Mac の Safari がリモート自動化を無効にしているため自動では測っていない。人の手で確かめる手順と計測片は findings の「実 Safari」節、依頼は `docs/QUESTIONS.md` の TR-C2。headless の WebKit では一致 5000 個で median=116ms、検索なしで 33ms。
