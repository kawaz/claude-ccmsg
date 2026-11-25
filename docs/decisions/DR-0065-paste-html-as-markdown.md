# DR-0065: 入力欄に貼られた HTML を markdown に直して入れる

- Status: Accepted (kawaz 2026-11-25) — ✅ 実装済み
- Date: 2026-11-25

## Context

Web からコピーしたリンク付きの文を入力欄に貼ると、ブラウザは text/plain を入れるのでリンクが落ちる。入力欄の paste で text/html を読んで markdown に直せば `[label](url)` の形で貼れる。kawaz の指示 (2026-11-25):

> そうしたいです。リストとかテーブルもいける？ ちなみに ⌘+Shift+v だと text/plain にするとかもちゃんとやってほしい。

決めるために測ったこと (クリップボードの中身・undo・部品の比較・bundle の大きさ) は [findings 2026-11-25](../findings/2026-11-25-paste-html-clipboard.md)。

## Decision

### 1. 対象の入力欄と、変換しない貼り付け

メッセージの本文を書く textarea の貼り付けを対象にする。

- FAB の入力欄 (`SessionInputComposer`)
- コメントのフォームと、未送信のコメントの「直す」(`timeline/comments.tsx`)
- Status の新セッションの起動の最初の prompt と、再起動・fork のフォームの文 (`StatusSessionForms`)
- SessionCreator の PROMPT

次の貼り付けは、ブラウザの貼り付けのまま (変換しない)。

- ファイルのある貼り付け: 今までどおり添付 ([DR-0015](./DR-0015-composer-attachments.md) §2.5) が引き受け、横の text/html は使わない
- text/html の無い貼り付け: ⌘⇧V (スタイルを合わせて貼り付け) は、paste イベントの時点で text/html を外して届く (Playwright の Chromium・WebKit と、本物の Chrome 159 で実測)。形式の有無は貼り付けの操作ごとに決まり、同じクリップボードでも ⌘V では text/html が届く。これで見分け、キーの修飾は見ない
- 読み取り専用の間 (送信の返事を待つ間) の貼り付け
- markdown に直す意味のある要素が無い HTML (§2)

### 2. 変換するかの判定

変換は、次のどれかが 1 つでもある時だけ始める。

- http(s)・mailto のリンク (`a[href]`)
- http(s)・mailto の画像 (`img[src]`)
- リスト (`ul` / `ol`)
- 表
- 見出し
- 引用
- `pre`
- `code`
- 水平線

段落・改行・太字・斜体・打ち消し・色付けの `span` / `div` だけの HTML は変換しない。字下げ・改行・空白・タブを 1 文字も変えないため。

- Chrome は mac で、クリップボードに RTF しか無い時 (Terminal 等) は Cocoa の HTML 出力で text/html を作る。その HTML は 1 行が 1 つの `<p>` で、太字は `<b>`
- VS Code のコピーは空の行に `<br>` を持つ

代償として、太字だけの断片は今までどおり text/plain で入る。判定はクリップボードの HTML を `DOMParser` で文書の外の木にして見る (§5)。判定は最初の画面の bundle に置く (変換するかを paste イベントの中で決めないと、ブラウザの貼り付けを止められない)。

### 3. 入れ方

paste イベントの中でブラウザの貼り付けを止め、クリップボードの text/html と text/plain を読んでおく (イベントの後は読めない)。変換の部品を読み込んでから、`document.execCommand("insertText")` で、貼った時の選択の位置に入れる (選択があれば置き換え)。

- `execCommand` を使うのは、textarea の undo の履歴に積んだまま文字を入れる手段がこれしか無いため。⌘Z と ⌘⇧Z は、await を挟んでもブラウザ自身の貼り付けと同じに動く。`value` の書き換えと `setRangeText` では ⌘Z で戻らない (Chromium・WebKit で実測)
- 入れると input イベントが出るので、欄の `onInput` が中身を受ける (下書きの保存も今までどおり)
- 読み込みを待つ間にフォーカスが外れても、貼った欄に戻して入れる。待つ間に中身が変わっていなければ貼った時の選択に入れ、変わっていれば今の選択に入れる
- 部品の読み込みや変換に失敗したら、貼り付けを落とさないよう text/plain を同じ方法で入れる

貼り付けの handler は 1 つ (`paste-html-as-markdown.ts` の `pasteHtmlAsMarkdown`)。添付を持つ欄は添付の `onPaste` (`useAttachmentInput`) が添付の後に呼び、他の欄は `onPaste` に直接付ける。

### 4. 直し方

