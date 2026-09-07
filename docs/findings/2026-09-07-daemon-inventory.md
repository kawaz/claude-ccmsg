# daemon モジュール棚卸し (作り直し議論の一次資料)

- 日付: 2026-09-07
- 対象: `packages/daemon/src/` 全 52 ファイル (+ 境界確認のため `packages/cli/src/` 3 ファイル、
  `packages/protocol/src/paths.ts`)
- 目的: 「daemon / protocol (契約) / webui」の 3 リポ分離と規約ファーストでの作り直しを
  議論するための現状把握。**設計案は書かない**。事実の棚卸しと、疑わしいものの根拠付き列挙まで。
- 姉妹資料: `docs/findings/2026-09-07-webui-component-inventory.md` (webui 側)、
  `docs/findings/2026-09-07-protocol-inventory.md` (protocol package、別 worker が並行執筆)。
  protocol の型定義そのものの評価はそちらが正、本書は **daemon がそれをどう使うか** に留める。
- 数値は 2026-09-07 時点の `wc -l` / `grep -ac` 実測 (`-a` はソース中の NUL 対策)。

## 判明した事実

1. **daemon src は 19,914 行 / 52 ファイル**。うち `server.ts` 4,008 行 (20%)、
   `session-status.ts` 2,040 行 (10%)、`fs-access.ts` 1,339 行、`session-dump.ts` 1,214 行。
   上位 4 ファイルで全体の 43%。テストは 72 ファイル 31,252 行 (src の 1.57 倍)。
2. **`server.ts` は 4 つの責務が 1 ファイルに同居している**: (a) transport 抽象 (`Conn`) と
   UDS listener の実装、(b) wire フレームの整形 (`orderedMsgFrame` / `writeDelivered`)、
   (c) 55 個の op ハンドラを持つ `dispatch` の巨大 switch (1,809-3,626 行 = ファイルの 45%)、
   (d) プロセスのライフサイクル (`startDaemon` / `gracefulShutdown`)。
   `Daemon` interface 1 個に **22 個のフィールド** がぶら下がる。
3. **op ハンドラのサイズ分布は極端に偏る**。55 op のうち上位 3 個
   (`create_room` 200 行 / `hello` 143 行 / `subscribe` 89 行) で switch 全体の 24%、
   下位 30 op は 20 行以下。ハンドラの中身が「引数検証 + 他モジュール呼び出し + 返信」の
   3 行に収まるものと、ドメインロジックが丸ごと埋まっているものが同じ場所に並ぶ。
4. **role 制限 (`user` 限定) が 35 個の同一コピーとして各 case 内に散っている**。
   `if (conn.identity?.role !== "user") { sendErr(conn, ErrorCode.bad_request, "op '<name>' requires user role"); return; }`
   という完全に同型の 4 行。一方で **hello 必須の判定は `IDENTITY_OPS` という Set のデータ**
   として dispatch の外に括り出されている (server.ts:1677-1720、43 op)。同じ「op の属性」が
   データと分岐の 2 通りで表現されている。
5. **daemon がメモリに持つ状態は 22 種**、正本の所在は 4 通りに分かれる
   (メモリのみ / ファイルがマスタ / 外部プロセスがマスタ / メモリと外部の二重)。
   このうち **ファイルに書き戻されるのは `rooms` と `lastLive` の 2 つだけ**。
   残りは daemon 再起動で全消滅する設計 (sandbox grant は「再起動が失効手段」と明記)。
6. **transcript の tail (`transcript.ts` の Watch) が 4 系統の消費者に fan-out する**:
   wire の `transcript_subscribe` 購読者 (`subscribers`) と、内部の
   `lineListeners` に登録する `session-status` / `session-errors` / `session-user-input`。
   1 セッション 1 Watch を共有する構造で、Watch 側は fs.watch + 2 種のポーリング
   (fallback 1s / backup 2s) を持つ。
7. **タイマー / ポーリングは 8 箇所**。間隔に実測根拠が書いてあるのは transcript tail の
   backup poll 2s (「macOS/Bun で FSEvents が数十秒遅延するのを実測」) と
   session-kill の 1s (「claude TUI の 1 回目 SIGTERM は確認ガードを立てるだけ」) の 2 つ。
   agents poller の 5s は「real usage never needs sub-5s freshness」という宣言のみ。
8. **参照 0 の export は 17 個**。うち実際に完全な dead code は 1 個
   (`agents.ts` の `_resetPidHyouiCacheForTests`)、残り 16 個は自ファイル内でのみ使われる
   = `export` が不要なもの (定数 8 個 / 関数 8 個)。
9. **テストから 1 度も import されない src モジュールが 7 個**:
   `event-loop` / `fs-find` / `fs-serve` / `http` / `launcher-paths` / `run` / `session-errors`。
   `fs-find`・`fs-serve`・`launcher-paths` は認可境界を実装しており、`session-errors` は
   全 peer に fan-out する fold を持つ。
10. **コメント行が 5,206 行 (src の 26%)**。DR 参照 244 箇所 (26 種の DR)、
    `kawaz r<N> mid=<M>` のような会話由来の出典 22 箇所、`docs/issue/` 参照 4 箇所、
    `docs/findings/` 参照 4 箇所。設計判断の記録としては密度が高い反面、
    「なぜこの値か」を知るのに常に外部文書を辿る必要がある。

## 実用的な示唆

- 分離の第一の切れ目は **op ハンドラの粒度差** (事実 3)。「引数検証 + 委譲」だけの op が
  30 個ある一方、`create_room` / `hello` / `subscribe` はハンドラ自体がドメインロジックを
  持つ。前者は規約 (protocol) から機械的に導けるが、後者は導けない。
- **role と hello 必須が別表現になっている** (事実 4) のは、op の属性表が protocol 側に
  無いことの現れ。webui 側の「hello の能力フラグ 7 個」(webui 棚卸し §判明した事実 3) も
  同じ根から出ている — op の可用性がハンドラ内の分岐 6 種と hello のフラグ 6 個に
  二重管理されている。
- **持ち直すべき状態と捨ててよい状態の境界は明確** (事実 5)。永続化されるのは rooms と
  last-live の 2 つだけで、残り 20 種は「再起動で消えてよい派生」と設計文書が明記している。
- **transcript tail の fan-out (事実 6) は既に共有化されている**が、その上に載る 3 つの
  fold (status / errors / user-input) は互いに独立した Map と `inflight` Set を持つ。
  同じ 1 行を 3 回 fold している。
- 未テストの 7 モジュール (事実 9) は、作り直しで「移植前に仕様を確定させる必要がある」
  一次候補。特に認可境界を持つ 3 つ。

---

## 1. 全体像

| 項目 | 値 |
|---|---|
| src ファイル数 | 52 |
| src 総行数 | 19,914 |
| コメント行 | 5,206 (26%) |
| test ファイル数 / 行数 | 72 / 31,252 |
| ランタイム依存 | `@ccmsg/protocol` (workspace) / `@ccmsg/webui` (workspace) のみ。外部 npm 依存ゼロ |
| ランタイム API | Bun 固有 (`Bun.listen` / `Bun.spawn` / `Bun.write` / `Bun.main`) + `bun:ffi` (flock) |
| package exports | `.` → `server.ts`、`./run` → `run.ts`、`./session-dump` → `session-dump.ts` |
| 環境変数 | 13 種 (§4.6) |

### エントリと合成

```
index.ts (7 行)  ─ `--foreground` を見て runDaemon() を呼ぶだけ
  └ run.ts (11 行) ─ 合成ルート。createWebuiApp() を作り fallback として startDaemon に渡す
      └ server.ts:startDaemon() ─ 実体
```

