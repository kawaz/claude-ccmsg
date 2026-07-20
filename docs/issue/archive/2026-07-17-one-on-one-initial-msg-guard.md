---
title: 1on1 宛 create-room/next-room の初期 msg にも session 発ガードを適用
status: resolved
category: design
created: 2026-07-17T17:21:32+09:00
last_read:
open_entered: 2026-07-17T17:21:32+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-21T03:40:19+09:00
discard_reason:
pending_reason:
close_reason: ["done: create_room/next_room ハンドラで 1on1 宛かつ session 発の初期 --msg を sendReplyViaTlError で拒否済み。post 経路と同一文言・同一 code、broadcast 例外は one-on-one.test.ts で維持確認"]
blocked_by:
origin: 自リポ TODO
---

# 1on1 宛 create-room/next-room の初期 msg にも session 発ガードを適用

## 概要

`create_room` / `next_room` ハンドラで 1on1 宛に渡す初期 `--msg` も、
session 発の場合は `reply_via_tl` で拒否する。v0.45.0 で post 経路に入れた
session 発ガードと同じエラー文言を使う。broadcast の初期 msg 例外
(DR-0013 §2.10) はそのまま維持し、対象は 1on1 のみに絞る。

## 背景

kawaz 裁定 (r26 mid=103)「そもそもその機能が不要、混ぜない」により、
RL-Q1 で残っていた「create-room/next-room の初期 msg なら 1on1 でも
session 発を許す」という抜け道を塞ぐことが確定した。

## 受け入れ条件

- [ ] `packages/daemon/src/server.ts` の `create_room` ハンドラで、1on1 宛
      かつ session 発の初期 `--msg` を `reply_via_tl` で拒否する
- [ ] `packages/daemon/src/server.ts` の `next_room` ハンドラも同様に対応
- [ ] エラー文言は v0.45.0 の post ガードと同一のものを使う
- [ ] broadcast 宛の初期 msg 例外 (DR-0013 §2.10) は引き続き許可されることをテストで確認
- [ ] 1on1 宛の初期 msg が session 発の場合に拒否されることをテストで確認
