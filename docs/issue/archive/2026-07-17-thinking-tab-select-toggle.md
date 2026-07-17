---
title: thinking タブの「前選択」ボタンをトグル化 + 翻訳比較タブと配置分離
status: discarded
category: design
created: 2026-07-17T09:12:12+09:00
last_read:
open_entered: 2026-07-17T09:12:12+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered: 2026-07-17T18:04:13+09:00
resolved_entered:
discard_reason: ["host-translation-followups 項目4で select 機能を完全削除する裁定に置き換え (kawaz r26 mid=107)"]
pending_reason:
close_reason: ["discarded"]
blocked_by:
origin: 自リポ TODO
---

# thinking タブの「前選択」ボタンをトグル化 + 翻訳比較タブと配置分離

## 概要

thinking タブの「前選択」(全選択) ボタンを改善する (kawaz r26 mid=74)。

1. DR-0023 の翻訳比較タブ (original / ja(host) / ja(browser)) 導入後も、このボタンは
   original タブ選択時の動作として残す
2. 配置を翻訳選択タブ群と少しスペースを開けて区別する
3. 動作を「常に全選択」ではなく**トグル**にする — 押すたびに全選択 ⇄ 解除

## 背景

DR-0023 で thinking タブに original/ja(host)/ja(browser) の翻訳比較タブが入る予定。
既存の「前選択」ボタンは、この翻訳選択タブ群と見た目上混同しやすい位置にあると
誤操作を招く。また現状「常に全選択」の一方向動作になっており、選択解除の手段が
別途必要 (or 無い) ため、押下トグルにして往復操作を 1 ボタンで完結させたい。

DR-0023 Phase 2 (webui 配線) と同時に実装するのが自然 (同じコンポーネント領域の
変更のため)。

## 受け入れ条件

- [ ] 「前選択」ボタンは original タブ選択時のみ動作する (翻訳タブ選択時は非対象、
      または disabled/非表示)
- [ ] ボタンの配置が翻訳選択タブ群と視覚的にスペースを空けて区別される
- [ ] ボタン押下で「全選択 → 解除 → 全選択 → …」のトグル動作になる
- [ ] DR-0023 Phase 2 (webui 配線) の実装と同時 or 直後に着手する

## TODO

<!-- wip 時のみ -->
