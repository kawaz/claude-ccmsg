---
title: cli-agents-test-timeout-macos-ci
status: open
category: bug
created: 2026-11-11T21:09:11+09:00
last_read:
open_entered: 2026-11-11T21:09:11+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 旧統括セッションが Release v0.245.0 の CI を見ていて気づいた (2026-11-11)
---

# cli-agents-test-timeout-macos-ci

## 概要

GitHub Actions の macos-latest で packages/cli/test/agents.test.ts の describe「ccmsg agents (daemon の偽応答に対する出力)」が 5 秒の期限で落ち続けている。

## 観測 (2026-11-11、gh run view <id> --log-failed で確認)

- 今日の Release の run 7 本のうち 6 本で ci (macos-latest) が失敗: v0.238.0 (42929018929)、v0.239.0 (42946815013)、v0.240.0 (42949159878)、v0.241.0 (43001477600)、v0.242.0 (43004940625)、v0.244.0 (43007687296)。v0.243.0 (43005953926) だけ全ジョブ成功。ci (ubuntu-latest) と hooks-bundle は 7 本とも成功
- 落ちるのは毎回この describe の中の 3〜4 件: 「既定は daemon の応答をそのまま 1 行の JSON で出し、セッションの中からでも user role で hello する」「--format text は表を出す (オプションはコマンドの前にも後ろにも置ける)」「daemon が断ったら、その応答を stderr に出して exit 1 (表を頼んでいても)」「--format が json / text 以外、または余計な引数は、daemon に繋がず usage を出して exit 1」
- どれも「this test timed out after 5000ms」(所要 5002〜5080ms) で、子プロセスの終了コードが期待の 0 / 1 に対して 143 (SIGTERM)
- 4 つ目のテストは daemon に繋がない (usage を出して終わるだけ) のに同じく期限で落ちている
- 手元の macOS の just test では同じ日に通っている

## 分かっていないこと

- なぜ macOS の CI でだけ、この describe の子プロセスが 5 秒以内に終わらないのか
- いつの版から落ち始めたか (今日より前の run は見ていない)
- 期限が 5000ms なのは docs/issue/2026-11-02-bun-preload-default-timeout-first-file-only.md (preload の 15 秒が最初のファイルにしか効かない) と同じ現象に見えるが、期限を延ばせば通るのかは確かめていない

## 切り分けに要る観測

- 落ち始めた run と、その commit の差分 (gh run list を遡る)
- CI の log で、この describe の直前・最初のテストの所要時間と、通った v0.243.0 の run での同じテストの所要時間
- agents.test.ts が子プロセスをどう起こしているか (同じ起こし方をするほかの CLI のテストは CI で何 ms か)

## 関連

- docs/issue/2026-10-18-send-message-served-dir-test-flaky-macos-ci.md (別のテスト)
- docs/QUESTIONS.md の HP-Q3 (テストの期限をどちらに揃えるか) の判断材料になる

## 受け入れ条件

- [ ] macos-latest の CI で当該 describe が安定して通る (真因を特定した上で)
