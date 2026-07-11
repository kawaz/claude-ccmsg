---
title: caddy-app-proxy 経由の webui オリジン許可を daemon respawn 越しに永続化したい
status: open
category: task
created: 2026-07-12T00:51:50+09:00
last_read:
open_entered: 2026-07-12T00:51:50+09:00
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

# caddy-app-proxy 経由の webui オリジン許可を daemon respawn 越しに永続化したい

## 概要

caddy-app-proxy (Caddy) 経由で webui にアクセスする際のオリジン許可設定が、daemon の respawn (再起動) を挟むと失われる。respawn 越しに永続化したい。

## 背景

`docs/issue/2026-07-11-origin-isolated-app-reverse-proxy.md` の Caddy ベース origin 分離構想と関連する運用上の課題。origin 許可がプロセス内メモリ等の揮発領域にしか保持されていない場合、daemon respawn のたびに許可設定が消え、webui 側で再設定が必要になる可能性がある。永続化先 (設定ファイル / DB / Caddy 設定自体への書き戻し等) の方式は未検討。

## 受け入れ条件

- [ ] 現状オリジン許可がどこに保持されているか (メモリ限定か、永続化済みか) を調査する
- [ ] daemon respawn 前後でオリジン許可が保持されることを確認する手段 (テスト or 手動検証手順) を用意する
- [ ] 永続化方式 (設定ファイル / Caddy 設定書き戻し 等) を決定し実装する

## TODO

<!-- wip 時のみ -->
