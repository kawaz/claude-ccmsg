---
title: PC 再起動後の直前ライブセッション復元
status: wip
category: design
created: 2026-08-25T15:34:45+09:00
last_read:
open_entered: 2026-08-25T15:34:45+09:00
wip_entered: 2026-08-25T15:34:45+09:00
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

# PC 再起動後の直前ライブセッション復元

## 概要

PC 再起動 (daemon ごと落ちる) の後、直前まで「どのディレクトリでどのセッションが動いていたか」が分からなくなる問題 (kawaz 報告、r151m14 で進捗確認あり。以前口頭報告を受けたが起票漏れで追跡できていなかった)。

## 背景

方針: daemon が接続中 peer 集合 (sid / cwd / repo / ws / title / 最終確認時刻) を state ディレクトリへ随時スナップショット永続化し、daemon 再起動後に webui SESSIONS へ「前回稼働中」セクションとして表示、各行から resume launcher (model/effort prefill 済み) へ導線。既存の Session Search + resume 基盤 (v0.109-0.112) を再利用。

## 受け入れ条件

- [ ] PC 再起動を模した daemon 再起動後、直前に接続していたセッション一覧が webui に表示され、そこから resume できる

## TODO

- [ ] daemon の peer スナップショット永続化 (state ディレクトリへの随時書き出し) の実装方針を詰める
- [ ] webui SESSIONS への「前回稼働中」セクション表示の実装
- [ ] resume launcher への導線 (model/effort prefill) の接続
