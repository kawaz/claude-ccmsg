---
title: webui を workspace UI に育てる長期 roadmap
status: idea
category: design
created: 2026-07-09T23:35:02+09:00
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

## マイルストーン案 (順不同、着手時にそれぞれ DR 追補が必要)

1. **セッション一覧**: ccmsg peers と Claude セッション jsonl の突合。daemon 側 API 拡張が必要
2. **セッション jsonl リッチビューア**: `claude-session-analysis` の知見流用候補
3. **ファイルツリー + ファイルビューア**: daemon にローカル FS 読み取り API を足すことになるため、セキュリティ境界 (= identity pinning 前提) の再確認が必須
4. **作業操作系**: 何をもって「基本的な作業」とするかは kawaz と要すり合わせ

## 受け入れ条件

- [ ] (idea 段階のため未確定。着手判断時に個別マイルストーンごとの受け入れ条件を定める)

## TODO

<!-- wip 時のみ -->