`run.ts` の存在理由はコメントに明記: 「両方の起動経路 (cli の `ccmsg daemon run` と
daemon の直接エントリ) がここを呼ぶので配線が 1 箇所に収まり、server.ts / http.ts は
UI 非依存のままでいられる (DR-0004 §4)」。**daemon が webui package に依存する唯一の点**が
この 1 行 (`run.ts:9`) で、他の 51 ファイルはいずれも webui を知らない。

### 起動順序 (`startDaemon`、server.ts:3734-3999)

| 順 | 処理 | 失敗時 |
|---|---|---|
| 1 | `resolvePaths()` → `stateDir` / `roomsDir` を mkdir | throw |
| 2 | `Logger` 生成 | — |
| 3 | `tryAcquireLock(paths.lock)` (flock、bun:ffi) | 取得失敗 = 先客あり → `exit(0)` |
| 4 | 残留 socket の unlink (lock 保持者が権威) | 無視 |
| 5 | `CCMSG_HTTP_ALLOW` を CIDR にパース | 不正なら lock 解放 → `exit(1)` |
| 6 | `scanRooms(roomsDir)` — 全 room の jsonl を**全件メモリへ** | — |
| 7 | `migrateLegacyConfigFiles` / `writeConfigTypesFile` (`ccmsg-config.d.ts` を書く) | log のみ |
| 8 | `loadConfig()` (config.ts / .js / .json の優先順) | 劣化のみ (launcher 無効) |
| 9 | `Daemon` オブジェクト構築 (22 フィールド) | — |
| 10 | `buildWebhookSources` (token file 読めない source は登録されず 404 になる) | 劣化 |
| 11 | `createStatusRefresher` (llm_status_url 未設定なら null) | — |
| 12 | `readLastLiveSessions` → `daemon.lastLive` を埋める。**その後 async で `withLaunchContext` が transcript を読んで model/effort を後追い補完し `maybeBroadcastPeers`** | best-effort |
| 13 | `createNetworkWatch` (`CCMSG_NETWORK_WATCH=off` で無効化)。有効なら `syncSessionErrors` を再計算 | 劣化 |
| 14 | `fs.writeFileSync(paths.pid)` — **listen より前** (「pid を読むクライアントとの race を防ぐ」と明記) | throw |
| 15 | `Bun.listen({unix})` で UDS を開き `chmod 0600` | throw |
| 16 | `CCMSG_HTTP_BIND` の各 spec で `startHttpListener` | 個別に log.error、他は継続 |
| 17 | `fetchTailscaleServeOrigins` を async 発火。解決した origin を **listener が握っている Set に後から add** | best-effort |
| 18 | `SIGTERM` / `SIGINT` に `gracefulShutdown` を登録 | — |

### 停止順序 (`gracefulShutdown`、server.ts:3644 + `daemon-shutdown.ts`)

1. `shuttingDown = true` (再入ガード)
2. 全 watcher / poller / 子プロセスの停止: agents poller → translator → sessionStatus →
   sessionErrors → userInputs → networkWatch → llmStatusRefresher → transcript tail
3. 全接続に `{ev:"restarting", reason}` を送る (**transport を落とす前**)
4. 全 room を `closeRoom` (fd を閉じ、debounce 中の fsync を確定)
5. `releaseDaemonResources` — **順序が規約** (`daemon-shutdown.ts` の docstring):
   HTTP listener 停止 → pid 削除 → lock 解放 → **最後に UDS close**。
   「クライアントは『UDS に繋がらない』を旧 daemon の退去完了として観測する」ため、
   後継と競合しうる資源を全部手放した最後に UDS を閉じる。socket pathname の unlink は
   **しない** (後継の起動時 cleanup の責務、旧側が消すと後継の新 socket を消す race)
6. `process.exit(0)`

### 永続化するファイル

| パス | 書くタイミング | 書き方 | 正本性 |
|---|---|---|---|
| `<data>/rooms/<id>.jsonl` | 各 event の append 時 | `appendFileSync` + 100ms debounce の fsync | **durable source of truth**。メモリは忠実なミラー |
| `<state>/last-live-sessions.json` | peers 構成が変わるたび (`maybePersistLastLive`) | tmp + rename | メモリがマスタ、ファイルは再起動用スナップショット |
| `<state>/daemon.pid` | listen 直前 / 停止時に unlink | `writeFileSync` | — |
| `<state>/daemon.log` | 毎ログ行 | 同期 write、10MB で 1 世代ローテート | **DR-0029 が同期を許した唯一の writer** (exit 直前の行を落とさないため) |
| `<state>/trace.jsonl` | transcript 遅延計測の各境界 | append、10MB ローテート | 診断専用 |
| `<state>/daemon.sock` / `daemon.lock` | 起動時 | — | — |
| `<config>/ccmsg-config.d.ts` | **毎起動時に上書き** | `writeFileSync` | daemon が生成、config.ts の型注釈用 |
| `<config>/allowed-origins.json` | daemon は書かない (`ccmsg origins` が書く) | — | ファイルがマスタ、mtime gate で読む |
| `<data>/dumps/<sid>-<ts>.{txt,jsonl}` | `session_dump_file` op | `writeFileSync` | 人が持ち回る成果物 |
| `$TMPDIR/claude-ccmsg-<uid>/attachment/<uuid>.<ext>` | 添付アップロード時 | `Bun.write` | cleanup は OS 任せ (DR-0015 §2.1) |

`resolvePaths` は state / config / data の 3 分割 (DR-0002 §1)。分割の意図は
paths.ts 冒頭に「失ってはいけないのは data/ だけ、手で編集してよいのは config/ だけ、を
構造で表現する」と明記されている。

---

## 2. モジュール一覧

「状態」欄は **プロセス生存中に保持される可変状態**のみ。純関数モジュールは「無」。

### 2.1 骨格 (エントリ / transport / ライフサイクル)

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `index.ts` | 7 | argv を見て `runDaemon` | 無 | 無 | プロセスエントリ |
| `run.ts` | 11 | webui を fallback に注入する合成ルート | 無 | 無 | index.ts / cli |
| `server.ts` | 4,008 | UDS listener / `Conn` 抽象 / 55 op の dispatch / 配信 / ライフサイクル | `Daemon` 22 フィールド (§3) | fs (pid/lock/socket)、signal handler、`process.exit` | 全て |
| `http.ts` | 380 | HTTP/WS transport。`/ws` は UDS と同じ行プロトコル。IP allowlist + Origin 検査、5 ルートの振り分け | 無 (listener closure が `extraOrigins` Set を握る) | `Bun.serve` | server.ts (startDaemon) |
| `daemon-shutdown.ts` | 19 | 資源解放の**順序**だけを持つ (§1 参照) | 無 | 渡された closure 経由 | server.ts |
| `event-loop.ts` | 11 | `yieldToEventLoop()` = `setImmediate` の Promise 化 | 無 | 無 | session-search / session-status |
| `flock.ts` | 59 | `bun:ffi` で libc の flock(2) を直接呼ぶ単一インスタンスガード | fd | fs | server.ts |
| `log.ts` | 86 | `daemon.log` writer、10MB 1 世代ローテート | fd + サイズ | fs (同期) | 全モジュール (注入) |
| `trace.ts` | 136 | `trace.jsonl` へ境界タイムスタンプ 1 行 | fd + サイズ | fs | transcript / server (client_trace) |

### 2.2 ルームとメッセージング (ccmsg の中核ドメイン)

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `storage.ts` | 502 | room 1 個 = append-only JSONL 1 本。**全 event をメモリ常駐**。room 走査、mid セレクタ、member 集合、未読 seq | `Room` ごとに events 配列 / fd / fsync タイマー | fs (append + 100ms debounce fsync)、破損行の切り詰め | server.ts のみ |

