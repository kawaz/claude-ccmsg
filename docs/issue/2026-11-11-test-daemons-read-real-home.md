---
title: テストが起こす daemon が開発者の実際の HOME の .claude*/projects を読んでいる
status: open
category: bug
created: 2026-11-11T23:17:11+09:00
last_read:
open_entered: 2026-11-11T23:17:11+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: served dir の flaky の調査で worker が見つけた (2026-11-11)
---

# テストが起こす daemon が開発者の実際の HOME の .claude*/projects を読んでいる

## 概要

test-daemons-read-real-home テストが起こす daemon が開発者の実際の HOME の .claude*/projects を読んでいる。

### 観測 (2026-11-11、手元の macOS)

- テストが起こす daemon (packages/daemon/test/helpers.ts の startTestDaemon が起こす子プロセス) は、session の hello の時の transcript の探索 (adoptTranscriptPath → resolveVirtualTranscript(sid, detectConfigDirs())) で、開発者の実際の $HOME の .claude* の projects/ を読む
- 手元ではこの探索が 1 回 166〜384ms かかり、途中で daemon の event loop が 25〜28ms 遅れた (一時 trace で計測)
- HOME を空の一時ディレクトリにして同じテスト (send-message.test.ts の served dir のテスト) を走らせると、所要は 456〜591ms になり、名乗りの段は 9〜47ms になった (HOME がそのままの時は名乗りの段が 119〜147ms 以上)

### 影響

- テストの速さと結果が、走らせる人の HOME の中身に左右される (docs/TESTING.md の「決定性」は、daemon の CCMSG_* をテスト側で固定して開発者の shell から継承しないと決めているが、HOME は継承している)
- テストの daemon が実際のセッションの transcript の置き場を読む

## 背景

### 決めること

- テストが起こす daemon の HOME を、実在する一時ディレクトリに固定するか (docs/TESTING.md の「子プロセスに偽の HOME を渡す時は実在する一時 dir」の決まりに合う)。固定すると、HOME の下を読む前提のテスト (config dir の検出など) は自分で HOME を作っているはずなので、それらとの整合を確かめる
- 本番の daemon でも、transcript が分からない hello のたびに全 config dir の projects/ を探す形になっている。hooks module は request のたびに hello するので、探索の頻度とコストを測る (v0.250.0 から、hello が 500ms 以上かかると daemon.log に内訳の warn が出る)

### 関連

- docs/findings/2026-11-11-macos-autofs-home-slows-bun-child.md (偽 HOME の件)
- docs/issue/2026-10-18-send-message-served-dir-test-flaky-macos-ci.md (この調査の途中で見つけた。macOS の CI の遅さの原因ではなかった)

## 受け入れ条件

- [ ] テストが起こす daemon の HOME が実在する一時ディレクトリに固定され、実際の HOME を読まない
- [ ] HOME の下を読む前提の既存テストとの整合が確認されている
- [ ] 本番 daemon の transcript 探索の頻度とコストが測られ、対応方針が決まっている
