# webui client の第三者レビュー (前知識なし、Preact / TS のベストプラクティス照合)

- Date: 2026-10-14

レビュアーの前提: docs / DR を読まず、`packages/webui/src/client` のコードと `.oxlintrc.json` / `tsconfig` / `packages/webui/test/` の方式だけを根拠にした。読んだ範囲は `store.ts`、`ws.ts`、`useStore.ts`、`context.ts`、`main.tsx`、`components/App.tsx`、`components/Timeline.tsx` (本体 3160-4972 行、1067-1415 行、2509-2609 行)、`components/SessionView.tsx`、`components/SessionInputComposer.tsx`、`components/session-input-store.ts`、`components/Sidebar.tsx`、`components/SessionList.tsx` (抜粋)、`components/RoomView.tsx`、`components/FileViewer.tsx` (721-1060 行)、`navigation.ts` (230-387 行)、`raw-view-mode.ts`、`useNow.ts`、`session-view-cache.ts`。行番号は v0.166.2 時点。

## 判明した事実

- データ層 (store / ws / 境界の parse) は堅実: reducer は純粋で Action が判別共用体、境界で valibot に通して `as` / `any` / `!` が無い、副作用は ws.ts と component effect に隔離、ロジックの大半を pure な `.ts` に切り出してテストしている (test 75 ファイル)。
- 問題は component 層に集中する。`Timeline()` は 1 関数 1812 行で hooks 約 90 個 (useEffect 24 / useMemo 27 / useState 14 / useRef 11 / useCallback 13)、createContext 8 個。
- hooks の基本規則違反がある: early return の後の hook 呼び出し (`Timeline.tsx:4548` → `4569/4570/4585`)、render 中の ref 書き換え (3 箇所)、deps を意図的に欠いた effect (9 箇所以上)。
- それを検出する仕組みが無い: `.oxlintrc.json` に react plugin (rules-of-hooks / exhaustive-deps) が無く、`preact/debug` も無く、DOM テスト環境が無いので component は vnode の形しか検査されていない。
- store 購読 (`useStore.ts`) は useState + useEffect の自作で selector が無く、購読者 7 箇所が全 dispatch で再描画される。`App.tsx` の SessionView memo (非表示ビューの描画スキップ) は `Timeline.tsx:3195` の直接購読で無効化されている。
- 同じ問題に対する解法がリポ内で複数流儀になっている: scroll settle (setTimeout 列 vs ResizeObserver)、非同期 effect のキャンセル (有 / 無)、localStorage 永続化 (4 流儀)、in-view search (Timeline / FileViewer の二重実装)、transcriptRead → dispatch (5 重コピペ)。
- 総合 6 / 10 (データ層のみなら 8)。

## 実用的な示唆 / ベストプラクティス

最初に直すべき 3 つ (詳細は後述の指摘番号):

