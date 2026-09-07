# 新 webui に残す機能のチェックリスト

- 日付: 2026-09-07
- 位置づけ: DR-0032 §2.2 の 3「移す対象は棚卸しの一覧から『残す機能のチェックリスト』を
  作って決める」の、そのチェックリスト。
- 一次資料: `docs/findings/2026-09-07-webui-component-inventory.md`、`docs/decisions/` の各 DR。
- **書くのは「何を残すか」だけ**。どう作るか (状態層の分割・ファイル構成・移行順) は書かない。

## 判定の語彙

| 判定 | 意味 |
|---|---|
| **移す** | 新 webui に同じ機能を用意する。実装は作り直してよいが、機能としては欠かさない |
| **落とす候補** | 移植しない。根拠は「参照 0」「テスト未 import かつ他機能で代替可能」「二重実装の片側」「別機能の場当たり回避」のいずれか |
| **保留** | kawaz 裁定が要る。主に「使われているか不明」「Proposed 止まりの DR の扱い」「クラスタ化 (DR-0032 §2.3) で意味が変わる」もの |

判定の根拠は棚卸しの事実とコード上の事実のみ。セッションログは漁っていないので、
「使用実績が不明」なものは落とさず保留に倒した。

---

## 1. Sessions 一覧 (サイドバー左)

由来の中心は DR-0001 (peers)、DR-0021 (pinned / 検索結果の常設)、
`docs/issue/2026-09-06-session-list-sections.md` (セクション分け)。

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| 稼働セッション (peers) の一覧表示 | `SessionList.tsx` / `op:peers` | DR-0001 | 移す | webui の中核。これが無いと何も始まらない |
| セッション行のクリックで TL を開く | `SessionList.tsx` → `locator.ts` | DR-0004 | 移す | 主動線 |
| agents (subagent) 行の表示 | `SessionList.tsx` / `op:agents` | DR-0025 | 移す | Timeline の agent 切替と対で使われる |
| pinned セッション (過去セッションの常設) | `pinned-sessions.ts` + `AppState.pinnedSessions` | DR-0021 | 移す | 検索結果を手元に残す唯一の手段 |
| 「前回稼働中」セクション | `last-live-sessions.ts` / `op:last_live_remove` | issue 2026-09-06-session-list-sections | 移す | daemon 側 op があり、削除操作まで実装済み |
| セクション分け (稼働 / agents / pinned / 前回稼働) | `utils.ts` + `SessionList` の `useMemo` 9 個 | 同上 | 移す | ただし派生の置き場は実装判断 |
| 並び替えキーの切替 (`peerSortKey`) | `AppState.peerSortKey` + localStorage | — (DR なし) | 移す | 永続化済み = 使われている前提が立つ |
| セッション行の D&D で room へ招待 | `dnd.ts` + `op:invite` | DR-0011 | 移す | DR-0011 が明示的に導入した操作 |
| セッション行の mini ステータスバッジ | `session-status-view.ts` | DR-0020 | 移す | Status タブと同じ派生を共有 |
| セッションのエラー表示 (`sessionErrors`) | `op/ev:session_errors` | — | 移す | 障害に気づく唯一の一覧上の手掛かり |
| セッション改名 (`op:session_rename`) | `ws.ts:378` 付近 | DR-0021 周辺 | 保留 | UI 呼び出し元が一覧なのかヘッダなのかコードから一意に読めない |
| `utils.SID_SHORT_LEN` | `utils.ts` | — | 落とす候補 | 参照 0 (棚卸し §5.4) |

---

## 2. Timeline (transcript 表示)

