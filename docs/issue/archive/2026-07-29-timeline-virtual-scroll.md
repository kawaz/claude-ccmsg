---
title: Timeline の仮想スクロール (windowing) 導入
status: resolved
category: design
created: 2026-07-29T15:12:58+09:00
last_read:
open_entered: 2026-07-29T15:12:58+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T12:28:26+09:00
discard_reason:
pending_reason:
close_reason: ["done: D0〜D2 (v0.100.8〜v0.100.10) で根治。閉fold遅延マウント+identity差分化+memoでDOM 11,995→2,428要素(-80%)、1行追記のfold側再レンダー2,362→3","discarded: 案A(自作windowing)は残ノード2,811では工数・回帰リスク(高さ推定・スクロールアンカ・検索/nav のモデル化)に見合わないため見送り(findings 2026-08-12-timeline-windowing-design の判断手順どおり再実測してから判断)","finding/2026-08-12-timeline-windowing-design"]
blocked_by:
origin: 自リポ TODO
---

# Timeline の仮想スクロール (windowing) 導入

## 概要

Timeline (TL) は全行を DOM 化しているため、DOM ノード数・イベントリスナ数が
セッション規模に比例して際限なく増える。windowing (仮想スクロール) の導入を
検討する。

## 背景

webui-memory-probe による実測 (2026-07-29, r76m58) で、1 セッションで DOM
73,000 ノード / イベントリスナ 12,000 個 (3MB transcript) を確認。SessionView
の LRU 3 面保持で常時 28.6 万ノード / 5 万リスナが乗り、ブラウザの体感の重さの
主因になっている。追記 1 turn ごとに DOM +42 / リスナ +7 で増加に上限がない。

### 課題

Timeline.tsx (3,679 行) は fold グループ / in-view 検索 / ユーザ発言ナビ /
スクロール位置復元 / uuid 位置アンカーが全て「全 item が DOM にいる」前提で
組まれており、素朴な windowing 導入は広範囲に影響する。設計からの検討が必要。

### 先行する安価な緩和 (別対応)

`.tl-item` への `content-visibility: auto` + `contain-intrinsic-size` は
レイアウト/ペイントコストのみの削減 (DOM/リスナ数自体は不変)。効果は要実測。
こちらはメモリ対策バッチとして先行実施予定。

## 受け入れ条件

- [ ] windowing 導入方針の設計判断 (DR) が定まる
- [ ] fold グループ / in-view 検索 / ユーザ発言ナビ / スクロール位置復元 /
      uuid 位置アンカーとの整合方針が決まる