`htmlToMarkdown(html: string): string | null` (`html-to-markdown.ts`) は、HTML の文字列を受けて、markdown の文字列か「変換しない」(null) を返す純関数。

HTML の要素と markdown の書き方の対応:

| HTML | markdown |
|---|---|
| リンク | `[label](url)` |
| `ul` / `ol` (入れ子・`start` を含む) | `- ` / `1. ` |
| 表 | GFM の表。揃えの空白は詰める。セルの中の改行は `<br>` |
| `h1`〜`h6` | `#`〜`######` |
| `strong` / `b` | `**…**` |
| `em` / `i` | `*…*` |
| `del` / `s` | `~~…~~` |
| `code` | `` `…` `` |
| `pre` | fence のコードブロック。言語が取れれば付ける |
| `blockquote` | `> ` |
| `br` | `\` の強制改行 |
| `p` | 空行で分けた段落 |
| `img` | `![alt](url)` |
| `hr` | `---` |

markdown の記号に読まれる文字は escape する。決め事:

- 表の揃えの空白を詰めるのは、送る先が AI で、桁の揃えが全角の文字で崩れるため
- コードの言語は、`<pre><code class="language-…">`、`pre` 自身の `language-…`、囲む要素の GitHub の `highlight-source-…` から取る。この webui の吹き出しのコードの塊も `language-…` を付けて描く (コピーした塊の言語が戻る)
- リストの項目に段落 (`<p>`) が 2 つ以上ある時だけ loose。段落が 1 つの項目は tight (この webui の描画のように、tight のリストの項目も `<p>` で包む描画がある)
- 見出しの行 (`th` / `thead`) の無い表 (表計算のコピー) は、最初の行を見出しにする (markdown の表は見出しの行が要り、無いと空の見出しの行が付く)
- リストの直下のリスト (ドキュメントの編集ソフトの入れ子の書き方) は、前の項目の中に移す
- `font-weight` を普通にした `<b>` / `<strong>` (ドキュメントの編集ソフトが全体を包む `<b style="font-weight:normal">`) は太字にしない
- コードの外の U+00A0 は空白にする (WebKit はコピーの要素の境目の空白を U+00A0 で書く)
- 文言の無いリンク (アイコンだけの見出しのアンカー等)、ボタン、文字の無い段落 (ブロックの間の `<br>`) は出さない
- この webui の markdown の描画が作るリンク (`md-…-link` の class) は戻す。描画が足したリンク (ファイルのパス・issue・添付・コードの中の URL) とパスへのリンクは、行き先が webui の中なので文言だけにする。画像のリンク (`🖼 alt`) は画像に戻す

### 5. 安全

- クリップボードの HTML は表示中の文書に入れない (`innerHTML` で生きた DOM に入れない)。`DOMParser` で文書の外の木にし、hast → mdast → 文字と木から木へ移すだけ。`DOMParser` の文書では script は走らず、画像も取りに行かない (e2e で確かめる)
- script・style・template・コメント・イベントの属性は出力に出さない
- リンクと画像の URL は、URL として読めて scheme が http・https・mailto のものだけを残し、それ以外 (`javascript:`・`data:`・相対 URL 等) は文言 (画像なら alt) だけを残す。相対 URL は貼った先で行き先が無いので残さない
- 出力は markdown の文字だけで、HTML のタグは表のセルの中の改行の `<br>` ([DR-0010](./DR-0010-timeline-markdown-rendering.md) §3) のほかに出さない

### 6. 部品と bundle

- `DOMParser` → hast-util-from-dom → hast-util-to-mdast → mdast-util-to-markdown で組む。3 つとも syntax-tree (unified の組織) の MIT / ISC で、更新が続いている。webui の markdown の描画が既に使う mdast の上に乗る
- 変換 (`html-to-markdown.ts` と部品) は、最初に変換が要る時に動的 import で読み込む chunk に置く。最初の画面の bundle に置くのは、貼り付けの handler と判定 (`pasted-html.ts`) だけ
- GFM の表と打ち消し線の toMarkdown は、mdast-util-gfm-table / -strikethrough のものを使わず、`gfm-to-markdown.ts` に書く (escape の決まりは 2 つの拡張と同じ)。2 つの module は最初の画面の markdown の読みと同じ module で、chunk から toMarkdown 側を使うと、bundler が mdast-util-to-markdown の handler 一式ごと entry に置く (実測で entry が gzip +6.8KB)
- 実測 (minify、v0.404.0 の上): entry は 864,763 → 867,565 (gzip 276,085 → 277,952)。増えたのは handler と判定と、chunk が entry と分け合う module の export。変換の chunk は 58,137 (gzip 18,867)

### 7. 試験の観点

- 純関数 (`html-to-markdown.dom.test.ts`、happy-dom の DOMParser): 要素ごとの書き方、入れ子、表の揃え・セルの改行・`|`。実物のコピーの fixture (`test/fixtures/paste-html/`) について:
  - GitHub の描画を Chromium・WebKit でコピーしたもの
  - この webui の吹き出しのコピー
  - 貼り付けの試験用のページの見本 (本物の Chrome と iPhone の Safari の text/html の形。iPhone の `Apple-converted-space` の空白は空白 1 つになる)
  - Monaco のコピー
  - Cocoa の変換の HTML
  - ドキュメントと表計算の形を手で組んだもの

  変換しない HTML、危ない URL と script が出ないことも見る。fixture の出力は Chromium・WebKit の DOMParser の上と同じ (実測)
- handler (`paste-html-as-markdown.dom.test.ts`):
  - カーソルの位置・選択の置き換え・待つ間にフォーカスが外れた時
  - text/html が無い時・判定が否の時・読み取り専用・先に引き受けられた時はブラウザのまま
- 各入力欄の配線: §1 の欄ごとに、HTML の貼り付けが markdown で入り、plain の貼り付けはブラウザのまま。ファイルのある貼り付けは添付になる
- 実ブラウザ (`paste-html.e2e.ts`、Chromium と WebKit):
  - 吹き出しのコピーが元の markdown で入り、⌘Z で貼る前に戻り、⌘⇧Z でやり直せる
  - 選択の置き換え
  - エディタとターミナル (Cocoa の変換の HTML) のコピーは text/plain が 1 文字も変わらず入る
  - HTML の中の script・イベントが走らず、画像を取りに行かない
  - ⌘⇧V は text/plain (Chromium だけ。Playwright は WebKit に ⇧⌘V の編集コマンドを送れない)

## Alternatives Considered

- 案 A: rehype-parse (parse5) + rehype-remark + remark-gfm + remark-stringify
  - 不採用理由: 出力は採った部品と 1 文字も違わず、大きさが 3 倍 (minify 317KB)。ブラウザが持つ `DOMParser` で足りる
- 案 B: turndown + @joplin/turndown-plugin-gfm
  - 不採用理由: 小さい (minify 18KB) が、既定で script と style の中身が出力に出る。escape が多く、強制改行は行末の空白。本家の gfm plugin は更新が止まっている。木を経ないので、URL の許可リスト等を木の上で決められない
- 案 C: HTML の木から markdown の文字を手で書く
  - 不採用理由: HTML の空白の畳み方・暗黙の段落・リストと表の崩れた形の扱いを作り直すことになる
- 案 D: ⌘⇧V を直前の keydown の修飾キーで見分ける
  - 不採用理由: text/html が外れて届くので要らない。メニューからの「スタイルを合わせて貼り付け」も同じに扱える
- 案 E: 段落・改行・太字も変換の引き金にする
  - 不採用理由: ターミナル (Cocoa 経由) とエディタのコピーの字下げ・空白が崩れる (§2)

## Consequences

- 変換しないもの:
  - 太字・斜体だけの断片 (§2)
  - ドキュメントの編集ソフトの `span` の style の太字・斜体
  - タスクリストのチェックボックス (項目の文言は残る)
  - 表のセルの結合
  - 入れ子の表 (文言になる)
  - 数式 (MathML は出さない)
- 相対 URL のリンク・画像は文言だけになる
- iPhone の Safari には text/html を外して貼る操作が無い (長押しのメニューの貼り付けは textarea にも text/html を渡す、実測)。引き金の要素のある HTML は必ず変換される
- 未検証:
  - macOS の Safari と Firefox の「プレーンテキストとして貼り付け」(Safari の既定は ⌥⇧⌘V)
  - 他のアプリからのコピーの text/html を Safari が書き直す時の形
  - 表計算・ドキュメントの編集ソフト・ターミナルの実物の text/html (OS のクリップボードを通さないと採れない)

## 関連

- [DR-0010](./DR-0010-timeline-markdown-rendering.md) — markdown の描画 (`<br>` の扱い、画像を `🖼 alt` のリンクで描くこと)
- [DR-0015](./DR-0015-composer-attachments.md) — 添付の貼り付け
- [DR-0062](./DR-0062-comments.md) — コメントのフォーム
- [findings 2026-11-25](../findings/2026-11-25-paste-html-clipboard.md) — 測ったこと
