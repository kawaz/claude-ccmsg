---
title: caddy-app-proxy 経由の webui オリジン許可を daemon respawn 越しに永続化したい
status: wip
category: task
created: 2026-07-12T00:51:50+09:00
last_read:
open_entered: 2026-07-12T00:51:50+09:00
wip_entered: 2026-07-12T02:10:28+09:00
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

## 追加調査 (2026-07-12)

### 症状の詳細

webui が caddy reverse proxy (実 URL は kawaz 個人 URL、公開ドキュメントではサニタイズ) 経由で app.js 取得時に 403 になる。html はアドレスバー直接アクセス (Origin ヘッダ無し) で 200 だが、module script の app.js 取得は crossorigin モードで Origin ヘッダ付きリクエストになり 403。curl マトリクスで Origin 有無による 403/200 の差を再現・確認済み。

### 原因確定

daemon の Origin 検証は許可源が env (CCMSG_HTTP_ALLOW_ORIGIN、respawn で消える) と tailscale serve 自動検出の 2 つのみで、caddy の公開ドメイン origin が未許可だった。

caddy 側は素の reverse_proxy で Origin ヘッダを改変していないことを別セッションで確認済み (Origin header_up 偽装は検証の無効化になるため今後もしない合意)。

### 恒久対応 (実装済み、次リリースで自動適用)

`<dataDir>/allowed-origins.json` による許可 origin の永続管理 (origins-file.ts、mtime キャッシュ + Origin チェック失敗時のみ再読込) + CLI サブコマンド `ccmsg origins add/remove/list`。ファイルは作成済み (実 URL 登録済み) なので、次リリース以降は自動で効く見込み。

### 暫定対応 (適用済み、2026-07-12)

常駐 daemon v0.19.1 を `CCMSG_HTTP_ALLOW_ORIGIN` env 付きで再起動、実 URL で 200 / evil origin で 403 になることを確認済み。この env は次回 respawn で消えるが、その頃には次リリースの origins-file 恒久対応が効いている想定。

## TODO

- [ ] 次リリースで origins-file.ts (mtime キャッシュ + 再読込) が実際に respawn 越しで効いていることを確認
- [ ] 確認後 close (env による暫定対応は不要になる)
