# webui コンポーネント / モジュール棚卸し (作り直し議論の一次資料)

- 日付: 2026-09-07
- 対象: `packages/webui/src/client/` 全 121 ファイル + `packages/webui/src/public/app.css`
- 目的: preact + `@preact/signals` での作り直しを議論するための現状把握。
  **設計案は書かない**。事実の棚卸しと、疑わしいものの根拠付き列挙まで。
- 前提資料: `docs/design/webui-architecture.md` (Draft)、`docs/decisions/DR-0005-webui-frontend-architecture.md`
- 数値は 2026-09-07 時点の `wc -l` / `grep -c` 実測。

## 判明した事実

1. **全体で 37,112 行 (TSX 50 / TS 71 ファイル) + CSS 9,381 行**。上位 3 ファイル
   (`Timeline.tsx` 4,918 / `transcript-model.ts` 2,716 / `markdown-view.tsx` 1,868) だけで
   全体の 25%。`Timeline.tsx` は 1 ファイルで 40 個の関数コンポーネントを抱え、
   うち `Timeline()` 本体が 1,832 行 (= ファイルの 37%)。
2. **全状態購読 (`useStoreState`) を行う component は 7 個**: `App` / `Timeline` /
   `SessionList` / `StatusPanel` / `FileViewer` / `FileTree` / `SessionSearchPanel`。
   `createStore` は listener に selector を持たない (`useStore.ts:23-27`) ので、
   **どの action でもこの 7 個が必ず再レンダーされる**。うち App はツリーの根なので、
   実質「全 action で全画面が再構築される」。
3. **`AppState` は 39 フィールド 1 オブジェクト**。接続・能力フラグ・ドメイン一覧・
   現在地 (locator 由来 7 フィールド)・表示設定・レイアウト (`sidebarOpen`) が同居し、
   `reducer` の 55 case すべてが同じオブジェクトを差し替える。内訳は
   Navigation 由来 9 / 能力フラグ 7 / 表示設定 4 / レイアウト 1 / ドメイン 18。
4. **props で `state: AppState` を丸ごと配る箇所が 10 個**。App が根で購読し、
   `Sidebar` / `RoomView` / `SessionView` / `UsageView` / `ServiceStatus` /
   `TopbarTitle` 等へそのまま渡す。SessionView はさらに `Timeline` へ分解して渡す。
5. **JS が viewport 幅を直接読む箇所は `Sidebar.tsx` に集中** (4 箇所の
   `window.innerWidth`)。他は `pane-axis.ts` / `layout-mode.ts` の
   `getComputedStyle` 方式 (設計文書 §4 が認める形) に移行済み。720px の
   breakpoint 判定を JS が行っている箇所は残っていない。
6. **`app.css` に `!important` は 0 件**。一方 **z-index はトークンが 1 個
   (`--z-composer`) しか無く、リテラルが 9 箇所**に散っている (設計文書 §5 の
   「用途別トークンに集約」は未達)。
7. **参照 0 の実行時 export が 37 個**、**テストから 1 度も import されない
   client モジュールが 37 個** (うち component が 29 個)。
8. **3 ファイルがソース中に生の NUL 文字 (`\0`) を含む** ため、`grep` が
   バイナリ扱いして黙って結果を落とす。合成キーの区切り文字として意図的に
   使われている (`timeline-position.ts:11` が「uuid / sid に現れない」と明記)。

## 実用的な示唆

- 再レンダーの支配要因は「購読の粒度」1 点。7 個の全状態購読 component のうち
  App を外すだけで波及範囲が変わるので、設計文書 §8 の移行順 (購読層 → App 解体) は
  観測と一致している。
- `AppState` 39 フィールドのうち **locator 由来が 7、レイアウト由来が 1、
  能力フラグが 8** で、ドメイン状態は残り 23。分割の第一の切れ目はこの 3 系統。
- 「純関数を別モジュールに切り出して bun test で叩く」規約は徹底されており
  (`*-view.ts` / `*-model.ts` が 14 個)、**TSX 側だけが肥大している**。
  作り直しで捨てる候補と残す候補の境界は概ねこの拡張子の境界に一致する。
- 参照 0 の export と未テスト component は、作り直し時に「移植せず落とす」
  判断の一次候補リストとして使える (§5.4 / §5.5)。

---

## 1. 全体像

| 項目 | 値 |
|---|---|
| client ファイル数 | 121 (TSX 50 / TS 71) |
| client 総行数 | 37,112 |
| `components/` 配下 | 53 ファイル |
| スタイル | `src/public/app.css` 単一ファイル 9,381 行 |
| ランタイム依存 | `preact ^10.29.7`、`shiki ^4.3.1`、`mdast-util-from-markdown` + GFM 拡張 6 種 |
| ビルド | `Bun.build` によるサーブ時トランスパイル (DR-0005 §3)。リポに dist を持たない |
| エントリ | `main.tsx` → `createStore` / `createWsClient` / `setupNavigation` → `render(<AppContext.Provider><App/>)` |

### エントリの配線 (`main.tsx`、81 行)

`main.tsx` は store と ws を作って context に載せるだけでなく、**3 つの effect を
直接ここに置いている**:

| effect | 内容 |
|---|---|
| `configureFilePathExistenceCache` | パスリンカのキャッシュに `ws.fsStatBatch` を注入 |
| `store.subscribe` #1 | peers 集合が縮んだら該当 sid の filepath キャッシュを破棄 |
| `store.subscribe` #2 | `pinnedSessions` が変わったら localStorage へ書き戻し |

いずれも「store と別モジュールの両方を知る唯一の場所」という理由でここに置かれた
(コメントに明記)。signal 化すると `effect()` で各モジュール側に戻せる性質のもの。

### 依存の向き

```
main.tsx ─┬─ store.ts (reducer)  ←── ws.ts (protocol-event に正規化して dispatch)
          ├─ navigation.ts (URL ⇄ store、popstate/pushState)
          └─ context.ts ── AppContext{store, ws} ── 21 ファイルが useApp()
```

---

## 2. コンポーネント一覧

