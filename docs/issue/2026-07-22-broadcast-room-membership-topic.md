---
title: broadcast room の membership を topic 化する (leave を書かない monotone 集合へ)
status: open
category: design
created: 2026-07-22T17:29:25+09:00
last_read:
open_entered: 2026-07-22T17:29:25+09:00
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

# broadcast room の membership を topic 化する (leave を書かない monotone 集合へ)

## 概要

broadcast room の membership モデルを「join/leave の両方を書く」現行方式から、「初回 join のみ記録し leave を書かない monotone 集合」方式 (topic 化) に変更する設計検討。

## 背景

`joinallbroadcasts-duplicate-member-rows` issue (`docs/issue/2026-07-22-joinallbroadcasts-duplicate-member-rows.md`) の真因調査 (2026-07-22) で判明: dup の真因は「一発 CLI の hello→op→close が leave を書き、次の呼び出しで member 再追記」の反復 (daemon 入れ替え時の再接続も同型)。

当面は A 案 (`memberIdBySid` を broadcast のみ leave 無視) で dup 蓄積を止める方針だが、より整った設計は B 案 = broadcast を topic 化すること:

- member は初回 join のみ記録
- broadcast では leave を書かない
- `rooms.members` は「かつて join した全 sid」の monotone 集合になる

この変更は DR-0013 §2.2 (disconnect = 自動 leave) の broadcast についての再解釈・DR 改訂を伴うため kawaz 裁定が必要。既存テスト「session disconnect auto-leaves every broadcast」の契約書き換えも伴う。

関連: 一発 CLI が leave/member noise を書き続ける構造自体が解消される。

## 受け入れ条件

- [ ] DR-0013 §2.2 の broadcast 解釈について kawaz 裁定を得る (A 案継続 or B 案採用)
- [ ] B 案採用時: broadcast room の join/leave 処理を topic 化 (leave 非記録、monotone member 集合) に変更
- [ ] B 案採用時: 「session disconnect auto-leaves every broadcast」テストの契約を新モデルに合わせて書き換える
- [ ] `joinallbroadcasts-duplicate-member-rows` issue との関係 (A 案が暫定対処か、B 案着地で不要化するか) を明記する

## TODO

<!-- wip 時のみ -->
