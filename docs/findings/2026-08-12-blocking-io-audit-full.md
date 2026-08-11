# 同期 IO・イベントループ阻害の全量監査 (DR-0029)

issue `2026-07-31-audit-blocking-io-paths` の受け入れ条件 1〜3 を満たす全量監査。
`2026-07-31-blocking-io-audit.md` (以下「前回」) の続きで、そちらが挙げた項目の
現状 (v0.100.2) を再確認しつつ、経路単位で全ての同期 API 呼び出しを仕分けた。

## 判明した事実

- 前回の high 4 件のうち **3 件は既に解消済み** (実機コード確認)。
  `scanTranscript` は `scanTranscriptLines` として chunk ごとに
  `yieldToEventLoop()` する非同期実装に、`session_search` は
  `fs.promises` + open handle に、attachment upload は `Bun.write` の
  非同期ストリーミングに置き換わっている。`readAgentToolUseIds` は
  full read から **incremental tail scan + per-path キャッシュ** になり、
  定常状態のコストは追記分のみに落ちている (ただし同期 API のまま、初回/
  キャッシュ evict 後は全長を同期リード)。
- 前回 medium だった `client_trace`/`trace.ts`、`fs-find`/`dir-tree` の走査系は
  非同期化済み (`fs.promises`、FileHandle 保持)。
- **現在の最大の残件は `session-status.ts` の `snapshot()`**。status push
  (= transcript が 1 行伸びるたび) に、`readAgentTree` / `readTeammateModels` /
  `readWorkflowDrilldown` / `discoverWorkspaceFolders` が **全て同期 fs** で走る。
  subagent や workflow が多いセッションほど readdir + per-file readFileSync +
  statSync の積み上がりが大きく、fs.watch コールバック内で完結するため
  全クライアントの WS 配信を止める。前回 high #1 の周辺は直ったが、
  その呼び出し元である snapshot 全体は同期のまま残っている。
- `fs-access.ts` は **部分的にしか非同期化されていない**。`fsList` /
  `fsListWorkspace` / `fsEdit` / `fsCreate` / `fsDelete` は async 化されたが、
  **`fsRead` と `fsWrite` は同期関数のまま** で、`resolveContained` の
  realpath 祖先ウォークも全経路が `realpathSync`。fs_read は最大
  `FS_READ_MAX_BYTES` を同期リードする。
- webui は前回同様、同期 fs は無く memo 化も行き届いている。ただし
  **live-tail 1 行ごとに transcript 全行を走る cross-line パスが複数ある**
  (pairQueuedTurns / offsets / groupTimelineLines / boundaries 等)。per-line
  parse は `incremental-line-map.ts` で差分化済みだが、その後段の全走査は
  差分化されていない。DOM 規模 (別 issue) とは独立した CPU コスト。
- daemon に worker_threads / child_process へのオフロードは依然として存在しない。

## 仕分けの総数

| 区分 | 件数 |
|---|---|
| 非同期化する: high | 4 |
| 非同期化する: medium | 8 |
| 非同期化する: low | 5 |
| 性質上同期で問題ない | 17 |
| 合計 (経路単位) | 34 |

行単位の同期 API 呼び出しは daemon 130 / cli 8 / hooks 12 箇所あるが、
同一経路のものは 1 項目にまとめている。

## 非同期化する (優先度順)

### high