storage.ts のヘッダに設計意図が明記: 「個人スケールなら有界で、read (任意 mid 範囲) と
subscribe の since-replay (位置差分) が自明かつ正確になる。retention / compaction は
MVP スコープ外 (DR-0001 open questions) なので無制限成長は現状許容」。

### 2.3 セッションレジストリと peers

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `last-live-sessions.ts` | 193 | 「前回稼働中」の on-disk 記録。tmp+rename で書く | 無 (呼び出し側が Map を持つ) | fs、`withLaunchContext` が transcript を読む | server.ts |
| `native-messaging.ts` | 45 | 2 つの CLAUDE_CONFIG_DIR を正規化して比較し、`PeerInfo.send_message` を答える | 無 | fs (realpath) | server.ts (peers) |
| `repo-derive.ts` | 252 | hello が repo/ws を名乗らなかった時に cwd から導出 (git config の origin URL / jj workspace 名) | 無 | fs | server.ts (hello) |
| `session-wake.ts` | 73 | api error で停止中のセッションのうち誰を起こすかの純 fold | `notified: Map<sid, string>` | 無 | server.ts (networkWatch の onOnline) |
| `virtual-sessions.ts` | 212 | 接続していない過去 sid を config dir 配下から解決 (user role 限定の「仮想セッション」) | 無 | fs (transcript 先頭 4MB を chunk 走査して cwd を得る) | fs-access / transcript / session-dump |

### 2.4 transcript 系 (tail と fold)

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `transcript.ts` | 887 | sid ごとの Watch を 1 本持ち、追記行を購読者と listener に配る。byte offset ページング read。`adoptTranscriptPath` で hello が名乗らなかった path を disk から拾う | `watches: Map<sid, Watch>`。Watch は lastEnd / ino / birthtime / sawMissing / fsWatcher / pollTimer | fs.watch + `setInterval` (1s or 2s)、fs 読み | server / session-status / session-errors / session-user-input |
| `session-status.ts` | 2,040 | transcript 行を fold して SessionStatus スナップショットを作る。todo / api error / context usage / agent tree / workflow / 添付 / 外部ファイル allowlist | `sessions: Map<sid, LiveSessionStatus>` (fold state / 購読 conn / scanGen / pushChain / pendingLines) | fs 多数 (agent meta / workspace / workflow)、`yieldToEventLoop` | server.ts、session-dump.ts |
| `session-errors.ts` | 240 | 全 peer 横断で「API error で止まっているセッション」だけを fold | `watches: Map<sid, ErrorWatch>` + `inflight: Set<Promise>` | transcript tail 経由 | server.ts |
| `session-user-input.ts` | 334 | 「最後にユーザが入力した時刻」だけを fold (sidebar の並び順) | `watches: Map<sid, UserInputWatch>` + `inflight` | transcript tail 経由 | server.ts |
| `agent-transcripts.ts` | 228 | subagent / workflow agent の transcript path 解決 (DR-0025) | 無 | fs | transcript / session-status / session-dump |
| `workflow-drilldown.ts` | 248 | 1 workflow run の phase + agent 一覧を on-disk artifact から fold | 無 | fs | session-status |
| `fork-origin.ts` | 278 | fork された transcript が祖先のコピーでなくなる境目を、兄弟 transcript との uuid 集合比較で探す | `memo: Map<key, Promise<ForkOrigin|null>>` | fs (兄弟 transcript を全走査) | server.ts (fork_origin op) |
| `mtime-cache.ts` | 62 | 1 パス由来の値を (mtimeMs, size, ino) で再検証しつつメモ化 | Map | stat | session-status / workspace-folders |
| `session-dump.ts` | 1,214 | 1 セッションの room 履歴 + status を text/jsonl に整形して書き出す | 無 | fs 読み書き | server.ts、cli (`./session-dump` export) |
| `session-search.ts` | 863 | 全 config dir の transcript を横断検索 | 無 | fs 全走査 + `yieldToEventLoop` | server.ts |

### 2.5 ファイルアクセス (認可境界)

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `fs-access.ts` | 1,339 | containment 検査付きの list/read、transcript allowlist 経由の外部 read、inbox 限定 write、create/delete/edit、stat batch、workspace 版 | 無 | fs 読み書き | server.ts、fs-serve、sandbox、fs-find |
| `fs-find.ts` | 261 | 再帰ファイル名検索。既存 2 種の認可面を再利用 | 無 | fs 全走査 | server.ts |
| `fs-serve.ts` | 91 | `GET /fs-serve` — 画像のみ拡張子 allowlist で配信 | 無 | fs 読み | http.ts |
| `gitignore.ts` | 243 | fs_find の walk 用 `.gitignore` マッチャ (自前実装) | 無 | fs (`.gitignore` 読み) | fs-find |
| `dir-tree.ts` | 174 | launcher の cwd ツリー。深さ有界、ディレクトリのみ、dot 除外 | 無 | fs | server.ts |
| `launcher-paths.ts` | 71 | dir_tree と session_launch が共有する realpath containment | 無 | fs (realpath) | dir-tree / session-launch |
| `workspace-folders.ts` | 267 | `.code-workspace` の検出 + JSONC パース + folders[] 解決 | 無 (mtime-cache に委譲) | fs | session-status |
| `sandbox.ts` | 466 | 別 eTLD+1 での MIME 無制限配信 (DR-0030)。grant の発行 / 失効 / Host 判定 | `byGid: Map` + `byScope: Map` | fs 読み (毎回 `fsResolveForServe` を再実行) | http.ts、server.ts |
| `attachment.ts` | 266 | `POST /attachment` / `GET /attachment/<id>` | 無 | fs 書き ($TMPDIR) | http.ts |

### 2.6 外部プロセス / 外部サービス

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `agents.ts` | 354 | `claude agents --json` を全 config dir でポーリング (5s)。`ps eww` で pid の hyoui env を読む | `AgentsCache` + `timer` + module-level `pidHyouiCache: Map<pid, …>` | `Bun.spawn` × 2 種、fs (`$HOME/.claude*` を毎回再走査) | server / session-kill / session-search / virtual-sessions |
| `session-launch.ts` | 324 | launcher テンプレの検証 + 明示 shell argv での実行。2 段階 timeout 終了 | 無 | `Bun.spawn` | server.ts |
| `session-kill.ts` | 283 | sid→pid を毎回解決 → `ps` で claude プロセスか検証 → 2 発 SIGTERM | 無 | `Bun.spawn`、signal | server.ts、session-env |
| `session-env.ts` | 131 | `ps eww` で対象プロセスの env を読む | 無 | `Bun.spawn` | server.ts |
| `session-rename.ts` | 173 | `hyoui input` でターミナルに `/rename <title>` をタイプする | 無 | `Bun.spawn` (hyoui) | server.ts |
| `translate-helper.ts` | 426 | macOS Translation.framework の常駐 helper プロセス (DR-0023)。バイナリを自前で展開 | 子プロセス + watchdog タイマー | `Bun.spawn`、fs 書き | server.ts |
| `network-watch.ts` | 249 | `/sbin/route -n monitor` を常駐させ、burst を 1.5s coalesce して `scutil -w` で online 判定 | timer + 子プロセス | `Bun.spawn` × 2 | server.ts |
| `tailscale-origin.ts` | 141 | `tailscale serve status --json` を読み、自分の bind port を proxy している ts.net ホスト名を得る | 無 | `Bun.spawn` | server.ts (起動時 1 回) |

