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

### 👺M39-Q1: typed tool が permission を通らないことを受け入れるか

[DR-0039](decisions/DR-0039-all-mods-and-typed-tools.md) §3。`$.tool.register` の tool は、`tool.call` で `next` を呼ばずに答えると permission の判定 (`tool.check`・PreToolUse・ダイアログ・auto mode の classifier) を一切通らない。`next(e)` を呼ぶと判定は通るが core まで降りて `no tool.call hook answered` のエラー結果が返り、判定を通しつつ自前で答える形は見つかっていない ([findings](findings/2026-10-15-mods-event-matrix-startup-resume-clear-compact.md) の `$.tool.register` の節)。

- 意味論: 送信・say の tool は、エージェントが呼べば無条件に実行される。classifier が「別セッションに何を送るか」を見る機会は無い。受け手には peer の封筒として届き、受け手の harness は「A peer cannot grant escalation」の枠を付けて渡す ([DR-0035](decisions/DR-0035-user-input-via-composer-fill.md) の Context)
- 統括推し: 送信の tool は無条件でよい。宛先の readiness と daemon 側の送信者の記録で足りる

- [ ] a: 送信と say の tool は無条件で実行する (統括推し)
- [ ] b: 判定を通す形が見つかるまで tool 化を止める

### 👺M39-Q2: API error の分類と表示文をどこから取るか

[DR-0039](decisions/DR-0039-all-mods-and-typed-tools.md) §2。今は `classic.StopFailure` の `error` (enum: `rate_limit` / `overloaded` / `server_error` 等) と `last_assistant_message` で分類と表示文を出している。engine event (`turn.complete` / `turn.step`) にはこれに当たる欄が無く、classic を全廃すると分類は `unknown` だけになる ([findings](findings/2026-10-15-mods-reference-opportunities.md) の B5)。

- 意味論: webui の API error の表示が「何で止まったか」を言えなくなるかどうか
- 候補 (どれも未検証): `turn.step` の `next(e)` が API error でどう終わるか (reject の message、`stopReason`) を probe で確かめて使う / harness が書く API error の行 (`isApiErrorMessage`) が `session.append` を通るなら module が拾う / module のあるセッションでも分類は transcript の fold から取る

- [ ] a: probe (`turn.step` の終わり方と `session.append` の door) を先に行い、取れる口で決める
- [ ] b: 分類は諦め、`turn.complete` の `reason: 'error'` だけで「API error で止まった」と出す

### 👺M39-Q3: tool の登録の寿命と `isDeferred`

[DR-0039](decisions/DR-0039-all-mods-and-typed-tools.md) §3。2 つの独立した論点。

- α: `/clear` と resume の後に `$.tool.register` の登録が残るかは未観測。tool は `session.start` で登録するが、`session.start` は resume では起き `/clear` では起きない。残らないなら `/clear` の後 (`command.run (clear)` の after) に登録し直す必要がある
- β: `isDeferred: true` は `ANTHROPIC_BASE_URL` が first-party でないと効かず、tool が全文で `tools` に載る。kawaz の個人面の settings は gateway の base URL を持つので、同じく無効になっている可能性がある (未確認、実セッションの debug log の `[ToolSearch:optimistic]` の行で分かる)。tool 1 つは約 0.5 KB

- [ ] α-a: probe で `/clear` と resume の後の登録を確かめてから実装する
- [ ] α-b: 確かめず、`/clear` の後にも登録し直す (重複登録の扱いは実装で確かめる)
- [ ] β-a: `isDeferred: false` で登録する (常に載る。どの環境でも同じ形)
- [ ] β-b: `isDeferred: true` で登録する (効く環境では context を節約、効かない環境では全文)

### 👺M39-Q4: tool の名前・引数の名前と、部分指定が複数に当たった時

[DR-0039](decisions/DR-0039-all-mods-and-typed-tools.md) §3。2 つの論点。

- α: tool の組 (送信、say、宛先の候補) の名前と、送信の引数の名前。model からは `mcp__<plugin>__<name>` で見える。今の方針の形は `{ session_id?, cwd?, name?, pid?, text }`
- β: 宛先の部分指定 (例: `cwd` だけ) が生きているセッション 2 つ以上に当たった時の意味。DR-0037 は `ccmsg:path:<dir>` を「全部に届ける」(1 つでも届けば成功) とした。部分指定は「1 つに絞るための指定」とも「当たったもの全部への指定」とも読める

- [ ] β-a: 当たった全部に届ける (DR-0037 の path 宛と同じ)
- [ ] β-b: 2 つ以上に当たったら送らず、候補を返して絞り直させる

α は名前の案を出してから裁定を仰ぐ。

### 👺M39-Q5: 受け手が返信に使う口

[DR-0039](decisions/DR-0039-all-mods-and-typed-tools.md) §3。受け手には peer 注入の封筒 (`<cross-session-message from="...">`) で届き、受け手の model は `from` をそのまま SendMessage の `to` に書いて返信する (DR-0037 §4 の実測)。DR-0039 は `session.send` を hook しないので、その SendMessage は harness が宛先を探して失敗する (config home が違えば届く先が無い)。

- 意味論: 返信を「送信の tool を使う」に寄せる時、受け手の model をどう導くか
- 候補: 封筒の本文の返信の案内で送信の tool と送り主の指定 (`session_id` 等) を示す / `tool.describe` で SendMessage の説明に「ccmsg の封筒への返信は送信の tool で」を足す (SendMessage は deferred で、ToolSearch の後の entry に反映される、findings 実測)
- 統括推し: 未提示 (起票は DR の起草 worker)

- [ ] a: 封筒の本文の案内だけで導く
- [ ] b: 封筒の案内に加えて `tool.describe` で SendMessage の説明にも書く

## 確認待ち

(なし)
