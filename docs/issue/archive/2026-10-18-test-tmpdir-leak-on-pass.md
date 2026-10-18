---
title: テストの一時ディレクトリが pass した run でも OS の temp dir に残る
status: resolved
category: bug
created: 2026-10-18T15:08:04+09:00
last_read: 2026-10-18T15:09:42+09:00
open_entered: 2026-10-18T15:08:04+09:00
wip_entered: 2026-10-18T15:24:48+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T15:25:12+09:00
discard_reason:
pending_reason:
close_reason: ["implemented"]
blocked_by:
origin: test-daemon-leak-subscribe-duplicate の調査中に観測
---

# テストの一時ディレクトリが pass した run でも OS の temp dir に残る

## 概要

テストの一時ディレクトリが、全 pass の run でも片付かず OS の temp dir に残る。docs/TESTING.md の「一時ディレクトリは mkdtemp で作り、テストの後で消す」に反している。

2026-10-18 に macOS の $TMPDIR 直下の `ccmsg-*` を数えたら 8792 個あった。接頭辞別:

| 接頭辞 | 個数 | 作るテスト |
|---|---|---|
| ccmsg-fsfind | 5700 | packages/daemon/test/fs-find.test.ts |
| ccmsg-origins | 1332 | packages/daemon/test/origins-file.test.ts |
| ccmsg-migrate | 996 | packages/protocol/test/config-migration.test.ts |
| ccmsg-migrate-same | 249 | 同上 |
| ccmsg-fsroot | 230 | packages/daemon/test/fs-access.test.ts |
| ccmsg-launcher-root | 224 | packages/daemon/test/session-launcher-integration.test.ts |
| ccmsg-t | 41 | timeout や setup 失敗で finally が走らなかった回 |
| ccmsg-wh | 9 | 同上 |

ccmsg-fsfind-* は全 test が pass した `just test` (2026-10-18 15:00) の時刻のものが新たに出来ていた。失敗時でなく通常の run で片付けていない。

## 背景

ccmsg-t / ccmsg-wh は timeout や setup の失敗で finally が走らなかった回のもの。daemon の残留は issue test-daemon-leak-subscribe-duplicate で lifeline により解消したが、一時 dir は対象外。

調べること: 各テストの後始末の有無、timeout 時 (finally が走らない) の扱い。

## 受け入れ条件

- [x] 全 pass の `just test` の前後で $TMPDIR 直下の ccmsg-* が増えない
- [x] 検査を足すかは設計判断 (UDS の sun_path 長の制約で TMPDIR を run 単位の dir に向ける案は path 長に注意)

## 結果

### 真因 (TMPDIR を run 専用の dir に向けて全テストを流し、残ったものを数えた)

pass した run 1 回で 55 個残り、いずれも作ったテストが消していなかった: fs-find x25 (fixtureDir を 1 つも消さない)、agent-transcripts (cfg x10・outside)、origins-file x6、workflow-drilldown x4、config-migration x5、fs-access 2 か所 (session_not_found の fsroot と、tmpdir 直下に固定名で作る sibling)、session-launcher-integration 1 か所、attachment (daemon が TMPDIR/claude-ccmsg-<uid>/attachment に書く。DR-0015 section 2.1 で daemon は消さない)。timeout・失敗の時は、UNIX socket の sun_path のために /tmp を直に書く ccmsg-si / ccmsg-sc / pi も残る。

### 直し方

- preload (packages/testkit/src/test-env.ts) が /tmp/ccmsg-run-XXXXXX を作り、TMPDIR をそこに向ける。テストと、テストが起こすプロセス (CLI・daemon・スクリプト) の os.tmpdir() は全部そこに入り、afterAll で丸ごと消える。afterAll は timeout・失敗の後でも走る (bun test は exit を発火しないので afterAll に置いた)。lifeline の socket もこの dir に置いた
- run dir を /tmp に置くのは、macOS の $TMPDIR (49 文字) の下だと daemon の socket パスが sun_path の 104 に近づくため (packages/testkit/src/tmp.ts の Design rationale)
- /tmp を直に書いていた 6 か所は shortTmpDir で作り、run の終わりに検査して消す
- 最後のテストの後に run dir か shortTmpDir に残っているものは、消さなかったテストのものとして run を落とし、パスを並べる
- 残していたテストは afterEach で消す perTestTmpDir (testkit) で作るか、finally で消すように直した。fs-access の固定名 sibling は fixture の中に移した。attachment は file の afterAll で run の TMPDIR 下の per-uid dir を消す
- 規約は docs/TESTING.md の決定性の節

### 受け入れ条件の確認

- just test と just coverage がどちらも 4049 pass / 0 fail。前後で $TMPDIR 直下と /tmp に新しく出来たものは 0 (ファイル名で比較)
- packages/testkit/test/run-tmp.test.ts: os.tmpdir() が run の dir を指すこと、timeout したテストが残した一時 dir と short dir が入れ子の run で消され、その run が exit 1 で両方のパスを並べて落ちること。TMPDIR の向け替え・run dir の削除・検査をそれぞれ外すと落ちることを確かめた
- 検査は足した (上記)。bun test 自体が SIGKILL された時はその回の run dir が 1 つ残る。これは許容し、古い run dir の掃除は入れない (統括判断)
