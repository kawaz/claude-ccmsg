---
title: テスト群の第三者レビュー指摘 (test-suite-review-fresh-eyes) を直す
status: open
category: bug
created: 2026-10-14T14:18:27+09:00
last_read: 2026-10-18T13:08:11+09:00
open_entered: 2026-10-14T14:18:27+09:00
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

# テスト群の第三者レビュー指摘 (test-suite-review-fresh-eyes) を直す

## 概要

`docs/findings/2026-10-14-test-suite-review-fresh-eyes.md` の指摘を直す。規約は `docs/TESTING.md`。

### high

1. webui の component / hook の配線が 0 カバレッジ。happy-dom (GlobalRegistrator を bunfig の preload) で preact の render をマウントする基盤を `webui/test` に 1 本置く。最初の対象は SessionInputComposer (storage event → 入力欄) と Timeline の effect (issue `webui-timeline-decomposition-and-hook-tests` と連動)
2. (済 d3b34fa329eb。残: `cli/test/sidecar.test.ts:108` の `Bun.sleep(1)` は「バイトを別々の write で届ける」ための間隔で観測待ちではないが、coalesce で vacuous pass し得る。sidecar 側に読み取りの区切りを観測する口が無いため未対応) `broadcast.test.ts:577-601, 635-651` の「起きないこと」を `Bun.sleep` で主張する negative テストを、marker の round-trip で順序づける形にする
3. (済 385c4f956ae0) `webui/test/ws.test.ts:182, 537, 1034` の実時間待ち。ws.ts に clock を注入 (hooks の `Engine.clock` と同型) して決定的にする

### medium

4. (済 7578f3cdfff8) `llm-stats-op` / `llm-usage-op` の固定ポート 18941 / 18921 を port 0 にする
5. (済 17257a95fa93) `ws.test.ts` の送信フレームを index で固定している 37 箇所を、op で引く helper にする
6. (済 bd0157df) `session-input.test.ts` の readiness テストを fs.watch から poll 経路に差し替えた件 (v0.166.1 で CI 対策として入れた) は実装の都合で緩めた典型。issue `sidecar-should-not-resolve-its-own-pid` の案 A (bind 時の名乗りを契機) で fs.watch 依存ごと解消し、テストは名乗り経路で書き直す

### 残り (7)〜(12)

commit 07e4ac32 (change wznuytvw) で解消。

7. (済) findings が挙げた integration / broadcast / one-on-one の行は該当ファイルの削除・書き換えで既に無かった。残っていた cli.test.ts の dump --format text の文脈 JSON (正規表現で JSON ブロックを切り出し jsonObjectOf で読む)、testkit の mock-bin.test.ts (JSON.parse してから比較、testkit は protocol に依存させない)、file-tree-favorites.dom.test.ts の保存値 (parseFavorites で読む) を直した。config-migration.test.ts の「ファイルがバイト単位でそのまま移る」比較、raw-view-mode / timeline-rendering の表示文字列 (整形結果そのものが仕様)、transcript-row の往復一致は文字列比較が仕様なので対象外
8. (済) session-input-store.test.ts に「入力欄が保存済みの下書きをすでに映していれば null、下書きが無ければ空、空の入力欄には何もしない」を戻した。sameContent の分岐を外すと落ちることを確認済み
9. (一部済) 実測では子プロセスの daemon 起動は 1 回約 90ms で、findings の 300-400ms 見積もりより小さく、2〜3 分の大半ではなかった (fs-access は 89 起動で 8.2 秒)。server.ts に createDaemon / listenUds / shutdownDaemon を切り出し、テストの helpers.ts に同じプロセスに daemon を立てて UDS で繋ぐ startInProcessDaemon を足し、wire 越しに op を確かめる 13 ファイル (fs-access / fs-find / transcript / session-status / peers-push / session-errors / session-rename / peer-timestamps / branch / session-user-input / session-kill / repo-derive / subscribe-superseded) を移した。just test は 101 秒 → 82 秒。startTestDaemon は環境変数・lock / pid / 再起動・HTTP・agents poll を確かめるファイルに残る (静的に 52 か所)。残りの遅さは起動回数ではなく 1 テスト内の実時間: http-transport の HTTP を有効にした各テストが約 1.8 秒 (原因未特定、tailscale CLI は 0.05 秒で無関係)、reconnect の daemon 停止中 subscribe が 6.3 秒 (#15 の sleep(6000))、translate-helper の watchdog が 6.1 秒、send_message の unconfirmed が 2.3 秒。これらは別 issue で扱う
10. (済) stubDaemon は createDaemon の上に置き、テストは fields を Object.assign で差し替える (daemon のクロージャが差し替えた値を見るため)。Daemon に exit (graceful shutdown 後に起動側を終える) を足し、同じプロセスの daemon では何もしない
11. (済) daemon の helpers.ts に sessionConn / userConn / fixtureDir、cli に run-cli.ts の runCli を置き、各ファイルの写しと connect + hello の書き直し (約 110 か所) を消した。hello の repo / ws を省くこと自体を確かめる repo-derive の helper と、hello の世代・応答を確かめる protocol-version / request-correlation は残した。timeout は bun が bunfig.toml の [test] timeout を読まないこと (bun 1.4.2 で実測) を確かめたうえで、preload (packages/testkit/src/test-env.ts) の setDefaultTimeout(15_000) に揃え、27 ファイルの const T と引数を消した
12. (済) テスト名・コメントの room / メッセージ番号の出典 142 行を外した (データとしての mid は対象外)。外すと過去経緯の記述になる箇所は現在の契約の文に書き直した

## 背景

テスト群の第三者レビューで挙がった指摘。テストを実装の都合で緩めた箇所と、配線が未検証の箇所が中心。

## 受け入れ条件

- [ ] high (1) が解消している
- [x] medium (6) が解消している
- [x] (7)〜(12) が findings に沿って解消している
