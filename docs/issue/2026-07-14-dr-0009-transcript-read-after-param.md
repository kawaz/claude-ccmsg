---
title: DR-0009 transcript_read に after (差分取得) パラメータを追加する
status: idea
category: design
created: 2026-07-14T23:34:29+09:00
last_read:
open_entered:
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

# DR-0009 transcript_read に after (差分取得) パラメータを追加する

## 概要

DR-0009 で定義された `transcript_read` は `before` (tail から遡る) のみを持ち、
`after` (= 「この時点より新しい行だけ」を指す since 相当) パラメータを持たない。
これを追加し、既存 lines との append merge に切り替えることで差分取得を可能にしたい。

## 背景

TLR-Q1=b (Timeline tab 訪問時の auto-refresh) を実装する過程で判明。
`after` が無いため、v0.30.0 の実装は「毎回全 tail を `mode:replace` で
再取得する」経路を採用した。

- 個人スケールでは実害なし (v0.30.0 で動作確認済み)
- ただし transcript が大きいセッションや頻繁な revisit では、本来不要な
  全量再送により帯域負荷がかかる

関連 issue: [2026-07-14-session-tl-refresh-on-revisit](../issue/archive/2026-07-14-session-tl-refresh-on-revisit.md) (resolved)
— この issue で TLR-Q1=b の実装判断そのものは決着済み。本 issue は
そこで先送りにした「根本改善 (プロトコル拡張)」側の受け皿。

## 受け入れ条件

- [ ] DR-0009 §3 (TranscriptReadRequest) に `after` パラメータを追加する設計を検討する
- [ ] `after` 指定時、daemon 側が差分行のみ返す経路を設計する (既存 `before` 経路とのモード分岐 or 統合)
- [ ] webui 側の TLR-Q1=b 実装を `mode:replace` 全量取得から差分 append merge に切り替える
- [ ] 既存 `before` 消費側 (通常の history 遡り読み込み) への非互換変更が無いことを確認する

## TODO

<!-- wip 時のみ -->
