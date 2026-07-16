---
title: Status タブに teams (agent teams) セクションを追加
status: open
category: design
created: 2026-07-17T08:14:07+09:00
last_read:
open_entered: 2026-07-17T08:14:07+09:00
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

# Status タブに teams (agent teams) セクションを追加

## 概要

Status タブに teams (agent teams) セクションを追加する。daemon の
session_status fold を拡張し、以下を突合して teammate 一覧 (名前、最終
送受信時刻、活動状態の推定) を表示する:

- Agent tool call の name 付き spawn
- SendMessage 送信
- teammate-message relay 受信

## 背景

kawaz r26 mid=67 での依頼。DR-0022 (in-view 検索) workflow 完了後の実装
キューとして起票。

制約として、teammate の生死は TUI 内部状態を直接観測できないため
transcript からの推定 (spawn / 完了通知の突合) にとどまる。「最後に観測
した活動」ベースの表示とする。

DR-0020 Phase 1 と同じ流儀で、実装着手前に実際の transcript 上の
tool call 形 (Agent tool call の引数構造、SendMessage の記録形、
teammate-message relay の受信形) を観測してから schema を決めること。
未観測のまま schema を先に固定しない。

## 受け入れ条件

- [ ] 実 transcript から Agent spawn (name 付き) / SendMessage 送信 /
      teammate-message relay 受信の tool call 形を観測し記録した
- [ ] 上記観測に基づき session_status fold の突合 schema (teammate 一覧:
      名前、最終送受信時刻、活動状態の推定) を設計した
- [ ] daemon の session_status fold を拡張し、Status タブに teams
      セクションとして表示できる
- [ ] 「TUI 内部状態は見えない、最後に観測した活動ベース」という制約が
      UI 上の表現 (文言・注記) にも反映されている

## TODO

<!-- wip 時のみ -->
