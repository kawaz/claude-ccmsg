---
title: 本番の daemon で、hello の transcript の探索に 550〜640ms かかるセッションがある
status: open
category: bug
created: 2026-11-11T23:48:09+09:00
last_read: 2026-11-12T20:13:51+09:00
open_entered: 2026-11-11T23:48:09+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: macOS の CI の flaky の調査で足した warn が、実 daemon の log に出ていた (2026-11-11)
---

# 本番の daemon で、hello の transcript の探索に 550〜640ms かかるセッションがある

## 概要

本番の daemon で、hello の transcript の探索に 550〜640ms かかるセッションがある。

## 観測 (2026-11-11、実 daemon の daemon.log。v0.250.0 から、hello が 500ms 以上かかると warn が出る)

- daemon が再起動した直後 (14:11:10Z と 14:24:36Z の 2 回) に、同じ 4 つのセッションの hello がそれぞれ 549〜637ms かかった。内訳はどれも transcript search が 548〜636ms で、cwd / repo root / location は 0〜21ms
- 4 つの hello は同じ時刻 (数十 ms の差) に並んで走っている
- 手元の計測 (テストの daemon が実際の HOME を読んだ時): transcript の探索 (adoptTranscriptPath → resolveVirtualTranscript(sid, detectConfigDirs())) は 1 回 166〜384ms で、途中で event loop が 25〜28ms 遅れた
- 走査の期限切れ (session runs: not read in time) と scan_timed_out の行は、同じ log に 0 件

## 分かっていないこと

- この 4 つのセッションだけが探索に入る理由 (hello が transcript の場所を名乗っていないのか、名乗った場所が受け入れられていないのか)。ほかのセッションの hello は 500ms 未満
- 探索が何を読んでいるのに 0.5 秒かかるのか (config dir の数、projects/ の下のディレクトリとファイルの数)
- daemon の再起動の時以外 (hooks module は request のたびに hello する) にも同じ探索が走っているか。500ms 未満だと warn に出ないので、今の log では見えない

## 影響

- その hello の応答が 0.5 秒遅れる
- 同時に 4 本走るので、その間 daemon の読み込みが混む

## 決めること

- 探索に入る条件を絞れるか (名乗られた場所を先に確かめる、見つけた場所を sid ごとに覚える、等)
- 探索そのものを速くするか (config dir ごとの projects/ の一覧を覚える等)

## 関連

- docs/issue/2026-11-11-test-daemons-read-real-home.md (テストの daemon が実際の HOME を読む件)
- packages/daemon/src/server.ts の HELLO_SLOW_MS と slowHelloText

## 受け入れ条件

- [ ] 探索に入る条件、または探索の速度について方針が決まる
