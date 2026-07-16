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

### SS (Session Search, DR-0021)

- **SS-Q1**: 過去セッション (未接続) の transcript/Files 読み出しの認可設計はこれで良い?
  - (a) daemon が jsonl から cwd を復元し「仮想 session」として既存 transcript_read / fs_list / fs_read を path ベースで拡張、user role (webui) 限定 — **AI 推し**: 既存 op の意味論を保ちつつ最小拡張
  - (b) 検索専用の read-only op 群を別に切る (既存 op は hello 済み専用のまま)
  - 詳細: `docs/decisions/DR-0021-session-search.md#31`
- **SS-Q2**: pinned sessions の保存先は?
  - (a) webui localStorage — **AI 推し**: 閲覧マーキングは端末ローカルで足りる、daemon 変更ゼロ
  - (b) daemon 側永続化 (端末を跨いで共有)
  - 詳細: DR-0021 § 3.2

