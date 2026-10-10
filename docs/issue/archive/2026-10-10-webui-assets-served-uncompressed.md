---
title: webui の資産が無圧縮で配られ、遅い経路では完走しない
status: resolved
category: bug
created: 2026-10-10T13:37:30+09:00
last_read:
open_entered: 2026-10-10T13:37:30+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-10T21:05:22+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","done:daemon が webui の資産を Accept-Encoding に応じて br / gzip で返す (commit tqvyrktn)。bundle は br で 1,483,352 → 251,007 byte","pending:iPhone 実機で完走するかは未確認。足りなければ bundle の削減 (約半分が shiki の言語文法) を別 issue に"]
blocked_by:
origin: 自リポ TODO
---

# webui の資産が無圧縮で配られ、遅い経路では完走しない

## 概要

daemon は webui の資産を `Accept-Encoding` に関わらず無圧縮で返していた。client の bundle は 1.47 MB あり、tailnet 越しの iPhone (1〜10 KB/s) では一度も最後まで届かず、webui が真っ黒のままになる。daemon で br / gzip で返すようにする。

調査は `docs/findings/2026-10-10-iphone-webui-blank-uncompressed-assets.md`。

## 受け入れ条件

- [x] JS / CSS / HTML を `Accept-Encoding` に応じて br / gzip / 無圧縮で返し、`Content-Encoding`・`Vary: Accept-Encoding`・`Content-Length` を付ける
- [x] 圧縮は資産を読み込む時に一度だけ行い、リクエストごとには行わない
- [x] `/assets/*` の `Cache-Control: public, max-age=31536000, immutable` を維持し、ETag は coding ごとに分ける
