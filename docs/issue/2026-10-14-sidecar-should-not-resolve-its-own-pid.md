---
title: sidecar は自分で harness の pid を探さず、pid への対応付けは daemon が行う
status: open
category: design
created: 2026-10-14T11:24:47+09:00
last_read:
open_entered: 2026-10-14T11:24:47+09:00
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

# sidecar は自分で harness の pid を探さず、pid への対応付けは daemon が行う

## 概要

sidecar は socket 名 `<sid>.<pid>.sock` のために自分で harness の pid を探している。祖先探索は `ps` を使うが sandbox-exec 内では EPERM になる。v0.166.0 では module が `/bin/sh -c echo $PPID` で pid を取り、`--pid` で sidecar に渡す回り道をしている。

kawaz 2026-10-14: sid と起動時刻があれば daemon は `claude agents --json` や `sessions/<pid>.json` で pid を引けるので、sidecar 側で pid を知る必要は無い。

## 設計方針

- sidecar は sid と、run を区別する値 (起動時刻か乱数の run id) だけで名乗る
- pid への対応付けは daemon が自分の持つ情報で行う。対象は同じ sid の複数 run の区別と、`ccmsg:<sid>.<pid>` 宛先
- module 側の pid 取得 (`/bin/sh -c echo $PPID` と `--pid` の受け渡し) と、CLI の祖先探索を消す

## 受け入れ条件

- [ ] sidecar の起動に pid が要らない (socket 名が sid + run 識別子で決まる)
- [ ] daemon が sid と起動時刻から pid を引き、同じ sid の複数 run を区別できる
- [ ] `ccmsg:<sid>.<pid>` 宛先が従来どおり解決される
- [ ] module の pid 取得と CLI の祖先探索が消えている