state の読み方の凡例: **全購読** = `useStoreState(store)`、**props** = 親から
`state: AppState` を受け取る、**部分props** = 必要な値だけ props、**ctx** = `useApp()` で
store/ws を取るが state は購読しない。

### 2.1 骨格 / ルーティング

| ファイル | 行 | 責務 | state | 副作用 | 備考 |
|---|---|---|---|---|---|
| `App.tsx` | 343 | topbar + layout + footer、view による本文の出し分け、SessionView の LRU キャッシュ | **全購読** + 3 子へ props | `writeSessionStorage`、`document.title`、`layout.scrollLeft` の初回スナップ、dispatch×3 | 根で全購読するため全 action で全体再構築。`document.title` の effect が `[state]` 依存 = 毎 action 実行 |
| `Sidebar.tsx` | 326 | 一覧 + フォームパネル + splitter 2 本 | props | `window.innerWidth` ×4、storage ×3、dispatch ×2 | **JS が viewport 幅を知る唯一の残存箇所** |
| `SessionView.tsx` | 407 | セッション画面のタブ殻 (Files / Timeline / Status / Rooms / Terminal) と購読ライフサイクル | props | `sessionStatusSubscribe` 等 ws ×5、setInterval ×1 | `memo` 経由で非表示時の再レンダーを抑止 (`session-view-cache.ts`) |
| `RoomView.tsx` | 294 | room チャット画面 | props | ws ×3、dispatch ×4 | |
| `UsageView.tsx` | 515 | `/usage` 画面 (クオータ / 使用量タブ) | props | ws ×3、setInterval ×3 | 内部に `QuotaSection` / `UsageTabs` を持ち、そこへも `state` 丸ごと渡す |
| `CatalogView.tsx` | 850 | `/catalog` — 実 CSS で共通部品を並べるカタログ | 無 | 無 | 純表示。DR-0031 の成果物 |
| `ErrorView.tsx` | 89 | 404 / 失敗の共通表示 | 部分props | 無 | |
| `ConnectionStatus.tsx` | 17 | 接続状態バッジ | 部分props | 無 | |
| `Tabs.tsx` | 98 | 排他タブ列の共通部品 | 部分props | 無 | 3 通りに分岐していたタブ表現を統合した部品 |

### 2.2 一覧・サイドバー

| ファイル | 行 | 責務 | state | 副作用 | 備考 |
|---|---|---|---|---|---|
| `SessionList.tsx` | 1,169 | SESSIONS 一覧 (peers + agents + pinned + lastLive のマージ、セクション分け、D&D) | **全購読** | storage、dispatch ×1、ws ×8、setInterval ×4 | `useMemo` 9 個。派生 (セクション分け) を component 内で毎回組み立て |
| `RoomList.tsx` | 117 | ROOMS 一覧 | props | 無 | |
| `SessionRooms.tsx` | 197 | セッションが参加する room 一覧 (Rooms タブ) | props | ws ×1 | |
| `RoomCreator.tsx` | 133 | ROOMS「+ 新規」フォーム | ctx | ws ×2 | |
| `SessionCreator.tsx` | 479 | 新規セッション起動フォーム (DR-0018) | props | ws ×1 | 内部に `LaunchResultPanel`、そこへも `state` 丸ごと |
| `SessionSearchPanel.tsx` | 415 | 過去セッション検索 (DR-0021) | **全購読** | ws ×1、dispatch ×2 | `useMemo` 3 |
| `CwdTree.tsx` | 260 | 起動フォームの cwd ピッカー | ctx | ws ×1、setTimeout ×1 | |
| `MemberChip.tsx` | 95 | room メンバのチップ + kick | 部分props | 無 | |
| `RoomTitle.tsx` | 138 | room 名のインライン改名 | ctx | ws ×1 | |

### 2.3 Files タブ

| ファイル | 行 | 責務 | state | 副作用 | 備考 |
|---|---|---|---|---|---|
| `FileViewer.tsx` | 1,426 | 行番号付きファイルビューア + Shiki ハイライト + 検索 + markdown プレビュー | **全購読** (3 箇所) | ws ×15、dispatch ×11 | `useState` 21 / `useMemo` 7 / `useCallback` 5 / `useEffect` 16。client 最大の hook 密度 |
| `FileTree.tsx` | 1,093 | 遅延ロードのディレクトリツリー (DR-0008) + 外部ファイル (DR-0024) | **全購読** | ws ×8、dispatch ×6、storage ×9 | |
| `FilesPanes.tsx` | 169 | FileTree + splitter + FileViewer の 3 分割 | ctx | `getComputedStyle` 系 ×1 | 比率を自分で持つ |
| `FileSearchPanel.tsx` | 249 | ファイル名検索 (ツリー本体を置換) | ctx | ws ×1、setTimeout ×1 | |
| `FileIcon.tsx` | 169 | 拡張子別インライン SVG アイコン | 部分props | 無 | |
| `InlineFileViewer.tsx` | 112 | Timeline 内のインラインファイル表示 | 部分props | 無 | |
| `CodeBlock.tsx` | 70 | markdown のフェンス済みコードブロック (highlight.ts 経由) | 部分props | 無 | |

### 2.4 Timeline (`Timeline.tsx` 内部は §2.7)

| ファイル | 行 | 責務 | state | 副作用 | 備考 |
|---|---|---|---|---|---|
| `Timeline.tsx` | 4,918 | transcript 表示の全部 (§2.7) | **全購読** | ws ×16、dispatch ×24、storage ×6、setTimeout ×5、DOM 計測 ×8 | |
| `TimelinePanes.tsx` | 100 | AgentTreePanel + splitter + Timeline | ctx | `getComputedStyle` ×1 | `FilesPanes.tsx` と同一構造 |
| `AgentTreePanel.tsx` | 566 | セッションツリー左ペイン (Teammates / Agents / Workflows) | 部分props | 無 | 描画のみ。判断は `agent-tree-view.ts` |
| `TimelineItem.tsx` | 288 | **room チャットの 1 メッセージ行** | 部分props | 無 | 名前が `Timeline.tsx` と紛らわしいが別物 (§5.1) |
| `StatusPanel.tsx` | 606 | Status タブ本体 (DR-0020) | **全購読** | ws ×3 | 判断は `session-status-view.ts` / `env-filter.ts` |
| `TerminalPanel.tsx` | 59 | Terminal タブの iframe | 部分props | setTimeout ×1 | |
| `SearchBar.tsx` | 267 | in-view 検索バーの共通殻 (Timeline / FileViewer 共用) | 部分props | 無 | |
| `Fold.tsx` | 40 | `<details>` ベースの折り畳み節 | 部分props | 無 | |

