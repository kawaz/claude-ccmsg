---
title: bun test を 2 プロセス同時に走らせると agents / send-message / op-http のテストが落ちる
status: open
category: bug
created: 2026-11-05T14:50:52+09:00
last_read:
open_entered: 2026-11-05T14:50:52+09:00
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

# bun test を 2 プロセス同時に走らせると agents / send-message / op-http のテストが落ちる

## 概要

bun test を 2 プロセス同時に走らせると agents / send-message / op-http のテストが落ちる。何かを取り合っているが未調査。

## 観測

worker launch-tool-flaky の報告 (2026-11-02、統括は未再現)。全体の `bun test` を別プロセスで並走させながら `bun test packages/daemon/test/launch-tool.test.ts` を走らせた負荷試験で、並走させた側の全体 bun test (4617 tests, 99.5s) が 5 fail。単独 (3 ファイルを並走なしで 2 回) は 58 pass / 0 fail。

落ちたテストとエラー文 (load-bg.log より):

1. agents.test.ts「$HOME/.claude* のうちディレクトリのみ読み、regular file の ~/.claude は除外される」: `agents` イベントの sessionId が ["sA"] のみで "sB" が欠ける。
2. send-message.test.ts「a session id reaches every run of the session; a pid the one」: 15000ms timeout。
3. send-message.test.ts「a directory reaches the other sessions working there, through a symlink too」: cwd 宛の送信で期待 `{outcome: delivered, sid: bbbb…}` が `{outcome: not_delivered, reason: self, sid: aaaa…}` になる (宛先が peer でなく送り主自身に解決される)。
4. send-message.test.ts「a run refusing while another takes it is delivered; every run refusing is refused」: 期待 delivered が `not_delivered / refused` (2 run のうち受ける側の run が見えていない)。
5. op-http.test.ts「sends to the sessions `to` names, as the asking process's session, and lists them」: cwd 宛の結果に `33333333-… / no_module` の 1 件が欠ける。

共通点: どれも「同じ cwd / session の複数 run・複数セッションのうち 1 つが daemon から見えない」形。送信・ピア一覧の相手の同定に関わるテストに集中している。pid の同定 (テストは `process.pid` / `process.ppid` を LIVE_PID / OTHER_LIVE_PID に使う) か、プロセス横断の何か (ps の走査、固定パス) を疑うが未調査。TMPDIR は run ごと (`/tmp/ccmsg-run-XXXXXX`)、socket の短縮 dir も mkdtemp なので、パス共有ではなさそう。

## 再現 (未確認)

`cd <作業コピー> && (bun test > bg.log 2>&1 &) && bun test packages/daemon/test/launch-tool.test.ts` の形。並走側の出力は一時ベース `tmp.zVmvisKNMo/tmp.8woJsoTPw7/load-bg.log`。一時ベースは relay-fix の完了後に消す予定なので、調査するなら先にログを findings に写す。

## 関連

- findings `2026-11-02-launch-tool-test-first-run-timeout.md` (この負荷試験の主目的)
- issue `2026-11-02-bun-preload-default-timeout-first-file-only`

## 影響

push gate の `just test` は 1 プロセスなので通常は当たらない。複数の作業コピーで同時に `just push` / `just test` を回すと当たりうる (worker 並走の運用で起きる)。

## 受け入れ条件

- [ ] 取り合っているものを特定する
- [ ] 2 プロセス並走でも 5 件が落ちない
