# webui 全体設計 (状態 / 描画 / レイアウト / URL / 永続化 / 通信)

- Status: **Draft**。状態層と action の読み替えは [DR-0032](../decisions/DR-0032-repo-split-protocol-first.md) §2.1 で
  裁定済み。裁定待ちは §9。実装着手は DR-0032 確定と §9 の後で、本文書はその時点で新 webui リポ向けに再構成する
- 関係 DR: DR-0032 (リポ分離、webui は別リポの静的サイト)。DR-0004 §2 (WS 同一プロトコル) は不変
- 一次資料: 現状のコンポーネントツリー実測 (2026-09-05、[QUESTIONS.md](../QUESTIONS.md) 起票時の調査)、
  `packages/webui/src/client/` の実装

## 1. なぜ全体設計を書き直すか

現状の webui は、店舗 (room 一覧 + room view) だった時期の器のまま workspace (セッション一覧 /
Timeline / Files / Status / 検索 / usage) に育ったため、層の境界が無いまま機能が積まれている。
症状として観測されているもの:

- **無関係な component が再レンダーされる**: store が 1 個の `AppState` を丸ごと差し替え、購読は
  selector 無し (`useStoreState` = 全 action で全購読者を再レンダー)。App がルートで全状態を購読して
  props で配るので、どの action でもツリー全体が再レンダーされる
- **幅で構造が変わる**: 720px を CSS と JS の両方が知っていて、同じ概念 (サイドバー幅、フォームの
  親) が幅で別要素・別キーになる箇所が残る
- **layout の都合が state に漏れる**: `sidebarOpen` のような描画都合の値が、ドメイン状態
  (rooms / peers / sessions) と同じ store に同居し、同じ reducer を通る
- **1 ファイルの肥大**: `Timeline.tsx` が 4900 行、`store.ts` が 1300 行、`ws.ts` が 1060 行

根本は「状態の粒度」と「層の責務」が決まっていないことなので、機能の穴埋めではなく層を先に定義する。

## 2. 層と責務

```
┌────────────────────────────────────────────────────────────┐
│ Components (preact)   見た目と操作。signal を読み、intent を呼ぶ │
├────────────────────────────────────────────────────────────┤
│ Intents               ユーザ操作の意味 (selectSession, post …) │
├────────────────────────────────────────────────────────────┤
│ State (signals)       ドメイン状態。独立に変わる単位ごとの signal │
├──────────────┬─────────────────────────┬───────────────────┤
│ Transport    │ Navigation (URL)         │ Persistence        │
│ ws.ts        │ locator / sidebar-url    │ storage.ts         │
│ 受信 → state │ URL ⇄ state の双方向同期   │ state ⇄ storage     │
└──────────────┴─────────────────────────┴───────────────────┘
```

| 層 | 責務 | 持ってはいけないもの |
|---|---|---|
| **Transport** (`ws.ts`) | WS 接続・再接続・hello・request/response 相関、受信イベントを **state への書き込み**に変換 | 描画の知識、URL の知識 |
| **State** | ドメイン状態を **独立に変わる単位ごとの signal** で保持。派生値は `computed` | 副作用 (送信 / storage / DOM) |
| **Navigation** | URL (path + `sb.*`) と state (`locator`, `sidebar`) の双方向同期、history の push / replace の判断 | ドメイン状態の変更 (選択の変更は intent 経由) |
| **Persistence** | 値の永続化 3 分類 (§6) と復元。state の signal に `effect` で追随 | ドメイン知識 |
| **Intents** | ユーザ操作の意味単位 (「セッションを選ぶ」「投稿する」「パネルを開く」)。state 更新 + transport 送信 + navigation を**ここで束ねる** | JSX |
| **Components** | signal を読んで描く。イベントは intent を呼ぶだけ | store の構造を知って組み立てる処理、URL の組み立て |

「サーバイベントと UI 操作が同じ形式に乗る」(DR-0005 §1、kawaz 要求) は維持する: サーバイベントは
Transport が、UI 操作は Intents が、どちらも **state への書き込み関数**を呼ぶ形で揃える。型付き action
+ 単一 reducer という器は、粒度の問題 (全部が 1 つの値) を作っていたので、**更新関数 = action**
と読み替える (関数名が action 名、引数が payload。reducer の switch は消える)。

## 3. State: signal の単位

`@preact/signals` を採用する (候補比較は QUESTIONS の WA-Q1)。**単位の決め方**: 「同じタイミングで
一緒に変わり、一緒に読まれる」ものを 1 signal にする。独立に変わるものを同居させない。

現在の `AppState` (39 フィールド) の振り分け:

| 群 | signal | 変わる契機 |
|---|---|---|
| 接続 | `connStatus`, `daemonInfo`, `versionMismatch` | hello / 切断 |
| 能力 | `capabilities` = {translator, terminalGatewayUrl, llmUsage, llmStats, llmStatus, sandbox, fork} | hello 直後の 1 回 |
| セッション一覧 | `peers`, `agents`, `lastLiveSessions`, `sessionErrors`, `llmRequests`, `pinnedSessions` | それぞれ別の push / ポーリング |
| room | `rooms` (Map<id, RoomState>) | msg / member push |
| 現在地 | `locator` = {view, sid, roomId, tab, mid, agent, unknownPath, missingTarget} | Navigation |
| サイドバー | `sidebar` (= `sb.*` の URL 状態) | Navigation |
| セッション別 | `sessionTrees` (Map<sid, tree>)、`sessionStatuses` (Map<sid, status>) | transcript / status 購読 |
| 表示設定 | `peerSortKey`, `usageTab`, `usagePeriod`, `usageDays` | ユーザ操作 (永続) |
| 入力補助 | `mentionTo` | ユーザ操作 |
| レイアウト | `sidebarOpen`, 各ペイン幅 | ユーザ操作 (永続、§6) |

