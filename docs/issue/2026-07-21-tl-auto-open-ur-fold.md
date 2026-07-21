---
title: TL AUTO OPEN で U/R もチェック外し可能にする (fold 形の設計が前提)
status: open
category: design
created: 2026-07-21T09:04:26+09:00
last_read:
open_entered: 2026-07-21T09:04:26+09:00
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

# TL AUTO OPEN で U/R もチェック外し可能にする (fold 形の設計が前提)

## 概要

TL (タイムライン) の AUTO OPEN トグルを、現状の T/A/items だけでなく U (ユーザ発言) / R (アシスタント応答) にも適用しチェック外し可能にしたい。kawaz 発案 (r46m20、2026-07-21)、「したいかも」段階でまだ形が確定していない。

## 背景

現状 U/R は fold 対象外の常時表示行で、AUTO OPEN トグルは T/A/items のみに効く。U/R をチェック外し可能にするには fold 構造への組み込みが前提になる。

候補案:

1. **items 系 fold グループへ畳み込み** (kawaz 推し。既存 fold 機構と `autoOpenCategoriesForLine` が U/R を既に認識しており構造が素直。ただし user-turn ナビの跳び先が fold 内部になるため「ジャンプ時に該当 fold を自動展開」の追従実装が必要)
2. **U/R 行を個別 details 化** (閉時は先頭 N 文字サマリー表示)
3. **フィルタで非表示** (ナビとの整合が要検討)

## 受け入れ条件

- [ ] kawaz が fold 形の設計方針を裁定
- [ ] 裁定に基づき U/R が AUTO OPEN トグルでチェック外し可能になる
- [ ] user-turn ナビが fold 内部の U/R へジャンプした際、該当 fold が自動展開される

## TODO

<!-- wip 時のみ -->
