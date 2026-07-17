---
title: ja(host) 翻訳 + TL 表示のフォローアップ 5 件
status: open
category: task
created: 2026-07-17T17:19:07+09:00
last_read:
open_entered: 2026-07-17T17:19:07+09:00
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

# ja(host) 翻訳 + TL 表示のフォローアップ 5 件

## 概要

kawaz が r26 (mid=102) のスクショと r32 で受け取った誤送信分から拾った、ja(host)
翻訳周りと TL 表示の小規模フォローアップ 5 件。simplify workflow (Timeline.tsx
編集中) の完了後に、まとめて 1 workflow で実装する。

1. **TL 下部ミニパネルにコンテキスト消費を表示**
   - `ctx 522k/1M` のような表示を miniSummaryLines に追加
   - session_status snapshot に既に値があるので、行を 1 本足すだけの見込み

2. **ja(host) 翻訳の高速化**
   - daemon 常駐化は済み (warm 400-900ms/件)
   - thinking が複数件あると翻訳が直列実行され体感が遅い
   - 対応: helper の `translations(from:)` バッチ API を採用 + daemon 側
     translate op を複数 texts 一括処理対応に拡張 + webui は表示中の
     thinking をまとめて 1 リクエストに束ねる

3. **全文日本語テキストは翻訳リクエスト自体を skip**
   - 混在テキスト (日本語+他言語) は従来どおり丸ごと翻訳
   - 全文日本語かどうかの判定は既存 `translate.ts` の日本語判定ロジックを流用

4. **thinking の select 機能を完全削除**
   - Timeline.tsx の select/clear トグルボタンとその関連ロジック・CSS・テストを撤去する

5. **TL 下部ミニパネルに teams (チームメイト) も表示**
   - session_status snapshot の teammates から活動中のものを要約行に追加
   - (1) の ctx 消費表示と同じ miniSummaryLines 拡張なので同時実装

## 背景

kawaz が実運用中 (r26/r32) に気づいた UX 上の粗。特に (2) は複数 thinking が
並ぶセッションで顕著に体感遅延が出ている。(5) は r26 mid=106 で追記。

## 受け入れ条件

- [ ] miniSummaryLines に ctx 消費表示が追加されている
- [ ] thinking 複数件の翻訳が 1 リクエストにバッチ化され、直列実行によるもたつきが解消している
- [ ] 全文日本語テキストで翻訳リクエストが発生しないことを確認
- [ ] thinking の select 機能 (select/clear トグルボタン・関連ロジック・CSS・テスト) が削除されている
- [ ] miniSummaryLines に活動中の teammates 要約行が追加されている
