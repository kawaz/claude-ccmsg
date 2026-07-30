---
title: TL の in-view search が閉じた fold の中身をカウントしない (コメントの仕様記述と食い違い)
status: open
category: bug
created: 2026-07-29T13:25:27+09:00
last_read: 2026-07-30T08:24:30+09:00
open_entered: 2026-07-29T13:25:27+09:00
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

# TL の in-view search が閉じた fold の中身をカウントしない (コメントの仕様記述と食い違い)

## 概要

Timeline の検索窓でタイプすると、fold group が閉じている間はその中のマッチが 0 件扱いになり、fold を開くとカウントに入る (例: 閉じていると 0 件、開くと 1/4)。コード上のコメントは「fold の開閉に関わらず数える」と書いており、実装と食い違っている。

## 背景

worker 実測 (2026-07-29, v0.82.1/v0.82.2 とも) で確認。v0.82.2 の dedup 修正 (ccmsgRenderTargets 一本化) より前から存在する挙動 (修正前ビルドでも同一を確認済み)。

## 受け入れ条件

- [ ] コード上のコメントと実装の挙動が一致している (どちらかに寄せる)

## 対応方針の選択肢

- (a) コメントどおり「閉じた fold の中も数え、ヒットへのジャンプで fold を自動展開」に実装を寄せる。検索体験としては素直だが fold 自動展開の UX 判断を含む
- (b) 現挙動を仕様としてコメントを直す

## 解決時の記録先

- (a) を採るなら commit message で足りる。(b) ならコメント修正のみ
