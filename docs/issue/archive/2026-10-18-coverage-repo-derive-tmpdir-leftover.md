---
title: 全体の coverage 実行で repo-derive.test.ts の一時 dir が 1 回だけ残り run が落ちた (原因未特定)
status: resolved
category: bug
created: 2026-10-18T16:15:06+09:00
last_read:
open_entered: 2026-10-18T16:15:06+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T16:31:36+09:00
discard_reason:
pending_reason:
close_reason: ["done:再現しないまま閉じる。観測の口として run 終了時の検査が残った dir の中身を出すようにした (packages/testkit/src/tmp.ts contentsOf、run-tmp.test.ts で固定)。再発すれば失敗メッセージの中身を根拠に新規起票","done:有力候補の抑止として repo-derive.test.ts の git に maintenance.auto=false と gc.auto=0 を渡した (5 回の commit で maintenance 起動 0 回)"]
blocked_by:
origin: issue-batch-3 (worker、2026-10-18)
---

# 全体の coverage 実行で repo-derive.test.ts の一時 dir が 1 回だけ残り run が落ちた (原因未特定)

## 概要

全体の coverage 実行で repo-derive.test.ts の一時 dir が 1 回だけ残り、run が落ちた。原因は未特定。

## 観測

- 2026-10-18 の `just coverage` 1 回目で、run 終了時の検査 (packages/testkit/src/test-env.ts の afterAll) が `/tmp/ccmsg-run-<x>/ccmsg-repo-derive-<y>` を「テストが消さなかった一時ファイル」として挙げて run が落ちた (4067 pass / 1 fail、fail はこの検査だけ)。同じ作業コピーで直後の `just coverage` 2 回、`just test` 1 回では起きず、`bun test --coverage packages/daemon/test/repo-derive.test.ts` 単体 15 回でも起きなかった。
- この prefix を作るのは packages/daemon/test/repo-derive.test.ts の top-level beforeEach (`fs.realpathSync(fs.mkdtempSync(...))` を `let dir` に入れる) だけで、top-level afterEach が `fs.rmSync(dir, { recursive: true, force: true })` で消す。

## コードと実験で否定できたこと

- beforeEach と afterEach が対にならない経路: bun 1.4.2 で、通過・throw・timeout・skip・todo のいずれでも top-level の beforeEach / afterEach は対で走った (BABABABA)。
- afterEach の rmSync が失敗した: bun は afterEach の例外をそのテストの fail として出すが、その run の fail は検査の 1 件だけだった。
- 並列実行: bunfig / justfile に --concurrent / --parallel は無く、ファイルは順に走る。
- daemon が cwd の下に dir を作る: daemon/src の mkdir は attachment / config / session-dump / fs-access (書き込み op) / state dir / translate-helper だけで、hello の cwd の下には作らない。

## 残る候補 (未検証)

- いったん消えた dir を、後から誰かが mkdir -p で作り直した。候補は makeGitRepo の `git commit` が起こす `git maintenance run --auto --quiet --detach` (GIT_TRACE で git 2.55.0 が起動していることを確認済み)。detach した子が .git の下に書くと、先頭のディレクトリ (git の safe_create_leading_directories) ごと作り直しうる。新しい repo では閾値に届かず何もしないはずで、30 回試して子は残らず dir も戻らなかった。
- hello テストの in-process daemon が stopInProcessDaemon の後に残した非同期の処理。

## 次に要る観測

- run 終了時の検査が残っていた dir の中身 (ファイルの一覧) も出すようにする。中身が `.git/objects/...` だけなら git の書き込みと決まる。
- makeGitRepo の git の env に `GIT_CONFIG_PARAMETERS` などで `maintenance.auto=false` を渡し、背景の maintenance を起こさないようにするかを検討する (原因が確かめられてから)。

## 受け入れ条件

- [x] 残った dir の中身を検査が出すようになり、原因が特定される
- [x] 原因に対する修正が入る (または再現しないまま観測だけ残して閉じる判断が記録される)
