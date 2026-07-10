---
title: WebRTC DataChannel transport 構想
status: idea
category: design
created: 2026-07-10T18:16:15+09:00
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

# WebRTC DataChannel transport 構想

## 概要

ccmsg のメッセージ配送を WebRTC DataChannel に載せるプロトコル構想。静的アセット (UI 一式) は GH Pages / Cloudflare Pages 等にデプロイし、ICE candidate を含む URL で開いた側同士が peer 接続を確立、passkey 認証を経てメッセージ送受信する構成。tailnet (Tailscale 等) に依存せず「どこでも繋げられる」ことを狙う。

## 背景

kawaz 発言 (2026-07-10) 由来の構想。一次資料は verbatim で記録済み: `docs/research/2026-07-10-kawaz-webrtc-datachannel-vision.md`。

現行 ccmsg は中央デーモン方式 + tailnet 経由アクセスが前提 (関連: `2026-07-10-webui-https.md` の HTTPS 化検討)。本構想はそれとは異なる transport 層のアプローチで、シグナリングに静的ホスティングを使い、実データ伝送は P2P DataChannel に逃がす。認証は passkey に委ねる。

## 受け入れ条件

- [ ] 一次資料 (`docs/research/2026-07-10-kawaz-webrtc-datachannel-vision.md`) を読み直し、シグナリング方式 (ICE candidate をどう URL に埋め込み交換するか) の実現可能性を検討する
- [ ] 現行の中央デーモン方式との共存/置換の関係を整理する (transport の選択肢として並立させるのか、将来的な移行先とするのか)
- [ ] passkey 認証の組み込み方式 (どの段階で認証するか、認証失敗時の挙動) を検討する
- [ ] 検討結果を DR として記録する
