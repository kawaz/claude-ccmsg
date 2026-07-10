---
title: tailscale serve origin の自動許可 (zero-config) — env 頼みでは daemon respawn のたびに ts.net アクセスが壊れる
status: resolved
category: design
created: 2026-07-11T00:33:27+09:00
last_read: 2026-07-11T00:35:17+09:00
open_entered:
wip_entered: 2026-07-11T00:33:27+09:00
blocked_entered:
pending_entered: 2026-07-11T00:43:43+09:00
discarded_entered:
resolved_entered: 2026-07-11T00:46:14+09:00
discard_reason:
pending_reason: ["設計方針(同一マシン内 serve trust の信頼根拠)は固まったが、tailscale serve status --json / status --json の実機出力確認と daemon 起動シーケンスへの組込み箇所特定が未着手のため、DR-0004/DR-0008 追補への昇華を保留"]
close_reason: ["dr/DR-0004","implemented"]
blocked_by:
origin: 自リポ TODO
---

# tailscale serve origin の自動許可 (zero-config) — env 頼みでは daemon respawn のたびに ts.net アクセスが壊れる

## 概要

daemon 起動時に `tailscale serve status --json` (または `tailscale status --json` の
`Self.DNSName`) を best-effort (timeout ~1s、失敗は無視) で叩き、自分の bind ポートへ
proxy している serve 構成があれば `https://<dnsname>` を allowed origins に自動追加する。
`CCMSG_HTTP_ALLOW_ORIGIN` は手動拡張用として存置する。

## 背景

実地障害 (2026-07-11): kawaz が `https://<machine>.<tailnet>.ts.net` にアクセスしたら
空 UI になった。原因は WS の Origin 検証 403 (DR-0004 修正の意図した挙動) + 稼働中の
daemon に `CCMSG_HTTP_ALLOW_ORIGIN` が設定されていなかったこと。env 付きで再起動して
解消したが、daemon は upgrade のたびに任意セッションの env から respawn されるため、
env 頼みの運用では次回の push で同じ障害が再発する。さらに stop → spawn の窓で、
別セッションが env 無しのまま spawn してしまう race も実観測した。

env に依存しない zero-config な解決として、tailscale 自体が持つ serve 構成情報から
このマシンで正当に TLS 終端されている ts.net origin を自動的に信頼する案を検討する。

信頼根拠: その Origin を持てるページは serve (このマシンで TLS 終端) が配信したもの
だけ。同一マシン内の別アプリに serve が向いているケースは同 UID trust 圏内として
許容する (DR-0004 addendum に記録する想定)。

## 受け入れ条件

- [x] tailscale 未インストール/未 serve 環境で daemon 起動が遅延・失敗しない
- [x] serve 構成ありで ts.net origin の WS 接続が env 無しで通る
- [x] DR-0004 または DR-0008 に追補として記録する

## TODO

- [x] `tailscale serve status --json` / `tailscale status --json` の出力形式を実機確認
- [x] daemon 起動シーケンスへの best-effort 問い合わせ (timeout ~1s) の組み込み箇所を特定
- [x] 自 bind ポートへの proxy 判定ロジックを設計
- [x] DR-0004 or DR-0008 への追補文言を作成