| # | ファイル:行 | API / 処理 | 経路 | 何が起きるか |
|---|---|---|---|---|
| H1 | `session-status.ts:981` `snapshot()` — 内部で `readAgentTree` (1297/1314/1325 `readdirSync` ×3 階層 + `loadAgentMeta` 1550 `readFileSync` / 1557,1560 `statSync` を meta ごと) | 同期 fs 多数 | `pushSnapshot` ← transcript tail listener (fs.watch コールバック) | status push (transcript 1 行ごと) に subagents/ と workflows/<run>/ を readdir し、meta 1 個ごとに readFileSync + statSync。agent 数に比例して WS 配信が止まる |
| H2 | `session-status.ts:1036` `discoverWorkspaceFolders` → `workspace-folders.ts:180,195,212,221` | `readdirSync` + `readFileSync` + `realpathSync` + `statSync` | 同上 (snapshot 内、cwd がある全セッション) | push ごとに cwd 直下を readdir し、`*.code-workspace` を毎回パースして folder ごとに realpath+stat。キャッシュ無し |
| H3 | `fs-access.ts:456` `fsRead` → `readRegularFile` (406 `lstatSync` / 417 `openSync` / 421 `readSync` ループ / 426 `closeSync`) | 同期リード (最大 `FS_READ_MAX_BYTES`) | op `fs_read` / `fs_read_external` dispatch 内 | ファイルビューアで大きいファイルを開くたび、読み切るまでイベントループが止まる。周辺の fsList/fsEdit は既に async なので、この 2 つだけ取り残されている |
| H4 | `fs-access.ts:862` `fsWrite` (933 `lstatSync` / 947 `mkdirSync` / 972 `writeFileSync`) と `fsEdit` の 1091 `writeFileSync` / 1073-1077 の sniff read | 同期ライト | op `fs_write` / `fs_edit` dispatch 内 | 保存のたびに全内容の同期 write。attachment upload が `Bun.write` に移った理由 (DR-0029 のコメントが `attachment.ts:177` に残っている) がそのまま当てはまる |

### medium

| # | ファイル:行 | API / 処理 | 経路 | 理由 |
|---|---|---|---|---|
| M1 | `virtual-sessions.ts:37,48,61,67,90,110` `resolveVirtualRoot` → `scanTranscriptCwd` | `readdirSync` + `lstatSync` + 最大 4MB (`CWD_SCAN_MAX_BYTES`) の `readSync` ループ | `fs-access.ts:142` `resolveRoot` ← 未接続 sid への `fs_list` / `fs_read` | 未接続セッションを閲覧するたび、全 config dir の projects/ を readdir し transcript を最大 4MB 同期スキャン。上限はあるが 1 op あたりの停止時間として大きい |
| M2 | `session-status.ts:1220,1178-1204` `readAgentToolUseIds` / `scanAgentToolUseIdsFrom` | `statSync` + `openSync`/`readSync`/`closeSync` | snapshot → `readAgentTree` (push ごと) | 前回 high #1。incremental 化で定常コストは追記分のみになったが、同期 API のままで、初回・キャッシュ evict (512 ファイル上限)・inode 変化時は全長を同期リード |
| M3 | `session-status.ts:1000` `readWorkflowDrilldown` → `workflow-drilldown.ts:74,184` | `readFileSync` ×2 (state.json + journal) | snapshot 内、workflow ごと | push ごと・run ごとに state.json と journal を再読込。キャッシュ (mtime 比較) が無い |
| M4 | `session-status.ts:1056-1071` `readTeammateModels` | `readdirSync` + meta ごと `readFileSync` + `statSync` | snapshot 内 (teammate が 1 人以上のとき) | H1 と同じディレクトリを push ごとにもう一度 readdir + 全 meta パース。H1 と統合してキャッシュ化するのが筋 |
| M5 | webui `Timeline.tsx:3014,3020,3028,3032,3053,3066` — `pairQueuedTurns` / offsets / `groupTimelineLines` / boundaries / ccmsgTargets / userNavTargets | 全行を走る純 CPU パス (複数) | live-tail 到着ごとの再レンダー | per-line parse は `incremental-line-map.ts` で差分化済みだが、その後段の cross-line パスは毎回全行。長いセッションほど 1 行追記あたりの CPU が伸びる (DOM 規模とは別要因) |
| M6 | webui `store.ts:917` `lines: [...prev.lines, ...action.lines]` | 全行の配列コピー | reducer `timeline/tail` (tail イベントごと) | 1 行追記ごとに N 要素の配列を作り直す。参照コピーなので軽いが O(N)、M5 の再計算トリガでもある |
| M7 | webui `highlight.ts:191` `codeToTokens` | Shiki トークナイズをメインスレッド同期実行 | FileViewer / CodeBlock の描画 | 既知 (前回 medium)。async 包装のみで実体は同期。Web Worker 化候補 |
| M8 | `hooks/user-prompt-submit.ts:201` `Bun.spawnSync(["ps","-axww"])` | プロセス起動 (~50ms、上限 1s) | UserPromptSubmit フック 毎ターン | 既知 (前回 medium)。同期なので `armHookDeadline` で中断できない。`deadline.ts` に「spawnSync の timeout は実測で有効」の意図的選択の記録があるので、非同期化するならその検証を引き継ぐ |

