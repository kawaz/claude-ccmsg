---
title: bun test を 2 プロセス同時に走らせると agents / send-message / op-http のテストが落ちる
status: resolved
category: bug
created: 2026-11-05T14:50:52+09:00
last_read:
open_entered: 2026-11-05T14:50:52+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-11T22:05:54+09:00
discard_reason:
pending_reason:
close_reason: ["finding/2026-11-11-tests-fail-when-bun-parent-exits","implemented"]
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

`cd <作業コピー> && (bun test > bg.log 2>&1 &) && bun test packages/daemon/test/launch-tool.test.ts` の形。並走側の出力 (全文):

<details>
<summary>bun test の出力 (fail 5 件)</summary>

```
bun test v1.4.2 (744846f84)

packages/daemon/test/agents.test.ts:
207 |     const ctx = await startAgentsTestDaemon(home, binDir);
208 |     const u = await userConn(ctx);
209 |     await u.request({ op: "subscribe" });
210 |     const { ev } = await u.readEventUntil("agents");
211 |     const agents = ev.agents;
212 |     expect(agents.map((a) => a.sessionId).sort()).toEqual(["sA", "sB"]);
                                                        ^
error: expect(received).toEqual(expected)

@@ -2,3 +2,2 @@
    "sA",
-   "sB",
  ]

- Expected  - 1
+ Received  + 0

      at <anonymous> (packages/daemon/test/agents.test.ts:212:51)
(fail) agents: config dir detection > $HOME/.claude* のうちディレクトリのみ読み、regular file の ~/.claude は除外される [100.22ms]
killed 1 dangling process

packages/daemon/test/send-message.test.ts:
(fail) send_message through the daemon > a session id reaches every run of the session; a pid the one [15026.30ms]
  ^ this test timed out after 15000ms.
317 |       const ha = harness(SENDER, { pid: LIVE_PID, cwd: work });
318 |       const hb = harness(PEER, { pid: OTHER_LIVE_PID, cwd: work });
319 |       await withModule(ctx, PEER, hb.configDir);
320 |       const a = await sessionWithConfig(ctx, SENDER, ha.configDir);
321 | 
322 |       expect(await send(a, { cwd: `${link}/` }, "hello dir")).toEqual([
                                                                    ^
error: expect(received).toEqual(expected)

@@ -3,4 +3,5 @@
      "cwd": "/private/tmp/ccmsg-run-iZGCn7/ps-work-LigA0K",
-     "outcome": "delivered",
-     "sid": "bbbbbbbb-2222-4333-8444-555555555555",
+     "outcome": "not_delivered",
+     "reason": "self",
+     "sid": "aaaaaaaa-2222-4333-8444-555555555555",
    },

- Expected  - 2
+ Received  + 3

      at <anonymous> (packages/daemon/test/send-message.test.ts:322:63)
(fail) send_message through the daemon > a directory reaches the other sessions working there, through a symlink too [225.85ms]
393 |       const b1 = harness(PEER, { pid: LIVE_PID });
394 |       const b2 = harness(PEER, { pid: OTHER_LIVE_PID, configDir: b1.configDir });
395 |       await withModule(ctx, PEER, b1.configDir);
396 |       b1.refuseWith = "denied";
397 |       const a = await sessionWithConfig(ctx, SENDER, b1.configDir);
398 |       expect(await send(a, { session_id: PEER }, "hi")).toEqual([
                                                              ^
error: expect(received).toEqual(expected)

@@ -2,3 +2,4 @@
    {
-     "outcome": "delivered",
+     "outcome": "not_delivered",
+     "reason": "refused",
      "sid": "bbbbbbbb-2222-4333-8444-555555555555",

- Expected  - 1
+ Received  + 2

      at <anonymous> (packages/daemon/test/send-message.test.ts:398:57)
(fail) send_message through the daemon > a run refusing while another takes it is delivered; every run refusing is refused [229.79ms]

packages/daemon/test/op-http.test.ts:
441 |         return res.text();
442 |       };
443 |       const results = async (request: object) =>
444 |         servedReply("send_message", await ask({ op: "send_message", ...request })).results;
445 |       const text = "line 1\n`not run` $HOME 'quoted' \"double\"\n";
446 |       expect(await results({ to: { cwd: work }, text })).toEqual([
                                                               ^
error: expect(received).toEqual(expected)

@@ -7,8 +7,2 @@
    },
-   {
-     "cwd": "/private/tmp/ccmsg-run-iZGCn7/ccmsg-op-http-work-QVAmpg",
-     "outcome": "not_delivered",
-     "reason": "no_module",
-     "sid": "33333333-2222-4333-8444-555555555555",
-   },
  ]

- Expected  - 6
+ Received  + 0

      at <anonymous> (packages/daemon/test/op-http.test.ts:446:58)
(fail) send_message and peer_list over POST /op > sends to the sessions `to` names, as the asking process's session, and lists them [494.31ms]

 4608 pass
 4 skip
 5 fail
 10751 expect() calls
Ran 4617 tests across 230 files. [99.50s]
```

</details>

## 関連

- findings `2026-11-02-launch-tool-test-first-run-timeout.md` (この負荷試験の主目的)
- issue `2026-11-02-bun-preload-default-timeout-first-file-only`

## 影響

push gate の `just test` は 1 プロセスなので通常は当たらない。複数の作業コピーで同時に `just push` / `just test` を回すと当たりうる (worker 並走の運用で起きる)。

## 受け入れ条件

- [ ] 取り合っているものを特定する
- [ ] 2 プロセス並走でも 5 件が落ちない
