# 裁定・確認待ち一覧 (ユーザ用)

## 運用規約

<details>
<summary>ゼロコンテキストエージェント向け（本セクションは消さない）</summary>

- 裁定/確認待ち項目を 1項目=1ラベル=1セクション で記載
- ラベル形式: XX-Q1（バッチやセッション内で一意な短プレフィクス、Qn単独の使い回し禁止、長期一意性は不要)
- 依頼形式: 「👺XX-Q1 の裁定お願いします」（参照用途ではラベルに👺を付けない。誤陽性がユーザのハイライト/アラームを汚す）
- チャット提示と同一ターンで本ファイルに記録 + path 指定 commit (push はリリース窓に同乗)
- 裁定が下りたら該当セクションを即削除し、内容は正規の記録先 (DR / issue / journal / close_reason) へ反映。本ファイルは常に「現在待ち」だけを持つ
- 参照は[]()で提示（リポ内は相対、リポ外はフルパス）
- 初版質問/依頼は長文で書かない（ユーザが説明を求めらたら本ファイルに説明を追加し、チャットで👺ラベルで再依頼）
- **選択肢・確認項目は `- [ ] a: …` 形式（チェックボックス + ラベル）で書く**。
  Q / C で記法を分けない。回答は「チェックを付ける」でも「XX-Q1a」と言葉で返すでも通る
  （複数まとめてチェックし「チェックしたよ」の一言で済ませる運用を想定）

</details>

## 裁定待ち

(なし)

## 確認待ち

### 👺WEBUI-C9: standalone webapp で詰まなくなったか (v0.73.36 / v0.73.37 / v0.74.0)

下のリンクをこのプレビュー上で踏んで確認してください。

- [ ] a: 相対パスリンクが Files ビューアを開く → [markdown-link.ts](packages/webui/src/client/markdown-link.ts)
- [ ] b: 先頭 `/` の絶対パスもリポルート相対として解決される → [DR-0008](/docs/decisions/DR-0008-workspace-file-access.md)
- [ ] c: 行範囲付きも開ける → [DR-0008 の §7 付近](docs/decisions/DR-0008-workspace-file-access.md#L58-L66)
- [ ] d: 存在しないパスも**押せて、404 が出る** (v0.74.0 で仕様変更。probe 待ちの灰色期間を廃止し、外した先で 404 を見せる方式へ) → [存在しないファイル](docs/this-file-does-not-exist.md)
- [x] e: 外部 URL は in-app browser で開き、閉じる/戻るが出る → [hyoui](https://hyoui.kawaz-mbp16-20211217.kawaz.jp)
- [x] f: 万一未知 URL に着地してもアプリが立ち上がりサイドバーから復帰できる → [same-origin の未知パス](https://ccmsg.kawaz-mbp16-20211217.kawaz.jp/this-path-does-not-exist)

プロジェクト外 (`/tmp`) の試験ファイルもあります: `/tmp/ccmsg-md-testcases.md` (Files 検索や external files 経路の確認用)
