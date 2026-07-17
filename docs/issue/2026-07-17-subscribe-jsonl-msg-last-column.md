---
title: subscribe jsonl の msg カラムを末尾に並べ替え (truncation 対策)
status: open
category: bug
created: 2026-07-17T20:51:11+09:00
last_read:
open_entered: 2026-07-17T20:51:11+09:00
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

# subscribe jsonl の msg カラムを末尾に並べ替え (truncation 対策)

## 概要

`subscribe` が出力する msg イベント jsonl のカラム順を、`msg` 本文が必ず最後に来る形
(`{type, mid, from, ts, to?, r, seq, reply_hint?, msg}`) に並べ直す。

## 背景

harness の task-notification truncation はブロック末尾から切る。現状のカラム順
(`msg` が中程、`r` / `seq` / `reply_hint` が後ろ) だと、長文 `msg` のときに後続
フィールドだけが silent に消える。

mid=99 の実例では `reply_hint` が消えつつ本文はギリギリ読める状態になり、エージェント
が truncation の発生に気づかず後続フィールドの存在を認識しない事故が起きた
(kawaz r26 mid=110 で報告)。

`msg` を最後に置けば、切れるのは常に `msg` の途中になる。「切れている」ことが
出力から視認できるようになり、全文読み (transcript read 等) に誘導される。

## 実装方針

- daemon / CLI の subscribe 出力段で JSON を
  `{type, mid, from, ts, to?, r, seq, reply_hint?, msg}` の順に再構築する
  (`JSON.stringify` のキー順は挿入順で制御可能)
- webui 側の truncated 救済 parse (`tryParseTruncatedCcmsgMessage`) も新カラム順
  前提の抽出ロジックに追従させる。`r` / `seq` が `msg` より前に来るため、
  従来の room 欠落問題も構造的に解消される
- 保存側 (`rooms/*.jsonl`) のフィールド順は変えない。出力整形 (subscribe 表示層)
  のみの変更

## 受け入れ条件

- [ ] subscribe 出力の msg イベント jsonl で `msg` が常に最後のキーになっている
- [ ] 長文 msg で truncate されたとき、`r` / `seq` / `reply_hint` 等の他フィールドが
      欠落しない (= 切れるのは常に msg 本文側)
- [ ] webui の `tryParseTruncatedCcmsgMessage` が新カラム順で room 情報を正しく
      抽出できる
- [ ] 保存先 (`rooms/*.jsonl`) のフィールド順に影響がないことを確認
