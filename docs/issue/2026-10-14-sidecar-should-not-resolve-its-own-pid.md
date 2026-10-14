---
title: sidecar は自分で harness の pid を探さず、pid への対応付けは daemon が行う
status: open
category: design
created: 2026-10-14T11:24:47+09:00
last_read: 2026-10-14T16:45:52+09:00
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

## 設計案 (kawaz 2026-10-14)

mods が確実に知れるのは次の 4 つ。pid はこの中に無い。

- sid (`$.session.id()`)
- 環境変数
- module 読み込み時刻 (≒ run の開始)
- cwd

これを使った名乗りと対応付け:

- sidecar は sid + 起動時刻 (または乱数の run id) で名乗る。socket 名もそれにする
- daemon は `claude agents --json` (pid / cwd / startedAt / sessionId / name) の同 sid の行から、startedAt が最も近いものを選んで pid を引き、保管する。cwd は照合の確認用
- 同 sid の複数 run は startedAt で区別できる
- 名乗りに `CLAUDE_CONFIG_DIR` (`$.env.get`) も含める。daemon は複数の config dir を扱うので、これがあれば照合のために全 config dir の `claude agents --json` を見て回らず、その 1 つだけを引けばよい
- pid への対応付けは daemon の責務。sidecar は自分の pid を知らなくてよい

### 名乗りを daemon への通知にする (kawaz 2026-10-14)

bind 時の名乗りを daemon への通知にし、input_readiness の再判定の契機にもする (sidecar dir の fs.watch 依存を消す)。名乗りに `HYOUI_SESSION_ID` を添えれば、daemon が `ps eww` で harness の環境変数を読む処理も消せる。

背景: v0.166.0 の CI (macOS) で sidecar dir の fs.watch (FSEvents) が 5 秒以内に届かず readiness の test が落ちた。暫定として readiness を agents poll の毎回で判定し直す形にした (遅れは poll 間隔まで)。名乗りが入れば poll は backstop に下がる。

決めること:

- sidecar が去る時の契機 (接続を張り続けて切断で知る / fs.watch と poll に残す)
- daemon 再起動時の再名乗り

## 受け入れ条件

- [ ] sidecar の起動に pid が要らない (socket 名が sid + run 識別子で決まる)
- [ ] daemon が sid と起動時刻から pid を引き、同じ sid の複数 run を区別できる
- [ ] `ccmsg:<sid>.<pid>` 宛先が従来どおり解決される
- [ ] module の pid 取得と CLI の祖先探索が消えている
- [ ] readiness が sidecar の bind / 消滅に fs.watch を介さず追従する