1. **oxlint の `react` plugin を有効化し、`Timeline.tsx:4548` の early return と deps 欠落 effect を直す** (#1, #3)。コストは小さく、以後の退行を機械的に止められる。
2. **`useStoreState` を `useSyncExternalStore` + selector にし、`AppState` 丸渡しをやめる** (#4, #5, #17)。SessionView の memo 戦略が初めて意味を持ち、再描画コストの議論が成立する。
3. **`Timeline` を関心ごとの custom hook / ファイルに分割し、happy-dom 等で hook レベルのテストを足す** (#2, #9, #10, #11, #13)。分割の過程で #6 / #7 / #23 / #24 も自然に解消する。

横断的な規律として: await を含む effect は必ずキャンセル可能にする (`useAsyncEffect(signal => …)` に統一)、永続化は store 由来なら `main.tsx` の effect-layer helper 1 本、component ローカルなら `usePersistedState` 1 本、module singleton は `createClientRuntime()` が作って `AppContext` で配る。

## 検証の詳細

### 良い点 (評価の根拠)

| 項目 | 観測 |
|---|---|
| state 設計 | `store.ts` の `AppState` / `Action` は判別共用体、reducer は純粋 (network / DOM / storage に触れない) |
| 境界の型付け | `ws.ts` は `readDaemonFrame` で全 frame をスキーマに通す。localStorage の読み戻しも valibot (`session-input-store.ts`、`raw-view-mode.ts`) |
| 型の主張 | `as` (`as const` 以外) / `any` / `!` が無い。`.oxlintrc.json` の `consistent-type-assertions: never` で強制 |
| socket 世代管理 | `ws.ts:942-963` の listener が `socket !== ws` で守られ、`flushPending` で古い resolver が残らない |
| テスト戦略 | ロジックを pure `.ts` に切り出し (`in-view-search.ts`、`timeline-position.ts`、`session-input-store.ts` 等) vnode や DOM に依存しないテストにしている |

### high

#### 1. Timeline の early return の後に hook がある (rules-of-hooks 違反)

- 箇所: `packages/webui/src/client/components/Timeline.tsx:4548-4554` で `return <div class="timeline-view">…` した後、`4569` (`selfPeer` useMemo)、`4570` (`sessionFilePathCtx` useMemo)、`4585` (`ccmsgRenderValue` useMemo) が呼ばれる。
- なぜ問題か: hooks は毎 render 同じ順序・同じ個数で呼ぶのが React / Preact 共通の前提。`timeline.status` は store 側で loaded → idle に戻る経路がある (`store.ts:889-905` の agent ref 切替、`timeline/evicted`) ので hook 数が render 間で増減する。Preact は末尾の hook が消えても黙って動くが、React なら即例外、lint があれば即エラー。`FileViewer.tsx:854` のコメントで「hook-order rule」を意識している以上、同じリポ内で破られている。
- 直し方: 3 つの useMemo を early return より前に移す。あるいは loading 分岐を別コンポーネントにして Timeline 本体を常に全 hook 実行にする。

#### 2. `Timeline()` が 1 関数 1812 行、hooks 約 90 個

- 箇所: `packages/webui/src/client/components/Timeline.tsx:3160-4972`。本体だけで `useEffect` 24、`useLayoutEffect` 1、`useMemo` 27、`useCallback` 13、`useState` 14、`useRef` 11。ファイル全体 4972 行、`createContext` 8 個。
- なぜ問題か: effect 同士が ref (`prevEndRef`、`landedPositionRef`、`isNearBottomRef`、`wasVisibleRef`、`userScrolledSincePinRef`) と「宣言順で実行される」前提 (`4301` のコメント「両 effect の実行順序は定義順」) で結合している。1 つの effect の deps を触ると別の effect の前提が崩れる構造で、DOM テスト環境が無いので一切テストされていない。
- 直し方: 関心ごとに custom hook へ分解 (`useTranscriptLoader(sid, agent)`、`useLiveTailSubscription`、`useStickToBottom`、`useInViewSearch`、`useUserTurnNav`、`usePositionLanding`、`useAutoOpenSettings`)。各 hook は自分の ref を内側に閉じ、外には値とハンドラだけ出す。ファイルは `timeline/` ディレクトリに分割 (segments / bubbles / folds / ccmsg / search)。

#### 3. hooks 系 lint が無効で、「deps を意図的に欠く」effect が常態化

- 箇所: `.oxlintrc.json` の plugins は `typescript` / `unicorn` / `oxc` のみ。`react` plugin (`rules-of-hooks`, `exhaustive-deps`) が入っていない。
- 結果として closure を deps から外した effect が多数: `Timeline.tsx:3433` (`agentOpts` / `store` / `ws` 欠落)、`3464`、`3506` (コメントで「timeline.status is intentionally not in deps」)、`3964`、`4329` (`[sid]` のみで `currentPosition` / `scrollToBottomSettled` を閉じ込める)、`4381` (`[timeline.end]` のみで `userTurnKeys` / `currentPosition` を閉じ込める)、`4423`、`SessionView.tsx:287` と `SessionInputComposer.tsx:139` (`[state.peers.length]` で `state` 全体を閉じ込める)。
- なぜ問題か: React 公式は「deps を嘘で埋めるな、effect の構造を変えろ」と明言している (effect を分ける / "latest ref" / イベント化)。今の形は「この render 時点の値を使いたい」という意図を deps の欠落で表現しており、次に deps を正しく書いた人が挙動を壊す地雷になる。#1 もこの lint があれば入らなかった。
- 直し方: oxlint の `react` plugin を有効化し `react/rules-of-hooks: error`、`react/exhaustive-deps: warn` から始める。警告が出る effect は (a) mount 時 1 回の処理と更新時の処理に分ける、(b) 最新値が欲しいだけなら `useRef` に写す、(c) 「sid が変わった時」のような event は `useEffect` でなく key 付きコンポーネント化 (`<Timeline key={sid}>`) で表す。

#### 4. `useStoreState` が自作購読で selector が無い

- 箇所: `packages/webui/src/client/useStore.ts:31-35`: `useState(store.getState())` + `useEffect(subscribe)`。`raw-view-mode.ts:104-108` も同形。
- なぜ問題か: (a) 初回 render と effect 登録の間の dispatch を取りこぼす (tearing)。(b) 購読者全員が全 dispatch で再描画される。購読者は App、Timeline、SessionList、StatusPanel、SessionSearchPanel、FileViewer ×2 (`FileViewer.tsx:746` は `connStatus` 1 項目のために全 state を購読)。(c) preact/compat の `useSyncExternalStore` は `Timeline.tsx:3824` (翻訳レジストリ) で既に使われており、main store にだけ使っていないのが不統一。
- 直し方: `useStoreState(store, selector, isEqual = Object.is)` を `useSyncExternalStore` で実装し、各コンポーネントは必要な slice だけ選ぶ。`raw-view-mode.ts` も同じ hook に乗せる。

#### 5. SessionView の memo が Timeline の直接購読で無効化されている

- 箇所: `App.tsx:122-124` の `CachedSessionViewComponent` と `session-view-cache.ts:11-17` は「非表示の SessionView は store churn で再描画しない」が目的。しかし `Timeline.tsx:3195` が `useStoreState(store)` を直接呼ぶので、キャッシュされた最大 3 つの SessionView 配下の Timeline (TimelinePanes なら複数) が、他セッションの tail push・peers push・SessionList の 10 秒 tick を含む全 dispatch で 1800 行の本体を再実行する。
- なぜ問題か: 最適化の意図と実装が食い違っている。`MemoFoldGroup` / `MemoLineView` が DOM diff を抑えるので体感はまだ持つが、`useMemo` 27 個の deps 比較と `parseUrl(location…)` 等は毎回走る。
- 直し方: #4 の selector 化で Timeline の購読を `connStatus` / `says` / `peers` / `rooms` / `forkAvailable` / `hostTranslatorAvailable` / `sessionTrees.get(sid)` に絞るか、SessionView が props で渡して Timeline は store を見ない。

### medium

#### 6. render 中に ref を書き換えている

- 箇所: `App.tsx:146-155` (`sessionViewsRef.current = …`、`evictedSidsRef.current.push`)、`SessionView.tsx:114` (`visitedTabs.current.add(tab)`)、`Timeline.tsx:3800` (`itemRawLookupRef.current = …`)。
- なぜ問題か: render は純粋であるべきで、ref の読み書きは effect / handler に限る (React 公式 "Keeping Components Pure")。render が 2 回走る環境 (StrictMode 相当、中断された render) で `push` が重複する。`App.tsx` のコメント自身が「dispatch during render は危険」と書いているが、ref 書き換えも同じ理由で危険。
- 直し方: `sessionViews` は `useReducer` / store の派生状態 (locator 変化時に reducer で LRU 更新)、`visitedTabs` は `useState` + effect、3800 は "latest ref" パターンを `useEffect` 内で更新。

#### 7. render 中に `location` / `window.navigation` を読む

- 箇所: `Timeline.tsx:3197` `parseUrl(location.pathname, location.search)`、`App.tsx:267/277` `window.navigation.canGoBack / canGoForward`。
- なぜ問題か: store は `locator/changed` で URL を受け取っているのに (`navigation.ts:279-285`)、Timeline は URL を自前で再パースして `currentPosition` を導出している。再描画は「たまたま他の dispatch が来る」ことに依存。`replaceNavigation` → intercept → dispatch という副経路で動いてはいるが、読んだ人には追えない。
- 直し方: `position` を `AppState` に載せ (`applyLocatorChanged` の timeline 分岐)、Timeline は props / selector で受ける。履歴ボタンの可否は `currententrychange` で更新する store フィールドにする。

#### 8. ws.ts の handshake が socket に束縛されていない

- 箇所: `ws.ts:542-711` `onOpen()` は各 `send` で「その時点の `ws`」を使う。`flushPending` (872) は pending を reject ではなく `connection_closed` で resolve するので、keepalive timeout → `connect()` (905-909) が handshake 中に走ると、旧 `onOpen` は hello の失敗を受けた後も `rooms` / `subscribe` / `peers`… を続行し、`ws` が新しい CONNECTING socket なら `connecting` キュー (495-498) に積まれて新 socket で送られる。新 socket 側の `onOpen` も同時に走り、二重 handshake + 古い `spaHasState` スナップショットでの subscribe になる。
- 発生条件は「handshake 中に 30s 無通信 + 10s ping 無応答」なので狭いが、「listener は全部 `socket !== ws` で守る」(942-947 のコメント) という設計方針が handshake 本体に適用されていない穴。
- 直し方: `onOpen(socket)` に socket を渡し、各 `await` の後で `if (socket !== ws) return;`。または `AbortSignal` を `send` に渡す。

#### 9. `transcriptRead → dispatch` の 5 重コピペ

- 箇所: `Timeline.tsx:3418-3433` (初回)、`3450-3464` (resync)、`3490-3506` (再訪)、`3511-3521` (`loadOlder`)、`3533-3549` (`refresh`)。then / else / catch の 3 分岐が全て同形。
- 直し方: `const readTranscript = useCallback((mode, before?) => …, [sid, agentOpts, ws, store])` 1 本にし、各 effect はそれを呼ぶだけにする。loading dispatch の有無は引数で。

#### 10. in-view search の Timeline / FileViewer 二重実装

- 箇所: `Timeline.tsx:3703-3716, 3955-3975, 3919-3923` と `FileViewer.tsx:1017-1049`: query 3 状態、`parseSearchQuery` memo、「query が変わったら index を 1 に戻す」effect、「件数が変わったら clamp」effect、`Map<key, HTMLElement>` + `register` callback が同じ形で 2 回書かれている。
- 直し方: `useInViewSearch({ query, units })` を `in-view-search.ts` の隣に置き、両者がそれを使う。

#### 11. scroll の "settle" を setTimeout の列で行っている

- 箇所: `Timeline.tsx:4087-4089` `[0, 60, 300]` の `scrollIntoView`、`settledScroll` (2973) は 0/60/300/1000ms、`RoomView.tsx:82` `[0, 60, 300]`。一方 `FileViewer.tsx:979-983` は同じ問題を ResizeObserver + ユーザ操作で解除、で解いている。
- なぜ問題か: 根拠の無い時間値は遅い端末で足りず、速い端末では不要。同一リポに正しい解法が既にあるのに不統一。
- 直し方: `useStickToBottom(scrollerRef, { active })` のような hook に ResizeObserver 版を集約し、Timeline / RoomView もそれを使う。

#### 12. SessionInputComposer の二重正本

- 箇所: `SessionInputComposer.tsx:81-95`: `contentRef` が `text` / `attachments` state を手動で複製。`beginUpload` / `removeAttachment` / `restoreDraft` は ref を読み、`handleSubmit` (340-361) は state の `text` / `attachments` を読む。
- なぜ問題か: 添付直後に ⌘+Enter を押すと (再 render 前)、`handleSubmit` は古い `text` を送る。2 つの読み口があること自体が不整合の温床。
- 直し方: content を `useReducer` に寄せ、handler は `dispatch` で更新しつつ `reducer` 内で最新値を読む。あるいは `session-input-store.ts` が既に draft を正本にしているので、そこに content state を持たせて component は購読だけにする。

#### 13. 非同期 effect のキャンセル規律が不統一

- 箇所: `Timeline.tsx:1096-1131` `useTranslatedText`: `translateTextOnHost` の結果で unmount 後も `setHost` が走る (cancelled フラグ無し、`source === text` の一致判定で表示だけ守っている)。`useCcmsgBody` (2543) は cancelled 有り、`FileViewer.tsx:999-1005` は有り、`SessionView.tsx:224` は有り。
- 直し方: await を含む effect は必ず `let cancelled = false; return () => { cancelled = true }` か `AbortController`。lint で強制できないので、`useAsyncEffect(signal => …)` の小さな hook に統一する。

#### 14. error boundary が 1 つも無い

- 箇所: `componentDidCatch` / `ErrorBoundary` の grep 結果 0。Timeline は任意の JSONL 行を 4972 行のコードで描画する。
- なぜ問題か: 1 行の描画で throw すると `render()` の tree 全体が落ち、復旧手段がリロードしかない。`ErrorView` という表示部品は既にあるのに、受け止める境界が無い。
- 直し方: `class Boundary extends Component { componentDidCatch }` を 1 つ作り、SessionView / RoomView / 各 Timeline item (`ItemRawToggle` 相当) を包む。fallback は既存の `ErrorView`。

#### 15. localStorage 永続化が 4 流儀

- 箇所: effect で値変化ごとに書く: `App.tsx:168` (sidebarOpen)、`Sidebar.tsx:186-197` (4 つの幅。drag の毎フレーム書き込み + mount 時に読んだ値をそのまま書き戻す)。handler で書く: `Sidebar.tsx:242`、`Timeline.tsx:3341`、`FileViewer.tsx:921`。`store.subscribe` で書く: `main.tsx:64-71` (pinned)、`ws.ts:861-864` (since、1 メッセージごとに `JSON.stringify` + `setItem`)。module singleton: `raw-view-mode.ts`。
- 直し方: store 由来の値は `main.tsx` に `persist(store, selectPinned, KEY, schema)` のような effect-layer helper 1 本で統一。component ローカルの好みは `usePersistedState(key, schema)` 1 本。`since` は rAF / idle で debounce。

#### 16. module-level singleton が状態を持っている

- 箇所: `Timeline.tsx:2516` `CCMSG_BODY_CACHE`、`1198` `pendingViewportTranslations`、`translate.ts` レジストリ、`filepath-existence-cache.ts`、`raw-view-mode.ts`、`session-input-store.ts` `inFlight` / `lastFailures`、`trace.ts` (`ws.ts:534` で `setActiveTraceCollector`)。
- なぜ問題か: テストで初期化する口が `resetSessionInputPageState` にしか無い。`main.tsx` が `configureFilePathExistenceCache(ws…)` で後から配線するなど、依存の向きがファイルを跨いで見えない。
- 直し方: `main.tsx` で `createClientRuntime()` が store / ws / 各 cache を作り、`AppContext` の value として配る。テストは runtime を作り直すだけで済む。

#### 17. `AppState` 丸ごとを props で受けるコンポーネントが 11

- 箇所: App、Sidebar、RoomView、RoomList、SessionView、SessionInputComposer、SessionRooms、SessionCreator、UsageView、ServiceStatus 等 (`grep "state: AppState" components` で 15 箇所)。
- なぜ問題か: props が「何を必要とするか」を表さず、テストで full AppState を組み立てる必要があり、memo が効かない。`SessionList` は `peers` だけ props で受けつつ残りは store 購読という中間形 (880 行目のコメント「Sidebar.tsx's own props surface is out of this task's scope」) になっている。
- 直し方: #4 の selector hook を導入し、各コンポーネントは自分の slice だけ選ぶ (props か selector のどちらかに統一)。

#### 18. reducer のイベント追加が配列コピーで、frame ごとに全体再描画

- 箇所: `store.ts:759-760, 777, 794, 808` `timeline: [...r.timeline, ev]`、`749` と `813` で `new Map(rooms)` を 2 回。`ws.ts:865` は 1 frame 1 dispatch。
- なぜ問題か: `room_history` で N 件届くと O(N²) のコピー + N 回の App 再描画 (Preact の setState batching は同一 task 内のみで、WebSocket の message は task ごと)。
- 直し方: ws.ts で 1 tick 分の delivered event を集めて `protocol-events: DeliveredEvent[]` を 1 回 dispatch。reducer は batch を 1 回のコピーで畳む。

#### 19. Navigation API を feature detect していない

- 箇所: `navigation.ts:254, 261, 293`、`App.tsx:267, 277`、`FileViewer.tsx:936, 955` で `window.navigation` を無条件使用。
- なぜ問題か: 対応していないブラウザでは `setupNavigation` で起動時に throw し、白画面。意図的に Chromium 限定でも、その旨を表示する分岐が無い。
- 直し方: `main.tsx` で検出し、非対応なら `ErrorView` で理由を出す (または History API fallback)。

#### 20. SessionView の scroll 位置退避が `querySelectorAll("*")`

- 箇所: `SessionView.tsx:118-128`: 遷移のたびに配下の全要素を走査して scrollTop ≠ 0 を Map に保存。Map のキーは HTMLElement なので detach された要素も保持。
- 直し方: スクロール容器に `data-scroll-keep` を付けて `querySelectorAll("[data-scroll-keep]")` だけ見る。`viewer-scroll-store.ts` が既にあるのでそちらに寄せるのも手。

#### 21. RoomView の timeline が index key

- 箇所: `RoomView.tsx:263` `key={i}`。`store.ts:708-717` `forgetRoomHistories` で配列が空になって再取得されるため、同じ index が別イベントを指す瞬間がある。
- 直し方: `seq` があるなら `seq`、無ければ `${ev.type}:${ev.ts}:${mid ?? id}`。Timeline 内の `key={i}` (1649, 1678, 1681, 1757, 1799, 2074, 2281, 2388) は 1 行内の固定配列なので許容。

### low

#### 22. `utils.ts` が 1399 行 / 72 export の寄せ集め

- 時刻整形、peer ソート、ペイン幅計算、ファイルパス分類、session search フォーム、pinned storage、document title が同居。
- 直し方: `time-format.ts` / `session-rows.ts` / `pane-math.ts` / `file-path.ts` / `session-search-form.ts` に分割。

#### 23. 永続化の初期化が二重

- 箇所: `Timeline.tsx:3277-3282` `useState` 初期化で localStorage を読み、`3328-3336` の effect が mount 時にもう一度読んで `setAutoOpenRevision` を進める → `3358` で `foldOpenStore.reset()` が mount 直後に 1 回余分に走る。
- 直し方: effect を「sid / agentKey が変わった時だけ」にする (前回値を ref で比較するか、`key={sid}` で remount)。

#### 24. 制御 `<details>` の同期に合成 `toggle` イベント

- 箇所: `Timeline.tsx:4043-4047` `d.open = true; d.dispatchEvent(new Event("toggle"))`。制御 details の state 追従を DOM 側から逆流させるハック。
- 直し方: `FoldOpenStore` を唯一の正本にし、nav は store に `set(key, true)` するだけ (既に `openFoldsAt` がそれをしている。DOM 操作版を残す理由が無い)。

#### 25. 死んだ API 面

- 箇所: `ws.ts:267-273` `sessionStatus` は「Not called by any component today … kept for parity」。
- 直し方: 削除。必要になった時に足す。

#### 26. `useTranslatedText` の状態機械が boolean の束

- 箇所: `Timeline.tsx:1080-1085` 4 つの state + `done` / `pending` 比較で 3 状態 × 2 経路を表現。`translate.ts` に既にレジストリ (cache + subscribe + revision) がある。
- 直し方: 翻訳の進行状態をレジストリ側に持たせ、component は `useSyncExternalStore(subscribe, () => getTranslation(text, route))` で読むだけにする。

#### 27. `document.title` effect の deps が `[state]`

- 箇所: `App.tsx:187-189`。実質「毎 dispatch」。
- 直し方: `const title = documentTitleFor(state)` を計算して `[title]` に。

#### 28. 型が string に落ちている箇所

- 箇所: `utils.ts:724` `export type SessionStatus = string;`、`SessionList.tsx:845` `Record<string, string>`。union が存在するのに stringly-typed。
- 直し方: `"busy" | "waiting" | "error" | …` の union を定義し `Record<SessionSection["key"], string>` に。

#### 29. App の「毎 render 条件付き」effect

- 箇所: `App.tsx:174-183` deps 無しの effect が `max <= 0` の間は毎 render 再試行。
- 直し方: `ResizeObserver` で幅が付いた瞬間に 1 回だけ、または `useLayoutEffect` + 幅を deps に。

#### 30. dev 時の hooks 誤用検知が無い

- 箇所: `preact/debug` の import が無い (grep 0)。#1 のような問題は dev bundle で `preact/debug` を入れるだけで検出できる。
- 直し方: dev 用エントリで `import "preact/debug"`。

#### 31. コメントが変更履歴とレビュー参照で埋まっている

- 「kawaz r17 mid=54: 以前は…」「v0.33.2 まで…」「以前はここに手書きの if ガードがあった」等が随所。`r17 mid=54` は外部参照として解決できない。
- 直し方: 「現在こうである理由」だけ残し、経緯は VCS に任せる。

### 全体の評価: 6 / 10

- 加点: 型付き Action + 純粋 reducer、境界でのスキーマ parse、`as` / `any` 不使用、effect 層 (ws.ts) の socket 世代管理、pure ロジックの切り出しとテスト、JSX 内コメントで意図を残す姿勢。データ層だけなら 8 点。
- 減点: component 層で hooks の基本規則 (順序、deps、render 純粋性) が守られておらず、それを検出する lint も DOM テストも無い。`Timeline` は「動いているから触らない」領域になっており、memo / LRU などの最適化が購読設計と噛み合っていない。store 購読に selector が無いこと、AppState 丸渡し、永続化と singleton の多流儀は、全部「最初の小さな決定をそのまま拡大した」結果に見える。