`Timeline.tsx` 4,918 行 / 40 関数コンポーネント。**機能の塊としては最大**なので、
行の種類ごとの表示部品を 1 行ずつではなくグループで判定する。

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| transcript の購読と追記表示 | `Timeline()` + `op:transcript_subscribe` | DR-0009 | 移す | 中核 |
| jsonl 行 → 表示イベントの変換 | `transcript-model.ts` (2,716) | DR-0009 | 移す | 純関数層。テスト厚く、そのまま持てる |
| 行またぎ派生 (tool_use / tool_result 結合) | `incremental-cross-line.ts` | DR-0009 | 移す | 表示の正しさに直結 |
| 行単位の差分再計算 | `incremental-line-map.ts` | DR-0009 | 保留 | `transcript-model` + cross-line と合わせ 3 層 (棚卸し §5.1)。層として要るかは実装時の観測が要る |
| assistant 発言の Markdown レンダリング | `markdown-view.tsx` (1,868) | DR-0010 | 移す | DR-0010 Accepted、restricted / full の 2 モードとも現役 |
| markdown リンクの URL ポリシー | `markdown-link.ts` | DR-0010 | 移す | allowlist はセキュリティ境界 |
| GFM タスクリストのトグル | `markdown-task-list.ts` | DR-0010 | 移す | ソーステキスト側を書き換える実装があり単なる表示ではない |
| issue 参照のリンク化 | `issue-ref.ts` | — | 移す | dogfooding の日常動線 (docs/issue 運用) |
| `issue-ref.roomRefUrl` | 同上 | — | 落とす候補 | 参照 0 |
| コードブロックの Shiki ハイライト | `highlight.ts` + `CodeBlock.tsx` | DR-0010 | 移す | |
| thinking ブロックの表示・折り畳み | `ThinkingSegment` / `HiddenThinkingSegment` | DR-0009 | 移す | |
| 行の種類別表示部品 (Bash / Agent / File 系 30 個) | `Timeline.tsx` 内 | DR-0009 / DR-0025 | 移す | 「TL が読める」ことの実体。粒度の再設計は実装判断 |
| fold (折り畳み) の開閉 | `Fold.tsx` + `fold-open-store.ts` + `useFoldOpen` | DR-0020 | 移す | |
| 囲む fold の判定 (モデル側) | `fold-tree.ts` | DR-0022 | 移す | 検索で「隠れた一致」を開くために要る |
| 自動で開く category の判定 | `timeline-auto-open.ts` | DR-0020 | 移す | |
| fold グループ化 | `FoldGroup` | DR-0020 | 移す | |
| ccmsg メッセージ吹き出し | `CcmsgBubble` + `op:read` | DR-0027 | 移す | DR-0027 Accepted、daemon 一次情報での復元は現役 |
| AI 発 post/reply の TL 表示 | `PeerCcmsgLineView` | DR-0027 | 移す | 同上 |
| say バブルの配置 | `say-merge.ts` + `op:say_read` | — | 移す | daemon 側 op あり |
| fork 境界の表示 | `fork-point.ts` / `fork-divider.ts` / `ForkDivider` / `op:fork_origin` | — | 移す | `forkAvailable` の hello フラグ付きで能力交渉済み |
| 位置 pin と着地スクロール | `timeline-position.ts` + `navigation.ts` の `timelinePositions` | DR-0004 | 移す | URL で TL の一点を指せることは共有動線 |
| 自動追随 (追記時の追尾) | `Timeline()` 内 | — | 移す | |
| in-view 検索 (ハイライト + index 移動) | `in-view-search.ts` + `SearchBar.tsx` + `rendered-text-search.ts` | DR-0022 | 移す | DR-0022 Accepted |
| `in-view-search.unitMatches` | 同上 | DR-0022 | 落とす候補 | 参照 0 |
| `SearchTargetToggles` / `SearchFoldScopeToggle` | `SearchBar.tsx` | DR-0022 | 保留 | export された UI 部品が参照 0。検索スコープ切替 UI が意図的に未接続なのか、退化したのか不明 |
| raw JSONL 表示モード | `RawLineRow` + `raw-view-mode.ts` | — | 移す | デバッグ動線として日常的 |
| `raw-view-mode` の購読 API 3 つ | `RAW_PRETTY_KEY` / `getRawViewPretty` / `subscribeRawViewPretty` | — | 落とす候補 | 参照 0、購読機構だけが浮いている |
| 翻訳 (host / browser 2 経路) | `translate.ts` + `useTranslatedText` + `op:translate` | DR-0023 | 移す | DR-0023 Accepted (PoC 全項目成立)、hello の能力フラグ付き |
| dump 出力アクション | `DumpFileAction` + `session-dump-action.ts` + `op:session_dump_file` | — | 移す | daemon op と純関数層が揃っている |
| ミニ status パネル (TL 内) | `Timeline()` + `session-status-view.ts` | DR-0020 | 移す | Status タブと派生を共有 |
| 右端フロートパネル | `timeline-side-panel.ts` + `Timeline()` | — | 保留 | Status タブ・ツールバーと役割が重なる。統合可否は kawaz 裁定 |
| メッセージ hover ツールバー | `Timeline()` ツールバー | issue 2026-08-20-timeline-message-hover-toolbar | 保留 | issue が active。新 webui で作り直すなら仕様確定が先 |
| 配信レイテンシ計測 | `trace.ts` | — | 保留 | 開発用計測。新 webui で同じ計測が要るかは未定 |
| `prefers-reduced-motion` の尊重 | `Timeline.tsx:4417` | — | 移す | アクセシビリティ |
| ccmsg 本文キャッシュ | `CCMSG_BODY_CACHE` (`setBounded`) | DR-0027 | 移す | 上限付きで実害なし |
| agent TL では位置 pin を書かない分岐 | `Timeline.tsx:3122-3140` | — | 落とす候補 | URL 文法の制約が component 分岐に漏れた場当たり (棚卸し §5.6)。**ただし §12 の URL 文法で agent + position を同時に表せるようにするのが条件** |
| `TimelineItem.tsx` (room チャットの 1 行) | `TimelineItem.tsx` | DR-0003 | 移す | 機能としては §5 Rooms 側。名前が Timeline と紛らわしいだけ (棚卸し §5.1) |
| `TimelineItem.issueRepoForRoom` | 同上 | — | 落とす候補 | 参照 0 |
| `transcript-model` の 3 export | `isThinkingEntry` / `isSpawnPromptLine` / `parseSlashCommandPrompt` | DR-0009 | 落とす候補 | 参照 0。ただし純関数なので移植コストはほぼゼロ、実際に要るなら復活は容易 |
| `timeline-summary.ts` | 同上 (24 行) | — | 保留 | 24 行で責務コメントが無い (棚卸し §5.9)。何の要約かがコードから読み切れない |