### 2.7 LLM gateway 連携

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `webhook.ts` | 139 | `POST /webhook/<source>` の 1 ルート。source ごとの bearer token | 無 (Map は Daemon 側) | 無 | http.ts |
| `llm-events.ts` | 276 | gateway が POST する request event の検証と、series ごとの cache | `entries: Map` + `sidsByPrefix: Map` | 無 | server.ts |
| `cache-keepalive.ts` | 100 | prompt cache keepalive marker を該当セッションへ `ev:"notify"` として素通し | 無 | 無 | server.ts |
| `llm-gateway.ts` | 126 | 3 プロキシ共通の fetch + バイト上限 + 失敗の一本化 | 無 | HTTP fetch | llm-usage / llm-stats / llm-status |
| `llm-usage.ts` | 261 | クオータ文書のパース | 無 | (llm-gateway 経由) | server.ts |
| `llm-stats.ts` | 149 | 使用量文書のパース + 期間指定 | 無 | (同上) | server.ts |
| `llm-status.ts` | 341 | upstream service status のパース + 529 検知時の自動再取得 (5s debounce) | `LlmStatusRefresher` の timer | (同上) | server.ts |

### 2.8 設定と入口の許可

| ファイル | 行 | 責務 | 状態 | 副作用 | 誰が使うか |
|---|---|---|---|---|---|
| `config.ts` | 683 | `config.ts` > `config.js` > `config.json` の優先順で読む。壊れた編集は launcher 無効に劣化させ、crash させない。`ccmsg-config.d.ts` を書き出す | 無 (起動時 1 回) | fs 読み書き、動的 import | server.ts |
| `ip-allowlist.ts` | 135 | 依存ゼロの IPv4/IPv6 CIDR マッチャ | 無 | 無 | http.ts |
| `origins-file.ts` | 57 | `allowed-origins.json` を mtime gate 付きで読む。**Origin 検査が他の全てで落ちた時だけ**参照される | mtime + キャッシュ | fs | http.ts |

### 2.9 `server.ts` 内部の op ハンドラ (55 個)

行数は次の `case` までの距離 (`dispatch` は server.ts:1809-3626)。
「role」欄: `user` = user role 限定の明示ガードあり、`session` = session role 限定、
`—` = 制限なし。「hello」欄: `IDENTITY_OPS` に含まれるか。

| op | 行 | 行数 | role | hello | 触る状態 |
|---|---|---|---|---|---|
| `create_room` | 2108 | 200 | — | 要 | rooms / dedupIndex / sessions / subscribers |
| `hello` | 1811 | 143 | — | — | sessions / staleClients / lastLive / peersSnapshot / rooms (auto-join) |
| `subscribe` | 2551 | 89 | — | 要 | subscribers / conn.subscribed / agentsPoller / sessionErrors |
| `next_room` | 2308 | 72 | — | 要 | rooms / dedupIndex |
| `post` | 1975 | 67 | — | 要 | rooms (append + deliver) |
| `reply` | 2042 | 66 | — | — | rooms |
| `invite` | 3552 | 62 | — | 要 | rooms / sessions |
| `session_rename` | 2848 | 56 | user | 要 | agentsPoller (hyoui id 解決) |
| `say` | 2380 | 45 | session | 要 | rooms |
| `session_dump_file` | 2961 | 39 | user | 要 | rooms / sessionStatus / fs |
| `rooms` | 2668 | 36 | — | — | rooms |
| `say_read` | 2425 | 33 | user | 要 | rooms |
| `transcript_read` | 3264 | 32 | 一部 user | 要 | sessions / transcript |
| `set_title` | 2458 | 32 | — | 要 | rooms |
| `sandbox_grant` | 3220 | 31 | user | — | sandboxGrants |
| `kick` | 2520 | 31 | user | 要 | rooms |
| `fs_find` | 3100 | 31 | user | 要 | sessions |
| `llm_stats` | 3348 | 30 | user | — | config (外部 fetch) |
| `archive_room` | 2490 | 30 | — | 要 | rooms |
| `client_trace` | 3462 | 29 | user | 要 | trace |
| `session_kill` | 2820 | 28 | user | 要 | agentsPoller |
| `fs_edit` | 3192 | 28 | user | 要 | sessions / fs |
| `translate` | 3398 | 27 | user | 要 | translator |
| `session_launcher_config` | 2744 | 24 | user | 要 | config |
| `session_env` | 2904 | 24 | user | — | agentsPoller |
| `notify` | 2720 | 24 | — | 要 | subscribers |
| `fs_create` | 3145 | 24 | user | 要 | sessions / fs |
| `fs_list_workspace` | 3038 | 23 | user | 要 | sessions / fs |
| `fs_delete` | 3169 | 23 | user | 要 | sessions / fs |
| `llm_usage` | 3326 | 22 | user | — | config (外部 fetch) |
| `session_status_subscribe` | 3505 | 21 | user | 要 | sessionStatus / transcriptTail |
| `ping` | 1954 | 21 | — | — | 全体 (統計値) |
| `transcript_subscribe` | 3425 | 20 | user | 要 | transcriptTail |
| `llm_status` | 3378 | 20 | user | — | config (外部 fetch) |
| `fs_stat_batch` | 3080 | 20 | user | 要 | sessions / fs |
| `fork_origin` | 2941 | 20 | user | 要 | forkOrigins |
| `fs_read_workspace` | 3061 | 19 | user | 要 | sessions / fs |
| `dir_tree` | 2784 | 19 | user | 要 | config |
| `transcript_unsubscribe` | 3445 | 17 | user | 要 | transcriptTail |
| `session_launch` | 2803 | 17 | user | 要 | config |
| `room_history` | 2651 | 17 | — | 要 | rooms |
| `peers` | 2704 | 16 | — | — | sessions / lastLive |
| `leave` | 3536 | 16 | — | 要 | rooms |
| `last_live_remove` | 2768 | 16 | user | 要 | lastLive |
| `session_errors` | 3311 | 15 | user | 要 | sessionErrors |
| `agents` | 3296 | 15 | user | 要 | agentsPoller |
| `session_status` | 3491 | 14 | user | 要 | sessionStatus |
| `fs_write` | 3131 | 14 | user | 要 | sessions / fs |
| `fs_read_external` | 3024 | 14 | user | 要 | sessions / fs |
| `session_search` | 2928 | 13 | user | 要 | — |
| `sandbox_revoke` | 3251 | 13 | user | — | sandboxGrants |
| `shutdown` | 3614 | 12 | — | — | 全体 |
| `fs_read` | 3012 | 12 | 一部 user | 要 | sessions / fs |
| `fs_list` | 3000 | 12 | 一部 user | 要 | sessions / fs |
| `read` | 2640 | 11 | — | — | rooms |
| `session_status_unsubscribe` | 3526 | 10 | user | 要 | sessionStatus |

「一部 user」= role で拒否せず `allowVirtual: role === "user"` のように**挙動を変える** 3 op
(`fs_list` / `fs_read` / `transcript_read`)。role が可否ではなく可視範囲を決めている。

### 2.10 daemon が push する event (`ev:`) — 12 種

`agents` / `llm_requests` / `llm_status` / `net_online` / `notify` / `peers` /
`restarting` / `room_cursors` / `session_errors` / `session_status` /
`subscribe_superseded` / `transcript`。
このうち `transcript` は transcript.ts が、`session_status` は session-status.ts が
`conn.write` を直接呼んで書く (server.ts の `send` を通らない)。

---

## 3. 状態の実態

`Daemon` interface (server.ts:225-314) の 22 フィールドを、正本の所在で分類する。

### 3.1 メモリのみ (再起動で消えるのが仕様)

