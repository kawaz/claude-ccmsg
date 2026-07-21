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

## 👺 WFT-Q1: セッションツリーの agent ドリルダウン (Prompt/Activity/Outcome) の展開 UI

workflow member 行のリッチ化 (v0.71.0) の続き。TUI の右ペイン相当 (Prompt / Activity = 実行中ツール / Outcome = 返り値) をツリーでどう出すか。データは Status の drilldown 経路で入手済み、UI の形だけ裁定待ち。

- a) 各 agent 行を `<details>` 化し、展開時に行下へ 3 項目を淡色表示 (ツリー内で完結、縦に伸びる)
- b) 行クリックで選択 → パネル下部 (または右) に固定の詳細エリアを出す (TUI の左右ペイン構成に近い、ツリーは伸びない)
- c) やらない (TL リンクで agent TL に飛べば全部見えるので、ツリーは一覧に徹する)

AI の推し: **b** (ツリーの可読性を保ちつつ TUI の体験に一致。a は複数展開で縦に爆発する)。詳細は docs/issue/2026-07-21-session-tree-workflow-tui-parity.md の受け入れ条件 #4。

