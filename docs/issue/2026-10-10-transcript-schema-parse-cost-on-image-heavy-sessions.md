---
title: transcript-schema-parse-cost-on-image-heavy-sessions
status: open
category: bug
created: 2026-10-10T12:47:04+09:00
last_read: 2026-10-18T17:57:40+09:00
open_entered: 2026-10-10T12:47:04+09:00
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

# transcript-schema-parse-cost-on-image-heavy-sessions

## 概要

transcript の行を valibot のスキーマで読む (DR-0038 §3、段 A・B) ようにした結果、13MB の transcript で JSON.parse 13ms に対しスキーマ 35ms、画像だらけの 218MB / 722 行では 240ms に対し 1.5s と約 6 倍 (段 B worker の計測 2026-10-10)。Session Search で固定文字列を含まない正規表現だと全行がスキーマに通るので差がそのまま効く。実運用の検索で体感に出るかを計測し、出るなら検索用の投影スキーマ (text ブロックだけ、image の source を読まない) や前段の文字列フィルタで絞る。

## 背景

DR-0038 §3 の段 A・B でスキーマ読みへ移行した副作用。画像ブロックの source (巨大な base64) までスキーマが走査することが差の主因と推測される (未検証)。

## 受け入れ条件

- [ ] 実運用の Session Search で体感に出るか計測し結果を記録する
- [ ] 出る場合、投影スキーマまたは前段の文字列フィルタで絞って再計測する

(category: perf の指定だが enum に無いため bug を選択 — 要確認)