| フィールド | 型 | 中身 | 同期の仕方 |
|---|---|---|---|
| `connections` | `Set<Conn>` | 生きている全接続 (UDS + WS) | listener の open/close |
| `sessions` | `Map<sid, SessionEntry>` | hello したセッション。meta / configDir / clientVersion / conns / connectedAt / lastActivityAt | hello で追加、conns が 0 で削除 |
| `subscribers` | `Set<Conn>` | subscribe 中の接続 | subscribe op / removeConn |
| `staleClients` | `Map<sid, StaleClientInfo>` | 世代違いで hello を拒否されたクライアント。**`sessions` に入れないので唯一の記録** | hello 拒否時に記録、正しい hello で削除 |
| `sandboxGrants` | `byGid` + `byScope` の 2 Map | 発行済み preview URL の grant。TTL 30 分 | 「再起動が失効手段」と docstring に明記 |
| `sessionWake` | `notified: Map<sid, string>` | 既に起こした stall | network online のたび fold |
| `forkOrigins` | `Map<key, Promise>` | fork seam 解決のメモ | transcript identity をキーに永続メモ |
| `llmRequests` | `LlmRequestCache` (2 Map) | series ごとの最新 gateway request | webhook POST のたび |
| `httpListeners` / `server` / `lock` / `log` / `trace` | — | 資源ハンドル | — |
| `startTime` / `version` / `shuttingDown` / `dedupWindowMs` / `httpAllow` / `paths` | — | 不変値 | — |

### 3.2 ファイルがマスタ

| フィールド | ファイル | 同期の仕方 |
|---|---|---|
| `rooms` + `dedupIndex` | `<data>/rooms/*.jsonl` | 起動時に全件 `scanRooms` でメモリへ。以後は append と同時にメモリも更新 (write-through)。`dedupIndex` は起動時に rooms から再構築される派生 |
| `config` | `<config>/config.{ts,js,json}` | **起動時 1 回だけ** (DR-0018 LN-Q4)。以後リロードしない |
| `webhooks` | config + token file | 起動時 1 回。token が読めない source は Map に入らず、そのルートが 404 になる |

### 3.3 メモリがマスタでファイルへ書き戻す

| フィールド | ファイル | 同期の仕方 |
|---|---|---|
| `lastLive` | `<state>/last-live-sessions.json` | 起動時に読み込み、以後 **縮むだけ** (sid が戻ってきた時のみ削除)。書き戻しは `lastLiveSnapshot` 文字列との比較で差分がある時だけ |

### 3.4 外部プロセス / 外部サービスがマスタ

| フィールド | 外部 | 同期の仕方 |
|---|---|---|
| `agentsPoller` | `claude agents --json` | 5s ポーリング。**user role の subscriber が 1 人以上いる間だけ回る** |
| `transcriptTail` | transcript jsonl | fs.watch + 1s/2s poll |
| `sessionStatus` | 同上 (fold) | tail の lineListener |
| `sessionErrors` | 同上 (fold) | tail の lineListener |
| `sessionUserInputs` | 同上 (fold) | tail の lineListener |
| `networkWatch` | `route -n monitor` + `scutil` | 常駐子プロセス + 1.5s debounce |
| `llmStatusRefresher` | gateway の status endpoint | 529 検知時に 5s debounce で再取得 |
| `translator` | 常駐 helper プロセス | リクエスト単位 + watchdog |
| `sandboxOrigin` | config の template をコンパイルしたもの | 起動時 1 回 |

### 3.5 「前回送った内容」を文字列で覚える push 抑制キャッシュ 3 個

| フィールド | 何と比較するか | 目的 |
|---|---|---|
| `peersSnapshot` | `peersCompareKey(daemon)` | hello 再送などで peers が実質変わっていない時に `ev:"peers"` を送らない |
| `lastLiveSnapshot` | `lastLiveCompareKey(daemon)` | 同じ内容の last-live 書き込みを避ける |
| `sessionErrorsSnapshot` | `sessionErrorEntries()` の直列化 | 変化のない `ev:"session_errors"` を送らない |

3 つとも **「派生値を JSON 文字列にして前回と比較する」という同じ手法の別実装**。
`session_status` / `agents` / `llm_requests` には同種のガードがない。

### 3.6 重複して持っているもの

| # | 重複 | 根拠 |
|---|---|---|
| 1 | **1 本の transcript 行を 3 つの fold が独立に処理**。`sessionStatus` / `sessionErrors` / `sessionUserInputs` はそれぞれ自前の `Map<sid, Watch>` と `inflight: Set<Promise>` を持ち、同じ `transcriptTail` の Watch に別々の `lineListener` を登録する | transcript.ts:843 `addLineListener`、3 モジュールの store 定義 |
| 2 | **API error の情報が 2 系統ある**。`sessionErrors` (全 peer 横断、1 パターンだけ fold) と `sessionStatus` の fold 内 `classifyApiErrorRow` (購読中 sid のみ、詳細)。前者は後者の関数を import して使う | session-errors.ts のヘッダが DR-0020 §2.1(a) を引いて「全 peer に full fold は高すぎる」と明記 |
| 3 | **セッションの「最終活動時刻」が 2 種**。`SessionEntry.lastActivityAt` (ccmsg リクエストのたび更新 = agent の忙しさ) と `sessionUserInputs` (人間の入力のみ = sidebar の並び順) | session-user-input.ts のヘッダに両者の違いが明記 |
| 4 | **config dir 検出が毎回ディスク走査**。`detectConfigDirs()` は `$HOME/.claude*` を毎回再スキャンし、agents poller (5s) / session-kill / session-search / virtual-sessions の 4 箇所から呼ばれる。キャッシュを持たないのは意図的 (「daemon の env は respawn で失われうるのでディスクが唯一の durable source」) | agents.ts:17-25、40 |
| 5 | **pid → hyoui env のキャッシュだけ module-level にある**。`agents.ts:142` の `pidHyouiCache` は `Daemon` に属さない唯一の可変状態で、テスト用リセット関数 (`_resetPidHyouiCacheForTests`) が export されている (が、どこからも呼ばれていない — §5.3) | agents.ts:134-145 |

---

## 4. 外部との境界

### 4.1 `claude agents --json` (subprocess ポーリング)

前提にしている相手の仕様:

- `claude agents --json` が **JSON を stdout に出す**、`--all` フラグを受け付ける
  (session-kill は `--all` 版を使う)
- **`$HOME/.claude*` のディレクトリが CLAUDE_CONFIG_DIR の候補**である。
  `~/.claude` が regular file の環境 (kawaz の運用) は `isDirectory()` で自然に除外される、
  と明記
- CLI が 5s 以内に応答する (超えたら SIGKILL)。1 つの config dir の hang が他を止めない
- 出力行に `hyoui_session_id` を紐付けるため、**pid の `ps eww -o command=` の中に
  hyoui の env pair が現れる**

`sessions/<sid>.json` (hook が書くセッション状態ファイル) は **daemon は読まない**。
読むのは cli 側 (`packages/cli/src/index.ts:142`、`subscribe-owner.ts:41`) だけで、
daemon はその内容を hello のフィールドとして受け取る。

### 4.2 LLM gateway

2 方向ある。

**(a) inbound webhook**: `POST /webhook/<source>` (webhook.ts)。
- source ごとの bearer token、token file が読めない source はルートごと 404
- **fire-and-forget**: 構造的に読めれば 204、個々の不正 item は log して捨てる。
  「4xx で retry する producer に daemon を叩かせないため」
- 受け口が push 型なのは「gateway が stable / unstable の 2 プロセス同時稼働で、
  1 本の subscription ではどちらか片方しか見えないから」(llm-events.ts ヘッダ)
- 扱う item は 2 種: LLM request event (→ `llmRequests`) と cache keepalive marker
  (→ 該当セッションへ `ev:"notify"` で素通し)