### low

| # | ファイル:行 | API / 処理 | 経路 | 理由 |
|---|---|---|---|---|
| L1 | `origins-file.ts:30,39` `reload()` | `statSync` (+ mtime 変化時のみ `readFileSync`+`JSON.parse`) | `http.ts:174,242` — **HTTP/WS リクエストごと** | 毎リクエスト 1 回の statSync。パース結果は mtime キャッシュ済みなので実コストは stat 1 回だが、リクエストパスに同期 fs がある事実は DR-0029 的に潰しておきたい |
| L2 | `fs-access.ts:265,563,1203` `resolveContained` の realpath 祖先ウォーク | `realpathSync` をパス深さ分ループ | 全 fs_* op (async 化済みの op も含む) | async 関数の中に同期 realpath が残っている。1 回は軽いが深いパスで回数が伸びる。`realpathOrSelf` (172) は既に `fs.promises.realpath` なので置換先は既存 |
| L3 | `fs-access.ts:77` `validateRepoRoot` (85,86,94 `realpathSync` ×3) | 同期 realpath | op `hello` | v0.100.2 の realpath 修正時に既知として残置。hello は接続ごと 1 回で頻度は低いが、経路としては op ハンドラ内 |
| L4 | `agent-transcripts.ts:131,165,184,195,213` `resolveAgentTranscript` | `realpathSync` / `lstatSync` / `readdirSync` / `readFileSync` | op `transcript_read` (agent 指定時)、session-status/transcript から | 1 op あたり subagents/ の readdir + meta 読み。回数は少なく入力も小さい |
| L5 | `session-status.ts:151,168,224,230` `resolveExternalRoot` / `resolveWorkspaceAnchor` の realpath | `realpathSync` ループ | `getSessionStatus` / `subscribeSessionStatus` | op ごと数回。L2 と同じ性質 |

## 性質上同期で問題ない