### 2.1 セッションツリー左ペイン (Timeline の隣)

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| Teammates / Agents / Workflows のツリー表示 | `AgentTreePanel.tsx` (566) | DR-0025 | 保留 | DR-0025 は **Proposed のまま**。実装は入っているが、正式仕様として残すか kawaz 裁定 |
| ツリーから各 agent TL へ遷移 | `AgentTreePanel` + `locator` の `agent` | DR-0025 | 保留 | 同上 |
| agent 間通信 segment の提示 | `agent-communication-view.ts` | DR-0025 | 保留 | 同上。責務コメントが無いモジュールの 1 つ |
| `agent-tree-view.isErrorState` | `agent-tree-view.ts` | DR-0025 | 落とす候補 | 参照 0 |

---

## 3. Files タブ

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| ディレクトリツリーの遅延ロード | `FileTree.tsx` + `op:fs_list` / `op:dir_tree` | DR-0008 | 移す | DR-0008 Accepted |
| ファイル本文の表示 (行番号付き) | `FileViewer.tsx` + `op:fs_read` | DR-0008 | 移す | |
| Shiki シンタックスハイライト | `highlight.ts` | DR-0008 | 移す | |
| ファイル内検索 | `in-view-search.ts` + `SearchBar.tsx` | DR-0022 | 移す | Timeline と共用 |
| markdown プレビュー切替 | `FileViewer` + `files-view-store.ts` | DR-0010 | 移す | |
| 選択ファイルの per-sid 記憶 | `files-view-store.ts` (localStorage) | — | 移す | タブを行き来する日常動線 |
| `FILES_VIEW_PREFIX` / `FILES_VIEW_STALE_DAYS` | 同上 | — | 落とす候補 | 参照 0 |
| プロジェクト外ファイルのセクション | `FileTree` + `op:fs_read_external` | DR-0024 | 移す | DR-0024 Accepted、allowlist は認可境界 |
| ワークスペースセクション (.code-workspace) | `op:fs_list_workspace` / `op:fs_read_workspace` | DR-0026 | 移す | DR-0026 Accepted (kawaz が仕様を直接指定) |
| ファイル名検索 (daemon 側マッチ) | `FileSearchPanel.tsx` + `file-search.ts` + `op:fs_find` | — | 移す | daemon op あり |
| 新規ファイル作成 (docs/inbox) | `op:fs_create` / `op:fs_write` | DR-0019 | 移す | DR-0019 Accepted |
| ファイル編集 / 削除 | `op:fs_edit` / `op:fs_delete` | DR-0019 | 保留 | DR-0019 は fs_write が主題。edit / delete の UI 到達経路と認可範囲が DR から一意に読めない |
| sandbox origin での生ファイル配信 | `op:sandbox_grant` / `op:sandbox_revoke` + `sandboxAvailable` | DR-0030 | 移す | DR-0030 Accepted。非信頼コンテンツの隔離は設計上の要 |
| パス存在判定のバッチ問い合わせ | `filepath-existence-cache.ts` + `op:fs_stat_batch` | — | 移す | TL のパスリンクが「開けるか」を示すために要る |
| `path:LINE:COL` トークンの解析とリンク化 | `filepath-ref.ts` | — | 移す | TL / ファイル本文の両方で効く日常動線 |
| パスリンカの共通配線 | `filepath-linker.tsx` (188) | — | 落とす候補 | **モジュールの export が全滅** (棚卸し §5.4)。`filepath-ref.ts` が実体を持つ |
| ファイル拡張子アイコン | `FileIcon.tsx` | — | 移す | |
| インラインファイル / diff 表示 (TL 内) | `InlineFileViewer.tsx` + `inline-file-model.ts` | DR-0008 | 移す | |
| JSON 文字列トークンのコピーボタン | `useJsonStringCopy.tsx` + `json-string-token.ts` | — | 保留 | テスト未 import かつ FileViewer 専用。使用実績が不明 |
| ビューアのスクロール位置記憶 | `viewer-scroll-store.ts` | — | 移す | history entry 単位で戻れる = 戻るボタンの体験 |
| クリップボードコピー | `CopyButton.tsx` | — | 移す | |

---

## 4. Status タブ

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| workflow / background / TODO の可視化 | `StatusPanel.tsx` + `session-status-view.ts` + `op:session_status` | DR-0020 | 移す | DR-0020 Accepted |
| status の購読 (subscribe / unsubscribe) | `op:session_status_subscribe` / `_unsubscribe` | DR-0020 | 移す | |
| ENV パネルとクエリ絞り込み | `EnvPanel` / `EnvValue` + `env-filter.ts` + `op:session_env` | DR-0020 | 移す | 純関数層まで作られている |
| セッション停止ボタン (KillZone) | `KillZone` + `op:session_kill` | DR-0028 | 保留 | DR-0028 は **Proposed のまま**。危険操作なので裁定なしに移さない |
| sessions.json 由来の status | — | issue 2026-09-06-session-status-from-sessions-json | 保留 | active issue。新 webui で status の出所が変わる可能性 |

---

