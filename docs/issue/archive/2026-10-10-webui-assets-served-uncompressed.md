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
close_reason: ["implemented","done:daemon が webui の資産を Accept-Encoding に応じて br / gzip で返す (commit tqvyrktn)。bundle は br で 1,483,352 → 251,007 byte","done:10-10 の時間帯は iPhone への転送が 1〜10 KB/s で切れていた。10-11 には同じ無圧縮の 1,473,461 byte が 0.277 秒で届いた。遅かった理由は未特定で、圧縮配信は転送量を約 1/6 にする改善 (原因への対処ではない)"]
blocked_by:
origin: 自リポ TODO
---

# webui の資産が無圧縮で配られ、遅い経路では完走しない

## 概要

daemon は webui の資産を `Accept-Encoding` に関わらず無圧縮で返していた (client の bundle は 1.47 MB)。2026-10-10 に iPhone で webui が開けなかった時間帯は、iPhone への転送が 1〜10 KB/s で切れていた (遅かった理由は未特定)。転送量を減らすため、daemon で br / gzip で返すようにする。原因への対処ではない。

調査は `docs/findings/2026-10-10-iphone-webui-blank-uncompressed-assets.md`。

## 受け入れ条件

- [x] JS / CSS / HTML を `Accept-Encoding` に応じて br / gzip / 無圧縮で返し、`Content-Encoding`・`Vary: Accept-Encoding`・`Content-Length` を付ける
- [x] 圧縮は資産を読み込む時に一度だけ行い、リクエストごとには行わない
- [x] `/assets/*` の `Cache-Control: public, max-age=31536000, immutable` を維持し、ETag は coding ごとに分ける
