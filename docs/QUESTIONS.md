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

### 👺TL-Q2: 自 post/reply の専用バブルを復活させるか

[issue](issue/2026-07-29-self-ccmsg-post-bubbles-missing.md): 自セッションが Bash tool で `ccmsg post/reply` した時の専用バブル (DR-0027 §2.2) が v0.80.0 の bash 一体カード化で出なくなっています (実行自体は bash カードとして見える)。

- [ ] a: 専用バブルを復活 (bash カードと併存。修正は小さい)
- [ ] b: bash カードで代替済みとして DR-0027 §2.2 を supersede

### 👺TL-Q3: in-view search が閉じた fold の中を数えない件

[issue](issue/2026-07-29-inview-search-skips-closed-folds.md): 現状は閉じた fold 内のマッチが 0 件扱い (コード内コメントの記述と食い違い)。

- [ ] a: 閉じた fold の中も数え、ヒットへのジャンプで fold を自動展開 (検索体験としては素直)
- [ ] b: 現挙動を仕様としてコメントを直すだけ

### 👺ISSUE-Q1: 棚卸しの close 候補 3 件

- [ ] a: `kawaz-req1` / `kawaz-agents-status` を close (起票 commit に「v0.34.14 で対応済み」とあり解決済みの可能性大。中身の再確認込みで任せてもらえれば close します)
- [ ] b: `2026-07-04-daemon-side-subscribe-detection` を close (v0.82 系の supersede + /clear 検出で元の動機が解消していれば)
- [ ] c: `2026-07-26-webui-url-structure-redesign` を close (Phase 1〜3 出荷済み。C20c の確認が済んだら)

## 確認待ち

### 👺WEBUI-C23: agent TL からメインへ戻れる (v0.82.3)

- [ ] a: サブエージェントの TL を開いた後、サイドバーのセッションリンクで戻るとメイン TL (または直前に見ていた Files 等) に着地する (agent TL に引き戻されない)
- [ ] b: エージェントツリーの先頭に main 行があり、クリックでメイン TL に戻れる
- [ ] c: agent TL 上で TL 項目をクリックしても親 TL に弾き出されない

### 👺WEBUI-C20: URL 再設計 Phase 3 (v0.80.0)

- [x] a: TL でメッセージバルーンをクリックすると URL が `/timeline/<uuid>` に replace され、履歴は増えない
- [x] b: 最下部までスクロールすると `/head` に戻る
- [ ] c: uuid 付き URL 直アクセスで該当位置にスクロール + ハイライト (ロード窓外なら head へ)
- [x] d: ヘッダの back/forward ボタンが活性状態も含めて動く
- [x] e: セッションを離れて戻ると、見ていた位置 (uuid) に復帰する

### 👺WEBUI-C21: `!` bash 実行表示の作り直し (v0.80.0)

- [x] a: `! ls` がユーザ側の並びに Bash ツール実行風カードで出る (通常メッセージの見た目ではない)
- [x] b: 長い出力は max-height で切れてブロック内スクロールになる
- [x] c: 30KB 超の出力は CC がサイドカー退避するため、スタブ (パス + プレビュー) が表示される。「全文を開く」リンクは TL-Q1=a の裁定を実装後に常時点灯予定

### 👺WEBUI-C22: リンク解決の再確認 (URL 実パス化後の総ざらい、v0.80.1)

URL が実パス化 (v0.78.0) された後の再確認です。旧チェック済み分もリンク経路が変わったためリセットしています。このプレビュー上で踏んでください。相対リンクはこのファイルの位置 (`docs/`) 基準、先頭 `/` はファイルシステム絶対パスです。

- [x] a: 相対パスリンクが Files ビューアを開く → [markdown-link.ts](../packages/webui/src/client/markdown-link.ts)
- [ ] b: リポルート相対のつもりの先頭 `/` は 404 になり、「もしかして」が出て押すと開く → [DR-0008](/docs/decisions/DR-0008-workspace-file-access.md)
- [x] c: 行範囲付きは code モードで開き、指定行にジャンプ・ハイライト (プレビューモードの記憶は消えない) → [DR-0008 の §7 付近](decisions/DR-0008-workspace-file-access.md#L58-L66)
- [x] d: 存在しないパスも押せて 404 が出る → [存在しないファイル](this-file-does-not-exist.md)
- [ ] e: 基準を間違えた相対リンクで「もしかして」が出て、押すと開く → [リポルート基準で書いたリンク](packages/webui/src/client/markdown-link.ts)
- [x] f: どちらの読みでも存在しないファイルでは候補が出ない → [本当に無いファイル](totally-nonexistent-xyz.md)
- [x] g: プロジェクト外ファイルが開ける (このセッションでアクセス済みのもの) → [プロジェクト外ファイル](/Users/kawaz/.cache/claude-session-state/ccmsg/20260727-1045.md)
- [x] h: 外部 URL は in-app browser で開き、閉じる/戻るが出る → [hyoui](https://hyoui.kawaz-mbp16-20211217.kawaz.jp)
- [x] i: 未知 URL に着地してもアプリが立ち上がりサイドバーから復帰できる → [same-origin の未知パス](https://ccmsg.kawaz-mbp16-20211217.kawaz.jp/this-path-does-not-exist)

### 👺WEBUI-C24: workflow の TL と状態表示 (v0.83.0)

- [ ] a: workflow 配下エージェントの TL がツリーから開ける (agent transcript not found が出ない)
- [ ] b: workflow の running / done / error が dot の色で見分けられる (running=active 色、done=グレー、error=danger 色)。run 行にも dot が付く

### 👺WEBUI-C25: メモリ/重さ対策 (v0.83.0)

- [ ] a: 長時間使用 + セッション巡回でブラウザが重くなっていく現象が改善した (実測: セッション巡回の常駐メモリが線形増加 → 頭打ちに、追記時のメインスレッド占有が約 4 割減 145ms → 86ms。残りの主因は全項目再描画で、根治は仮想スクロール issue)
- [ ] b: TL の表示・fold・検索・位置ジャンプ・スクロール復元に退行がない

### 👺DAEMON-C18: ルーム自己 echo の解消 (v0.76.3)

- [x] a: 複数エージェントのルームで post しても自分に echo されない (daemon 再起動後の再接続でも)

### 👺CLI-C15: `ccmsg dump` の改善 (v0.75.0 / v0.76.0)

CLI での確認です。`ccmsg dump <sid> --format text` で見てください。

- [ ] a: `--since` を付けると、その範囲に関わったエージェントだけが指示文込みで展開され、それ以外は 1 行に畳まれる
- [ ] b: 畳まれた分を `--agent <名前 or id>` で読み戻せる (ヘッダにそのヒントが出る)
- [ ] c: task list (TODO) が context に載っている
- [x] d: `--no-thinking` で思考が消え、`--no-agent` でエージェント情報と通信が消える (日誌用途)
