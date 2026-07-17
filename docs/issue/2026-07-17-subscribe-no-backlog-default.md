---
title: subscribe のデフォルトを過去メッセージ再送なしに変更
status: open
category: request
created: 2026-07-17T22:15:49+09:00
last_read:
open_entered: 2026-07-17T22:15:49+09:00
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

# subscribe のデフォルトを過去メッセージ再送なしに変更

## 概要

`subscribe` 開始時のデフォルト挙動を、過去ログ(バックログ)再送ありから
**再送なし**に変更する(kawaz 裁定 2026-07-17)。

デフォルトでは過去 msg を流さず、接続時に **参加中 room の
`{roomid, last_mid}` 一覧だけ**を初期イベントとして出力する。各セッションは
自分が記憶している mid と比較して進んでいれば `read` で取りに行く形にし、
「追いつくかどうか」の判断をセッション側に委ねる。

従来のバックログ再送挙動は、既存の `--since` オプション or 明示フラグ側に
退避する(= 完全に消すのではなく opt-in 化)。

## 背景

現状 `subscribe` 開始時に過去ログが再送されるため、貼り直し時に**全セッション**
が「過去メッセージの再送に戸惑い → (既に対応済みと誤判断して) 無視する」という
同一の判断コストを払う羽目になり、context 浪費が発生する。broadcast での
一斉貼り直しでこの問題が実証された。

## 受け入れ条件

- [ ] `subscribe` のデフォルトで過去 msg が再送されず、接続時イベントが
      `{roomid, last_mid}` 一覧のみになる
- [ ] 各セッションが記憶している mid と比較し、進んでいれば `read` で追いつける
      経路が daemon 側に用意されている
- [ ] 従来の全バックログ再送挙動が `--since` 等の明示オプションで引き続き利用可能
- [ ] daemon の subscribe ハンドラ + CLI 両方に変更が反映されている
- [ ] SKILL.md / `--help-full` の記述がこのデフォルト変更に追従している

## TODO

<!-- wip 時のみ -->