## 5. Rooms (一覧・room 画面)

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| room 一覧 | `RoomList.tsx` + `op:rooms` | DR-0003 | 移す | |
| room チャット表示 | `RoomView.tsx` + `TimelineItem.tsx` + `op:room_history` | DR-0003 | 移す | |
| メッセージ購読 (seq cursor 付き再接続) | `op:subscribe` + `ws.ts` の `since_seq` | DR-0016 | 移す | DR-0016 Accepted。取りこぼさない再接続の要 |
| room 作成 | `RoomCreator.tsx` + `op:create_room` | DR-0003 | 移す | |
| room 改名 (インライン) | `RoomTitle.tsx` + `op:set_title` | DR-0003 | 移す | |
| room アーカイブ | `op:archive_room` | DR-0012 | 移す | DR-0012 Accepted |
| メンバ招待 | `op:invite` | DR-0011 | 移す | |
| メンバ kick (admin 専用) | `MemberChip.tsx` + `op:kick` | DR-0012 | 移す | |
| メンバチップ表示 | `MemberChip.tsx` | DR-0006 | 移す | id 体系 v2 の表示面 |
| broadcast room | daemon 側 + `RoomList` の表示 | DR-0013 | 移す | DR-0013 Accepted |
| 1on1 room | `OneOnOneComposer` 経路 | DR-0014 | 移す | DR-0014 Accepted |
| `reply_via` の提示 | `ws.ts` / TL 表示 | DR-0017 | 移す | DR-0014 の reply_via 部を DR-0017 が置換済み、DR-0017 が現役 |
| セッションが参加する room 一覧 (Rooms タブ) | `SessionRooms.tsx` + `rooms-filter.ts` | DR-0003 | 移す | |
| 外側クリックでキャンセル | `useDismissOnOutsidePointer.ts` | — | 移す | RoomTitle / SessionRooms の 2 箇所が使用 |
| room id が instance を含意する | — | DR-0032 §2.3 | 保留 | **新規要件**。既存機能ではなく、移す際に room id の形が変わる。裁定要 |

---

## 6. Composer (room 用 / 1on1 用)

棚卸し §5.1 が「共有しているのは 3 モジュールのみ、下書き永続化は片側だけ」と
指摘した二重実装。**機能として両方要るのか、片方に寄せるのか**が最大の論点。

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| room への投稿 | `Composer.tsx` + `op:post` | DR-0003 | 移す | |
| 1on1 のフローティング投稿欄 | `OneOnOneComposer.tsx` (611) | DR-0014 §2.6 | 保留 | room 版との二重実装。「フローティングであること」が要件なのか実装都合なのか裁定要 |
| 下書きの localStorage 永続化 | `OneOnOneComposer` の `loadDraft`/`saveDraft`/`clearDraft` | DR-0014 | 保留 | 1on1 側にしか無い。room 側にも要るなら片側実装の是正、要らないなら 1on1 固有の要件 |
| `OneOnOneComposer.keyFor` | 同上 | — | 落とす候補 | 参照 0 |
| 添付ファイル (画像 / 任意ファイル) | `composer-upload.ts` + `ComposerAttachments.tsx` | DR-0015 | 保留 | DR-0015 が **Proposed のまま**。実装は入っている |
| clipboard paste からの添付 | `composer-upload.ts` | DR-0015 | 保留 | 同上 |
| 添付画像の全画面表示 | `ImageLightbox.tsx` | DR-0015 | 保留 | 同上。加えてモジュールスコープ state の 11 個目 (棚卸し §5.9) |
| 配信フィルタ (`to`) の指定 | `AppState.mentionTo` + `Composer` | DR-0011 | 移す | DR-0011 が mention から配信フィルタへ変えた本体 |
| 送信キーバインド | `composer-keydown.ts` | — | 移す | |
| prompt cache リング表示 | `CacheRing.tsx` + `useCacheRing.ts` + `llm-cache-view.ts` + `ev:llm_requests` | — | 移す | 純関数層 (`llm-cache-view`) まであり、投稿タイミングの判断材料 |
| FAB + ポップアップの殻 | `RoomComposerFab.tsx` + `useFabPopup.ts` | — | 保留 | 1on1 Composer と同じ 2 箇所でしか使われない。Composer 統合の裁定に従属 |
| フローティング要素の D&D 移動 | `useDraggable.ts` (393) | — | 保留 | 同上。393 行を 2 箇所のために持つ |
| `useDraggable` の 2 export | `DRAG_THRESHOLD_PX` / `getViewport` | — | 落とす候補 | 参照 0 |

---

## 7. Usage (`/usage`)

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| クオータ窓の進捗表示 | `QuotaSection` + `llm-usage-view.ts` + `op:llm_usage` | — | 移す | hello の `llmUsageAvailable` で能力交渉済み = 契約が既にある |
| ペース判定 (使い切り予測) | `llm-usage-view.ts` | — | 移す | |
| クレデンシャル別の行表示 | `CredentialRow` | — | 移す | |
| リセット時刻の絶対/相対切替 | `RESET_DISPLAY_KEY` (localStorage) | — | 移す | 永続化済み |
| 使用量の集計表 | `UsageStats.tsx` + `llm-stats-view.ts` + `op:llm_stats` | — | 移す | `llmStatsAvailable` で能力交渉済み |
| 積み上げ棒チャート | `UsageChart.tsx` (手書き SVG) | — | 移す | チャート依存を増やさない判断が既にある |
| 集計期間の切替 (URL 同期) | `AppState.usagePeriod` / `usageDays` + `locator` | — | 移す | URL に載る = 共有可能。文法として §12 に含む |
| 60 秒自動更新 | `REFRESH_MS` + `setInterval` ×3 | — | 移す | ただし 3 本の interval を持つ形は実装判断 |
| `llm-usage-view` の 2 export | `windowDurationMs` / `limitDurationMs` | — | 落とす候補 | 参照 0 |
| `llm-stats-view` の 4 export | `UNATTRIBUTED_CREDENTIAL` / `CONTEXT_KINDS` / `MAX_CHART_SERIES` / `labelStride` | — | 落とす候補 | 参照 0 |

