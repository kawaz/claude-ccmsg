---
title: webui 接続ログに接続 ID / User-Agent を付与
status: open
category: task
created: 2026-09-06T16:54:55+09:00
last_read:
open_entered: 2026-09-06T16:54:55+09:00
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

# webui 接続ログに接続 ID / User-Agent を付与

## 概要

webui 接続ログに接続 ID / User-Agent を付けて、古い bundle のまま残った端末を特定できるようにする。

## 背景

現状 daemon.log の `webui hello client_version=…` と `webui ws closed` は接続を識別する情報が無く、複数端末が同時接続していると「どの hello がどの closed に対応するか」「特定バージョンの接続がまだ生きているか」を判別できない。

実例: 2026-09-06 06:49Z 再起動後、0.146.0 と 0.150.4 が各 1 本 hello → 06:58Z に 1 本 closed、どちらか不明だった。

## 提案

- hello / closed の両方に接続 ID (連番で可) を付ける
- hello に UA の要約 (iPad / Mac 等) を出す

裁定は不要の小改修だが、webui 設計議論 (QUESTIONS WA-Q1〜Q4) と独立なので着手時期は任意。

## 受け入れ条件

- [ ] daemon.log の `webui hello` / `webui ws closed` に共通の接続 ID が出る
- [ ] `webui hello` に UA 要約が出る
