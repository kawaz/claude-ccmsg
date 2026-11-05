---
title: Timeline の older を先頭まで読むとタブが固まる
status: open
category: bug
created: 2026-11-05T15:30:00+09:00
last_read:
open_entered: 2026-11-05T15:30:00+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz 2026-11-05
---

# Timeline の older を先頭まで読むとタブが固まる

## 概要

Timeline の older を何度か押す (先頭まで読む等) と、ほぼ毎回タブが固まって死ぬ (kawaz 2026-11-05)。

## 分かっていること

計測: [findings](../findings/2026-11-05-older-tab-freeze.md)

- 17 MB の transcript を先頭まで読むと DOM ノードは 2.4 万、JS heap は 125 MB。先頭まで読むこと自体では、headless の Chromium と WebKit のどちらも固まらなかった
- 先頭まで読んだ状態で turn が流れると、live tail の push 1 回ごとに 150 ms〜1.3 秒の long task が出る。短い turn 3 回 (約 13 秒) で main thread が合計 17.7 秒ふさがった。初回の読み込みだけの状態では 0
- 内訳は layout (`useStickToBottom` の `scrollHeight` の読み、`ScrollHold.toBottom`) と markdown の parse のやり直しで、どちらも読んだ量に比例する。`content-visibility: auto` を当てても減らなかった

## 残っていること

- 直し方の判断 (候補: 画面外の古い group を軽い placeholder に畳む仮想化、push のたびの scroll 計測と末尾寄せを新しい行の分に限る、markdown の parse を行ごとに使い回す)。DR-0009 / DR-0005 の該当節に反映
- 「死ぬ」まで至る条件 (実ブラウザ、iPad Safari、LRU が隠れたまま持つ他のセッションの TL) の確認
