# daemon/webui の同期 IO・イベントループ阻害の監査 (DR-0029)

kawaz r99m5「IO を伴うイベントやメッセージは全て非同期化を原則に。今もまだ色んな
ところで詰まりを感じる」を受けた全体監査の結果。調査は read-only worker (opus5-medium、
2026-07-31)、high #1 の幽霊上限は統括が実機 grep で裏取り済み。

## 判明した事実

- daemon はほぼ全ての op ハンドラが `dispatch()` 内で同期 fs を直接叩いており、
  1 クライアントの重い要求が全クライアントの WS 配信を止める構造。worker_threads /
  child_process へのオフロードは daemon 全体に存在しない
- webui は memo 化が徹底されており、Timeline の DOM 規模 (別 issue
  `2026-07-29-timeline-virtual-scroll`) を除けば high は無し。**体感の「詰まり」の
  主因は daemon のイベントループ独占の可能性が高い**
- `packages/daemon/src/transcript.ts` は全経路が上限付き・ウィンドウ化されており、
  他モジュールが倣うべき良い実装例

## high (ユーザ体感の詰まりに直結)

| # | 箇所 | 何が起きるか | 頻度 |
|---|---|---|---|
| 1 | `session-status.ts:1056` `readAgentToolUseIds` | ルート + 全 subagent transcript を `readFileSync` フルリード + 全行走査 | status push のたび (transcript が 1 行伸びるたび) |
| 2 | `session-search.ts:657` `sessionSearch` | 最大 256MB を無 yield で `readSync` + `JSON.parse` | 検索 1 回ごと |
| 3 | `session-status.ts:1444` `scanTranscript` | transcript を先頭から全走査、dispatch 内で完全同期 | `session_status(_subscribe)` の初回・再接続・truncate 検知時 |

- #1 補足 (統括裏取り済み): doc comment は「Read is bounded by
  MAX_TRANSCRIPT_SCAN_BYTES」と主張するが、**この識別子はコメント 1 行以外に
  リポ内に存在しない**。上限は未実装で実際は無制限リード。「対策済み」に見える
  コメントが見落としの原因になっていた
- #1 のトリガ経路: `subscribeSessionStatus` listener → `pushSnapshot` →
  `snapshot()` → `readAgentTree` → `readAgentToolUseIds`。subagent 多用セッション
  ほど悪化
- #3 は `session_search` が使う 2 フェーズ返信 (server.ts:1078) を通らず dispatch
  内で直接実行。truncate 検知時は fs.watch コールバック内から同じフルスキャン

## medium

- `server.ts:2397` `client_trace` + `trace.ts` — 1 リクエスト最大 8 点、各点で
  `statSync` + `appendFileSync` (fd 非保持)。webui タブが transcript 更新のたびに
  投げる。バッチ 1 回書きで syscall 1/16
- `fs-access.ts:341,606` / `fs-find.ts:83` / `dir-tree.ts:66` — `readdirSync` +
  エントリごと `lstatSync` の同期走査 (ファイルブラウザ・cwd 選択)。dir-tree.ts の
  コメント自身が stall リスクを自認 (深さ 5 制限のみで幅無制限)
- `storage.ts:357` `appendEvent` — `deliver()` の前に同期 write (fd 保持 + fsync
  100ms debounce 済みなので 1 回は軽い)
- `log.ts:16,38` — trace と同じ open/write/close パターン (低頻度)
- webui `highlight.ts:191` — Shiki tokenizer がメインスレッド同期実行 (async 包装
  のみ)。コメントが 200KB 未満でも jank と自認。Web Worker へのオフロード候補
- `hooks/user-prompt-submit.ts:201` — `Bun.spawnSync(["ps","-axww"])` 毎ターン実行
  (~50ms、上限 1s、同期なので armHookDeadline で中断不可)。ただし deadline.ts に
  「spawnSync の timeout は実測で有効」の意図的選択の記録あり、非同期化するなら
  その検証を引き継ぐこと

## low

- webui `SessionList.tsx:286,352` の useMemo 外 map/Set (毎レンダー、軽量)
- 起動・終了時のみの同期 fs (storage/config/flock/server 終端処理)
- CLI 起動時・単発サブコマンドの同期 fs (対象ファイル小)

## 未確認 (追加調査候補)

- `attachment.ts:161-255` の同期 fs が Bun.serve fetch ハンドラ経由で WS 配信と
  同じループに乗るか (大きい添付なら high になりうる)
- `translate-helper.ts` の `build()` がコールドスタート時にリクエスト中で同期実行
  されうるか
- `fs-find.ts` FS_FIND_VISIT_MAX / `fs-access.ts` FS_STAT_BATCH_MAX_PATHS の実効値
