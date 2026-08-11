# フォーム UX 幅調査 (D フェーズ材料)

対象: webui のフォーム 3 系統。隔離 daemon + playwright、1280x900 / 390x844 実測 (2026-08-12, v0.99.0)。

## 判明した事実

- サイドバー内フォームは「デスクトップの方がスマホより狭い」逆転が起きている。1280px でフォーム実効幅 264px (main ペインは 995px 空いている)、390px では 316px。幅の制約はサイドバーという置き場所そのものに由来する。

### 1. new session フォーム (`SessionCreator.tsx` 479 行 + `session-creator.ts`)

- サイドバー `#sessions-panel` 内でインライン置換される (開いている間 `SessionList` が消える、`Sidebar.tsx:189-195`)。
- 状態は `Sidebar.tsx:146` の `useState<SidebarPanelState>` (URL/ストアに出ない、`sidebar-panel.ts` の union が 3 パネル排他を担保)。fork prefill のみストア経由。
- 実測 1280x900: `#sidebar` 280px (`--sidebar-width`、splitter 200〜560、localStorage 永続)、`#session-creator-panel` 264x708、main は 995px 空き。
- 問題:
  1. cwd 確定表示が末尾から切れる (422px 必要 vs 234px 枠、worktree 識別は末尾なのに末尾が見えない)
  2. uuid 36 文字が scrollWidth 270 > clientWidth 262 で溢れる
  3. command textarea が 30 文字弱で折返し
  4. RESUME_AT ヒント文が 5 行
  5. cwd ツリーが二重スクロール
  6. fork テンプレでパネル高 902px vs sidebar 845px となり、実行ボタンが両幅とも画面外
  7. 入力中はセッション一覧が不可視
- スマホ 390x844 は 316px で new テンプレなら縦は収まるが、overlay で背後不可視 + splitter は `display:none` (`app.css:5006`)。

### 2. セッション検索 (`SessionSearchPanel.tsx` 318 行)

- 同じサイドバー内 264px。「検索は使い捨てツール、locator にしない」は `Sidebar.tsx` の doc comment に明文化された設計判断。
- 結果抜粋が 27 文字前後 ×3 行で切れて判断材料が読めない。
- config dir チェックは `word-break: break-all`。

### 3. TL 内検索 (`SearchBar.tsx` / `Timeline.tsx` `.tl-toolbar`) とファイル検索 (`FileSearchPanel.tsx`)

- どちらもサイドバー外。
- TL 検索はデスクトップ editor 433px で幅は足りるが、390px で `.search-bar-editor` (非折返し flex) が溢れる。💬 (right 446px) / 📁 (right 492px) が viewport 外・scrollWidth 390 でスクロールも不可 = 操作不能の実バグ (D フェーズと独立に修正対象)。
- FileViewer 同居時はファイルパスが省略される。
- ファイル検索は結果行 531px を 262px 枠で横スクロールする必要がある。
- 3 系統で幅レジームが 264 / 173 / 262 とバラバラ。

### 4. 移行案ごとに壊れるもの

共通前提: 開閉状態が URL にもストアにも無い。

- **モーダル化**: フォーカストラップ/Esc を新設する必要、検索→TL 遷移時の「閉じる」判断、TL 参照動線の消失、スマホで overlay in overlay になる。
- **パネル化**: main ペインのタブ構造との差し込み競合、`PaneSplitter` キー増、TL 再マウントの有無は要検証。利点: 一覧を見ながら入力できる。
- **ページ化**: DR-0021 SS-Q1/Q2・DR-0018 §3.4 の明文判断を覆す DR 改訂が前提。fork prefill を URL に載せるか、実行結果 (stdout/stderr) がページ離脱で消える問題がある。

## 実用的な示唆 / ベストプラクティス

- D-Q1 として `QUESTIONS.md` に起票済み。統括推しは main ペインのパネル化。
- TL 検索のスマホ操作不能バグは D フェーズの意思決定と独立に修正対象。

## 検証の詳細

隔離 daemon + playwright により 1280x900 (デスクトップ想定) と 390x844 (スマホ想定) の 2 サイズで実測。数値・座標は上記「判明した事実」内に記載済み。
