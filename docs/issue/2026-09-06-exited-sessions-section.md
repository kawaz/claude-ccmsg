---
title: セッション一覧に Exited (終了・保持・resume 可) 分類を追加する
status: open
category: design
created: 2026-09-06T19:57:35+09:00
last_read:
open_entered: 2026-09-06T19:57:35+09:00
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

# セッション一覧に Exited (終了・保持・resume 可) 分類を追加する

## 概要

kawaz 裁定 (QUESTIONS SS-Q1 = a + c、2026-09-06): 「プロセスは終了するがセッション
リストには残す」分類を「前回稼働中エントリの昇格」で実装する。`last-live-sessions.json`
のエントリに `stopped_at` を足し、Busy の Status に一時停止ボタン (= `session_kill` に
`retain: true`) を置く。消える条件は前回稼働中と同じ (同 sid 再接続 / ✕)。
加えて (c) 前回稼働中の行にも「Exited へ移す」ボタンを足す。

## 背景

名称は Docker の語彙で Exited を推す。SS-Q2 で裁定中: Exited と Last seen を
1 セクションに統合するか、Busy/Idle を分けるか、英語名。

## 受け入れ条件

- [ ] SS-Q2 (セクション構成: Exited と Last seen の統合可否、Busy/Idle 分離、英語名) の裁定
- [ ] `last-live-sessions.json` のエントリに `stopped_at` フィールドを追加
- [ ] Busy の Status に一時停止ボタン (`session_kill` に `retain: true`) を追加
- [ ] 前回稼働中の行に「Exited へ移す」ボタンを追加
- [ ] Exited エントリが消える条件 (同 sid 再接続 / ✕) の実装
