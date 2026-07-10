---
title: Critical: HTTP/WS の trust model 見直し (Origin 検証 + 127.0.0.1 bind 回帰 + tailnet allow 削除)
status: wip
category: design
created: 2026-07-10T19:12:09+09:00
last_read:
open_entered: 2026-07-10T19:12:09+09:00
wip_entered: 2026-07-10T20:06:40+09:00
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

# Critical: HTTP/WS の trust model 見直し (Origin 検証 + 127.0.0.1 bind 回帰 + tailnet allow 削除)

## 概要

**Severity: critical**。悪意ある Web ページを kawaz が開いただけで、そのページの JS が
ブラウザ経由 WebSocket 接続で kawaz の localhost daemon (ccmsg) を任意操作できる。
DR-0004 §2/§3 の trust model「reachable == user (= 127.0.0.1 / tailscale に到達できる者は
kawaz 本人)」が、Web ブラウザからの cross-origin WebSocket 接続 (SOP が効かない) を想定して
いないために生じている設計欠陥。

詳細評価は `docs/findings/2026-07-10-codex-review-evaluation.md` (codex レビュー
2026-07-10 の実物検証記録)。

## 背景

成立条件が全部揃っている (実物コード確認済み、`docs/findings/2026-07-10-codex-review-evaluation.md` 参照):

- `DEFAULT_HTTP_BIND = "0.0.0.0:8642"` (`protocol/src/index.ts:29`) — 全 interface bind
- `DEFAULT_HTTP_ALLOW = "127.0.0.0/8,::1,100.64.0.0/10,fd7a:115c:a1e0::/48"` (同 :35) —
  tailscale の CGNAT レンジ丸ごと allow
- `fetch(req, srv)` が Origin ヘッダを検証しない (`http.ts:64-83`)
- `pinHelloToUser` が hello を強制的に `role: "user"` に pin する (同 :41-51)
- `IDENTITY_OPS = ["post", "create_room", "next_room", "subscribe", "notify", "leave"]`
  (`server.ts:284`) — **`read` / `rooms` / `peers` / `ping` / `shutdown` は hello 不要**

実悪用シナリオ (evil.com を開いた瞬間に JS から):

1. `new WebSocket("ws://127.0.0.1:8642/ws")` — source IP は `127.0.0.1` で allowlist 通過、
   Origin は `evil.com` だが daemon は無視
2. hello なしで `{"op":"shutdown"}` → `gracefulShutdown` → `process.exit(0)` →
   **リモート DoS**
3. `{"op":"rooms"}` → 全 room 一覧漏洩、`{"op":"read","room":"r1","mids":"1-9999"}` →
   **全メッセージ漏洩**
4. hello (自動 `role: "user"` pin) 後 `{"op":"post",...}` → **u1 として偽メッセージ注入**
   (受信側 AI が「kawaz の指示」と誤認するリスク)

この issue の修正で以下も同時解決する ([[2026-07-10-codex-review-evaluation]] 参照):

- **Major 2**: webui-https close 判断時に残っていた「採用方式に応じて bind/allowlist を
  見直す」実装調整の未実施分
- **Major 3**: `100.64.0.0/10` allowlist が tailnet 内の他 device 全員を u1 admin 扱いに
  してしまう問題 (shared tailnet で脆弱)

## 受け入れ条件

- [ ] `DEFAULT_HTTP_BIND` を `"127.0.0.1:8642,[::1]:8642"` に戻す (tailscale serve が
      localhost へ proxy する前提、kawaz の HTTPS 化裁定と整合)
- [ ] `DEFAULT_HTTP_ALLOW` から `100.64.0.0/10` と `fd7a:115c:a1e0::/48` を削除
- [ ] `fetch` に Origin 検証を追加: `null` origin (file://, non-browser) と許可オリジン
      (`http://127.0.0.1:8642` / `http://[::1]:8642` 等) のみ通す。tailscale serve 越しは
      Origin が `https://<machine>.<tailnet>.ts.net` になるため `CCMSG_HTTP_ALLOW_ORIGIN`
      環境変数で明示的に追加できる形にする
- [ ] DR-0004 に追補として本件の trust model 修正を記録する
- [ ] Major 2 (webui-https close 判断の残タスク) と Major 3 (tailnet allowlist 問題) が
      本修正で同時解決されていることを確認する
