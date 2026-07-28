---
title: canddy sandbox origin を使った非信頼コンテンツ配信 (生ファイル / HTML / 大出力)
status: open
category: design
created: 2026-07-29T00:14:53+09:00
last_read:
open_entered: 2026-07-29T00:14:53+09:00
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

# canddy sandbox origin を使った非信頼コンテンツ配信 (生ファイル / HTML / 大出力)

## 概要

ccmsg daemon が canddy の sandbox origin (apps とは別 eTLD+1) 向けの配信エンドポイントを持ち、MIME 制限なしの生配信 (text/html 含む) を提供できるようにする。

## 背景

webui は same-origin の /fs-serve (画像拡張子 allowlist のみ) しか配信経路が無く、HTML の実表示・任意バイナリ・TL の長大 bash 出力の「別タブで全文を開く」ができない。kawaz 指摘 (2026-07-29): canddy-app-proxy に **sandbox ドメイン (`*.kawaz-mbp16-20211217.tmpspace.net`、apps の kawaz.jp とは別 eTLD+1)** が用意済みで、passkey 窃取 / cookie tossing / SameSite 無効化を構造的に封じている。ccmsg はこれを未活用。

### やりたいこと

- ccmsg daemon が sandbox origin 向けの配信エンドポイント (例: `ccmsg-raw.<host>.tmpspace.net` を canddy で ccmsg の別ポート or Host 判定にルーティング) を持ち、そこでは MIME 制限なしの生配信 (text/html 含む) を行う
- 認可は既存の fs_read 系 3 op と同じ境界 + capability トークン (sandbox 側は cookie を使えない前提なので URL トークン)
- 用途: (a) FileViewer からの「HTML として開く」/ 生ダウンロード (b) TL の長大 bash 出力の別タブ全文表示 (c) 将来の attachment 生配信

### 検討事項

- canddy 側の Caddyfile への app 追加 (ccmsg-raw) と ccmsg 側の Host/ポート設計
- capability トークンの寿命・失効 (rotate)
- issue 2026-07-11-origin-isolated-app-reverse-proxy との統合 (あちらは docroot-hash 分離案。canddy 実在を前提に具体化して supersede してよい)

## 受け入れ条件

- [ ] sandbox origin 経由での生配信エンドポイントの設計方針が decisions/DR として確定する
- [ ] capability トークンの発行・検証・失効の仕組みが定まる
- [ ] issue 2026-07-11-origin-isolated-app-reverse-proxy との関係 (統合/supersede) が整理される

## 解決時の記録先

- 設計判断を伴う: decisions/DR-NNNN
