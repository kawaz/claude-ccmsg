---
title: msgVisibleTo が subscribe stream 上で死んだ判定になっている (user role only 化の帰結)
status: open
category: task
created: 2026-09-28T14:36:26+09:00
last_read:
open_entered: 2026-09-28T14:36:26+09:00
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

# msgVisibleTo が subscribe stream 上で死んだ判定になっている (user role only 化の帰結)

## 概要

subscribe stream で msg を受けるのが user role だけになったため、`server.ts` の
`msgVisibleTo` (to フィルタ・セッション向け 50 件 cap) が stream 上では常に true の
死んだ判定になっている。効いているのは `room_history` と peer-inject のみ。整理候補。

## 背景

v0.154.1 の feat(daemon) commit `uyxnpmxw` で subscribe stream の受信対象が
user role のみに変わった。`msgVisibleTo` はもともと役割別の可視性を絞る目的の
判定だったが、その前提が崩れたため stream 経路では常に true を返すだけの
dead code 相当になっている。

あわせて記録: cursor 未保持 room で daemon 再起動中に起きた非 msg イベント
(leave / title 等) が session subscriber に届かない既存挙動がある。msg の
recent-replay で目立たなかっただけで、これも同じ変更の副作用として顕在化した。

## 受け入れ条件

- [ ] `msgVisibleTo` の stream 経路での要否を判断し、不要なら削除 (room_history /
      peer-inject への影響がないことを確認した上で)
- [ ] cursor 未保持 room の再起動中非 msg イベント欠落について、記録に残すか
      対応するかを判断する

## TODO

<!-- wip 時のみ -->
