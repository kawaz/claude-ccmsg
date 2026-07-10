---
title: webui の HTTPS 化検討
status: idea
category: design
created: 2026-07-10T10:43:53+09:00
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

# webui の HTTPS 化検討

## 概要

webui の tailscale 経由アクセスは疎通確認済みだが、plain HTTP での公開は不採用と判断した。HTTPS 化の方式を検討する。

## 背景

kawaz 判断 (2026-07-10): webui の tailscale 経由アクセスは疎通したが「ポート開いたけど安全じゃないでダメ。https は今度考えよう」= plain HTTP での公開は不採用、HTTPS 化は後日検討。

検討時の候補:

1. **tailscale serve** (最有力候補): tailnet 内向けに `https://<machine>.<tailnet>.ts.net` を正規証明書付きで張り localhost に proxy する組み込み機能。採用すると ccmsg は bind を `127.0.0.1` に戻せて (`CCMSG_HTTP_BIND` 既定の `0.0.0.0` と source-IP allowlist を縮退可能)、証明書管理も不要。secure origin になるので将来 service worker / clipboard 等の web API も使える。
2. 自前 TLS (`Bun.serve` の `tls` オプション + mkcert/self-signed): 端末側に CA 配布が要り運用が重い。
3. caddy 等の別プロセス reverse proxy: supervision 対象が増える (DR-0004 §1 で bridge プロセスを不採用にしたのと同じ理由で筋が悪い)。

検討時は DR-0004 §3 の追補 (bind/allowlist の縮退含む) として扱うこと。

それまでの運用: 現状の HTTP + source-IP allowlist (loopback + `100.64.0.0/10`) は tailnet 境界内なら実害は限定的だが、kawaz は「安全じゃない」評価なのでスマホ運用は HTTPS 化まで保留。

## 受け入れ条件

- [ ] tailscale serve / 自前 TLS / reverse proxy の比較検討を行い方式を決定する
- [ ] 決定内容を DR-0004 §3 追補として記録する
- [ ] 採用方式に応じて `CCMSG_HTTP_BIND` の既定値・source-IP allowlist の要否を見直す
