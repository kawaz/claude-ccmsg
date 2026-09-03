---
title: webui が daemon の version 不一致を検知して自動リロードする
status: open
category: task
created: 2026-09-03T09:47:44+09:00
last_read:
open_entered: 2026-09-03T09:47:44+09:00
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

# webui が daemon の version 不一致を検知して自動リロードする

## 概要

hello 応答の daemon version と webui bundle に埋め込んだ version を突き合わせ、不一致なら (未送信の入力を失わないよう配慮した上で) 自動リロードする仕組みを入れる。

## 背景

v0.136.0 で全要求に request_id が必須になり、古い bundle を掴んだままのブラウザタブは新 daemon に対して全要求が bad_request になる (手動リロードまで無反応に見える)。protocol 変更のたびに同じ症状が起きるので、version 不一致の自動検知・自動リロードで再発を防ぎたい。daemon upgrade (`local-daemon-upgrade` / `ccmsg daemon restart`) 後の再接続時も同じ経路で拾える必要がある。

## 受け入れ条件

- [ ] hello 応答の version と webui bundle の version を比較し、不一致で再読込 (ユーザ入力中なら通知 + ボタンに fallback)
- [ ] daemon 再起動 → 再接続の経路でも動く
- [ ] version 一致時は何もしない (無限リロードしない) ことのテスト

## TODO

<!-- wip 時のみ -->