---

## 8. Service status (upstream サービス状態)

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| upstream 状態のストリップ表示 | `ServiceStatus.tsx` + `op:llm_status` / `ev:llm_status` | — | 移す | `llmStatusAvailable` で能力交渉済み、push event もある |
| topbar の状態バッジ | `ServiceStatusBadge` | — | 移す | 全画面から見える唯一の障害シグナル |
| 状態の色・語彙・並び | `llm-status-view.ts` | — | 移す | 純関数層 |
| `llm-status-view.compareServices` | 同上 | — | 落とす候補 | 参照 0 |
| `ServiceStatus.SERVICE_STATUS_ANCHOR` | `ServiceStatus.tsx` | — | 保留 | 参照 0 だが、棚卸し §5.4 が「アンカー名は CSS / URL 側から使われうる」と明記。個別確認が要る |

---

## 9. Session launcher (新規セッション起動)

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| 起動フォーム (テンプレ + params) | `SessionCreator.tsx` + `session-creator.ts` + `op:session_launch` | DR-0018 | 移す | DR-0018 Accepted |
| テンプレ設定の取得 | `op:session_launcher_config` | DR-0018 | 移す | |
| cwd ピッカー | `CwdTree.tsx` + `cwd-tree.ts` | DR-0018 | 移す | |
| 起動結果パネル | `LaunchResultPanel` (`SessionCreator` 内) | DR-0018 | 移す | |
| フォーム値の URL 同期 (`sb.*`) | `sidebar-url.ts` | DR-0018 + kawaz r259 m47-m53 | 移す | 「URL を貼れば相手の画面も同じ組み合わせ」が明示された設計意図 |
| `session-creator` の 4 export | `RESUME_AT_PARAM` / `TITLE_PARAM` / `cwdWithinRoots` / `launchDefaultsFromTranscript` | DR-0018 | 保留 | 参照 0 だが `cwdWithinRoots` は cwd の許可範囲判定、`launchDefaultsFromTranscript` は「このセッションから再開」の種。**機能として意図されて未接続の可能性が高い** |
| 起動先 instance の選択 | — | DR-0032 §2.3 | 保留 | **新規要件**。クラスタ化で「どの instance で起動するか」が要る |

---

## 10. Session search (過去セッション検索)

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| 過去セッションの検索 | `SessionSearchPanel.tsx` + `op:session_search` | DR-0021 | 移す | DR-0021 Accepted |
| 検索結果から pin して閲覧 | `pinned-sessions.ts` | DR-0021 | 移す | pin が検索の出口 |
| 検索語の URL 同期 (`sb.search`) | `sidebar-url.ts` | DR-0018 周辺 | 移す | |
| pinned の identity 修復 (peers/agents 合流時) | `pinned-sessions.ts` | DR-0021 | 移す | 過去セッションが起動したら実体に繋ぎ直す挙動 |

---

## 11. Catalog (`/catalog`)

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| 共通部品を実 CSS で並べるカタログ | `CatalogView.tsx` (850) | DR-0031 | 保留 | DR-0031 Accepted だが、**部品セットを作り直す以上カタログの中身は全面的に作り直しになる**。「カタログという機能を持つか」を裁定してから中身を決める |
| markdown 2 セクションの色見本 | `CatalogMdColors.tsx` (404) | DR-0031 | 保留 | 同上 |
| `CatalogMdColors.MARKDOWN_ALL_SAMPLE` | 同上 | DR-0031 | 落とす候補 | 参照 0 |
| デザイントークン | `app.css` | DR-0031 | 移す | トークンという規約自体は残す。z-index はトークン 1 個 / リテラル 9 箇所で §5.7 の未達分を含めて作り直し |
| daemon を読まない (壊れた UI の診断に使える) | `locator.ts` のコメント | DR-0031 | 移す | カタログを残すなら、この制約ごと残す |

---

