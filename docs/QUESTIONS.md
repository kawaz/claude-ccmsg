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

### IB (fs_write / inbox, DR-0019)

- **IB-Q3**: DR-0019 (webui Files から docs/inbox/ への新規ファイル作成、fs_write op) の Phase W1 実装に進んで良い?
  - (a) 進める — **AI 推し**: スコープが inbox 限定 write で小さく、スマホ完結の価値が高い
  - (b) inbox 手動運用をしばらく見てから
  - 詳細: `docs/decisions/DR-0019-fs-write-inbox.md`

