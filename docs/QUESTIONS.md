# 裁定・確認待ち一覧 (ユーザ用)

## 運用規約

<details>
<summary>ゼロコンテキストエージェント向け（本セクションは消さない）</summary>

- 裁定/確認待ち項目を 1項目=1ラベル=1セクション で記載
- ラベル形式: XX-Q1（バッチやセッション内で一意な短プレフィクス、Qn単独の使い回し禁止、長期一意性は不要)
- 依頼形式: 「👺XX-Q1 の裁定お願いします」（参照用途ではラベルに👺を付けない。誤陽性がユーザのハイライト/アラームを汚す）
- チャット提示と同一ターンで本ファイルに記録 + path 指定 commit (push はリリース窓に同乗)
- 裁定が下りたら該当セクションを即削除し、内容は正規の記録先 (DR / issue / journal / close_reason) へ反映。本ファイルは常に「現在待ち」だけを持つ
- 確認系 (C) も滞留させない: チェックが揃った項目・セクションは即削除、放置が続く低リスク項目は登録ごと落とす (kawaz)
- 参照は[]()で提示（リポ内は相対、リポ外はフルパス）
- 初版質問/依頼は長文で書かない（ユーザが説明を求めらたら本ファイルに説明を追加し、チャットで👺ラベルで再依頼）
- **選択肢・確認項目は `- [ ] a: …` 形式（チェックボックス + ラベル）で書く**。Q / C で記法を分けない。回答は「チェックを付ける」でも「XX-Q1a」と言葉で返すでも通る（複数まとめてチェックし「チェックしたよ」の一言で済ませる運用を想定）

</details>

## 裁定待ち

### 👺M39-Q4: tool の名前と引数の名前

[DR-0039](decisions/DR-0039-all-mods-and-typed-tools.md) §3。tool の組 (セッション間の送信、say、宛先の候補) の名前と、送信の引数の名前。model からは `mcp__<plugin>__<name>` で見える (plugin 名は今 `ccmsg-v1`)。方針の形は `{ session_id?, cwd?, name?, pid?, text }`。tool は `isDeferred: true` で description を短くし、案内と skill が名前で名指すので、名前だけで用途が分かることが要る。

名前の案を出してから裁定を仰ぐ。

### 👺M39-Q5: 受け手に届く封筒の `from` の綴りと、返信に使う口

[DR-0039](decisions/DR-0039-all-mods-and-typed-tools.md) §3。受け手には peer 注入の封筒 (`<cross-session-message from="...">`) で届く。`from` は今 `ccmsg:<送り主の sid>` で (DR-0037 §3)、受け手の model はこれをそのまま SendMessage の `to` に書いて返信する (DR-0037 §4 の実測)。DR-0039 は `session.send` を hook しないので、その SendMessage は harness が宛先を探して失敗する (config home が違えば届く先が無い)。

- 意味論: 2 つの軸がある。α は `from` に何を書くか (送り主を送信の tool の引数でそのまま名指せる形にするか。`ccmsg:` 接頭辞を利用者に課さない方針と、SendMessage の宛先に見える綴りが返信を SendMessage に誘う点の両方に関わる)。β は受け手の model を送信の tool に導く場所
- α の候補: `ccmsg:<sid>` のまま / 送り主の sid だけ / 送り主の名前と sid
- β の候補: 封筒の本文の返信の案内で送信の tool と送り主の指定 (`session_id` 等) を示す / それに加えて `tool.describe` で SendMessage の説明に「ccmsg の封筒への返信は送信の tool で」を足す (SendMessage は deferred で、ToolSearch の後の entry に反映される、findings 実測)
- 統括推し: 未提示

- [ ] α-a: `ccmsg:<sid>` のまま
- [ ] α-b: 送り主の sid だけ
- [ ] α-c: 送り主の名前と sid
- [ ] β-a: 封筒の本文の案内だけで導く
- [ ] β-b: 封筒の案内に加えて `tool.describe` で SendMessage の説明にも書く

## 確認待ち

(なし)
