# テスト群の第三者レビュー (TDD / 回帰防止 / 一般プラクティス照合)

- Date: 2026-10-14

レビュアーの前提: docs / DR を読まず、テストコードと対応する実装だけを根拠にした。読んだ範囲は `packages/daemon/test/helpers.ts`、`drive-request.ts`、`integration.test.ts`、`session-status.test.ts`、`broadcast.test.ts`、`http-transport.test.ts`、`session-input.test.ts`、`packages/webui/test/helpers.ts`、`ws.test.ts`、`store.test.ts`、`transcript-model.test.ts`、`markdown-view.test.ts`、`session-input-store.test.ts`、`use-draggable.test.ts`、`packages/protocol/test/request.test.ts`、`transcript-rows.ts`、`packages/cli/test/cli.test.ts`、`client-correlation.test.ts`、`reconnect.test.ts`、`hooks/composer-fill.test.ts`、`composer-fill.bundle.test.ts`、`packages/testkit/src/*`、`bunfig.toml`、`.oxlintrc.json`、`.github/workflows/ci.yml`。直近 1 週間 (`ab724f30..@`、124 commit) のうちテストを触った 13 commit の stat と、`5bc9f801d90d` / `d062e2fe3b45` / `dc7495a72df0` / `5e4d58088f9f` / `d774df27229c` / `28488b413e34` / `ec9f4518fc57` の diff。実行は daemon を起動しない `bun test packages/webui packages/protocol` のみ (2513 pass / 0 fail / 4.9 秒)。行番号は v0.166.2 時点。

## 判明した事実

- 規模: 182 ファイル、約 67,500 行。daemon 1236 件、webui + protocol 2513 件、残りが cli / hooks / testkit。pure テスト 2513 件は 4.9 秒で終わり、2〜3 分の残りはほぼ全部が子プロセスの daemon 起動 (`startTestDaemon` が 328 回、1 テスト 1 daemon、bun test はファイル直列)。
- daemon / protocol / CLI の wire 契約は強い: `TestClient` が daemon の書いた全行を wire スキーマで読み、スキーマ外のフィールドがある行を受け取ったテストを落とす (`helpers.ts:289-318`)。observed-order の `readEventUntil` で「起きないこと」を順序づけで主張する型がある。`protocol/test/request.test.ts` は全 op のサンプル表を型で強制し、表が全 op を覆うこと自体をテストする。
- hooks module は `Engine` (clock / process / env) を注入して決定的。webui の ws クライアントは同じ設計を取っておらず、実時間 sleep に依存するテストが 3 本ある。
- webui の component (`components/*.tsx` 58 ファイル) のうちテストから import されるのは 7 つ。`Timeline.tsx` (4972 行)、`FileViewer.tsx` (1425)、`SessionList.tsx` (962)、`SessionInputComposer.tsx` (608) と hook 本体 (`useDraggable` / `useFabPopup` / `useStore` / `useNow` / `useCacheRing`) はテスト無し。直近の fix 2 件 (`1153654c9c02`、`dc7495a72df0`) は `SessionInputComposer.tsx` の effect 配線のバグで、付随テストは pure 関数だけ。
- 直近 commit に悪質な「緩め」は無い。意図的に観測対象を変えたものが 2 件 (fs.watch → poll、`storedDraftChange` の null 経路の直接テスト削除)、テスト削除は対応する機能削除と一致 (`findExistingOneOnOne`、`native-messaging.ts`)。
- 総合 7 / 10。

## 実用的な示唆 / ベストプラクティス

最初に直すべき 3 つ (番号は後述の指摘):