### 2.5 Composer 系

| ファイル | 行 | 責務 | state | 副作用 | 備考 |
|---|---|---|---|---|---|
| `Composer.tsx` | 402 | room 用の投稿欄 | ctx | ws ×1、DOM ×2 | |
| `OneOnOneComposer.tsx` | 611 | 1on1 用のフローティング投稿欄 (DR-0014 §2.6) | props | storage ×7、ws ×4 | `useCallback` 8。下書きを自前で localStorage 管理 |
| `RoomComposerFab.tsx` | 120 | room Composer を FAB + ポップアップに載せる殻 | ctx | setTimeout ×2 | |
| `ComposerAttachments.tsx` | 85 | 添付一覧の表示 (DR-0015 §4.3) | 部分props | 無 | |
| `ImageLightbox.tsx` | 63 | 添付画像の全画面表示 | モジュール state | 無 | |

### 2.6 その他の表示部品

| ファイル | 行 | 責務 | state | 備考 |
|---|---|---|---|---|
| `UsageStats.tsx` | 326 | `/usage` 使用量タブ (表 + チャート) | ctx | |
| `UsageChart.tsx` | 170 | 積み上げ棒 SVG (手書き、チャート依存なし) | 部分props | `const WIDTH = 720` は viewBox 幅であり breakpoint ではない |
| `ServiceStatus.tsx` | 259 | upstream サービス状態のストリップ + topbar バッジ | props | |
| `CatalogMdColors.tsx` | 404 | `/catalog` の markdown 2 セクション | 無 | `matchMedia("(prefers-color-scheme: dark)")` を JS で読む (色の内訳表示のため) |
| `CopyButton.tsx` | 93 | クリップボードコピー | 部分props | |
| `avatar.tsx` | 153 | sid 決定論アバター | 部分props | |
| `PaneSplitter.tsx` | 68 | ドラッグ splitter の配管のみ | 部分props | Sidebar / FilesPanes / TimelinePanes の 3 箇所が使用 |

### 2.7 `Timeline.tsx` の内部構造 (4,918 行 / 40 関数コンポーネント)

上位のサイズ (関数開始行 → 次の関数までの行数):

| 行 | 関数 | 行数 | 責務 |
|---|---|---|---|
| 3086 | `Timeline` | **1,832** | 購読ライフサイクル、初期ロード、位置 pin と着地スクロール、自動追随、検索、raw モード、翻訳availability、ツールバー、右端フロートパネル、ミニ status パネル |
| 2600 | `CcmsgBubble` | 219 | ccmsg メッセージ吹き出し (`ws.read` で本文を後追い取得) |
| 1261 | `ThinkingSegment` | 166 | thinking ブロック + 翻訳タブ |
| 1943 | `LineView` | 150 | 1 transcript 行のディスパッチャ (`memo` 済み) |
| 1465 | `SegmentView` | 142 | segment 種別の分岐 |
| 2323 | `AssistantBubble` | 138 | assistant 応答の吹き出し |
| 1067 | `useTranslatedText` | 125 | 翻訳の hook (host / browser 2 経路) |
| 2106 | `FoldGroup` | 117 | 折り畳みグループ (`memo` 済み) |
| 1767 | `SystemMessageFold` | 110 | system メッセージの折り畳み |
| 2951 | `DumpFileAction` | 82 | dump 出力アクション |

残り 30 個は 15〜80 行で、**行の種類ごとの表示部品** (`BashUseFold` /
`BashResultFold` / `BashRunCard` / `BashRunOutput` / `AgentCard` / `AgentSendFold` /
`AgentSpawnFold` / `FileToolFold` / `FileReadResultView` / `AttachmentFileView` /
`UserPromptBubble` / `PeerCcmsgLineView` / `SystemMessageRichView` / `IdlePeerRow` /
`ApiErrorNotice` / `RawLineRow` / `ForkDivider` / `HiddenThinkingSegment` /
`AssistantMarkdownText` …) と、
**hook / context** (`useFoldOpen` / `useCategoryOpen` / `useCcmsgBody` /
`TimelineAutoOpenContext` / `CcmsgRenderCtx`)、
**モジュールスコープの状態** (`CCMSG_BODY_CACHE`、`pendingViewportTranslations`) に分かれる。

`Timeline()` 本体が持つ hook: `useState` 43 / `useMemo` 45 / `useCallback` 15 /
`useEffect` 41 / `useRef` 22 (ファイル全体の値、大半が `Timeline()` 内)。

---

## 3. 非 component モジュール一覧

### 3.1 状態 / 通信 / 経路

| ファイル | 行 | 責務 | 主な読み手 |
|---|---|---|---|
| `store.ts` | 1,300 | `AppState` (39 フィールド) + `Action` union (46 種) + `reducer` (55 case)。WS イベントも `protocol-event` action 1 本に正規化して同じ reducer に流す | 全 component |
| `useStore.ts` | 35 | `createStore` (selector なし) + `useStoreState` | 7 component |
| `context.ts` | 21 | `AppContext{store, ws}` + `useApp()` | 21 ファイル |
| `ws.ts` | 1,078 | WS ライフサイクル、hello、request/response 相関、subscribe、`since_seq` 永続化 | main / navigation / 全 component (ctx 経由) |
| `navigation.ts` | 369 | URL ⇄ store の双方向同期、popstate/pushState、`missingTarget` 判定、位置記憶 | main / App / 各画面 |
| `locator.ts` | 257 | URL の文法 (`parseUrl` / `*Href`) | navigation / 全画面 |
| `sidebar-url.ts` | 155 | サイドバーフォームの `sb.*` パラメータ文法 | navigation / Sidebar |
| `storage.ts` | 153 | localStorage / sessionStorage の try/catch 集約 + `sweepStaleBySid` | 12 モジュール |
| `version-guard.ts` | 79 | daemon version 不一致の検知と遷移時フルリロード | store / App / navigation |
| `trace.ts` | 150 | transcript 配信レイテンシのブラウザ側計測 | ws / Timeline |

