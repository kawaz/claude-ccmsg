# 裁定・確認待ち一覧 (ユーザ用)

## 運用規約

<details>
<summary>ゼロコンテキストエージェント向け（本セクションは消さない）</summary>

- 裁定/確認待ち項目を 1項目=1ラベル=1セクション で記載
- ラベル形式: XX-Q1（バッチやセッション内で一意な短プレフィクス、Qn単独の使い回し禁止、長期一意性は不要)
- 依頼形式: 「👺XX-Q1 の裁定お願いします」（参照用途ではラベルに👺を付けない。誤陽性がユーザのハイライト/アラームを汚す）
- チャット提示と同一ターンで本ファイルに記録 + path 指定 commit (push はリリース窓に同乗)
- 裁定が下りたら該当セクションを即削除し、内容は正規の記録先 (DR / issue / journal / close_reason) へ反映。本ファイルは常に「現在待ち」だけを持つ
- 確認系 (C) も滞留させない: チェックが揃った項目・セクションは即削除、放置が続く低リスク項目は登録ごと落とす (kawaz r76m75)
- 参照は[]()で提示（リポ内は相対、リポ外はフルパス）
- 初版質問/依頼は長文で書かない（ユーザが説明を求めらたら本ファイルに説明を追加し、チャットで👺ラベルで再依頼）
- **選択肢・確認項目は `- [ ] a: …` 形式（チェックボックス + ラベル）で書く**。
  Q / C で記法を分けない。回答は「チェックを付ける」でも「XX-Q1a」と言葉で返すでも通る
  （複数まとめてチェックし「チェックしたよ」の一言で済ませる運用を想定）

</details>

## 裁定待ち

### SG-Q1: 設定グループ化の置き場 (r259m7)

3 分類 (Session / TL / TL-Message) は合意済み。置き場が未裁定。統括案: TL 対象の設定を
`.tl-toolbar` の ⚙ ポップオーバーに集約し、フロートパネルを廃止。

- [ ] a: 統括案 (⚙ ポップオーバー集約、フロートパネル廃止)
- [ ] b: フロートパネルを残し、中を 3 分類で区切る
- [ ] c: 別案 (チャットで)

### WA-Q2: signal の単位 (要素単位をどこまで)

新 webui (DR-0032) の状態層。[webui-architecture Draft §3](design/webui-architecture.md) の表は「群単位」(接続 / 能力 / 一覧 / room / 現在地 / …)。争点は Map を持つものを
**要素ごとの signal** (`Map<sid, Signal<tree>>`) にする範囲。

- [ ] a: `sessionTrees` / `sessionStatuses` / `rooms` を要素単位 (統括推し)。1 セッションの
  transcript 更新が他セッションの Timeline を触らない。一覧 (`peers` / `agents`) は並び替えが
  配列全体の値なので群単位のまま
- [ ] b: 一覧の行も sid 単位にする (行の内容更新と並び替えを分離)。効果は大きいが構造が二重になる
- [ ] c: 新 webui はまず群単位のみで始め、要素単位は Timeline を作る段階で判断

### PV-Q1: protocol v2 の面 (plane) の分け方 ([Draft §2](design/protocol-v2.md))

op 56 のうち user-only が 36。エージェントに見せる語彙 (room / notify / say) と、daemon の
内部状態を読む・操作する API (session / transcript / fs / llm) を同じ面に置くと、CLI の help と
skill が後者まで背負う。

- [ ] a: messaging / control / mesh の 3 面 (統括推し)。同じ型システム・封筒・エラーを共有し、
  面は op 属性表の 1 列。mesh は control の op を封筒で転送するだけ
- [ ] b: messaging / control の 2 面 (mesh は control の一部として扱う)
- [ ] c: 面を分けず、role で見せる op を絞るだけ (現状の延長)

### PV-Q2: 能力 (capability) の表現 ([Draft §3.2](design/protocol-v2.md))

hello の `*_available` boolean 6 個 + op ハンドラの `<x>_not_configured` 6 種の二重管理を解消する。

- [ ] a: hello が `capabilities: string[]` を返し、op 属性表の `capability` 列と突き合わせて
  「押せる op」を導く。未設定は `capability_unavailable` 1 コード (統括推し)
- [ ] b: hello は何も返さず、op を呼んで `capability_unavailable` が返るかで判断 (導線が出ない)

### PV-Q3: 観測系の一本化 ([Draft §3.3](design/protocol-v2.md))

peers / agents / session_status 等が「op で全量 + push で全量」の 2 経路 (最大 4 経路)。

- [ ] a: `subscribe <topic>` の snapshot + delta に一本化し、one-shot op は置かない
  (CLI は subscribe → 即 unsubscribe)。統括推し
- [ ] b: one-shot op も残す (CLI の単発取得のため)。ただし response は subscribe の snapshot と
  同じ型にする

### PV-Q4: op の命名 ([Draft §5](design/protocol-v2.md))

現状は `create_room` (動詞先頭) と `session_kill` (名詞先頭) が混在。

- [ ] a: 名詞先頭 `<名詞>_<動詞>` に統一 (`room_create` / `room_post` / `session_kill`)。
  同じ名詞の op がソートで隣接する (統括推し)
- [ ] b: 動詞先頭に統一
- [ ] c: 混在のまま (v1 の名前を温存)

### PV-Q5: 契約の正本 ([Draft §7](design/protocol-v2.md))

- [ ] a: TS 型を正本にし、schema (実行時検証) を型から生成 (統括推し: 型の表現力が高く、
  既存の 184 interface を出発点にできる)
- [ ] b: JSON Schema を正本にし、TS 型を生成 (言語非依存だが、union / literal の表現が冗長)

### PV-Q7: role が可視範囲を変える 3 op ([op 表 §8-4](design/protocol-v2-op-table.md))

`fs_list` / `fs_read` / `transcript_read` は role で「可否」でなく「見える範囲」(user なら
`allowVirtual` で sid から jsonl を探す) が変わる。op 属性表の `roles` 列 (可否) では表せない。

- [ ] a: 属性 `scope` (role ごとの可視範囲) を表に足す (統括推し: op は 1 つのまま、表で挙動が読める)
- [ ] b: role ごとに別 op に割る (`transcript_read` は session 用、`transcript_read_any` は user 用 等)
- [ ] c: 可視範囲の差を無くす (session role にも仮想解決を許す)

### PV-Q8: 未配送メッセージの扱い ([Draft §2.1](design/protocol-v2.md))

v2 の messaging は room (永続ログ + 既読カーソル) を持たない。相手セッションが受信できない間
(subscribe していない / 途絶) に届いたメッセージをどうするか。

- [ ] a: sid 単位の inbox に溜め、受信できるようになった時に配送 (統括推し: v1 の「post → 相手がまだ
  subscribe していない → 黙って落ちる」を replay 窓で塞いでいた場当たりを、正面から解く)
- [ ] b: 届かなければ送信側に `undeliverable` を返し、溜めない (状態を持たないが、送信側が再送を考える)
- [ ] c: 会話は transcript が正本なので、届かなかったことを送信側の transcript に残すだけで良い

## 確認待ち
