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

### RL (1on1 応答レール、issue cli-help-diet-and-reply-rails)

- **RL-Q1**: create-room / next-room の初期 msg (--msg) が 1on1 post ガードを素通りする件、塞ぐ?
  - (a) 塞ぐ — session 発の 1on1 create/next-room 初期 msg も reply_via_tl 拒否 (next-room 経由で実 1on1 の次スレに session msg を載せる抜け道が閉じる)
  - (b) 現状維持 — broadcast の先例 (DR-0013 §2.10: 初期 msg は制約を意図的に適用しない) と整合。**AI 推し = (b)**: 1on1 の next-room を session が自発する運用は現状なく、post の主経路は塞げているので急がない
  - 詳細: workflow 検査報告 (a) 項
- **RL-Q2**: help 文面と実引数の乖離 — kawaz 指定文面 `peers [cwd(partial)]` / `create-room ... <title>` に実装が未対応 (peers の cwd フィルタなし / positional title は silent drop)。どちらに寄せる?
  - (a) 実装を文面に合わせる — peers に cwd 部分一致フィルタ追加 + create-room が positional title を受理 — **AI 推し**: kawaz 指定の help がレール定義そのものなので、実装が従うのが筋。silent drop は今すぐ有害
  - (b) 文面を実装に合わせる
  - 詳細: 同報告 (b) 項