### 3.2 store の外に置かれた小さな状態ストア

`AppState` に入らず、モジュールスコープで状態を持つもの。**それぞれ独自の購読機構か、
無購読 (呼び出し時読み取り) を持つ**。

| ファイル | 行 | 保持するもの | 永続化 | 購読機構 |
|---|---|---|---|---|
| `fold-open-store.ts` | 88 | 1 Timeline 内の全 fold の開閉 | 無 (メモリ) | 自前 listener |
| `raw-view-mode.ts` | 117 | raw JSONL の pretty 表示モード | localStorage | 自前 `subscribeRawViewPretty` |
| `files-view-store.ts` | 132 | Files タブの per-sid 選択ファイル + markdown モード | localStorage | 無 (読み取り時) |
| `viewer-scroll-store.ts` | 71 | FileViewer のスクロール位置 (history entry 単位) | 無 (メモリ、`setBounded`) | 無 |
| `filepath-existence-cache.ts` | 138 | パス存在判定のキャッシュ + バッチ待ち行列 | 無 | コールバック注入 |
| `session-view-cache.ts` | 49 | SessionView の LRU (`memo` 比較関数付き) | 無 | 無 (App の ref が保持) |
| `translate.ts` | 353 | 翻訳結果 3 種のキャッシュ | 無 (`setBounded`) | 部分テキスト listener |
| `terminal-gateway-store.ts` | 47 | Terminal iframe の embed URL 組み立て | 無 | 無 |
| `navigation.ts` (内) | — | `timelinePositions: Map<sid, position>` | 無 | 無 |
| `rendered-text-search.ts` | 339 | `Map<Document, Map<HTMLElement, RootHighlights>>` | 無 | DOM イベント |

### 3.3 純関数の派生層 (`*-view.ts` / `*-model.ts` / 判定モジュール)

JSX を含まず bun test から直接叩ける規約で切り出されたもの。**この層は規約が
よく守られている**。

| ファイル | 行 | 責務 |
|---|---|---|
| `transcript-model.ts` | 2,716 | jsonl 行 → 描画可能イベントへの変換 (DR-0009) |
| `markdown-view.tsx` | 1,868 | mdast → preact JSX レンダラ (DR-0010)。restricted / full の 2 モード |
| `utils.ts` | 1,417 | 表示ヘルパ全般 (セッション行の合成、セクション分け、整形) |
| `llm-stats-view.ts` | 568 | `/usage` 使用量の集計・チャート幾何 |
| `session-creator.ts` | 521 | 起動フォームのモデルと wire request 射影 |
| `filepath-ref.ts` | 470 | `path:LINE:COL` トークンの解析と `fileHref` 解決 |
| `llm-usage-view.ts` | 436 | クオータ窓の進捗・ペース判定 |
| `session-status-view.ts` | 377 | Status タブ / TL ミニパネル / サイドバー mini バッジの派生 |
| `rendered-text-search.ts` | 339 | 描画済み DOM 上のテキスト範囲射影 |
| `in-view-search.ts` | 287 | クエリ解析・マッチ列挙・インデックス移動 (DR-0022) |
| `markdown-task-list.ts` | 247 | GFM タスクリストのソーステキスト側トグル |
| `highlight.ts` | 222 | Shiki の細粒度バンドル駆動 |
| `markdown-link.ts` | 221 | markdown リンク先の URL ポリシー (DR-0010 allowlist) |
| `llm-status-view.ts` | 214 | upstream 状態の色・語彙・並び |
| `incremental-cross-line.ts` | 194 | transcript の行またぎ派生 (tool_use/tool_result 結合等) |
| `llm-cache-view.ts` | 150 | prompt cache リングの算術 |
| `issue-ref.ts` | 127 | markdown 中の issue 参照 |
| `timeline-auto-open.ts` | 122 | どの category を自動で開くか |
| `fork-point.ts` | 113 | fork が会話を切る位置 |
| `file-search.ts` | 115 | ファイル名検索の派生 |
| `pinned-sessions.ts` | 109 | ピン留めの identity 選択規則 |
| `env-filter.ts` | 98 | Status タブ ENV パネルのクエリ意味論 |
| `last-live-sessions.ts` | 89 | 「前回稼働中」セクション |
| `say-merge.ts` | 82 | say バブルの Timeline 内配置 |
| `incremental-line-map.ts` | 79 | 行単位派生値の差分再計算 |
| `pane-axis.ts` | 68 | splitter 位置 → 一覧側サイズの変換 (CSS 正本) |
| `cwd-tree.ts` | 67 | CwdTree のツリーマージ |
| `room-creator.ts` | 64 | RoomCreator の派生 |
| `rooms-filter.ts` | 46 | Rooms タブの絞り込み |
| `inline-file-model.ts` | 46 | インラインファイル/diff のモデル |
| `session-dump-action.ts` | 41 | dump アクションの要求組み立て |
| `fork-divider.ts` | 40 | fork 境界線の位置 |
| `fold-tree.ts` | 39 | ある行を囲む fold の集合 (DOM でなくモデルから判断) |
| `layout-mode.ts` | 34 | 「横に並べきれるか」を CSS から読む |
| `json-string-token.ts` | 28 | Shiki トークンが JSON 文字列かの判定 |
| `timeline-summary.ts` | 24 | TL 要約 |
| `bounded-map.ts` | 24 | 上限付き挿入順 Map (`setBounded`) |
| `user-nav.ts` | 16 | 安定キー list 変更後の選択再索引 |
| `agent-communication-view.ts` | 40 | agent 間通信 segment の提示 |
| `dnd.ts` | 44 | セッション行 D&D のペイロード MIME |
| `sidebar-panes.ts` | 153 | サイドバー寸法の丸めと永続化 |

### 3.4 hook モジュール

