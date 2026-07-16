# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス
- 選択肢は横並びにせず**箇条書き**で書く (kawaz 2026-07-16: 横に長いと読みにくい)

## 現在の裁定待ち

### ST (Status タブ, DR-0020)

- **ST-Q1**: TODO 再生に必要な transcript の読み込み範囲は?
  - (a) 読み込み済み範囲だけで fold し、範囲外は「それ以前の状態は不明」と明示 — 実装最小、長セッションでは序盤の TODO が欠ける
  - (b) Status タブ表示時に older ページを自動で遡り、TODO の初出まで読み足す — 正確だが大 transcript で重い
  - **AI 推し = (a)** で開始し、実運用で欠けが気になれば (b) に拡張 (fold 層は共通なので後から差し替え可)
  - 詳細: `docs/decisions/DR-0020-session-status-tab.md#32`

