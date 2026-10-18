---
title: テストの一時ディレクトリが pass した run でも OS の temp dir に残る
status: open
category: bug
created: 2026-10-18T15:08:04+09:00
last_read:
open_entered: 2026-10-18T15:08:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
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

- [ ] 全 pass の `just test` の前後で $TMPDIR 直下の ccmsg-* が増えない
- [ ] 検査を足すかは設計判断 (UDS の sun_path 長の制約で TMPDIR を run 単位の dir に向ける案は path 長に注意)