| ファイル | 行 | 責務 | 使用箇所 |
|---|---|---|---|
| `useDraggable.ts` | 393 | フローティング要素の D&D 移動 (位置は永続化しない) | OneOnOneComposer / RoomComposerFab |
| `useFabPopup.ts` | 167 | FAB + ポップアップの open state / openTicket | 同上 2 箇所 |
| `useJsonStringCopy.tsx` | 154 | JSON 文字列トークンにコピーボタンを重ねる | FileViewer |
| `useDismissOnOutsidePointer.ts` | 79 | 外側クリックでキャンセル | RoomTitle / SessionRooms |
| `useCacheRing.ts` | 39 | cache リングの CSS を 1 sweep 分固定 | Composer 系 |
| `useNow.ts` | 16 | 相対時間表示用の 3 分 tick (`setInterval`) | 相対時刻を出す各所 |
| `filepath-linker.tsx` | 188 | パスリンカの共通配線 | **参照 0 (§5.4)** |

---

## 4. 状態の実態

### 4.1 `AppState` 全 39 フィールド

| # | フィールド | 型 | 変わる契機 | 読んでいる主な component |
|---|---|---|---|---|
| 1 | `rooms` | `Map<string, RoomState>` | msg / member push、`rooms/loaded` | RoomView, RoomList, Sidebar, App(TopbarTitle) |
| 2 | `roomsLoaded` | boolean | 同上 | RoomList |
| 3 | `peers` | `PeerInfo[]` | peers reply / push | SessionList, MemberChip, RoomCreator, main.tsx |
| 4 | `peersLoaded` | boolean | 同上 | SessionList |
| 5 | `lastLiveSessions` | `LastLiveSession[]` | peers と同一フレーム | SessionList |
| 6 | `agents` | `AgentInfo[]` | `op:agents` / `ev:agents` | SessionList, SessionView |
| 7 | `agentsLoaded` | boolean | 同上 | SessionList |
| 8 | `daemonInfo` | `DaemonInfo \| null` | hello | App(footer) |
| 9 | `versionMismatch` | `VersionMismatch \| null` | hello | App(reload ボタン), navigation |
| 10 | `hostTranslatorAvailable` | boolean | hello 後の probe ×1 | Timeline |
| 11 | `terminalGatewayUrl` | `string \| null` | hello ×1 | SessionView |
| 12 | `llmUsageAvailable` | boolean | hello ×1 | App, UsageView |
| 13 | `llmUsageProbes` | `Map<string, ProbeRecord>` | usage refresh | UsageView |
| 14 | `llmStatsAvailable` | boolean | hello ×1 | App, UsageView |
| 15 | `llmStatusAvailable` | boolean | hello ×1 | App, ServiceStatus |
| 16 | `llmStatus` | `LlmStatusReport \| null` | 接続時 / `ev:llm_status` | ServiceStatusBadge (全画面) |
| 17 | `sandboxAvailable` | boolean | hello ×1 | FileViewer |
| 18 | `forkAvailable` | boolean | hello ×1 | Timeline |
| 19 | `sidebar` | `SidebarUrlState` | `locator/changed` のみ (URL が正本) | Sidebar |
| 20 | `peerSortKey` | `PeerSortKey` | ユーザ操作 (localStorage) | SessionList, RoomCreator |
| 21 | `usageTab` | `"quota"\|"stats"` | ユーザ操作 | UsageView |
| 22 | `usagePeriod` | `StatsPeriod` | URL 由来 | UsageStats |
| 23 | `usageDays` | `number \| null` | ユーザ操作 | UsageStats |
| 24 | `view` | `View` | Navigation | App |
| 25 | `currentTab` | `SessionTab \| null` | Navigation | App, SessionView |
| 26 | `unknownPath` | `string \| null` | Navigation | App |
| 27 | `missingTarget` | `MissingTarget \| null` | Navigation | App |
| 28 | `currentRoomId` | `string \| null` | Navigation | App, RoomView |
| 29 | `currentMid` | `number \| null` | Navigation | RoomView |
| 30 | `currentSid` | `string \| null` | Navigation | App, SessionView |
| 31 | `currentAgent` | `AgentRef \| null` | Navigation | App, Timeline |
| 32 | `sessionTrees` | `Map<sid, SessionTreeState>` | transcript 購読 / fs_list | Timeline, FileTree, FileViewer |
| 33 | `sessionStatuses` | `Map<sid, SessionStatusSnapshot>` | status 購読 | StatusPanel, Timeline, SessionList |
| 34 | `sessionErrors` | `Map<sid, SessionApiError>` | `op/ev:session_errors` | SessionList |
| 35 | `llmRequests` | `Map<sid, LlmRequestInfo>` | `ev:llm_requests` | Composer 系 (cache ring) |
| 36 | `pinnedSessions` | `Map<sid, SessionSearchHit>` | ユーザ操作 + peers/agents 修復 | SessionList, SessionView |
| 37 | `mentionTo` | `Set<string>` | ユーザ操作 | Composer |
| 38 | `connStatus` | `ConnStatus` | 接続 / 切断 | App, Timeline |
| 39 | `sidebarOpen` | boolean | ユーザ操作 (sessionStorage) | App, Sidebar |

