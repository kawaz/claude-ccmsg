---
title: llm-gateway status API の ccmsg 組み込み (DR-0021)
status: resolved
category: request
created: 2026-09-02T15:04:20+09:00
last_read: 2026-09-02T16:24:00+09:00
open_entered: 2026-09-02T15:04:20+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-02T16:48:47+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.134.0 (commit 38278df4) で実装。llm_status_url 設定 / llm_status op + 二相 llm_status_result / hello llm_status_available / usage 画面の service status strip / header badge / webhook 529 受信で 5 秒 debounce + single-flight の再取得と push。受け入れ条件の「60 秒ごとの polling」のみ意図的に不採用 (接続時 1 回 + usage 画面表示時 + 529 駆動の push で代替、統括メモどおり event 駆動に見直し)。"]
blocked_by:
origin: llm-gateway
---

# llm-gateway status API の ccmsg 組み込み (DR-0021)

## 概要

llm-gateway v0.25.1 (DR-0021) が `GET /llm-gateway/status` を提供開始した。ccmsg 側への組み込みを依頼する。

1. daemon config に `llm_status_url` を追加 (usage/stats 同様、daemon が bounded fetch する)
2. protocol に user-role 限定の `llm_status` request と二相 `llm_status_result` を追加
3. hello に `llm_status_available` を追加
4. WebUI は cached status を 60 秒ごとに取得し、`/usage` 画面に service status strip を常設表示
5. global header に severity=warning で黄バッジ / critical で赤バッジ、ok はバッジなし、unknown は strip 内の灰色表示のみ
6. webhook の request event で 529 受信時、5 秒 debounce + single-flight で即時 status 取得
7. 外部由来の文字列は text node として描画 (innerHTML 禁止)。未知の field / state は unknown 扱いにフォールバック

## 背景

llm-gateway 側に DR-0021 で upstream (Anthropic 等) の service status を返す `GET /llm-gateway/status` が実装された。ccmsg の WebUI/daemon が取り込むことで、利用者が API 障害の兆候 (429/529 等) を能動的に把握できるようにする。正本仕様は llm-gateway リポの `docs/decisions/DR-0021-upstream-service-status.md` の「ccmsg への組み込み契約」節。`schema_version` は 1、`severity` は ok / warning / critical / unknown、ccmsg 側で severity を再判定せずそのまま icon 選択に使う契約。

統括メモ: 「daemon config に項目追加」「60 秒 polling」は依頼元の提案であり、ccmsg 側の設計 (既存 usage URL からの導出、event 駆動) で見直してよい。

## 受け入れ条件

- [ ] daemon config に `llm_status_url` が追加され、daemon が bounded fetch する
- [ ] protocol に `llm_status` request (user-role 限定) と二相 `llm_status_result` が実装されている
- [ ] hello response に `llm_status_available` が含まれる
- [ ] `/usage` 画面に service status strip が常設され、60 秒ごとに cached status を取得する
- [ ] global header の badge 表示 (warning=黄 / critical=赤 / ok=非表示 / unknown=strip内灰色のみ) が仕様通り
- [ ] webhook の 529 受信時、5 秒 debounce + single-flight で status を即時取得する
- [ ] 外部文字列の描画が text node 経由、未知 field/state が unknown フォールバックする
