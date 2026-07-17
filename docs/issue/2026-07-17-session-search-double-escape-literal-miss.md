---
title: Session Search literal モードが二重 JSON エスケープの ccmsg メッセージを検索できない
status: open
category: bug
created: 2026-07-17T11:14:00+09:00
last_read:
open_entered: 2026-07-17T11:14:00+09:00
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

# Session Search literal モードが二重 JSON エスケープの ccmsg メッセージを検索できない

## 概要

Session Search の literal モードで、ccmsg 経由メッセージ (queue-operation 行) がヒットしない既存制限がある (v0.44.0 検査で fable が実測報告)。

## 背景

ccmsg 経由の msg は content 内に二重 JSON エスケープされた状態で埋め込まれる。そのため literal 検索の needle (一重エスケープの綴り) が raw line の substring として一致しない。

具体的には `col1\tcol2` / `say "hi"` / `C:\Users` のようなエスケープ対象文字 (タブ・ダブルクォート・バックスラッシュ等) を含む ccmsg メッセージを literal モードで検索すると hits:0 になる。

エスケープ対象文字を含まないクエリ、および regex モードは影響を受けない。

修正候補: プリフィルタ needle に二重エスケープ綴りも OR で加える。false positive 側は strict 段でフィルタされるため安全。該当箇所は `packages/daemon/src/session-search.ts` の `prefilterNeedles`。

## 受け入れ条件

- [ ] エスケープ対象文字を含む literal クエリで ccmsg 経由メッセージがヒットする
- [ ] 既存の regex モード・非 ccmsg メッセージの検索結果に regression がない
