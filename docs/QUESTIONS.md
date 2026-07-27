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

相対リンクはこのファイル自身の位置 (`docs/`) が基準です (markdown の慣習、GitHub / エディタと同じ読み)。リポルートからの記法にしたい時は b のように先頭 `/` を付けます。

- [x] a: 相対パスリンクが Files ビューアを開く → [markdown-link.ts](../packages/webui/src/client/markdown-link.ts)
- [ ] b: 先頭 `/` の絶対パスもリポルート相対として解決される → [DR-0008](/docs/decisions/DR-0008-workspace-file-access.md)
- [ ] c: 行範囲付きも開ける → [DR-0008 の §7 付近](decisions/DR-0008-workspace-file-access.md#L58-L66)
- [x] d: 存在しないパスも**押せて、404 が出る** (v0.74.0 で仕様変更。probe 待ちの灰色期間を廃止し、外した先で 404 を見せる方式へ) → [存在しないファイル](this-file-does-not-exist.md)
- [x] e: 外部 URL は in-app browser で開き、閉じる/戻るが出る → [hyoui](https://hyoui.kawaz-mbp16-20211217.kawaz.jp)
- [x] f: 万一未知 URL に着地してもアプリが立ち上がりサイドバーから復帰できる → [same-origin の未知パス](https://ccmsg.kawaz-mbp16-20211217.kawaz.jp/this-path-does-not-exist)

プロジェクト外 (`/tmp`) の試験ファイルもあります: `/tmp/ccmsg-md-testcases.md` (Files 検索や external files 経路の確認用)

### 👺WEBUI-C11: リンクを踏み外した時に救済が出るか (v0.76.0)

相対リンクの基準を書き間違えても 404 で行き止まりにならず、逆算した候補が出ます。

- [ ] a: 基準を間違えたリンクで「もしかして」が出て、押すと開く → [リポルート基準で書いたリンク](packages/webui/src/client/markdown-link.ts)
- [x] b: どちらの読みでも存在しないファイルでは候補が出ない → [本当に無いファイル](totally-nonexistent-xyz.md)
- [ ] c: Files ツリーから存在しないパスを開いた時 (遷移元が無い) は候補が出ない

### 👺WEBUI-C12: Status タブの入れ替え (v0.74.0)

- [ ] a: Workflows と Teams のセクションが消えている (TL のエージェントツリーに一本化)
- [ ] b: 残った Background / TODO / メタ情報 (CWD・SESSION_ID・PID・CTX 等) / 危険ゾーンが正常に出る
- [ ] c: ENV が折りたたみで出て、開くと名前昇順のテーブルになる
- [ ] d: 空白区切りの AND 検索が名前と値の両方に当たる (例: `claude personal`)
- [ ] e: コロン区切りを改行にするスイッチで `PATH` が読みやすくなる
- [ ] f: 機微な名前 (`*TOKEN` / `*KEY` / `*SESSION*` 等) の値が伏字で、クリックで表示・再クリックで非表示に戻る
- [ ] g: マスクされた値も検索に当たる (値で探して名前が見つかる)

### 👺WEBUI-C13: Files 検索の 3 改善 (v0.74.0)

- [ ] a: workspace のヒットが `{ws名}/{相対パス}` で表示される (フルパスは hover で見える)
- [ ] b: `.gitignore` トグルが既定 ON で、`node_modules` 等が結果に出ない
- [ ] c: トグルを OFF にすると出るようになり、リロードしても設定が残る
- [ ] d: `-語` で除外できる (例: `package.json -webui`)
- [ ] e: 中間のハイフンはリテラル扱い (例: `file-search` がそのまま引ける)

### 👺WEBUI-C14: サブエージェント TL の spawn prompt (v0.76.0)

- [ ] a: サブエージェントの TL を開くと、先頭の spawn prompt が他の agent メッセージと同じ見た目 (アイコン + 名前 + markdown 描画) になっている
- [ ] b: 閉じた状態のラベルが `spawn prompt ← 親` (または `← team-lead`) で、どの経路のメッセージか読める

### 👺CLI-C15: `ccmsg dump` の改善 (v0.75.0 / v0.76.0)

CLI での確認です。`ccmsg dump <sid> --format text` で見てください。

- [ ] a: `--since` を付けると、その範囲に関わったエージェントだけが指示文込みで展開され、それ以外は 1 行に畳まれる
- [ ] b: 畳まれた分を `--agent <名前 or id>` で読み戻せる (ヘッダにそのヒントが出る)
- [ ] c: task list (TODO) が context に載っている
- [ ] d: `--no-thinking` で思考が消え、`--no-agent` でエージェント情報と通信が消える (日誌用途)