1. **webui に DOM テスト基盤 (happy-dom) を足し、`SessionInputComposer` と `Timeline` の effect 配線をマウントして検証する** (#1)。直近のバグが集中する層で、pure 関数テストでは再現できない。
2. **`createWsClient` に clock を注入し、実時間 sleep のテストを決定的にする** (#3)。hooks の `Engine.clock` と同型にすれば設計が揃う。
3. **negative テストを順序づけに統一し (#2)、固定ポートと文字列 JSON assert を消す (#4, #7)**。flaky の芽と並走時の衝突を潰す。

速度は「1 テスト 1 daemon」の直列起動がほぼ全てで、`drive-request.ts` の in-process 部品を UDS listen まで広げれば大半の op テストは子プロセス無しで書ける (#9)。

### テスト規約案 (docs に置く)

1. テスト名は「何を保証するか」を仕様の語彙で書く。出典は DR 番号か `docs/findings/` の path。チャットの room / mid は書かない。
2. 過去の実装・バグの経緯はテストに書かない (commit log / DR に残す)。
3. daemon との通信は `helpers.ts` の `TestClient` を通す。daemon が書いた行は全部 wire スキーマで読み、スキーマ外のフィールドは失敗にする (`readStreamItem`)。
4. 「起きないこと」の主張は sleep でなく順序づけで行う (marker の round-trip の後に `pendingEvents` / ファイルを読む)。
5. 時間に依存するコードは clock を注入し (`Engine.clock` 型)、テストは実時間を待たない。実時間の待ちは「外部プロセスの観測」に限り、deadline 付きの retry にする。
6. ポートは `0` で取り、固定しない。一時ディレクトリは `mkdtemp`。daemon の env は `CCMSG_*` を全部固定し、開発者 shell から継承しない。
7. transcript / room の行は `transcript-rows.ts` のビルダーで作る。JSON を文字列で assert しない (スキーマで読んで比較)。
8. 送信フレームは op で引く。index や件数で固定しない。
9. 1 テスト 1 daemon は統合テストにだけ使う。op の挙動は in-process (`stubDaemon` / in-process listen) で書く。
10. webui の component / hook は DOM 基盤 (happy-dom) でマウントして検証する。pure 関数に切り出すのは補助であって代替ではない。
11. テストファイルも本番と同じ lint (any / 型主張 / 非 null 主張 禁止)。読みは `defined` / `propsOf` / `jsonObjectOf` で。
12. グローバルの差し替えは `stubGlobal` で行い `afterEach` で戻す (bun は全ファイル 1 プロセス)。
13. timeout は `bunfig.toml` で一括指定し、個別指定は理由コメント付きの例外だけ。
14. テストファイルに非 ASCII 制御文字を生で書かない (エスケープで書く)。
15. バグ修正はまず落ちるテストを書いてから直す。再現できる基盤が無い層は、基盤を足すことを fix の一部にする。

## 検証の詳細

### 良い点 (評価の根拠)

- `helpers.ts:289-318` `readStreamItem`: daemon が書いた全行を wire スキーマで読み、`Bun.deepEquals` で「スキーマが読んだ値 = 生の値」を要求する。スキーマ外のフィールドを 1 つ足しただけで、その行を受け取った全テストが落ちる。実装が仕様から外れた行を書いたことを全テストが検出する仕組み。
- `protocol/test/request.test.ts:27-410`: `SAMPLES: { [Op in RequestOp]: OpSamples<Op> }` で全 op のサンプルを型で強制し、`:392` で表が `REQUEST_OPS` を覆うことをテストする。仕様ファースト。
- `protocol/test/transcript-rows.ts`: 実機の行の形を 1 か所で持つビルダー。daemon / webui / cli のテストが共有し、fixture の重複を潰している。
- `hooks/composer-fill.test.ts` の `fakeEngine`: clock / process / env / composer を全部注入して決定的。`composer-fill.ts:75-97` の `Engine` が注入点。
- `5bc9f801d90d`: 「push しない」の negative テストを、登録時の readiness push を読み切ってから測る形に直している。緩めではなく順序の正確化。
- `28488b413e34` / `ec9f4518fc57` のテスト削除 (`one-on-one-room.test.ts` 162 行、`native-messaging.test.ts` 188 行) は、対応する実装 (`findExistingOneOnOne`、`native-messaging.ts`) の削除と一致し、`config-dir.test.ts` が後継を覆う。
- `session-status.test.ts:2605-2626` の event loop ticker: 「同期 scan なら starve する」を in-process で観測する設計で、子プロセスでは成立しないことまでコメントにある。
- `webui/test/ws.test.ts:105-112` / `helpers.ts:stubGlobal`: bun が全ファイル 1 プロセスであることを前提にグローバルを「戻す」。過去の CI 失敗 (`WebSocket is not defined`) を踏まえた正しい後始末。

### high

#### #1 webui の component / hook の配線が 0 カバレッジで、直近のバグはそこで起きている

| 項目 | 結果 |
|---|---|
| 場所 | `packages/webui/src/client/components/` 58 ファイル中、テストが import するのは `CodeBlock` `CopyButton` `FileIcon` `Fold` `RoomReadOnlyNote` `Tabs` と `markdown-view.tsx` の 7 つ |
| テスト無し | `Timeline.tsx` (4972 行)、`FileViewer.tsx` (1425)、`SessionList.tsx` (962)、`SessionInputComposer.tsx` (608)、hook 本体 `useDraggable` / `useFabPopup` / `useStore` / `useNow` / `useCacheRing` |
| 明言 | `test/use-draggable.test.ts:1-3` 「hook 本体は DOM + pointerevent 前提なので切り出したロジックだけ」 |
| 直近の fix | `1153654c9c02` / `dc7495a72df0` は `SessionInputComposer.tsx:140-180` の `useEffect` / `useCallback` 配線 (restoreDraft をどの handler で呼ぶか)。付随テスト diff は `session-input-store.test.ts` の pure 関数 `otherTabDraft` だけ |

何が問題か: 同種のバグは pure 関数テストでは再現も回帰検知もできず、「落ちるテストを書く → 直す」の順になっていない。issue `webui-async-generation-guards-and-effect-bugs` / `webui-hooks-lint-and-rules-of-hooks` もこの層。

直し方: `happy-dom` の `GlobalRegistrator` を `bunfig.toml` の preload に足して preact の `render` でマウントする基盤 (または `@testing-library/preact`) を `webui/test` に 1 本置く。最初の対象は `SessionInputComposer` (storage event → 入力欄の文) と `Timeline` の effect。`markdown-view.test.ts:9-13` の「renderToString の依存はこのリポに無い」は依存追加で解ける制約であって設計上の理由ではない。

#### #2 「起きないこと」を sleep で主張する negative テスト

| 項目 | 結果 |
|---|---|
| 場所 | `packages/daemon/test/broadcast.test.ts:577-601` (restart 3 周の間に `Bun.sleep(50)`)、`:635-651` (`Bun.sleep(30)` / `(10)` / `(50)` の後に member 行数を数える) |
| 対比 | 同ファイル・同 helpers に `readEventUntil("msg", marker)` で順序を確定してから観測する型がある。`helpers.ts:552-561` `pendingEvents` のコメントが原則を書いている |

何が問題か: daemon が遅ければ書き込み前に数えて vacuous pass する。

直し方: marker post の round-trip で「それ以前の書き込みは終わった」を確定してから jsonl を読む。

#### #3 webui の時間依存テストが実時間で、ws クライアントに clock 注入が無い

| 項目 | 結果 |
|---|---|
| 場所 | `packages/webui/test/ws.test.ts:182` (`idleMs:15 / checkMs:5 / timeoutMs:10` を `Bun.sleep(50)` で待つ)、`:537` (300ms、reconnect 250ms を outlive する設計)、`:1034` (50ms) |
| 実装 | `ws.ts:428-485` は `setTimeout` / `Date.now` を直接使う。`RECONNECT_DELAYS_MS` (`:43`) は定数 |
| 対比 | `hooks/composer-fill.ts:75-97` の `Engine.clock { now, after }` は同じ問題を注入で解いている |

何が問題か: macos-latest の CI 負荷で 15ms タイマーが 50ms 内に 2 周しないと落ちる。同じリポ内で設計が揃っていない。

直し方: `createWsClient` に `clock` を注入 (composer-fill と同型) するか、`bun:test` の fake timers に切り替える。

### medium

#### #4 固定ポート

`packages/daemon/test/llm-stats-op.test.ts:11` (`GATEWAY_PORT = 18941`)、`llm-usage-op.test.ts:10` (`18921`)。2 つの worktree で同時に `bun test` (複数セッション並走はこのリポの運用そのもの) すると EADDRINUSE。`http-transport.test.ts:775` は `port: 0` で正しくやっている。`Bun.serve({ port: 0 })` + `gateway.port` に。

#### #5 送信フレームを index で固定 (handshake の手順を固定)

`ws.test.ts:1474, 1518, 1569, 1619` ほか `sentBody(ws, n)` / `sent[n]` / `sent.length).toBe(n)` 37 箇所。`sentBody(ws1, 2)` = subscribe は hello → rooms → subscribe の順序に依存。handshake に 1 request 足す・順序を変えるだけで 37 箇所落ちるが、仕様 (subscribe が cursor を運ぶ) は変わらない。`sentOp(ws, "subscribe")` のような op で引く helper に。

#### #6 fs.watch 経路のテストが poll 経路に差し替えられ、watch の回帰が見えなくなった

commit `d062e2fe3b45`、`packages/daemon/test/session-input.test.ts` の `startPolledDaemon` (`CCMSG_AGENTS_POLL_MS: "150"`)。Design rationale は書かれているが、「CI の FSEvents が不安定だから観測対象を変える」は実装の都合で緩めた形。`server.ts:3483` の `fs.watch` → readiness 再判定の経路は今どのテストでも検証されない。watch の経路は unit で `sidecarWatch` に偽イベントを入れて「再判定が走る」を確かめ、poll は poll で別テスト。統合テストは「どちらかで追従する」のままでよい。

#### #7 JSON を文字列として assert

`integration.test.ts:383-384, 835, 910, 1131, 1262`、`broadcast.test.ts:488-489, 560-651`、`one-on-one.test.ts:335` (`toContain('"type":"leave","id":"a2"')`、`includes('"type":"member"')`)。キー順・空白・エスケープに依存。`helpers.ts:253` に `jsonObjectOf` が既にある。行を `StorageEventSchema` で読んで filter する helper に。

#### #8 削られた仕様固定: `storedDraftChange` の「既に映している中身なら null」

commit `dc7495a72df0` で `session-input-store.test.ts` の "nothing to show when the input already shows the draft" が消えた。実装 `session-input-store.ts:273-276` は残っている。残るのは `otherTabDraft` 経由の間接 (`:425-426`) だけ。1 本戻す (入力中 state を作り直さない、という UI 上の意味がある契約)。

#### #9 速度: 2〜3 分のほぼ全部が daemon 起動

| 項目 | 結果 |
|---|---|
| pure テスト | 2513 件 = 4.9 秒 (実測) |
| 残り | 約 1500 件に 2〜3 分 |
| daemon 起動 | `startTestDaemon` 328 回 + `spawnDaemonProc` 22 回。1 テスト 1 daemon、bun test はファイル直列 |
| 見積 | 1 spawn ≈ 300-400ms × 328 ≈ 2 分 |

評価: 妥当ではないが理由は明確で、テスト独立性を daemon 単位で買っている。直し方: (a) `drive-request.ts` の `stubDaemon` は既に `handleRequest` を in-process で叩けているので、UDS を in-process で listen する `startInProcessDaemon` を足し、大半の op テストをそちらへ寄せる。(b) describe 単位で daemon 共有し sid / room を test ごとに分ける。(c) CI は `bun test --shard`。

#### #10 `stubDaemon` が `Daemon` の 36 フィールドを手で組む

`drive-request.ts:46-102`。`Daemon` に field を足す度にテスト側を直す。実装の構造 (god object) がテストに漏れている。`createDaemon(paths, deps)` を `src` に置き、テストは deps だけ差し替える。

#### #11 helper の重複

`session()` / `user()` 相当を 21 ファイルが各自定義、`runCli` を 6 ファイル、`const T = 15000` を 39 ファイル (15000 が 31、20_000 が 6、30000 が 2)、`fixtureDir` 系を 9 ファイル。`helpers.ts` に `TestClient.hello()` があるのに各ファイルで `connect + hello` を再定義。`sessionConn(ctx, sid, opts)` / `userConn(ctx)` を `helpers.ts` へ。`T` は `bunfig.toml` の `[test] timeout` で一括指定でき、411 箇所の `T,` 引数は消せる。

#### #12 テスト名・コメントの出典がリポ外のチャット参照

`fs-access.test.ts:1968` の "(kawaz + room 番号 + メッセージ番号)"、`cli.test.ts:1481, 1555` の "(RL-Q2 kawaz + room 番号 + メッセージ番号、裁定=a)" など 135 箇所。room 番号・メッセージ番号はリポ外で第三者には解けない。DR 参照 (321 箇所) は解ける。名前は仕様を書き、出典は DR か `docs/findings/` の path に。

### low

#### #13 テストファイルに生の NUL バイト

`packages/daemon/test/sandbox.test.ts:114` (`"\0\x01binary"` 相当を生で書いている)。git / jj が binary 扱いし diff / blame が読めない (`5e4d58088f9f` の diff で `Binary files differ` を確認)。エスケープで書く。

#### #14 module-level の時刻カウンタ

`incremental-cross-line.test.ts:82-85`、`fold-tree.test.ts:29-32`: 秒フィールドを `padStart(2)` で生成し、テスト順で値が変わる。今は 6〜7 回なので無害だが 60 を超えると不正 ISO。`beforeEach` で reset。

#### #15 実装定数に結合した固定待ち

`cli/test/reconnect.test.ts:301` `sleep(6000)`: backoff 最長 5s という実装定数に結合。`integration.test.ts:315` の `CCMSG_DEDUP_WINDOW_MS` と同じく env で短縮可能にする。

#### #16 daemon に開発者 shell の env が乗る

`helpers.ts:83` `...process.env` を継承。固定されるのは 7 変数だけで、`CCMSG_HTTP_ALLOW_ORIGIN` / `CCMSG_RECENT_REPLAY_MS` / `CCMSG_SAY_BIN` / `CCMSG_TAILSCALE_BIN` 等は開発者 shell の値が乗る。`CCMSG_*` を strip した env を組む。

#### #17 `TestClient.close()` が throw する

`helpers.ts:604-611` `close()` が `assertFrames()` で投げる。`finally` 内の close が投げると本来の失敗を上書きする。close は投げない (request 系で既に投げている)。

#### #18 過去経緯ナラティブ

「historically」「修正前」「以前は」28 箇所 (`hooks/deadline.test.ts` 5、`ws.test.ts` 3、`transcript-model.test.ts` 3 ほか)。テストは現在の契約を書く場所。148 箇所にある「何を保証するか」形式に統一。

### 直近 commit の「緩め」監査

| commit | 内容 | 判定 |
|---|---|---|
| `5bc9f801d90d` | peers-push の negative テストを登録時 push を読み切ってから測る | 順序の正確化。緩めではない |
| `d062e2fe3b45` | sidecar 追従テストを fs.watch から poll (150ms) に | 意図的・rationale 付きだが fs.watch 経路の回帰が見えなくなった (#6) |
| `dc7495a72df0` | 下書き同期テストを `otherTabDraft` 中心に書き換え | 仕様変更に沿う。`storedDraftChange` の null 経路の直接テストが消えた (#8) |
| `5e4d58088f9f` | 実機の形に合わない fixture を直す、`effort:""` を absent 正規化から「書かれたまま保存」に | 仕様変更 (DR-0038 §6) に沿う。expect +6 / -6 |
| `d774df27229c` | transcript-model 2200 行書き換え | test +9 / -5。消えた「message 無し → 0 segments、throw しない」「parentUuid 欠落 → fallthrough」は BrokenLine 仕様への置換 |
| `e398c9b77a14` | daemon テスト 54 ファイルを lint 対象に | expect +127 / -121、test ±0。型の主張の置換のみ |
| `814a41e93fe1` / `77707c01eee7` | webui / cli テストを lint 対象に | expect ±5 以内、test ±0 |
| `28488b413e34` / `ec9f4518fc57` | テストファイル削除 | 対応する実装削除と一致 |

### TDD の痕跡

- commit は test と src を同一 commit に含め、test 名は「何を保証するか」で仕様語彙。バグ修正 commit はテスト追加を伴う (`5bc9f801d90d`、`dc7495a72df0`、`ab7052e15c5c`)。
- `protocol/test/request.test.ts` の「全 op のサンプルが揃っていることをテストで強制」は仕様ファースト。
- 一方 webui の component バグ (`1153654c9c02`) はテストなしで直された後に pure 関数テストが足されており、「再現 → 修正」の順ではない。再現できる基盤が無いため (#1)。

### 全体の評価: 7 / 10

daemon / protocol / CLI の wire 契約は、スキーマ強制の読み取り (TestClient) と順序づけによる観測 (readEventUntil) で、2026 年の水準で見て上位の設計。テスト名が仕様語彙で、バグ修正に回帰テストが付く習慣も定着している。減点は 3 つ: (1) webui の component / hook 配線が構造的に 0 で、直近のバグがそこに集中している (#1)、(2) 時間依存の扱いが hooks では注入・webui では実 sleep と割れている (#3、#6)、(3) 1 テスト 1 daemon の直列 328 起動が速度の大半で、in-process 起動の部品が既にあるのに使われていない (#9)。直近 commit に「実装の都合でテストを無意味化した」跡は #6 と #8 の 2 件で、いずれも意図的で rationale 付き。悪質な緩めは見つからなかった。