## 12. Topbar / Layout / Sidebar / URL 文法 / 永続化

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| topbar のタイトル (現在地の表示) | `TopbarTitle` (`App.tsx`) | DR-0004 | 移す | |
| `document.title` の同期 | `App.tsx:186-188` | DR-0004 | 移す | 機能は移す。ただし依存が `state` 丸ごとで全 action 実行 (§5.6) の形は捨てる |
| 接続状態バッジ | `ConnectionStatus.tsx` + `AppState.connStatus` | DR-0004 | 移す | |
| daemon 情報のフッタ表示 | `AppState.daemonInfo` (hello) | DR-0004 | 移す | クラスタ化で「どの instance か」の表示に発展する |
| version 不一致の検知とフルリロード | `version-guard.ts` | DR-0004 | 保留 | 別 origin の静的サイト化 (DR-0032 §2.1) で「webui と daemon の版が別々に動く」前提が変わる。protocol 版の互換判定 (DR-0032 §3 未確定) に従属 |
| サイドバーの開閉 | `AppState.sidebarOpen` (sessionStorage) | — | 移す | |
| サイドバーの splitter 2 本 | `Sidebar.tsx` + `PaneSplitter.tsx` + `sidebar-panes.ts` | — | 移す | |
| Files / Timeline の 2 ペイン splitter | `FilesPanes.tsx` / `TimelinePanes.tsx` | — | 移す (統合) | 棚卸し §5.1 が「鏡写し」と明記した二重実装。**機能は残し、2 本の実装は 1 本に** |
| splitter 位置 → サイズ変換 (CSS 正本) | `pane-axis.ts` | — | 移す | |
| 「横に並べきれるか」の CSS 由来判定 | `layout-mode.ts` | — | 移す | JS が幅を持たない形として既に正しい |
| viewport 幅の JS 直読み (`window.innerWidth` ×4) | `Sidebar.tsx:181, 280, 312, 317, 321` | — | 落とす候補 | 棚卸し §5.3 が設計文書 §5 との不一致と明記。**機能 (ドラッグ上限) は残し、幅の出所をコンテナに変える** |
| `sidebar-panes.DRAWER_DEFAULT_RATIO` | `sidebar-panes.ts` | — | 落とす候補 | 参照 0 |
| タブの共通部品 | `Tabs.tsx` | — | 移す | 3 通りの分岐を統合した成果 |
| 404 / 失敗の共通表示 | `ErrorView.tsx` + `missingTarget` / `unknownPath` | DR-0004 | 移す | |
| URL 文法 (`/r/<id>` / `/s/<sid>/<tab>` / `/usage` / `/catalog`) | `locator.ts` | DR-0004 | 移す | |
| TL 位置の URL 表現 (`position`) | `locator.ts` | DR-0004 | 移す | |
| agent 指定の URL 表現 (`agent`) | `locator.ts` の `AgentRef` | DR-0025 | 保留 | DR-0025 が Proposed。かつ「agent と position を同時に表せない」制約が §2 の場当たり分岐の原因。**両立させるなら文法の変更が要る** |
| ファイル + 行範囲の URL 表現 | `locator.ts` の `path` / `lineRange` | DR-0008 | 移す | |
| `sb.*` サイドバー文法 | `sidebar-url.ts` | kawaz r259 m47-m53 | 移す | |
| popstate / pushState の双方向同期 | `navigation.ts` | DR-0004 | 移す | |
| 位置記憶 (`timelinePositions`) | `navigation.ts:14` | DR-0004 | 移す | |
| localStorage / sessionStorage の集約 | `storage.ts` | — | 移す | ただし 3 系統 18 キーが呼び出し側の規律だけで振り分けられている (§5.9) |
| 古いキーの掃除 (`sweepStaleBySid`) | `storage.ts` | — | 移す | |
| `storage.listStorageKeys` | 同上 | — | 落とす候補 | 参照 0 |
| WS のライフサイクル / hello / 相関 / 再接続 | `ws.ts` (1,078) | DR-0003 / DR-0004 | 移す | 契約は protocol リポへ、実装は新 webui に |
| 別 origin からの WS と origin 許可設定 | — | DR-0032 §2.1 | 保留 | **新規要件**。DR-0004 の identity pinning を置き換える形が未確定 |
| `instance` 属性の表示・per-instance 値の分離 | — | DR-0032 §2.3 | 保留 | **新規要件** |
| `~/.claude*` の自動検出 | daemon 側 | DR-0032 §2.3 | 落とす候補 | DR-0032 §2.3 が「instance は自分の config home だけを見る」と明記 = 廃止が決定済み |

### 12.1 Terminal タブ

| 機能 | 現在の実装 | 由来 | 判定 | 根拠 |
|---|---|---|---|---|
| Terminal の iframe 埋め込み | `TerminalPanel.tsx` + `terminal-gateway-store.ts` + hello の `terminalGatewayUrl` | issue archive/2026-07-21-webui-terminal-tab-embed | 保留 | 外部ゲートウェイ依存で、hello フラグが無ければ出ない。dogfooding で使われているかコードから判断できない |

### 12.2 store 外のミニ状態と場当たり回避 (機能ではないもの)

DR-0032 §2.1 が状態層を `@preact/signals` にすると決めているため、
以下は **機能ではなく現行の購読粒度への蓋**として全て落とす候補。

