---
title: PC 再起動後の直前ライブセッション復元
status: resolved
category: design
created: 2026-08-25T15:34:45+09:00
last_read:
open_entered: 2026-08-25T15:34:45+09:00
wip_entered: 2026-08-25T15:34:45+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-25T16:10:52+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.115.0で実装完了。daemonがpeers集合をstate/last-live-sessions.jsonにatomicスナップショット(join/leave契機、graceful shutdownでも保持)、再起動後にpeersレスポンス/pushのlast_liveでwebuiへ提供、SESSIONSに「前回稼働中」セクション表示、各行からresume導線(cwd/model/effort/title prefill)。受け入れ条件は隔離daemonでのkill-9→再起動→表示→resume prefill→再接続で行消滅、の通し実機確認で充足済み。既知の妥協点: webuiを開いていない間に記録された行はtitleが付かずcwd末尾にフォールバック(不足が出たらtranscript custom-title走査への切替を検討)"]
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
