---
title: sidecar.test.ts の pipe 経路から孤児の sidecar が漏れ、run の後も動き続ける
status: open
category: bug
created: 2026-10-18T16:16:06+09:00
last_read:
open_entered: 2026-10-18T16:16:06+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: issue-batch-3 (worker、2026-10-18)
---

# sidecar.test.ts の pipe 経路から孤児の sidecar が漏れ、run の後も動き続ける

## 観測

- 2026-10-18、親 pid 1 の `bun packages/cli/src/index.ts sidecar --sid 11111111-2222-4333-8444-555555555555 --run mgq1k2x3abcd1234` が約 4 日動き続けていた (SIGTERM で止めた)。sid と run は packages/cli/test/sidecar.test.ts の定数。fd 1 は PIPE、fd 2 は相手の閉じた unix socket だった。
- 該当しそうなのは「leaves once a write to stdout fails」で、`bash -c '... sidecar ... | true'` で起こし、stdout の読み手が消えた後の書き込みの失敗で去ることを見る。書き込みに至る前にテストが中断する (timeout 等) と、sidecar は daemon への名乗りを 5 秒ごとに試み続けるだけで何も書かず、去る契機が無い。
- sidecar の EOF 検知 (stdout の socket の終わりで harness の死を知る) は stdout が socket の時だけ効く。pipe の書き込み端は読めないので、この経路には効かない。
- test-env.ts の run 終了時の検査は lifeline に繋いだ daemon と run の一時 dir だけを見るので、漏れた sidecar は検出されない。

## 対応候補 (裏取りしてから採否を決める)

- daemon の lifeline (packages/testkit/src/lifeline.ts、CCMSG_TEST_LIFELINE) と同じ考え方を sidecar にも当てる: テストが起こした sidecar も lifeline に繋ぎ、切れたら去る。run の終わりにまだ繋がっていれば、止めなかったテストとして run を落とす
- テスト側で起こした sidecar の pid を記録し、afterAll で止める (sidecar.test.ts の「process reading its output is gone」のテストはこの形で後始末している)