| # | ファイル:行 | API | 経路 | 理由 |
|---|---|---|---|---|
| S1 | `transcript.ts:503` `checkNow` (506 `statSync`、461 `openSync`、91 `readSync`、476 `closeSync`) | 同期 fs | fs.watch コールバック / ポーリングタイマー | **意図的に同期**。コード内 doc comment が明記するとおり、途中で yield しないことで再入ガードを不要にしている。読み取り窓は `TRANSCRIPT_READ_MAX_BYTES` / `TRANSCRIPT_LINE_SCAN_MAX` (4MB) で上限付き。非同期化するなら再入設計をやり直す必要があり、コスト対効果が合わない |
| S2 | `storage.ts:360-362` `appendEvent` の `openSync`/`writeSync` | 同期 write | `deliver()` 前 | fd 保持 + fsync は 100ms debounce 済み。1 行 append の write(2) のみで、書いてから配信する順序が耐久性の前提 |
| S3 | `storage.ts:399,415,426` fsync/close | `fsyncSync` / `closeSync` | debounce タイマー / シャットダウン | debounce 済み、または終了処理 |
| S4 | `storage.ts:256,293,294,304,473` `loadRoom` / `scanRooms` | `readFileSync` / `truncateSync` / `readdirSync` | daemon 起動時の room 復元 | 起動時 1 回。この時点で配信すべきクライアントは居ない |
| S5 | `log.ts:35,56,58,69,81` | `writeSync` / `openSync` / `fstatSync` / `renameSync` | ログ出力 | 前回記録どおり、exit 直前行の保全のため**意図的に同期**。rationale はコード内 |
| S6 | `flock.ts:36-55` | `openSync` / `ftruncateSync` / `writeSync` / `closeSync` | 起動時の多重起動防止ロック | 起動時 1 回、かつロック取得は同期でないと意味が薄い |
| S7 | `server.ts:3016,3021,3073,3074,3086,3232,3233` | `mkdirSync` / `unlinkSync` / `existsSync` / `chmodSync` / `writeFileSync` | 起動・終了処理 | listen 前 / 終了時。イベント処理経路ではない |
| S8 | `server.ts:700` `buildWebhookSources` の token 読み | `readFileSync` | 起動時の webhook 設定構築 | 起動時 1 回、小ファイル |
| S9 | `config.ts:521` `loadConfig` | `readFileSync` | 起動時 1 回 (doc comment に LN-Q4 の明記あり) | 同上 |
| S10 | `attachment.ts:161,173` `mkdirSync` / `existsSync` | 同期 fs | upload ハンドラ | 本体の書き込みは `Bun.write` で非同期化済み (DR-0029 コメントあり)。残るのは dir 作成 1 回と衝突検査 1 回で、いずれも定数コスト |
| S11 | `attachment.ts:245,258` serve 側 | `statSync` 1 回 + `Bun.file` | 添付配信 | stat 1 回 + ゼロコピーストリーミング。前回の判定を踏襲 |
| S12 | `fs-serve.ts:80` / `sandbox.ts:464` の `readFileSync` | 同期リード | HTTP 配信 | `Bun.file` が使える環境では通らないフォールバック (plain Node / テスト) |
| S13 | `launcher-paths.ts:30,45,56` `containedInRoots` | `realpathSync` / `statSync` | `dir_tree` / `session_launch` | 定数回 (候補パスと設定ルートのみ)、op 頻度も低い |
| S14 | `translate-helper.ts:73,256,284,291` | `accessSync` / `statSync` / `existsSync` / `mkdirSync` | ヘルパのビルド判定 | 実ビルドは `spawn` + await で非同期、`buildPromise` で多重実行も排除済み。ここは stat 数回のみ (前回結論を踏襲) |
| S15 | `session-dump.ts:249,269,278,524,539,639,652` | `readFileSync` / `readdirSync` | CLI サブコマンド `session-dump` のみ (daemon から import されていない) | 単発 CLI プロセス。イベントループを共有する相手が居ない |
| S16 | `cli/index.ts:144,203,929,936,937` / `subscribe-owner.ts:16,44` | 同期 fs | CLI 起動時・単発サブコマンド | 同上。対象ファイルも小さい |
| S17 | `hooks/session-start.ts:280,281,301,308,354,365,366,397` | `writeFileSync` / `readdirSync` / `statSync` / `unlinkSync` / `accessSync` / `existsSync` | SessionStart フック | 短命プロセスの起動時処理。件数は state dir 内の小ファイルのみ |

## 補足

- H1〜H4 と M1〜M4 は全て **daemon のイベントループ独占**という同じ根に繋がる。
  前回の「体感の詰まりの主因は daemon 側」という結論は、snapshot 経路が
  丸ごと残っている点で今も有効。
- H1/H2/M3/M4 は「push ごとに毎回ディスクを読み直す」という共通の構造を
  持つので、非同期化と同時に **mtime ベースのキャッシュ**を入れるのが
  自然な形になる (`origins-file.ts` が既にその型を持っている)。
- M5/M6 は Timeline の DOM 規模 (別 issue `2026-07-29-timeline-virtual-scroll`)
  とは独立した CPU コスト。仮想スクロール導入で DOM を減らしても、
  cross-line パスの全走査は残る。
