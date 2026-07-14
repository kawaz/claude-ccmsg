# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス

## 現在の裁定待ち

### RLD-Q1: webui SPA 内リロードボタンの配置

出典: kawaz r12 mid=14 (2026-07-14) / a3 r12 mid=15 で提示。
背景: iOS ホーム画面追加からの PWA 起動時にブラウザリロードが無いため、SPA 内にリロードボタンが要る。

- **a) topbar (App.tsx `#topbar`) 一箇所に統一** — mobile PWA でも常時見える、desktop でも topbar は常時見える (**AI 推し**)
- b) topbar (mobile) + Sidebar header (desktop) の二箇所
- c) その他

参照: task #17。実装は本 Q 裁定後着手。

### DR13-Q1..Q4: broadcast room の Open questions

出典: docs/decisions/DR-0013-broadcast-room.md §5 (Proposed)、kawaz r12 mid=5 で提示。

- **DR13-Q1**: `create_room --kind broadcast --members <sid,...>` で `--members` を明示された時
  - **a) 無視 + stderr warning** (broadcast の意義は auto-populate、明示は redundant) (**AI 推し**)
  - b) 併記を error にする
- **DR13-Q2**: broadcast room 内の `kick` の扱い (直後の hello で auto-populate 再 join されて事実上効かない)
  - **a) op は使える形で残すが、broadcast では意味を持たない旨を SKILL に注記** (**AI 推し**)
  - b) 「再 join 拒否リスト」を持たせる (post-MVP)
- **DR13-Q3**: broadcast room から `next_room` で作られる新 room の kind
  - **a) broadcast を継承** (**AI 推し**)
  - b) normal にフォールバック
- **DR13-Q4**: broadcast room 作成時の `--msg "..."` 初期 msg
  - **a) u1 発扱いで受け入れる (post 制約 to:[u1] 必須は適用しない、通常 room と同じ挙動)** (**AI 推し**)
  - b) 何らかの制約を掛ける

参照: docs/decisions/DR-0013-broadcast-room.md §5。全 Q 裁定後 Accepted 昇格 → 実装着手 (protocol / daemon / CLI / webui / SKILL の 1 バッチ、v0.27.0 想定)。

### TLR-Q1: session Timeline 「訪問時の最新反映」修正方針

出典: kawaz r12 mid=12 (2026-07-14) 観測、webui-history-fix worker 調査で別問題として issue 化。

- a) 常時 `transcript_subscribe` を維持 (unsubscribe しない、複数 session だと帯域負荷)
- b) tab 復帰時に自動 refresh (`transcript_read` で最新を取り直す) (**AI 推し** — 帯域と実装の trade-off が最も軽い)
- c) SessionTreeState cache に TTL 導入
- d) UI に「更新」ボタンで手動 refresh

参照: docs/issue/2026-07-14-session-tl-refresh-on-revisit.md。DR 追加要否も含めて裁定要 (b/c は DR 不要、a は DR-0009 追記が要る)。