**(b) outbound relay** (`llm-gateway.ts` 共通): `llm_usage` / `llm_stats` / `llm_status` の
3 op が daemon から fetch する。
- 前提: **gateway が CORS ヘッダを付けない**ので browser から直接読めない。だから daemon が代理する
- webui に URL 自体は渡さず「設定済みか」の boolean だけ返す (hello の capability)
- timeout は 10s / 30s / 10s、probe は 60s / — / 30s
- `llm_status` だけ双方向: request event が 529 を報告したら daemon 側から status を
  再取得して user role subscriber に push する
- **verdict は gateway が持つ** (「ccmsg は語彙を正規化し描けないものを落とすが、
  severity を再計算しない。二重判定は webui と gateway CLI を食い違わせる」)

### 4.3 hyoui (ターミナル多重化)

- `session_rename` が唯一の利用箇所。`hyoui input` で `/rename <title>` を PTY に打ち込む
- 前提: **`/rename` スラッシュコマンドがタイトルの唯一の writer** (API 経路が無い)
- 前提: hyoui は `text:` のバイトを PTY にそのまま流す (エスケープ処理をしない) ので、
  daemon 側でタイトルを検証・正規化する必要がある
- 前提: `--namespace` を渡さないと false ENOENT が返る。namespace は `ps eww` で
  対象プロセスの `HYOUI_NAMESPACE` から取る (推測してはいけない、と明記)
- 前提: hyoui は input holder を直列化する (auto-lock)。5s timeout はこれも含む
- `terminal_gateway_url` (config) 経由で webui の Terminal タブが
  `<url>/sessions/<HYOUI_SESSION_ID>?embed=1` を iframe で開く

### 4.4 transcript jsonl の tail

前提にしている相手の仕様 (transcript.ts に実測根拠つきで列挙):

- Claude Code が `<projDir>/<sid>.jsonl` に **追記のみ**する。ただし truncate や
  unlink+recreate も起こりうるので ino / birthtime / sawMissing の 3 段で同一性を判定
- **ext4 (GitHub Actions) は解放直後の inode 番号を再利用する**ので ino だけでは足りない
  (v0.19.0 の run で実際に落ちた)
- **macOS/Bun の fs.watch は高負荷時に数十秒遅延しうる** (並列 `bun test` で子プロセスが
  多数走る状況で実測)。イベントを落としはしないが遅れるので、2s の backup poll を
  fs.watch と**併走**させる。fs.watch が使えない場合は 1s の fallback poll 単独
- subagent / workflow は兄弟ディレクトリ `<projDir>/<sid>/subagents/...` に置かれる (DR-0025)
- `--fork-session` は祖先の行を uuid / timestamp ごと複製し sessionId だけ書き換える。
  **コピー行と原本行を区別するフィールドがファイル内に無い**ので、seam は兄弟 transcript
  との比較でしか見つけられない (fork-origin.ts、この repo の 21 transcript で検証)

### 4.5 tailscale / caddy 前提の bind と Origin 制限 (DR-0004)

- bind: `CCMSG_HTTP_BIND` の `host:port` カンマ区切り。`off` で HTTP を無効化。
  1 つの bind が失敗しても他は継続する
- source IP: `CCMSG_HTTP_ALLOW` の CIDR allowlist (自前の依存ゼロマッチャ)。
  **空文字は「全拒否」ではなくデフォルトへのフォールバック** (「明示的な空 allowlist は
  ロックダウンの手段として提供しない、`CCMSG_HTTP_BIND=off` を使え」)
- Origin: 4 段階で許可される。(1) リクエスト自身の bind アドレス (常に暗黙許可)、
  (2) `CCMSG_HTTP_ALLOW_ORIGIN` の env、(3) tailscale serve が proxy している
  ts.net ホスト名 (起動時に `tailscale serve status --json` を読んで自動追加)、
  (4) `<config>/allowed-origins.json` (**他の全てが落ちた時だけ**参照される。
  mtime gate なので `ccmsg origins add` が daemon 再起動なしで次のリクエストから効く)
- (3) は起動時 async で解決し、**listener の closure が握っている Set に後から add する**。
  listener への再配線は無い (server.ts:3959-3985 のコメントに明記)
- (4) が必要な理由は「env は daemon を respawn したクライアントが渡さないと失われる」+
  「tailscale が把握していない reverse proxy (公開ホスト名の caddy) は自動許可できない」
- sandbox origin (DR-0030) は同じ 8642 listener で `Host` ヘッダにより振り分ける

### 4.6 環境変数 13 種

| 変数 | 用途 | テスト専用か |
|---|---|---|
| `CCMSG_HTTP_BIND` / `CCMSG_HTTP_ALLOW` / `CCMSG_HTTP_ALLOW_ORIGIN` | transport | 本番 |
| `CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` (protocol 側) | パス上書き | 「tests depend on them」 |
| `CCMSG_DEDUP_WINDOW_MS` | room dedup 窓 | 本番 |
| `CCMSG_ATTACHMENT_MAX_BYTES` | 添付上限 | 本番 |
| `CCMSG_WIRE_MSG_SAFE_BYTES` | subscribe wire の msg 本文カット閾値 (既定 400) | チューニング用と明記 |
| `CCMSG_RECENT_REPLAY_MS` | recent replay 窓 (既定 3 分) | 「env override exists purely for tests」 |
| `CCMSG_AGENTS_POLL_MS` | agents ポーリング間隔 | 「purely for test determinism」 |
| `CCMSG_NETWORK_WATCH` / `_FILE` / `_DEBOUNCE_MS` | network watch の無効化・差し替え | テスト用 daemon 向けと明記 |
| `CCMSG_TAILSCALE_BIN` / `_STATUS_TIMEOUT_MS` | tailscale 呼び出し差し替え | テスト用 |

---

## 5. 疑わしいものリスト (根拠付き)

### 5.1 `server.ts` の責務混在

4,008 行が 4 責務を持つ (§判明した事実 2)。分割の切れ目が既に見えているのは:

- **UDS listener の実装が `startDaemon` 関数の内部に inline されている** (server.ts:3860-3899、
  `UdsConnState` interface と `flushPending` を関数スコープに定義)。HTTP/WS 側は
  `http.ts` に外出しされているのに、UDS だけ startDaemon の中にいる。
  `Conn` 抽象があるので配置の必然性は無く、**片側だけ外に出た非対称**。
- `flushPending` は UDS 固有の backpressure 処理 (「`socket.write()` は sendto(2) を直接
  呼び、バッファが満杯なら short count を返す。Bun の `ws.send()` と違って残りを
  誰も再送しない」)。この知識が startDaemon の中に埋まっている。
- **`orderedMsgFrame`** (49 行 + 60 行のコメント) は wire フレームのフィールド順を
  ハーネスの truncation 挙動に合わせて組み立てる関数。protocol の関心なのか
  daemon の関心なのかが曖昧な位置にある。

### 5.2 同じ概念の二重実装

| # | 内容 | 根拠 |
|---|---|---|
| 1 | **op の属性が「データ」と「分岐」の 2 表現**。hello 必須は `IDENTITY_OPS` という Set (43 op)、role 制限は各 case 内の 35 個の同型 4 行 | server.ts:1677-1720 vs §判明した事実 4 |
| 2 | **push 抑制キャッシュ 3 個が別実装**。`peersSnapshot` / `lastLiveSnapshot` / `sessionErrorsSnapshot` はいずれも「派生値を直列化して前回と比較」だが共通化されていない。さらに `session_status` / `agents` / `llm_requests` には同じガードが無い | §3.5 |
| 3 | **transcript 行の fold が 3 系統**。それぞれ `Map<sid, Watch>` + `inflight: Set<Promise>` を持つ | §3.6 #1 |
| 4 | **`ev:` の書き出し口が 2 つ**。server.ts の `send()` (request_id をスタンプする) と、transcript.ts / session-status.ts が直接呼ぶ `conn.write()`。後者は `send` の相関付けロジックを通らない | transcript.ts:459 `sendTail`、session-status.ts:1810 `statusEventLine` |
| 5 | **API error 分類が 2 用途**。§3.6 #2 |
| 6 | **`llm_usage` / `llm_stats` / `llm_status` が同型の 4 モジュール構成**。共通の fetch は `llm-gateway.ts` に括られたが、op ハンドラ側 (22 / 30 / 20 行) は「role 検査 → config 未設定チェック → fetch → エラーコード分岐」を 3 回書いている | server.ts:3326/3348/3378 |

