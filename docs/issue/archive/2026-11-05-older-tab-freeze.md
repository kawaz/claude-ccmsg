---
title: Timeline の older を先頭まで読むとタブが固まる
status: resolved
category: bug
created: 2026-11-05T15:30:00+09:00
last_read:
open_entered: 2026-11-05T15:30:00+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-05T17:40:00+09:00
discard_reason:
pending_reason:
close_reason: ["done: 固まる原因は画面内の移動のたびに SessionView が view の全要素の scrollTop を読んでいたこと。スクロールのイベントから位置を取るようにして、読み切った 17 MB の TL から Files への移動が 60 秒超から 335 ms になった。push ごとの重さは 2026-11-05-timeline-push-cost-after-older に分けた"]
blocked_by:
origin: kawaz 2026-11-05
---

# Timeline の older を先頭まで読むとタブが固まる

## 概要

Timeline の older を何度か押す (先頭まで読む等) と、ほぼ毎回タブが固まって死ぬ (kawaz 2026-11-05)。

## 原因と修正

計測: [findings](../../findings/2026-11-05-older-tab-freeze.md) §3

- 固まるのは older で読み切った後の画面内の移動 (タブの切り替え、別のセッションへの移動)。SessionView が移動のたびに view の全要素の `scrollTop` / `scrollLeft` を読んでいて、読み切った TL では 1 要素あたり約 30 ms の layout が要素の数だけ走った
- 位置をスクロールのイベントから取るようにした。読み切った 17 MB の TL から Files への移動は、60 秒を超えて応答なしから 335 ms になった
- 読み切った TL で push のたびに重い件は [timeline-push-cost-after-older](../2026-11-05-timeline-push-cost-after-older.md) に分けた
