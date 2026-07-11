---
title: 自己所有ドメイン + wildcard ACME の app リバースプロキシ構想 (docroot ごとの origin 分離で JS 実行可能な file serving)
status: idea
category: design
created: 2026-07-11T19:33:01+09:00
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

# 自己所有ドメイン + wildcard ACME の app リバースプロキシ構想 (docroot ごとの origin 分離で JS 実行可能な file serving)

## 概要

自己所有ドメインの wildcard 証明書 (ACME) を使い、`{app}.{myhost}.{mydomain}` 形式のサブドメインで複数 app をリバースプロキシする構想。ccmsg のファイル配信については、docroot ごとに別サブドメイン (origin) を割り当てることで、配信コンテンツ内の JS を安全に実行できるようにする (github.io / googleusercontent と同型の origin 分離)。

## 背景

kawaz 構想 (2026-07-11 verbatim):

> httpsとか考えると今、自己所有ドメインを使って https://{app}.{myhost}.{mydomain} でを使えるようにしてACMEで *.{myhost}.{mydomain} の証明書取得をして、apps=[ {name:"ccmsg",url:"http://127.0.0.1:8642"}, {name:"ccmsg-files-*", url:"http://127.0.0.1:8643"} ] みたいな設定ファイル付きにするみたいな。そしたら ccmsg 側では https://ccmsg-files-{docroot-hash}.{myhost}.{mydomain}/{path} みたいなURLで隔離すればjsも動かせると思います。

AI 評価: origin 分離の定石で方向性は正。以下の論点あり。

1. **公開範囲**: origin 分離はコンテンツから app を守るもので、閲覧者認証は別問題。A レコードを tailnet IP に向ければ ACME (DNS-01) を保ちつつ実質 tailnet 限定にできる
2. **cookie は親ドメインに置かない** (host-only / cookie レス)
3. **docroot-hash は分離キーであって秘密ではない**。capability URL にするなら random token 別設計
4. **build or buy**: Caddy (wildcard DNS-01 + `reverse_proxy`) が設定のみでほぼ満たすので、まず Caddy で検証 → apps ホットリロードや ccmsg からの docroot 動的登録 API 等の自作価値が見えたら自作置換が低リスク

公開範囲の論点は解決済み — kawaz 裁定 (2026-07-11 verbatim):

> *.{myhost}.{mydomain} はtailnetのホスト名へのCNAMEにする予定なので公開の心配もない筈

解決先が tailnet IP (100.x) になるため tailnet 外から経路が存在せず、ACME は DNS-01 なので到達性不要。補足: TLS 終端は自前 proxy の仕事 (tailscale serve は *.ts.net の証明書しか持てない)。wildcard 証明書は個別サブドメイン名が Certificate Transparency ログに漏れない副次的利点もある。

関連:

- webui の html プレビューは本構想までセキュリティ理由で見送り (kawaz 裁定「セキュリティ考えると今はhtmlは要らない」)
- `docs/issue/2026-07-10-webrtc-datachannel-transport.md` (DR-0009 の WebRTC DataChannel 構想) とも接続する可能性

## 受け入れ条件

- [ ] Caddy での wildcard DNS-01 + `reverse_proxy` 設定での PoC 実現可能性を検証する
- [ ] 公開範囲 (tailnet 限定 A レコード等) の方針を決める
- [ ] docroot ごとの origin 割当方式 (hash 生成規則、subdomain 命名規則) を設計する
- [ ] cookie / 認証境界の扱いを整理する
- [ ] build (Caddy 等の既製品) か buy (自作リバースプロキシ) かを判断する
