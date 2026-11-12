---
title: テストのプロセスの中で動かす daemon が、開発者の shell の CCMSG_* を継ぎうる
status: open
category: bug
created: 2026-11-12T22:47:03+09:00
last_read:
open_entered: 2026-11-12T22:47:03+09:00
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

# テストのプロセスの中で動かす daemon が、開発者の shell の CCMSG_* を継ぎうる

## 概要

分かっていること (2026-11-12、コードを読んだだけで、実際に値が入る場面は未調査):

- テストのプロセスの中で動かす daemon (packages/daemon/test/helpers.ts の startInProcessDaemon、stubDaemon) に渡す環境 (DaemonHost.env) は、テストのプロセスの環境をそのまま継ぐ
- 別プロセスで起こす daemon は helper が CCMSG_STATE_DIR / CCMSG_CONFIG_DIR / CCMSG_DATA_DIR / CCMSG_HTTP_BIND / CCMSG_NETWORK_WATCH / CCMSG_AGENTS_POLL を固定値で上書きし、HOME と CLAUDE_CONFIG_DIR もテスト用に固定する (testHomeEnv)
- CCMSG_CLAUDE_CONFIG_DIRS はテスト共通の初期化 (packages/testkit/src/test-env.ts) がプロセスの環境から消す (v0.263.0)
- それ以外の CCMSG_* のうち、DaemonHost.env からしか読まれないものがあれば、開発者の shell の値がテストの daemon に入る
- 加えて daemon の src には、渡された環境 (daemon.env) でなくプロセスの環境変数を直接読む所が 20 か所ほど残っている
  - packages/daemon/src/server.ts の CCMSG_HTTP_BIND / CCMSG_HTTP_ALLOW / CCMSG_HTTP_ALLOW_ORIGIN / CCMSG_NETWORK_WATCH* / CCMSG_TAILSCALE_BIN
  - agents.ts の CCMSG_AGENTS_POLL_MS / CCMSG_AGENTS_POLL
  - attachment.ts の CCMSG_ATTACHMENT_MAX_BYTES
  - tailscale-origin.ts の CCMSG_TAILSCALE_STATUS_TIMEOUT_MS
  - config.ts の PATH
  - これらはテストのプロセスの中の daemon でも、開発者の値がそのまま効く

先例: CCMSG_CLAUDE_CONFIG_DIRS を設定した環境では、直す前はテストが 21 本落ちた (docs/issue/archive/2026-11-11-test-daemons-read-real-home.md)。

分かっていないこと: 実際に開発者の値でテストの結果が変わる CCMSG_* がどれか。

調べ方: daemon が読む CCMSG_* を全部挙げ、1 つずつ「テストを起こす側の環境に変な値を入れて全テストを走らせる」と落ちるかを見る。

## 背景

決めること:

- (a) テスト共通の初期化で、テストが使わない CCMSG_* をまとめてプロセスの環境から消す (名前の一覧を持つか、CCMSG_ で始まるものを全部消してからテスト用の値を入れるか)
- (b) daemon の src の process.env の直接参照を daemon.env に寄せる (HOME を DaemonHost.home に寄せたのと同じ整理。範囲が広い)

関連: docs/TESTING.md の「決定性」

## 受け入れ条件

- [ ] 開発者の shell にどの CCMSG_* があっても、全テストの結果が変わらないことを、変数を入れた環境での全テストの実行で示す