| 対象 | 由来 | 判定 | 根拠 |
|---|---|---|---|
| `SessionView` の LRU + `memo` 比較関数 (`session-view-cache.ts`) | — | 落とす候補 | 棚卸し §5.6 が「§4.2 の問題への局所的な蓋」と明記 |
| LRU evict を render 中に ref へ積んで effect で dispatch (`App.tsx:129-158`) | — | 落とす候補 | 同上。store 再入の回避 |
| 初回だけ `layout.scrollLeft` を合わせる依存配列なし effect (`App.tsx:170-183`) | — | 落とす候補 | 自前ガード付きの回避。機能 (初期位置合わせ) は移す |
| `main.tsx` の 2 つの `store.subscribe` | — | 落とす候補 | 棚卸しが「signal 化すると effect() で各モジュール側に戻せる性質」と明記 |
| ミニ store 3 実装 (`createStore` / `fold-open-store` / `raw-view-mode` の listener) | — | 落とす候補 | 同じ形の購読機構が 3 つ |
| `memo(LineView)` / `memo(FoldGroup)` / `useMemo` 73 個 | — | 落とす候補 | 設計文書 §4 が「signal 化で不要になるものとして扱う」と規定済み |
| 生 NUL 文字の合成キー (`\0` ×3 箇所) | — | 保留 | バグではなく設計判断だが、grep が黙って 0 件になる副作用がある (§5.8)。区切り文字を変えるかは裁定要 |

---

## 13. 落とす候補の一覧 (行数の合計付き)

### 13.1 ファイルごと落とす候補

| 対象 | 行数 | 根拠 |
|---|---|---|
| `filepath-linker.tsx` | 188 | export 全滅 (参照 0)。実体は `filepath-ref.ts` |
| `session-view-cache.ts` | 49 | 購読粒度への局所的な蓋 |
| `FilesPanes.tsx` / `TimelinePanes.tsx` のどちらか一方 | 100 | 鏡写しの二重実装、1 本に統合 |
| **小計** | **337** | |

### 13.2 シンボル単位で落とす候補 (参照 0、37 個のうち保留を除く 31 個)

`raw-view-mode` 3 / `session-creator` 4 (→ うち 4 個は保留、下記参照) /
`llm-stats-view` 4 / `transcript-model` 3 / `useDraggable` 2 /
`llm-usage-view` 2 / `files-view-store` 2 / `in-view-search` 1 /
`sidebar-panes` 1 / `issue-ref` 1 / `storage` 1 / `useNow` 1 /
`llm-status-view` 1 / `utils` 1 / `session-view-cache` 1 / `TimelineItem` 1 /
`OneOnOneComposer` 1 / `agent-tree-view` 1 / `CatalogMdColors` 1。

保留に回した参照 0: `SearchBar` の 2 component、`ServiceStatus.SERVICE_STATUS_ANCHOR`、
`session-creator` の 4 個 (機能として意図されて未接続の可能性)。

行数としては個々が数行〜数十行で、合計は概算 200〜300 行。
**削除前に個別確認が要る** (棚卸し §5.4 が文字列経由・動的アクセスを検出できないと明記)。

### 13.3 実装の形として落とす候補 (機能は残す)

購読粒度への蓋と場当たり回避 (§12.2 の 6 項目) + `Sidebar.tsx` の
`window.innerWidth` ×4 + `Timeline.tsx:3122-3140` の agent 分岐。
`useMemo` 73 個 / `memo()` 3 個も含む。**これらは行数で数える意味がない** —
新 webui で同じ機能を書けば自然に消える性質のもの。

### 13.4 決定済みで落とすもの

`~/.claude*` の自動検出 (DR-0032 §2.3 が明記)。

---

## 14. 保留の一覧 (画面を作る段階で統括が判断する。kawaz r278m67: 溜めて裁定待ちにしない)

各 1 行の問いの形。番号は §11 までの表と対応しない独立の連番。

1. DR-0025 (workflow 掘り下げ、Proposed) は正式仕様として新 webui に移すか、実装ごと落とすか。
2. DR-0028 (session_kill、Proposed) の停止ボタンは移すか。危険操作なので確認したい。
3. DR-0015 (Composer 添付、Proposed) の添付・paste・ライトボックスは移すか。
4. DR-0031 のカタログ (`/catalog`) は新 webui でも持つか。持つなら中身は部品セットに合わせて全面的に作り直すが、それでよいか。
5. Composer は room 用と 1on1 用の 2 本を維持するか、1 本に統合するか。
6. 下書きの localStorage 永続化は 1on1 だけの要件か、room 側にも要るか。
7. 1on1 Composer の「フローティング + D&D 移動」(`useDraggable` 393 行) は要件か、実装都合か。
8. Terminal タブ (外部ゲートウェイ iframe) は日常的に使っているか。
9. `trace.ts` の配信レイテンシ計測は新 webui でも要るか。
10. Timeline の右端フロートパネルは Status タブ / ツールバーと役割が重なるが、3 つとも要るか。
11. issue 2026-08-20 の「メッセージ hover ツールバー」は新 webui の要件に含めるか。
12. 検索の 4 系統 (in-view / rendered-text / ファイル名 / セッション) はこのまま 4 つか、統合の余地があるか。
13. `SearchBar` の未接続 export 2 つ (検索スコープ切替 UI) は、意図された未完成か、退化か。
14. `session-creator` の未接続 4 つ (特に `cwdWithinRoots` / `launchDefaultsFromTranscript`) は実装漏れか、不要か。
15. `ServiceStatus.SERVICE_STATUS_ANCHOR` は CSS / URL 側から使われているか (参照 0 だが文字列経由の可能性)。
16. `useJsonStringCopy` (JSON 文字列トークンのコピーボタン) は使っているか。
17. `incremental-line-map.ts` と `incremental-cross-line.ts` と `transcript-model.ts` の 3 層は、3 つとも要るか。
18. `timeline-summary.ts` (24 行、責務コメントなし) は何の要約か。残すか。
19. `op:fs_edit` / `op:fs_delete` の UI 到達経路と認可範囲は DR-0019 の範囲内か。
20. `op:session_rename` は一覧から呼ぶのかヘッダから呼ぶのか (どちらの機能として移すか)。
21. 合成キーの `\0` 区切り (3 箇所) は新 webui でも `\0` のままにするか、grep が効く文字に変えるか。
22. `version-guard` (daemon 版不一致の検知とフルリロード) は、別 origin の静的サイトになった後どう振る舞うべきか。
23. issue 2026-09-06-session-status-from-sessions-json は新 webui の status に反映してから移すか、後回しか。
24. クラスタ化 (DR-0032 §2.3) で新規に要る 3 つ — instance の表示、起動先 instance の選択、room id が instance を含意する形 — はマイルストーン 1 に含めるか、後続か。

