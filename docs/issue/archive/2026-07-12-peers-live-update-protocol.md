---
title: state.peers に live 更新経路が無く接続/切断がリアルタイム反映されない
status: resolved
category: design
created: 2026-07-12T03:41:25+09:00
last_read:
open_entered: 2026-07-12T03:41:25+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-21T03:36:02+09:00
discard_reason:
pending_reason:
close_reason: ["done"]
blocked_by:
origin: 自リポ TODO
---

# state.peers に live 更新経路が無く接続/切断がリアルタイム反映されない

## 概要

room メンバーチップの非接続グレー表示 (v0.21.0 予定の `isMemberConnected`) の根拠となる `state.peers` に live 更新経路が無く、セッションの接続/切断がリアルタイムに反映されない。現状は ws `onOpen` ハンドシェイクと Sidebar の手動リフレッシュでしか `peers`/`loaded` が dispatch されない。

## 背景

Wave4 の adversarial レビュー指摘 (minor)。正攻法は daemon 側が peers 変化を push する ephemeral event (`ev:"peers"` 等、`agents` の `ev:"agents"` と同型) による protocol 拡張だが、fix worker のスコープ (protocol 編集禁止) を越えるため今回は見送った。次に protocol を触る Wave で `ev:"peers"` push (hello/切断時に user-role subscriber へ配信) を実装するのが素直な解決策。

## 受け入れ条件

- [ ] daemon がセッションの接続/切断イベントを user-role subscriber へ `ev:"peers"` 相当の ephemeral event で push する
- [ ] client 側 (webui) が `ev:"peers"` を受けて `state.peers` を即時更新し、手動リフレッシュなしでチップの接続状態が切り替わる