### 5.3 参照 0 の export (17 個)

**完全な dead code (1 個)**:

| ファイル | シンボル | 状況 |
|---|---|---|
| `agents.ts` | `_resetPidHyouiCacheForTests` | 定義以外に 1 箇所も出現しない。テスト用として export されたが、そのテストが存在しない |

**自ファイル内でのみ使用 = `export` が不要 (16 個)**:

| ファイル | シンボル |
|---|---|
| `agents.ts` | `pollAgents`, `userSubscriberCount` |
| `attachment.ts` | `maxAttachmentBytes` |
| `fs-serve.ts` | `serveMimeForPath` |
| `gitignore.ts` | `compileIgnoreRule` |
| `llm-stats.ts` | `LLM_STATS_TIMEOUT_MS` |
| `llm-status.ts` | `LLM_STATUS_TIMEOUT_MS`, `LLM_STATUS_PROBE_TIMEOUT_MS`, `STATUS_REFRESH_DEBOUNCE_MS` |
| `llm-usage.ts` | `LLM_USAGE_TIMEOUT_MS`, `LLM_USAGE_PROBE_TIMEOUT_MS`, `resolveLoginUrl` |
| `network-watch.ts` | `probeOnlineDefault`, `startRouteMonitor` |
| `sandbox.ts` | `sandboxUrl` |
| `server.ts` | `wakeStalledSessions` |
| `session-dump.ts` | `sessionDumpFileName` |
| `session-env.ts` | `PS_TIMEOUT_MS` |
| `session-kill.ts` | `AGENTS_TIMEOUT_MS`, `SECOND_SIGNAL_AFTER_MS`, `POLL_INTERVAL_MS`, `TOTAL_GRACE_MS` |
| `session-launch.ts` | `launchVarCarrier` |
| `session-rename.ts` | `HYOUI_TIMEOUT_MS` |
| `session-search.ts` | `listCandidateFiles` |
| `storage.ts` | `flushRoom` |
| `trace.ts` | `TRACE_ROTATE_BYTES` |
| `transcript.ts` | `validateTranscriptPath` |
| `virtual-sessions.ts` | `scanTranscriptCwd` |

うち **timeout 定数 8 個は「テストが値を参照するため export した」形跡がある**が、
実際にはどのテストも参照していない (`session-kill.ts` の 4 個、`llm-*` の 5 個)。

### 5.4 テストの無い経路 (7 モジュール)

| モジュール | 行 | 何がテストされていないか |
|---|---|---|
| `http.ts` | 380 | **transport 全体**。IP allowlist の適用、Origin 4 段判定、5 ルートの振り分け、WS upgrade。`http-transport.test.ts` は存在するが daemon 経由の e2e で、このモジュールを直接 import しない |
| `fs-find.ts` | 261 | 再帰検索の認可 (contained / workspace の 2 モード)、結果上限、gitignore 適用 |
| `fs-serve.ts` | 91 | **`GET /fs-serve` の認可と拡張子 allowlist**。「任意の MIME を配ると content-sniffing / script 実行の経路になる」とヘッダが自ら書いている境界 |
| `launcher-paths.ts` | 71 | dir_tree と session_launch が共有する realpath containment。**両者の drift 防止が存在意義**なのに共有部分の直接テストが無い |
| `session-errors.ts` | 240 | 全 peer に fan-out する fold。watch の同期 (`syncSessionErrorWatches`) と inflight の扱い |
| `event-loop.ts` | 11 | `setImmediate` ラッパ (自明) |
| `run.ts` | 11 | 合成ルート (自明) |

上 5 つのうち 3 つ (`fs-find` / `fs-serve` / `launcher-paths`) が**認可境界**である点が
最も疑わしい。いずれも「既存の認可面を再利用しているから新しい境界ではない」と
ヘッダが主張しているが、その主張自体を検証するテストが無い。

### 5.5 タイマー / ポーリング一覧 (根拠の有無)

| 箇所 | 間隔 | 種別 | 根拠 |
|---|---|---|---|
| `transcript.ts:696` | 2,000ms | fs.watch と併走する backup poll | **有 (実測)**。「macOS/Bun で並列 test 実行時に FSEvents が数十秒遅延するのを観測。イベントは落ちないが遅れる」 |
| `transcript.ts:693/701` | 1,000ms | fs.watch 不能時の唯一の手段 | 無 (「purely an internal fallback knob」とだけ) |
| `agents.ts:332` | 5,000ms | `claude agents --json` ポーリング | 弱 (「real usage never needs sub-5s freshness」— 宣言のみ) |
| `session-kill.ts:22` | 200ms | 死亡確認のポーリング | 無 |
| `session-kill.ts:17` | 1,000ms | 1 発目と 2 発目の SIGTERM の間隔 | **有 (挙動由来)**。「claude TUI の 1 回目 SIGTERM は quit 確認ガードを立てるだけ」 |
| `network-watch.ts:58` | 1,500ms | routing message burst の coalesce | 無 |
| `llm-status.ts:266` | 5,000ms | 529 検知後の再取得 debounce | 無 |
| `storage.ts:14` | 100ms | fsync debounce | 無 |
| `sandbox.ts:29` | 30 分 | grant TTL | 無 |
| `session-status.ts:1178` | 2 分 | agent の「live」判定 mtime 窓 | 無 |
| `session-launch.ts:26/36` | 500ms | force kill 猶予 / pipe drain 猶予 | 無 |
| `translate-helper.ts:53-55` | 10s + 1s/100 文字、上限 120s | watchdog | 弱 (式の根拠なし) |
| timeout 系 | 5s × 4 (agents / ps / hyoui / agents-all)、10s / 30s (gateway) | 子プロセス / fetch の予算 | 弱 (「hung な CLI が全体を止めない」という定性理由のみ) |

**8 種のタイマーのうち実測根拠が書いてあるのは 2 つ**。残りは「妥当そうな値」の域を出ない。
一方で `sloppy-ai-patterns` 的な「本来 event-driven にできるのに poll している」箇所は
少なく、network-watch は明示的に「タイマーではなくイベントソースにした」と書いている。

### 5.6 場当たり分岐 (「〜のため」の特例)

| # | 箇所 | 内容 |
|---|---|---|
| 1 | `orderedMsgFrame` (server.ts:470-518) | **wire のフィールド順が Claude Code ハーネスの truncation 挙動に従属**。「`msg` を最後に置く」「session role の時だけ 400 バイトで本文を `msg_via` に差し替える」。`WIRE_MSG_SAFE_BYTES` の 400 は「~140 サンプルの実測で 500 文字クラスタが見えたのでその 8 割」 |
| 2 | 同上の `echo` 分岐 | 自分の post が返ってくる時だけ本文を落として `echo: true` を付ける (DR-0003 §5 Addendum)。oversize と同じ `msg_via` を再利用している |
| 3 | `RECENT_REPLAY_WINDOW_MS` (server.ts:433) | 「post → 相手がまだ subscribe を張っていない → 黙って落ちる」への対策として 3 分の巻き戻し窓。**プロトコルの配送保証の穴を時間窓で塞いでいる** |
| 4 | `agents.ts` の config dir 毎回再走査 | 「daemon の env は respawn で CLAUDE_CONFIG_DIR 系設定を失いうる (known issue)」という**上流の既知バグへの回避策**が、5s ごとの `$HOME` 走査として常駐している |
| 5 | `session-rename.ts` 全体 | 「`/rename` スラッシュコマンドがタイトルの唯一の writer」なので**ターミナルにキー入力を送る**。API が無いことへの回避策が 1 op になっている |
| 6 | `transcript.ts` の ino + birthtime + sawMissing の 3 段判定 | ext4 の inode 再利用という**特定 FS の挙動**への対策。「CI-only failure、v0.19.0 の run #29160237229 で観測」 |
| 7 | `fs_list` / `fs_read` / `transcript_read` の `allowVirtual: role === "user"` | role が**可否ではなく可視範囲**を決める 3 op。他 34 op の role 分岐 (拒否) と意味が違うのに見た目が似ている |
| 8 | `sendReplyViaTlError` (server.ts:364) | room が null かどうかで文言を変える。「create_room/next_room の pre-check 経路では room がまだ無いので room id を含めない」 |