### 統括の事前回答 (このセッションの裁定・DR から導けるもの、kawaz の再確認は不要)

- 2: **移す**。停止ボタンは SS-Q1 (a+c) で「Paused へ移す」として裁定済み (`session_kill` に `retain: true`)
- 21: **grep が効く区切りに変える** (統括判断。`\0` は棚卸しで grep の欠落を実際に起こした)
- 23: **反映してから移す**。活動判定の正は llm-gateway のイベント (r278m10) で裁定済み。gateway 側の start / complete 通知待ち
- 24: **マイルストーン 1 には含めない**。DR-0032 §2.2 の順で、契約に `instance` を足すのが先 (webui は任意フィールドとして無視)。表示・起動先選択・room id の形はクラスタ化 issue の実装単位

残り 19 件は、その機能を含むマイルストーンに着手する時に統括が判断し、判断に迷うものだけその時点で kawaz に聞く。

---

## 15. 新 webui の最初のマイルストーン (案)

**目標**: kawaz が日常利用を旧 webui から新 webui に移せる最小集合。
「日常利用」= セッションを一覧から選び、TL を読み、ファイルを見て、room で会話する。

### 含む

| 領域 | 含む機能 |
|---|---|
| Sessions 一覧 | peers / agents / pinned / 前回稼働のセクション表示、行クリックで TL、並び替え、mini ステータスバッジ、エラー表示 |
| Timeline | 購読と追記表示、`transcript-model` + cross-line、Markdown レンダリング (DR-0010 一式)、Shiki、thinking、行種別の表示部品、fold 一式、ccmsg バブル (DR-0027)、fork 境界、位置 pin と着地、自動追随、in-view 検索、raw モード |
| Files | ツリー遅延ロード、本文表示、Shiki、ファイル内検索、markdown プレビュー、選択の per-sid 記憶、プロジェクト外 (DR-0024)、パスリンク (`filepath-ref` + `fs_stat_batch`) |
| Rooms | 一覧、チャット表示、投稿、seq cursor 付き再接続 (DR-0016)、作成、改名、招待、配信フィルタ (`to`) |
| 骨格 | topbar タイトル + `document.title`、接続状態バッジ、サイドバー開閉と splitter、Files/Timeline の 2 ペイン (統合した 1 本)、404 表示、URL 文法一式 (`/r` `/s` `/usage` `/catalog` + position + path/lineRange + `sb.*`)、popstate 同期、storage 集約 |
| 契約 | WS ライフサイクル / hello / 相関 / 再接続、別 origin からの WS (DR-0032 §2.1 の origin 許可設定) |

### 含まない (マイルストーン 2 以降)

Status タブ (DR-0020) / Usage (`/usage`) / Service status / Session launcher (DR-0018) /
Session search (DR-0021) / Catalog (DR-0031) / 翻訳 (DR-0023) / dump /
ワークスペースセクション (DR-0026) / sandbox origin (DR-0030) / ファイル作成・編集 (DR-0019) /
Terminal タブ / 1on1 Composer と添付 / AgentTreePanel。

### この切り方の根拠

- 旧 webui は並走する (DR-0032 §2.2 の 2) ので、**含まない機能は旧 webui で使い続けられる**。
  「移せる最小」は「全部揃う」ではなく「日常の主動線が新側で完結する」でよい。
- 含む側は **hello の能力フラグに依存しない機能だけ**で構成した。能力交渉が要る機能
  (翻訳 / usage / status / sandbox / terminal / fork) はマイルストーン 2 へ回すことで、
  最初の版が protocol の能力交渉の設計を待たずに動く。
  - 例外は fork 境界表示 (`forkAvailable`) — TL の読みやすさに直結するため含めた。
    能力交渉が間に合わなければ、この 1 つだけを落とす。
- 含む側に **保留項目を 1 つも入れていない** (§14 の 24 問はすべてマイルストーン 2 以降の判断)。
  裁定待ちでマイルストーン 1 が止まらないようにする。
- 唯一の新規要件として「別 origin からの WS」を含む。これは DR-0032 §2.1 の前提そのもので、
  これが動かないと新 webui は 1 画面も出せない。
