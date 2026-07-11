---
title: webui を workspace UI に育てる長期 roadmap
status: wip
category: design
created: 2026-07-09T23:35:02+09:00
last_read:
open_entered:
wip_entered: 2026-07-10T22:01:21+09:00
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

# webui を workspace UI に育てる長期 roadmap

## 概要

現状の webui を、単なる ccmsg メッセージビューアから「workspace UI」へ育てる長期 roadmap。
一次資料: `docs/research/2026-07-09-kawaz-webui-vision-statement.md`。
器の設計は DR-0005 (component + typed action/reducer + preact/TSX) に準拠する。

## 背景

kawaz が思い描く最終形イメージ:

- ccmsg 付きセッション一覧 / room 一覧
- セッション選択で jsonl からリッチレンダリング
- プロジェクト内ファイルツリー + ファイルビューア
- 最終的に基本的な作業が全てそこでできる

一気に最終形を目指さず、DR-0005 の器の上に必要になった時点で個別マイルストーンごとに設計する方針。

## マイルストーン案 (着手時にそれぞれ DR 追補が必要)

kawaz 裁定 (2026-07-10) により優先順を以下の通り確定。1〜3 は並列進行可:

1. **セッションリスト** (必須): ccmsg peers と Claude セッション jsonl の突合。daemon 側 API 拡張が必要
2. **ルームリスト + シンプルチャット** (必須): 既存コンポーネント流用でサクッと実装する方針
3. **セッション選択 → ファイルツリー + コードビューア** (kawaz 個人優先度最高): リモートからファイルが見れない辛みの解消が主目的。daemon にローカル FS 読み取り API を足すことになるため、セキュリティ境界 (= identity pinning 前提) の再確認が必須
4. **作業操作系**: 1〜3 の後続。何をもって「基本的な作業」とするかは kawaz と要すり合わせ

## 受け入れ条件

- [ ] (idea 段階のため未確定。着手判断時に個別マイルストーンごとの受け入れ条件を定める)

## TODO

- [x] セッションリスト (daemon API 拡張含む)
- [x] ルームリスト + シンプルチャット — 既存実装で充足につき変更なし (DR-0008 に記録)
- [x] セッション選択 → ファイルツリー + コードビューア (DR-0008、fs_list/fs_read 実装 + 実ブラウザ検証済み)
- [x] jsonl リッチビューア (DR-0009、transcript_read op + Timeline ビュー実装、実ブラウザ検証済み)
- [ ] 作業操作系 (範囲は要すり合わせ、kawaz と「基本的な作業」の定義すり合わせ待ち)
- [x] シンタックスハイライト (任意) — Shiki (@shikijs/core + JS regex engine) 採用、ts/js/jsx 系は tsx グラマー 1 本に集約して実測 gzip +138KB (47.7KB→185KB)、XSS 安全設計。増分は loopback/tailscale 配信のローカルツールとして許容の裁定 (メイン 2026-07-12)。さらなる削減は lazy chunk 分割が open option
- [ ] transcript の live 追従 stream (DR-0009 で延期と記録済み、必要になったら着手)