規約:

- **Map / Set を持つ signal は「要素単位の signal」を検討する**: `sessionTrees` のように sid ごとに
  独立に変わり独立に読まれるものは `Map<sid, Signal<tree>>` にして、1 セッションの更新で他のセッション
  の Timeline が更新されないようにする。`rooms` も同じ
- **派生値は `computed`** (例: 現在のセッションの tree、セクション分けした一覧)。component 内で毎回
  組み立てない
- **レイアウト値は state 層に置くが、ドメイン signal とは別 module** (`layout-state.ts`)。永続化
  分類も違う (§6)

## 4. 描画: component の規約

- component は `useApp()` から state を受け取り、**必要な signal だけを読む**。App から props で
  state を配る形は廃止する (App は骨格 (Topbar / Layout / Footer) を置くだけ)
- JSX の中で `signal.value` でなく `signal` をそのまま置ける箇所 (テキスト、属性) はそうする
  (preact-signals がテキストノードを直接更新し、component の再レンダー自体が無くなる)
- **入力欄は自分の状態を自分で持つ** (uncontrolled or local signal)。親の再レンダーで `value` を
  書き戻さない (IME 変換中の破壊を避ける)。下書きの永続化は Persistence が local signal に追随
- 大きな list (Timeline の行、一覧の行) は **要素ごとに component + 要素単位の signal** で、
  1 行の更新が他の行に波及しない
- `memo` / `useMemo` は「signal 化で不要になるもの」として扱い、新規には足さない
- **幅 (breakpoint) を JS で知らない**。縦横・表示切替は CSS が決め、JS が軸を要る時は
  `getComputedStyle` から読む (`pane-axis.ts` / `layout-mode.ts` の方式)

## 5. レイアウト

- DOM は 1 種類: `App = Topbar + Layout(Sidebar | main) + Footer`。Sidebar の中は
  `SidebarPanes(Lists | Splitter | Form) + SidebarSplitter`。幅による違いは CSS のみ
  (PC: main は残り幅 / スマホ: main は viewport 幅で Layout が横スクロール + スナップ)
- 絶対配置 (`position: fixed / absolute`) は「レイアウトに参加しない装飾・浮遊要素」に限る:
  composer の FAB とパネル、lightbox、Timeline 右端のつまみ、スプリッターの当たり判定拡張、
  cache ring の重ね描き。**ペインや列の配置には使わない**
- スプリッターは `PaneSplitter` (ドラッグの配管のみ) + 呼び出し側の「位置 → 一覧側のサイズ」変換
  (`pane-axis.ts`)。下限は `PANE_MIN_PX`、上限はコンテナ幅から導く
- z-index は用途別トークン (`--z-composer` 等) に集約し、リテラルを散らさない

## 6. 永続化の 3 分類

| 分類 | 例 | 保存先 | 読み |
|---|---|---|---|
| 窓ごと | `sidebarOpen` | sessionStorage のみ | 新しいタブは既定に戻る |
| レイアウト寸法 | 各ペイン幅 / 高さ / 比率 | session + local の両方に書く | session → local → 既定 |
| 内容 | 下書き、ピン留め、表示設定 | localStorage | localStorage |

URL に載せるもの (path と `sb.*`) は [webui-url-grammar.md](./webui-url-grammar.md) が正本。
URL に載せる = 共有・戻る/進むの対象、storage に載せる = その窓 / その人の好み、で分ける。

## 7. Transport と再接続

- 受信イベントは種類ごとに **対応する signal だけ**を更新する (`ev:agents` → `agents`、
  `ev:llm_requests` → `llmRequests`、transcript push → その sid の tree signal)
- 再接続時の再取得も同じ経路。**再接続で全状態を作り直さない** (onOpen で全 signal を一斉に書くと
  全体再レンダーの引き金になる。§1 の症状の一つ)
- 差分判定は daemon 側が担う (peers の compare key、agents の stableKey)。webui 側は届いた
  ものを信じて書く。同値の再書き込みは signal が弾く (`===` なら購読者に通知しない)

## 8. 移行計画

進め方は DR-0032 §2.2 (新 webui を別リポで並走させ、画面ごとに移す)。本文書の層の定義 (§2〜§7) は
新 webui 側の規約として使う。段階ごとに「再レンダー component 数 / 1 イベント」を Preact の debug
hook で計測し、数値を残す。Timeline の分割 (行の種類ごとの component / fold・検索・自動追随の intent /
transcript-model) は別 doc (`timeline-architecture.md`) を起こす。

## 9. 未確定 (新 webui の実装時に統括が決める)

- signal の単位 (要素単位 signal の範囲)。まず群単位で始め、Timeline を作る段階で要素単位を判断する