### 5.7 エラーコード体系のばらつき

- 全体で **28 種の `ErrorCode`** を使うが、分布が極端: `invalid_args` 70 回 /
  `bad_request` 41 回 / `not_found` 31 回 / `path_forbidden` 27 回 で **169 / 231 = 73%**。
  残り 24 種は 1〜12 回。
- **role 拒否 35 個が全て `bad_request`**。「認可の失敗」を表す専用コードが無く、
  引数不正と同じコードで返る。`hello_required` は専用コードがあるのと非対称。
- **`ErrorCode` を経由しない生文字列が 2 箇所**: `"internal"` (dispatch の catch-all と
  session_rename の hyoui 失敗)。`ErrorCode` に `internal` が無いのか使っていないだけかは
  protocol 側の棚卸しに委ねる。
- `not_found` (31) と `session_not_found` (12) / `room_not_found` (11) / `msg_not_found` (1)
  が併存する。粒度の使い分け規則は明文化されていない。

### 5.8 hello の能力フラグ増殖

hello の返信は user role に対して**最大 6 個の capability フラグ**を返す
(`terminal_gateway_url` / `llm_usage_available` / `llm_stats_available` /
`llm_status_available` / `sandbox_available` / `fork_available`)。webui 棚卸しは
7 個と数えている (protocol 側の `protocol` バージョンを含むか等で差が出る)。

構造上の特徴 (server.ts:1913-1951、**フラグ 6 個に対しコメント 26 行**):

- 6 個すべてが `newId.role === "user" && <config が設定済みか>` の同型
- 「URL 自体は渡さない、設定済みかの boolean だけ」という判断が 3 回繰り返し説明されている
  (「fetch するのは daemon 側だから」「usage とは独立に設定できるから」
  「client が触るのは完成 URL だけだから」)
- **同じ config の有無が 2 箇所で判定される**: hello の capability と、対応する op
  ハンドラ内の `<x>_not_configured` エラー。片方だけ変えると
  「導線は出るが押すと必ずエラー」または逆になる (コメント自身がその失敗を回避理由として挙げている)

### 5.9 role による分岐の散らばり

daemon 全体で role を比較する箇所は **95 箇所** (`role === "…"` / `role !== "…"` の実測)。用途は 5 種類に分かれる:

| 用途 | 箇所数 (概算) | 例 |
|---|---|---|
| op の拒否 (user 限定) | 35 | `session_kill`、`fs_*` 系 |
| op の拒否 (session 限定) | 2 | `say` |
| 可視範囲の切替 | 3 | `allowVirtual: role === "user"` |
| 配信先の絞り込み | 8 | `broadcastSessionErrors` / `notify` / `sendLlmRequests` が `role !== "user"` を skip |
| wire フレームの整形 | 2 | `redirectOversize = role === "session"` (oversize 差し替え)、`peersFor` の分岐 |
| hello の capability | 6 | §5.8 |
| ドメインルール | 多数 | 1on1 の `from === ADMIN_ID` 判定、`recipientId` の `ADMIN_ID` 解決、broadcast への post 制限 |

**「user は webui、session は CLI」という運用上の前提が、認可 (35) と配信 (8) と
表示整形 (2) と capability (6) に散っている**。これらは同じ role フィールドを
別の目的で読んでおり、role を増やす / 分ける変更が 4 系統に波及する。

### 5.10 その他

- **`config` は起動時 1 回しか読まない** (DR-0018 LN-Q4)。`allowed-origins.json` だけが
  mtime gate で無再起動反映される。同じ config ディレクトリの中で 2 つの流儀が併存する。
- **`ccmsg-config.d.ts` を daemon が毎起動時に上書きする** (config.ts:547)。
  ユーザの config ディレクトリに daemon が書き込む唯一の生成物。
- **`writeConfigTypesFile` が `loadConfig` より前に走る**ので、型定義の更新は
  次回起動時の config 読み込みからしか効かない。
- `session-dump.ts` が `session-status.ts` の内部関数 (`createSessionStatusState` /
  `foldLine` / `snapshot`) を直接 import している。dump は「購読なしで 1 回だけ fold する」
  ため store を経由しない — **fold のライフサイクル管理を持つ経路と持たない経路が並存**。
- `virtual-sessions.ts` の cwd 検出は transcript 先頭 **4MB** を 64KB chunk で走査する。
  この上限の根拠は書かれていない。
- `storage.ts` は破損した末尾行を検出すると **ファイルを切り詰めて書き戻す**
  (`fs.writeFileSync(tornPath, raw.subarray(keepLen))`、storage.ts:311)。
  append-only を謳う唯一の破壊的書き込み。

---

## 6. 数値まとめ

| 指標 | 値 |
|---|---|
| src ファイル / 行 | 52 / 19,914 |
| test ファイル / 行 | 72 / 31,252 |
| コメント行 (src) | 5,206 (26%) |
| `server.ts` | 4,008 行 (src の 20%)。`dispatch` は 1,818 行 (server.ts の 45%) |
| 上位 4 ファイル合計 | 8,601 行 (src の 43%) |
| op 数 | 55 |
| `IDENTITY_OPS` (hello 必須) | 43 |
| user role 限定ガード (同型コピー) | 35 |
| session role 限定ガード | 2 |
| role の比較箇所 (全体) | 95 |
| hello の capability フラグ | 6 |
| push event 種別 (`ev:`) | 12 |
| `Daemon` interface のフィールド | 22 |
| メモリに持つ可変状態 | 22 種 (うち永続化 2、外部マスタ 9) |
| 永続化ファイル | 10 種 |
| 使用中の `ErrorCode` | 28 種 / 延べ 231 回 (上位 4 種で 73%) |
| 生文字列のエラーコード | 2 箇所 (`"internal"`) |
| 参照 0 の export | 17 (完全 dead 1 / 自ファイル内のみ 16) |
| テストが import しない src モジュール | 7 (うち認可境界 3) |
| タイマー / ポーリング | 8 種 (実測根拠あり 2) |
| 子プロセス起動箇所 | 9 種 (`claude` / `ps` × 2 / `route` / `scutil` / `hyoui` / `tailscale` / launcher shell / translate helper) |
| 外部 HTTP fetch | 3 種 (llm_usage / llm_stats / llm_status)、いずれも `llm-gateway.ts` 経由 |
| HTTP ルート | 5 (`/ws`, `POST /attachment`, `GET /attachment/*`, `POST /webhook/*`, `GET /fs-serve`) + sandbox の Host 分岐 + webui fallback |
| 環境変数 | 13 (うちテスト専用と明記 6) |
| DR 参照 | 延べ 244 箇所 / 26 種 |
| 会話由来の出典 (`kawaz r<N>`) | 22 箇所 |
| 外部 npm 依存 | 0 |
