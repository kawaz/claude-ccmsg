---
title: Bun 1.3 fullstack 機能への webui 配信経路置換検討
status: idea
category: design
created: 2026-07-10T18:21:42+09:00
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

# Bun 1.3 fullstack 機能への webui 配信経路置換検討

## 概要

webui の配信経路を、現行の自作「サーブ時 `Bun.build` + メモリキャッシュ」構成 (DR-0005 §3) から、Bun 1.3 の公式 fullstack 機能 (HTML import + `Bun.serve` routes) へ置換できないか検討する。

## 背景

`docs/findings/2026-07-10-frontend-trends-vs-dr0005.md` の調査で、DR-0005 §3 の自作構成が Bun 1.3 の公式機能でほぼ置換可能と判明した。公式機能は HTML import による自動トランスパイル + lazy bundle + メモリキャッシュ + Cache-Control/ETag を備え、dev モードでは HMR / React Fast Refresh + ブラウザ console 転送も提供する。

TSX を route に直接渡す形はまだ未実装 (oven-sh/bun#20075 open)。現行実装は動いているため急ぎではなく、dev 体験 (HMR) が欲しくなったタイミングで着手するのが妥当と判断。

着手する場合は DR-0005 §3 の追補として扱い、自作経路との挙動差 (loader / cache 挙動) を実機検証してから置換する。

## 受け入れ条件

- [ ] oven-sh/bun#20075 (TSX を route に直接渡す機能) の進捗を確認する
- [ ] HTML import + `Bun.serve` routes 構成で現行 webui 相当の配信ができるか PoC する
- [ ] 自作経路 (`Bun.build` + メモリキャッシュ) との挙動差 (loader 挙動 / cache-control / ETag / HMR) を実機検証する
- [ ] 置換する場合は DR-0005 §3 の追補 DR を起票する
