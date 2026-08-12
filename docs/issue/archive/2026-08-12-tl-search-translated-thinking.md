---
title: 翻訳済み thinking と TL 検索の不整合
status: resolved
category: design
created: 2026-08-12T10:40:33+09:00
last_read:
open_entered: 2026-08-12T10:40:33+09:00
wip_entered: 2026-08-12T13:48:56+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T14:17:02+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.102.1 で実装。SearchUnit.texts (複数綴り、いずれかで M に計数、AND は綴り内で閉じる) + 訳 registry の購読で非同期到着にも追従。実測: 原文/訳文どちらのクエリでも 1/1、訳到着で 0/0→1/1"]
blocked_by:
origin: 自リポ TODO
---

# 翻訳済み thinking と TL 検索の不整合

## 概要

ja 自動翻訳が thinking の描画テキストを差し替えるため、TL 検索と thinking の
実際の描画がずれる。具体的には次の 2 点:

- (a) 📁 OFF (画面に出ているものだけを検索対象にするモード) では、翻訳済み
  thinking が原文クエリにマッチしない
- (b) thinking のマッチに視覚ハイライトが付かない (描画が翻訳後のテキストで
  あるのに対し、モデル側のマッチ計数は原文基準のため)

## 背景

D1 (v0.100.9) 以前から同じ挙動であり、D1 の変更で悪化も改善もしていない。
「原文で数え、翻訳後を塗る」というずれをどう扱うかの設計判断が要る。

候補:

- 両テキスト (原文 + 翻訳後) を検索対象にする
- 翻訳表示中である旨を UI 上で示す

D2 (fold 状態の持ち上げ) 後に扱うと、📁 OFF のモデル化と併せて解ける可能性が高い。

## 受け入れ条件

- [ ] 📁 OFF 時に翻訳済み thinking への検索クエリがマッチする、または
      マッチしない旨が UI 上で明示される
- [ ] thinking のマッチに視覚ハイライトが付く、または計数基準と描画基準の
      ずれが解消される

## TODO

<!-- wip 時のみ -->

着手 (2026-08-12)。統括方針: SearchUnit の検索対象テキストに原文と翻訳の両方を
含める (どちらの綴りのクエリでも計数にヒット)。装飾は表示中テキストにマッチする
分が自然に付く。
