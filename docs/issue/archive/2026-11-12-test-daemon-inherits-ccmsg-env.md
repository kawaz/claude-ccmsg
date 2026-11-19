---
title: テストのプロセスの中で動かす daemon が、開発者の shell の CCMSG_* を継ぎうる
status: resolved
category: bug
created: 2026-11-12T22:47:03+09:00
origin: 自リポ TODO
close_reason: implemented
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

- [x] 開発者の shell にどの CCMSG_* があっても、全テストの結果が変わらないことを、変数を入れた環境での全テストの実行で示す

## 解決

- 観測 (直す前): src とテストが読む CCMSG_* 28 個 (daemon・CLI・scripts が読むもの全部) を変な値で入れた環境で全テストを走らせると、67 本落ち、テストの間の未処理のエラーが 4 件出た。落ちたのは CLI の end-to-end (CCMSG_DAEMON_ENTRY・CCMSG_VERSION_OVERRIDE・CCMSG_TRANSCRIPT_PATH 等を CLI と CLI が起こす daemon が継いだ)、HTTP・WS・添付・webhook・sandbox (CCMSG_HTTP_ALLOW を別プロセスの daemon が継いで 403)、resolveStatusTimeoutMs の単体テスト (プロセスの環境を直に読んでいた)。入れない環境では全部通る
- テスト側: テスト共通の初期化 (packages/testkit/src/test-env.ts) が、CCMSG_ で始まるものを全部プロセスの環境から消し、テストの値 (CCMSG_AGENTS_POLL=off、CCMSG_TEST_LIFELINE) だけを入れる。名前の一覧を持たないので、src が読む変数が増えても漏れない。テストの daemon (別プロセスの spawnDaemonProc、プロセスの中の startInProcessDaemon、stubDaemon) の環境は、プロセスの環境を継がず testProcessEnv (PATH・TMPDIR・CCMSG_TEST_LIFELINE だけ) にテストの値を足して組む
- daemon の src: 設定をプロセスの環境変数から直に読む所をなくし、渡された環境 (DaemonHost.env) から読む形にした (agents poll の on/off と周期、添付の上限、tailscale の timeout、HTTP の bind / allow / allow origin、network watch、lifeline、fs probe、tailscale の bin、config のコマンドを探す PATH)。プロセスの環境を渡すのは本番の組み立ての startDaemon だけで、そこでは今まで通りプロセスの環境が渡る
- 観測 (直した後): 同じ 28 個を入れた環境と入れない環境で、どちらも 5589 pass / 4 skip / 0 fail / 13996 expect()。変な値の state / config / data dir 等に向けた dir には何も書かれなかった
- daemon の外 (CLI・hooks・webui・scripts) は、プロセスの環境を入力として読むのが仕様の CLI で、テストではテスト共通の初期化の消去で塞がる。webui と hooks の src は環境変数を読まない
- 決まりの正本は docs/TESTING.md の「決定性」