**内訳**: Navigation 由来 9 (#19, 24-31)、hello の能力フラグ 7 (#10-12, 14, 15, 17, 18)、
レイアウト 1 (#39)、表示設定 4 (#20-23)、残り 18 がドメイン状態。

### 4.2 「全 component が再レンダーされる」の根拠

```
useStore.ts:19-22   dispatch(action) { state = reducer(state, action);
                      for (const listener of listeners) listener(); }
useStore.ts:31-34   useStoreState(store) { const [state, setState] = useState(...);
                      useEffect(() => store.subscribe(() => setState(store.getState())), [store]); }
```

listener に selector も比較も無いので、**`dispatch` 1 回で全購読者の `setState` が
必ず呼ばれる**。`reducer` は 55 case すべてが新しいオブジェクトを返す
(`{...state, ...}` かヘルパ関数) ため、参照比較で弾かれることもない。

購読者は 7 個で、そのうち `App` がツリーの根。App は `Sidebar` / `SessionView` /
`RoomView` / `UsageView` に `state` を丸ごと props で渡すので、それらとその子孫も
props 変化で再レンダーされる。

抑止機構は 2 つだけ:

- `App.tsx:122` `memo(SessionView, skipInactiveSessionViewRender)` — 非表示の
  SessionView だけを止める
- `Timeline.tsx:2093/2223` `memo(LineView)` / `memo(FoldGroup)` — Timeline 内の行

### 4.3 派生値を component 内で毎回組み立てている箇所

| 場所 | 内容 | 規模 |
|---|---|---|
| `SessionList.tsx` | peers + agents + pinned + lastLive のマージとセクション分け | `useMemo` 9 個 |
| `Timeline.tsx` | fold の再構築、検索マッチ列挙、翻訳 availability、raw 行 | `useMemo` 45 個 |
| `FileViewer.tsx` | ハイライト結果、検索マッチ、markdown AST | `useMemo` 7 個 |
| `SessionSearchPanel.tsx` | 検索結果の整形 | `useMemo` 3 個 |

`useMemo` の合計は 73 個。設計文書 §4 は「`memo`/`useMemo` は signal 化で不要に
なるものとして扱う」としており、この 73 個が移行時の見積もり対象になる。

### 4.4 再接続時のふるまい

`ws.ts` の `onOpen` が rooms / peers / agents / session_errors / llm_requests /
status を一斉に取得して dispatch する。上記の通り 1 dispatch = 全体再レンダーなので、
**再接続 1 回でツリー全体の再構築が 6 回連続で走る**。

---

## 5. 疑わしいものリスト

### 5.1 同じ概念の二重実装 / 紛らわしい名前

| 対象 | 根拠 |
|---|---|
| **`Timeline.tsx` (4,918) と `TimelineItem.tsx` (288)** | 前者は「セッションの transcript ビュー」、後者は「room チャットの 1 メッセージ行」で **全くの別物**。`TimelineItem.tsx` を import しているのは `RoomView` 系のみ。名前から関係を推測できない |
| **`Composer.tsx` (402) と `OneOnOneComposer.tsx` (611)** | 共有しているのは `composer-upload.ts` / `composer-keydown.ts` / `ComposerAttachments.tsx` の 3 つのみ。下書きの永続化は OneOnOne 側だけが自前で localStorage に持つ (`loadDraft`/`saveDraft`/`clearDraft`)。room 側には下書き永続化が無い |
| **`FilesPanes.tsx` (169) と `TimelinePanes.tsx` (100)** | 後者のヘッダコメントが「`FilesPanes.tsx` の構造を鏡写しにした」と明記。ペイン 2 分割 + splitter + 比率保持という同じ形が 2 本 |
| **検索が 4 系統** | `in-view-search.ts` (クエリ解析・マッチ列挙、Timeline/FileViewer 共用) / `rendered-text-search.ts` (描画済み DOM への射影) / `file-search.ts` + `FileSearchPanel` (ファイル名、daemon 側マッチ) / `SessionSearchPanel` (過去セッション、daemon 側)。`SearchBar.tsx` は前 2 者の UI 殻のみを共通化しており、後 2 者は別 UI |
| **fold が 4 モジュール** | `Fold.tsx` (`<details>` 部品) / `fold-open-store.ts` (開閉状態) / `fold-tree.ts` (囲む fold の判定) / `timeline-auto-open.ts` (自動で開く category)。加えて `Timeline.tsx` 内に `useFoldOpen` / `useCategoryOpen` / `FoldGuide` / `FoldSummary` / `FoldGroup` |
| **incremental が 2 本** | `incremental-line-map.ts` (行単位) と `incremental-cross-line.ts` (行またぎ)。どちらも「transcript の差分再計算」で、`transcript-model.ts` と合わせて 3 層 |

### 5.2 store の外にある並行状態 (§3.2 の 10 箇所)

`AppState` に入らない状態が 10 箇所あり、**購読機構が 3 通りに分かれている**
(自前 listener / コールバック注入 / 無購読)。`fold-open-store.ts` と
`raw-view-mode.ts` はそれぞれ独自の listener セットを持ち、`useStore.ts` の
`createStore` と合わせて **同じ形のミニ store が 3 実装**存在する。

`main.tsx` の 2 つの `store.subscribe` も同種で、「store と別モジュールの両方を
知る場所が他に無い」ためエントリファイルに置かれている (コメントに明記)。

### 5.3 幅・レイアウトを JS が知っている箇所

| 場所 | 内容 | 判断 |
|---|---|---|
| `Sidebar.tsx:181` | `loadDrawerWidth(window.innerWidth)` | 初期幅の算出に viewport 幅を使う |
| `Sidebar.tsx:280, 312, 317, 321` | `clampSidebarWidth(..., window.innerWidth - m.start)` 等 | ドラッグ上限に viewport 幅。設計文書 §5 は「上限はコンテナ幅から導く」としており不一致 |
| `CatalogMdColors.tsx:329` | `matchMedia("(prefers-color-scheme: dark)")` | カタログが「両テーマの色を並べて見せる」ための読み取り。用途上は妥当 |
| `Timeline.tsx:4417` | `matchMedia("(prefers-reduced-motion: reduce)")` | アクセシビリティ設定の読み取り。幅ではない |

720px の breakpoint を JS が判定している箇所は**残っていない** (`pane-axis.ts` /
`layout-mode.ts` の `getComputedStyle` 方式に移行済み)。`utils.ts:422` と
`FilesPanes.tsx:6` / `TimelinePanes.tsx:5,66` の 720 はコメント内の言及のみ。
`UsageChart.tsx:14` の `WIDTH = 720` は SVG viewBox 幅で breakpoint とは無関係。

### 5.4 参照 0 の実行時 export (37 個)

`src` + `test` 全体で定義ファイル以外からの参照が 0 の `export function|const|class`。
型 (`interface`/`type`) は除外。

| モジュール | シンボル |
|---|---|
| `filepath-linker.tsx` | `makeFilePathLinker`, `useFilePathProbeEnqueue` — **モジュールの export が全滅**。ファイルごと未使用の可能性 |
| `raw-view-mode.ts` | `RAW_PRETTY_KEY`, `getRawViewPretty`, `subscribeRawViewPretty` — 購読 API が誰にも使われていない |
| `session-creator.ts` | `RESUME_AT_PARAM`, `TITLE_PARAM`, `cwdWithinRoots`, `launchDefaultsFromTranscript` |
| `llm-stats-view.ts` | `UNATTRIBUTED_CREDENTIAL`, `CONTEXT_KINDS`, `MAX_CHART_SERIES`, `labelStride` |
| `transcript-model.ts` | `isThinkingEntry`, `isSpawnPromptLine`, `parseSlashCommandPrompt` |
| `useDraggable.ts` | `DRAG_THRESHOLD_PX`, `getViewport` |
| `components/SearchBar.tsx` | `SearchTargetToggles`, `SearchFoldScopeToggle` — export された component が 2 つ未使用 |
| `llm-usage-view.ts` | `windowDurationMs`, `limitDurationMs` |
| `files-view-store.ts` | `FILES_VIEW_PREFIX`, `FILES_VIEW_STALE_DAYS` |
| その他 1 個ずつ | `in-view-search.unitMatches`, `sidebar-panes.DRAWER_DEFAULT_RATIO`, `issue-ref.roomRefUrl`, `storage.listStorageKeys`, `useNow.NOW_REFRESH_MS`, `llm-status-view.compareServices`, `utils.SID_SHORT_LEN`, `session-view-cache.SESSION_VIEW_CACHE_LIMIT`, `TimelineItem.issueRepoForRoom`, `OneOnOneComposer.keyFor`, `agent-tree-view.isErrorState`, `CatalogMdColors.MARKDOWN_ALL_SAMPLE`, `ServiceStatus.SERVICE_STATUS_ANCHOR` |

> 検出方法: `grep -alrw <name> --include='*.ts*' src test` から定義ファイルを除いて
> ヒット 0。文字列経由・動的アクセスは検出できないので、**削除前に個別確認が要る**
> (特に `SERVICE_STATUS_ANCHOR` のようなアンカー名は CSS / URL 側から使われうる)。

### 5.5 テストが 1 度も import しないモジュール (37 個、うち component 29 個)

`Timeline.tsx` (4,918) と `FileTree.tsx` (1,093) と `FileViewer.tsx` (1,426) には
それぞれ対応するテストファイルがあるが、**以下は test ディレクトリのどこからも
import されない**:

- 画面級: `SessionView.tsx` (407), `Sidebar.tsx` (326), `UsageView.tsx` (515),
  `RoomView.tsx` (294), `CatalogView.tsx` (850), `AgentTreePanel.tsx` (566),
  `SessionSearchPanel.tsx` (415), `ServiceStatus.tsx` (259), `UsageStats.tsx` (326),
  `CatalogMdColors.tsx` (404)
- 部品級: `SearchBar.tsx`, `TimelineItem.tsx`, `RoomList.tsx`, `RoomTitle.tsx`,
  `MemberChip.tsx`, `PaneSplitter.tsx`, `FilesPanes.tsx`, `TimelinePanes.tsx`,
  `CacheRing.tsx`, `ComposerAttachments.tsx`, `RoomComposerFab.tsx`,
  `TerminalPanel.tsx`, `ConnectionStatus.tsx`, `ErrorView.tsx`,
  `InlineFileViewer.tsx`, `ImageLightbox.tsx`, `UsageChart.tsx`,
  `FileSearchPanel.tsx`, `avatar.tsx`
- 配線: `context.ts`, `useCacheRing.ts`, `useNow.ts`, `useJsonStringCopy.tsx`,
  `useDismissOnOutsidePointer.ts`, `layout-mode.ts`, `filepath-linker.tsx`,
  `composer-upload.ts`

TSX に対するテストが薄いのは `docs/findings/2026-09-04-webui-render-test-feasibility.md`
の検討対象と重なる。純関数モジュール (§3.3) 側は `test/` 72 ファイルでよく覆われている。

### 5.6 「〜のため」の場当たり分岐

| 場所 | 内容 |
|---|---|
| `App.tsx:129-136, 149-158` | LRU で evict した sid を **render 中に ref へ積んで effect で dispatch** する。コメントに「render 中に dispatch すると Preact がツリーを構築中の store に再入するため」と理由が明記されている。store の粒度が細かければ不要になる類の回避 |
| `App.tsx:186-188` | `useEffect(() => { document.title = documentTitleFor(state); }, [state])` — 依存が `state` 丸ごとなので **全 action で実行される** |
| `App.tsx:170-183` | 初回だけ `layout.scrollLeft` を合わせる effect。依存配列なしで毎レンダー実行し、`initialSnapRef` と `max <= 0` で自前ガード |
| `session-view-cache.ts` | 「非表示の SessionView が store の churn で再レンダーされないように」だけのための `memo` 比較関数。§4.2 の問題への局所的な蓋 |
| `main.tsx:41-52` | peers 集合が縮んだら filepath キャッシュを消す `store.subscribe`。差分検知を自前の `Set` 比較で行っている |
| `Timeline.tsx:3122-3140` | agent TL では位置 pin を書き込まない分岐。「locator の文法上 agent ref と uuid を同時に表せない」ため。URL 文法の制約が component の分岐として現れている |

### 5.7 z-index とスタイルの散らばり

- `app.css` の z-index トークンは **`--z-composer: 40` の 1 個だけ** (150 行目)。
  リテラルは 9 箇所 (`z-index: 1` ×6、`2`、`5`、`100`)。設計文書 §5 の
  「用途別トークンに集約し、リテラルを散らさない (現状 6 段)」は未達で、
  段数はむしろ増えている。
- `!important` は **0 件** (この疑いは実測で否定された)。
- `@media` は 38 箇所。うち `max-width: 720px` が 4 箇所、残りは
  `prefers-color-scheme` (8) / `pointer: coarse` (7) / `hover` (5) /
  `prefers-reduced-motion` (6) と、**幅より入力・嗜好ベースが多い**。
- 単一ファイル 9,381 行で、component 単位の分割は無い。

### 5.8 ソース中の生 NUL 文字

| 場所 | 用途 |
|---|---|
| `components/timeline-position.ts:13` | `` `${sid}\0${position}` `` の合成キー区切り |
| `components/FileTree.tsx:810` | `` `${sid}\0${rootPath}\0${selectedPath}` `` |
| `components/FileSearchPanel.tsx:131` | `` folders.map(f => `${f.path}\0${f.name}`).join("\n") `` |

`timeline-position.ts:11` のコメントが「`\0` 区切りは uuid / sid に現れない」と
意図を説明しており、**バグではなく設計判断**。ただし副作用として `grep` /
`file(1)` がこれらをバイナリと判定し、`grep -a` を付けないと**マッチが黙って
0 件になる**。棚卸し・一括置換・lint の類で見落としを生む (本調査でも
最初のスキャンでこの 3 ファイルだけ欠落した)。

### 5.9 その他の観察

- **モジュールスコープの無制限キャッシュ**: `setBounded` (上限付き) が使われて
  いるのは `translate.ts` (3 箇所)、`viewer-scroll-store.ts`、`Timeline.tsx` の
  `CCMSG_BODY_CACHE` の計 5 箇所。一方 `navigation.ts:14` の `timelinePositions`
  と `filepath-existence-cache.ts:31-32` は上限なしの `Map`。前者は sid あたり
  1 エントリ、後者は peer 消失時に sid 単位で破棄されるので、**現状は実害が
  無いと見てよい** (推測ではなくコードの破棄経路を確認した)。
- **`ImageLightbox.tsx` はモジュールスコープの state で開閉を持つ**
  (`ImageLightboxHost` を App が 1 個置き、任意の場所から開く)。store を通らない
  グローバル UI 状態の 11 個目。
- **`storage.ts` に読み書き API が 3 系統ある** (`readStorage`/`writeStorage` =
  local、`readSessionStorage`/`writeSessionStorage` = session、
  `readLayoutStorage`/`writeLayoutStorage` = 両方に書いて session→local の順で読む)。
  設計文書 §6 の 3 分類に対応しているが、**どのキーがどの分類かを型で強制する
  仕組みは無く**、18 個の `ccmsg.*` キーが呼び出し側の規律だけで振り分けられている。
- **`agent-communication-view.ts` と `inline-file-model.ts` と `locator.ts` と
  `navigation.ts` と `timeline-auto-open.ts` と `rendered-text-search.ts` と
  `timeline-summary.ts` にはファイル冒頭の責務コメントが無い** (他の 110 ファイルには
  ある)。`locator.ts` / `navigation.ts` は URL 文法の中核なので、規約からの
  抜けとして目立つ。

---

## 6. 数値まとめ

| 指標 | 値 | 取得方法 |
|---|---|---|
| client 総行数 | 37,112 | `wc -l $(find src/client -type f)` |
| ファイル数 | 121 (tsx 50 / ts 71) | `find -name '*.tsx' \| wc -l` |
| `app.css` | 9,381 行 | `wc -l src/public/app.css` |
| `useStoreState` を呼ぶ component | 7 | `grep -rl useStoreState` |
| `useApp()` を呼ぶファイル | 21 | `grep -rl 'useApp()' \| wc -l` |
| `state: AppState` を props で受ける component | 10 | `grep -rhoE '<[A-Z][A-Za-z]* ?state=\{'` |
| `AppState` フィールド数 | 39 | `AppState` interface |
| `Action` の種類 | 46 | `grep -oE 'type: "[a-zA-Z/_-]+"' store.ts \| sort -u` |
| reducer の case 数 | 55 | `grep -c 'case "' store.ts` |
| `useState` 合計 (tsx) | 43 (Timeline のみ) / 全体 200+ | 下表 |
| `useMemo` 合計 | 73 | `grep -rc useMemo --include='*.tsx'` |
| `memo()` 呼び出し | 3 | `grep -rn 'memo(' --include='*.tsx'` |
| `useEffect` 合計 (Timeline) | 41 | `grep -c useEffect Timeline.tsx` |
| 参照 0 の実行時 export | 37 | §5.4 |
| テスト未 import の client モジュール | 37 | §5.5 |
| `!important` | 0 | `grep -c '!important' app.css` |
| z-index リテラル / トークン | 9 / 1 | `grep -n 'z-index' app.css` |
| `@media` | 38 (うち max-width:720px が 4) | `grep -n '@media' app.css` |
| `test/` のテストファイル数 | 72 | `find test -name '*.test.ts*' \| wc -l` |

### 上位ファイル 15 件

| 行数 | ファイル |
|---|---|
| 4,918 | `components/Timeline.tsx` |
| 2,716 | `transcript-model.ts` |
| 1,868 | `markdown-view.tsx` |
| 1,426 | `components/FileViewer.tsx` |
| 1,417 | `utils.ts` |
| 1,300 | `store.ts` |
| 1,169 | `components/SessionList.tsx` |
| 1,093 | `components/FileTree.tsx` |
| 1,078 | `ws.ts` |
| 850 | `components/CatalogView.tsx` |
| 611 | `components/OneOnOneComposer.tsx` |
| 606 | `components/StatusPanel.tsx` |
| 568 | `llm-stats-view.ts` |
| 566 | `components/AgentTreePanel.tsx` |
| 521 | `session-creator.ts` |

### hook 密度の上位 (tsx)

| ファイル | useState | useMemo | useCallback | useEffect | useRef |
|---|---|---|---|---|---|
| `Timeline.tsx` | 43 | 45 | 15 | 41 | 22 |
| `FileViewer.tsx` | 21 | 7 | 5 | 16 | 14 |
| `SessionList.tsx` | 11 | 9 | 0 | 7 | 6 |
| `FileTree.tsx` | 8 | 0 | 0 | 9 | 5 |
| `StatusPanel.tsx` | 8 | 0 | 0 | 0 | 0 |
| `CwdTree.tsx` | 8 | 0 | 0 | 3 | 0 |
| `AgentTreePanel.tsx` | 6 | 0 | 0 | 0 | 0 |
| `SessionCreator.tsx` | 6 | 0 | 0 | 2 | 0 |
| `UsageView.tsx` | 6 | 0 | 2 | 3 | 2 |
| `OneOnOneComposer.tsx` | 5 | 0 | 8 | 6 | 7 |
