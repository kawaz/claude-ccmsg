---
title: served dir への send_message のテストが macOS CI で確率的に no_peer_socket になる
status: open
category: bug
created: 2026-10-18T20:13:45+09:00
last_read:
open_entered: 2026-10-18T20:13:45+09:00
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

# served dir への send_message のテストが macOS CI で確率的に no_peer_socket になる

## 現象

packages/daemon/test/send-message.test.ts の `send_message through the daemon > a session in a dir another session announced is not reached; one in a dir CCMSG_CLAUDE_CONFIG_DIRS names is` が、GitHub Actions の macos-latest (Test with coverage step) で 1 回落ちた (run 39121226827、Release v0.188.0)。後半の CCMSG_CLAUDE_CONFIG_DIRS で dir を受け持つ daemon への send が、期待の `delivered` でなく `not_delivered / no_peer_socket` を返した。同じ run の ubuntu-latest は pass (512ms)、macOS の failed job を rerun すると pass。ローカル (macOS) では、CPU 負荷下の単体 ×8、coverage 付きのファイル全体 ×6 (agents テストと並走)、packages/daemon 全体を負荷下で、HOME 空・CLAUDE_CONFIG_DIR unset ×3 のいずれでも再現しない。

## 観測した数字

- 失敗時の所要 1416ms (macOS)。同じファイルの他のテストの macOS/ubuntu 比は 1.2〜2.0 倍。ubuntu の成功 (拒否待ち 250ms を含む) から見込む macOS の即失敗の所要は 700ms 前後で、約 0.7〜1 秒が余分
- 前半の隔離 daemon の assert (`ended`、frames 空) は通っている
- 送り先の run は同じ dir を読む liveRuns (session-runs.ts) が見つけている (見つからなければ reason は `ended`)。外れたのは直後に同じ dir を読む PeerInjector の `#target` / `#token`
- ローカルの実測で served daemon の `#rows` は readdir 0.05ms・全体 0.2〜0.5ms、liveRuns は 1ms 前後

## 仮説 (いずれも未検証)

1. INJECT_SCAN_MS (1 秒) の期限に対して、macOS CI の runner で daemon の fs 読み込みが 1 秒以上止まった (所要の余分 約 1 秒と矛盾しない)。止まる要因はコードからは見つかっていない
2. `#rows` の readdir と state file の書き込みの競合。ただし fake harness (test/peer-harness.ts) は state file と key を writeFileSync で daemon の起動前に書き終えており、送る時点で書き手は居ないので可能性は低い
3. 受け手の fake harness の key ファイル書き込みの遅れ。同じく daemon の起動前に同期で書いているので可能性は低い

## 入れた観測 (commit wlkpozmy)

PeerInjector の no_peer_socket に `lookup` (scan_timed_out / no_state_file / no_socket / no_key) を足し、daemon.log の `peer-inject … (send_message): unavailable (no_peer_socket: <lookup>)` に出る。このテストは配送できなかった時に served daemon の daemon.log を stderr に出す。

## 次に要る観測

- 次に macOS CI で落ちた時の daemon.log の `<lookup>`。scan_timed_out なら daemon 側の読み込みの停止 (仮説 1) を追う (その時刻の runner の負荷、同じ daemon の他の log 行の時刻差)。それ以外ならどのファイルが見えていないかから仮説 2・3 を検証する
- 落ちた時は test 名・run id・lookup をこの issue に足す

## 受け入れ条件

- [ ] 失敗時の lookup を得て真因を特定する
- [ ] 真因を直す (期限の延長・テストの緩和・skip はしない)

## 追記: 同型の失敗と機構 (2026-10-21)

- Release v0.192.0 の CI (run 39452714527、macos-latest のみ) で `send_message through the daemon > a run refusing while another takes it is delivered; every run refusing is refused` が `refused` でなく `ended` で落ちた (1503ms、ubuntu 765ms)。この daemon は agents の poll を止めているので、外れたのは liveRuns の読み込み (RUNS_SCAN_MS 1 秒の期限)。no_peer_socket の件と同じく「同じ dir を読む期限付きの読み込みが外れる」形
- 機構 (ローカルで再現): 期限付きの読み込みを始めた直後に process が期限を越えて動けないと (busy で 1.5 秒止める)、再開時に timer と読み終わりが揃い、timer が先に見られて「期限切れ」になる (Bun 1.4.2 で 5 回中 5 回。setImmediate で決定を遅らせても 5 回中 3 回は期限切れ)
- 対策 (commit xvrrrptp): 期限を process が動いていた時間で数える `withinBudget` (packages/daemon/src/time-budget.ts) を liveRuns と PeerInjector の走査に使う。timer が予定より 50ms 以上遅れて鳴ったら遅れの分だけ延ばす。本当に終わらない読み込みは予定どおり期限切れになる
- 未検証: CI の runner でこの daemon が実際に 1 秒以上動けなかったかは観測していない (所要時間の超過が約 0.6〜0.75 秒で、期限切れの経路と矛盾しないことだけが根拠)
- 同じ run の `agents.test.ts` の「読めない config dir のセッションは消さない」の失敗は別の原因で、テストの fixture が state file を消してから書く順だったため、その間の round が dir を読み切って session を外していた (消すと書くの間に 400ms 挟むと 3 回中 3 回再現、順を逆にして 5 回中 5 回 pass)。同じ commit で直した

## 次に要る観測

次に macOS CI でこの種の失敗が出たら daemon.log の lookup (scan_timed_out か否か) を見る。対策後も scan_timed_out が出るなら process の停止以外の要因を追う。
