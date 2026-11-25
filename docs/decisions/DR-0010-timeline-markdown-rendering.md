# DR-0010: Timeline の発言 (応答・ユーザ発言) の Markdown レンダリング

- **Status**: Accepted (team-lead セッションからの委譲プロンプトで確定方針として提示、実装完了)
- **Date**: 2026-07-11
- **Author**: AI agent (worker session、team-lead セッションの委譲プロンプトに基づく)
- **一次資料**: team-lead セッションからの委譲メッセージ (2026-07-11、下記 Context に要旨転記)
- **前提 DR**: DR-0005 (frontend architecture、preact/JSX 方針)・DR-0008 §6 follow-up (syntax highlighting の bundle-size 評価と `@speed-highlight/core` 採用。**Note**: highlight.ts のパイプラインはその後 Shiki に置き換え済み、DR-0008 §6 の実測値・パッケージ名は stale — 追補 DR 未起票)・DR-0009 (Timeline の transcript レンダリング基盤)

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz 経由]** = team-lead セッションの委譲プロンプトに確定方針として記載 / **[提案]** = 本セッションでの実装時判断 / **[保留]** = 意図的に未決。

## Context

Timeline (DR-0009) のアシスタント発言は現在プレーンテキストで表示されている。team-lead セッションが以下を調査済みの確定方針として委譲した [kawaz 経由]:

- ライブラリは `@mizchi/markdown` (npm v0.6.5、MIT、exact pin)。`parse(src): mdast.Root` を使う
- `toHtml`/`toHtmlLiteral` は XSS 素通し実測済みのため使用禁止 (javascript: URL をそのまま HTML 文字列に埋め込む)
- mdast → preact JSX walker で描画、innerHTML/dangerouslySetInnerHTML は全面禁止 (DR-0005 の既存方針)
- URL スキーム許可リスト (http/https/mailto/相対パスのみ)、mdast の `type:"html"` ノードはエスケープ済みテキストとして表示 (実行しない)
- コードフェンスは既存の `@speed-highlight/core` パイプライン (highlight.ts、DR-0008 §6 follow-up) を流用
- 画像は外部フェッチせず alt + URL のリンク表示に留める (情報漏洩ベクタ回避)

## Decision

### 1. mdast walker を独立モジュールとして実装、`toHtml` 系 API は一切呼ばない [kawaz 経由]

`packages/webui/src/client/markdown-view.tsx` に `renderMarkdownAst(root: Root): VNode` (純粋な mdast → VNode 変換) と `MarkdownView({ source })` (parse + render の薄いラッパー) を実装。カバーする mdast node type は heading/paragraph/list/listItem/code/inlineCode/blockquote/table 系 (table/tableRow/tableCell)/link/image/strong/emphasis/delete/break/thematicBreak/html/text。未知の node type は `children` があれば再帰して情報を落とさず、無ければ何も描画しない安全フォールバック (DR-0009 の「jsonl フォーマット非固定を前提にした forward-compat フォールバック」と同型の設計)。

### 2. URL 許可リストは制御文字除去 + スキーム抽出で判定 [提案]

`isSafeUrl(url): boolean` を export。`http:`/`https:`/`mailto:` のみ許可、スキームなし (相対パス・`#fragment`) は許可、それ以外 (`javascript:`/`data:`/`vbscript:`/`file:` 等) は拒否。判定前に ASCII 制御文字 (制御文字全般、空白含む) を除去してからスキームを正規表現抽出する — ブラウザの URL パーサーがスキーム判定時に制御文字を無視する挙動に合わせたもので、`"java\tscript:alert(1)"` のような制御文字分割によるスキーム偽装 (=「スキームなし」への誤判定) を防ぐ。`//host/path` (protocol-relative) はスキームを明示しないが現在ページのスキームを継承するため、相対パスと同列の「安全」扱いにはせず拒否する。

安全でない URL を持つ `link`/`image` ノードは `<a href>`/画像リンクを一切生成せず、リンクテキスト (または alt) のみを表示する — 情報は落とさず実行可能な参照だけを外す。

### 3. `type:"html"` ノードは常にプレーンテキスト表示、パース・実行しない [kawaz 経由]

raw HTML の source テキストをそのまま JSX テキスト子要素として描画する。Preact の JSX テキストノードは自動エスケープされるため、`<script>` 等が DOM に注入されることはない。

意味のとおりに扱うのは形で見分ける 3 つだけで、どれも HTML としては解釈しない:

- 改行のタグ `<br>` (kawaz 2026-11-20)。表のセルに 2 つ以上の要素を入れる時に `<br>` で行を分ける書き方のため。`<br>` / `<br/>` / `<br />` を大文字小文字を問わず認め、属性が付いたものは文字のまま出す。地の文 (段落・見出し・表のセル・強調やリンクの文言の中) のものを mdast の `break` (CommonMark の強制改行と同じノード) にして、強制改行と同じ `<br>` の要素で描く。コードの中 (inline code、コードフェンス) のもの、`&lt;br&gt;` と実体参照で書いたもの、`\<br>` と前にバックスラッシュを置いたものは文字のまま。パーサの前の `protectTagLikeAngleBrackets` が `<br>` に専用の印を付け、パース後に `text` ノードの中の印だけを `break` に分ける (`splitLineBreakTags`)。`<details>` の折りたたみが段落を行に分けて組み直す時も、`break` で終わった行の後には `break` を戻す (`"\n"` にすると改行の要素が消える)。生の HTML をパーサに通して許可リストで選ぶ方式は取らない: 行頭の `<br>` が CommonMark の HTML ブロックとして後続の行を空行まで飲み込むため。`MarkdownView` (Files の markdown プレビュー、Timeline のバブル (応答とユーザ発言、§6)、InlineFileViewer、カタログ、permit の本文) の全部に効く

- `<details>` / `<summary>` の折りたたみ (`foldDetailsBlocks`)
- 文書の中の場所に名前を付ける空のアンカー `<a id="…"></a>` / `<a name="…"></a>` (kawaz 2026-11-10)。属性が `id` か `name` の 1 つだけで、タグの間が空のものに限る (`DOCUMENT_ANCHOR_RE`)。その位置に `id` だけを持つ空の要素を描き、タグの文字は出さない。見出しの中に書けば目次の文字にも出ない。`…/files?path=…#<id>` でその位置へ飛べる (hash の扱いは [webui-url-grammar](../design/webui-url-grammar.md))。これをするのは Files の markdown プレビューだけで (1 つの文書だけが画面にある)、Timeline のバブルではタグの文字のままにする (バブルごとに別の文書なので、同じ id が画面に 2 つ出うる)。コードの中 (inline code、コードフェンス) のものは書いたとおりに出す

### 4. コードフェンスは `CodeBlock` コンポーネントに委譲、fence の info-string を拡張子とみなして既存の `detectLanguage` テーブルへ通す [提案]

`packages/webui/src/client/components/CodeBlock.tsx` を新規実装。FileViewer.tsx と同じ「非同期 tokenize、完了まではプレーン表示」パターンを再利用する。fence の `lang` (例: `ts`, `py`) を検出済み拡張子マップにそのまま通す (`detectLanguage("_.${lang}")`) ことで、`EXTENSION_LANGUAGE_MAP` (highlight.ts) を二重管理せずに済む。未対応言語は plain フォールバック。fence の `lang` は `<code>` に CommonMark の描画の慣習の `language-<lang>` の class で残す (コピーした塊を入力欄に貼ると言語が戻る、[DR-0065](./DR-0065-paste-html-as-markdown.md) §4)。

### 5. 画像は URL を自動フェッチせず、alt + リンク表示に留める [kawaz 経由]

markdown の画像 (`![alt](url)`) の URL からは `<img src=...>` を生成しない。安全な URL であれば alt テキストとその URL への `<a>` リンクとして表示し、ユーザが明示的にクリックした場合のみ画像へ到達する。理由: markdown 本文にリモート画像 URL を埋め込むだけで、レンダリングした瞬間に閲覧者の IP/UA が任意の第三者サーバへ到達する情報漏洩ベクタになり、この webui の CSP 制御範囲外の挙動になる。

### 6. ユーザ発言も応答と同じ Markdown の描画にする [kawaz 経由]

kawaz 2026-11-25: 「これなんでユーザ側だけ md プレビューチープなんだっけ? ほぼ使えないよね。」本文を書く欄のプレビュー (§15) で見えた形と、送った後の TL の吹き出しの形を揃えるため、ユーザ発言の吹き出しの md を応答の吹き出しと同じ描画にする、と裁定した (原文は source で見る)。

- **描き方**: ユーザ発言の吹き出し (`UserPromptBubble`) の text segment を、応答の吹き出しと同じ `LinkedMarkdownView` で描く (`segments.tsx` の `BubbleMarkdownText`)。見出し・リスト・表・コードブロック・強調などの記法、§3 の `<br>` と `<details>`、§7 の裸の URL、§8 の実在するパス、§12〜§14 の図と数式も応答と同じに効く。吹き出しで描くユーザ発言は、素のプロンプトと引数付き slash command の本文 (`userMessageKind` が `user-prompt` / `slash-command-prompt`)
- **人が書いたほかの吹き出し** (kawaz 2026-11-25): 未送信の FAB の下書きの吹き出し (`DraftBubble`) と人のコメントの吹き出し (`CommentBubble`。送ったもの・未送信のもの・btw の質問・返信のコメント、💬 のフィルタの中でも同じ) の本文も、ユーザ発言の吹き出しと同じ描画にする (`segments.tsx` の `UserWrittenText`。同じ部品・同じ `.tl-text` の要素で、単独の改行の扱いも同じ)。訳のタブは持たない。描くのは添付を置き換えた後の届く形 ([DR-0062](./DR-0062-comments.md) §13)
- **単独の改行**: 段落の中の単独の改行も、打たれたとおり改行として見える。TL の本文の要素 (`.tl-text`) は `white-space: pre-wrap` で、応答と同じく mdast の text に残った `\n` が行を分ける。改行を mdast の `break` (`<br>`) に置き換える形は取らない (`<br>` は描画済みの文字に改行を残さず、TL の検索で前後の行の字が繋がって当たる、§11)。コードブロックの中は書かれたとおり。本文を書く欄のプレビュー (§15) も同じ指定を通すので、プレビューと吹き出しは同じ形になる
- **足元の md | source** (kawaz 2026-11-20): md が上の描画で既定、source は打たれた文字そのもの (リンクも付けない、コピペ用の `tl-bubble-source`)。翻訳のタブで訳文を選んでいる間は、応答と同じく md も source も訳文を出す ([DR-0049](./DR-0049-webui-plamo-translation-tab.md) §8)。下書きとコメントの吹き出しも足元に同じ切り替え (`BodyViewTabs`、同じ title) を持ち、選んだ表示は吹き出しごとに持って覚えない (kawaz 2026-11-25)。未送信のコメントを「直す」間は、本文の代わりに出る欄が自分の md | source (§15) を持つので、足元には出さない
- **添付**: この app が発言に埋め込む `[FILE<N>:name](<添付のパス>)` は markdown のリンクとして読み、添付の配信経路の URL に替える ([DR-0015](./DR-0015-composer-attachments.md) §2.6)。画像の添付は画像、それ以外はリンクで出る
- **範囲選択のコメント**: ユーザの発言と FAB の下書きは対象外のまま ([DR-0062](./DR-0062-comments.md) §2)。md の描画にも `data-comment-text` を付けない。人のコメントは対象 (送ったもの、§2) で、md の描画に `data-comment-text` を付け、引用の文字と前後の文字は描画された文字から取る (記法の記号は入らない)。source の間は応答の source と同じく対象外
- **吹き出しの外のユーザの文字**: システム由来の行 (task-notification 等) の raw の表示に出る user の text segment は、打たれた文字のまま、裸の URL・実在するパス・`[label](target)` だけをリンクにする (`LinkedPlainText`、`renderPlainTextWithLinks`。URL は §7 の規則を markdown パーサを通さずに当て、パスは §8 の linker で確かめる。`[label](target)` は target が http(s) の URL・添付・実在の確かめられた絶対パス / `~/` パスの時だけリンクにする)

今の扱い: 記法のつもりでなく打った字も記法として読まれ、md では字が消える・別の字になることがある。どれも応答の描画と同じ振る舞いで、原文は source で読める (kawaz の裁定は化けることを承知の上、2026-11-25)。下書きとコメントの吹き出しも同じ扱いで、保護を足さない。

| 打った字 | md の見え方 |
|---|---|
| `[1]: https://example.com/ref` の行 (リンクの参照の定義) | 行ごと消える |
| `2*3*4`、`a*b*c` | 「234」「abc」(真ん中が斜体) |
| `__init__` | 太字の「init」 |
| `1. …` の次の行の `2026. …` | リストの「2.」(2026 が消える) |
| `\d+\.\w*`、`\[x\]`、`\*`、行末の `\` | `\d+.\w*`、`[x]`、`*`、行末の `\` は消えて改行 (`C:\Users\name` の `\` は残る) |
| `&amp;`、`&lt;`、`&copy;` | 「&」「<」「©」 |
| `<br>` | 改行 (§3) |
| 行頭の `#` / `- ` / `1.` / `>`、`~~x~~`、次の行が `---` の行 | 見出し / リスト / 引用 (続けて打った行も引用に入る) / 取り消し線 / 見出し |

`<div>`・`<T>`・`<確認項目>`・`a <b` のようなタグ風の字は、§3 の前処理 (`protectTagLikeAngleBrackets`) で字のまま出る。バッククォート 1 つ、`snake_case_name`、URL の中の `_` も字のまま。

描画の時間 (2026-11-25 実測、コードブロックの無い長いログを貼った発言): ブラウザで md のタブを押してから 2 frame 後までが、打たれた文字のままの描画に比べて Chromium で 300 行 22.6→37.6ms・1000 行 16.4→77.4ms、WebKit で 300 行 19→37ms・1000 行 30→103ms (中央値)。JS の処理だけ (happy-dom) では 300 行 1.2→20.5ms・1000 行 2.2→56.9ms で、ほぼ全部が markdown の parse (1000 行で約 65ms)。同じ長さの応答を描くのと同じ費用。parse は吹き出しを描く時と source から md に戻す時に 1 回ずつで、TL の追記などの描き直しでは `MarkdownView` の memo が効いて parse し直さない。

### 7. 地の文の裸の URL はリンクにする [kawaz 経由]

GFM の autolink literal (`micromark-extension-gfm-autolink-literal` + `mdast-util-gfm-autolink-literal`) を登録し、地の文の `https://…` / `www.…` / メールアドレスを link ノードにする。link ノードなので、書かれたリンク (`[x](url)`) と同じ `link` case を通り、scheme 許可リスト (`classifyMarkdownLinkUrl`) と新規タブの扱いもそのまま効く。`www.` 始まりは拡張の既定どおり `http://` を補う。

GFM は literal をホワイトスペースか `<` までとするので、空白を置かない日本語の文では URL の後ろの文までリンクに入る (`https://example.com/a。続き`)。literal の URL は最初の非 ASCII 文字か `<` で切り、切った端に出た句読点を GFM と同じ規則で落とす (`literalAutolinkText`)。切った残りはテキストに戻し、そこに続く URL を探し直す。生の非 ASCII を含む URL (IRI) はその文字以降を失うが、アドレスバーやツールからコピーされた URL は percent-encode 済みで、URL の直後に文が続く日本語の方がはるかに多いので、こちらを取る [提案]。

書かれたリンク・`<url>` autolink・inline code・コードフェンスの中身は対象外 (それぞれのノードが先に取る)。`protectTagLikeAngleBrackets` が退避した `<…>` は literal の中では非 ASCII の印として現れるので、URL はその手前で切れ、角括弧はテキストのまま残る。

### 8. 地の文の絶対パスは実在するファイルだけリンクにする [kawaz 経由]

地の文の `/…` と `~/…` のパス (`findProsePaths`) を、inline code と太字のパスと同じ linker (`FilePathLinker`) に通し、daemon の `fs_stat_batch` が実在を確かめたものだけをリンクにする。見た目は地の文のまま点線の下線だけを付ける (`.md-prose-file-link`、inline code のチップにはしない)。`~/` は daemon がユーザの HOME で展開して判定する。

パスは単語の途中・相対パスの途中・URL の `//` からは始まらず、空白・引用符・括弧・`,`・非 ASCII 文字で終わる (`/tmp/x.mdにある` → `/tmp/x.md`)。末尾の `.` と `:` は文の句読点として外し、行番号 (`/tmp/x.md:12`) は残す。相対パス (`docs/x.md`) は地の文では探さない: `and/or`・`I/O`・日付と区別が付かず、相対パスは inline code と太字で書かれる。リンクのラベルの中や、太字ごとファイルリンクになった中では、`<a>` の入れ子を作らないようリンクにしない。

### 9. Timeline の項目の中で始まった選択は、その項目の外へ広げない [kawaz 経由]

コードをコピーしようと選択範囲を調節している間に、選択が隣の項目や吹き出しの外まで広がる (タッチ端末のハンドル操作で特に起きる)。選択の始点が項目の中なら、選択を調節している間はその項目に閉じ込める。項目は始点から次の順で決める: コードの塊 (`pre`) > inline code (`.md-inline-code`) > 吹き出しの本文 (`.tl-bubble-body`) > thinking の本文 > 吹き出しの外の発言 (`.tl-text`)。コードを最優先するのはコピーしたいのが大抵コードだから。閉じ込めるのは始点がコードの中の時だけで、コードの外 (本文) から始めた選択は本文に閉じ込められ、コードを含めて選べる。吹き出しの本文を中の段落より優先するのは、段落や segment をまたいで選べるようにするため。項目でない場所 (fold の見出し等) から始めた選択は閉じ込めない。

CSS UI 4 の `user-select: contain` がこの振る舞いそのものだが、使えない [提案、2026-10-21 確認]:

| 確認先 | 結果 |
|---|---|
| MDN `user-select` | 「`contain` を実装しているブラウザは無い」と明記 |
| MDN browser-compat-data (`css.properties.user-select`) | 下位項目は `all` / `auto` / `none` / `text` のみで `contain` が無い |
| Chrome 155 / Chrome Beta 157 / WebKit 26.6 (playwright で実測) | `CSS.supports("user-select", "contain")` が false、`contain` を当てた `pre` の中から drag した選択は外の段落まで伸びる |

代わりに、選択が広がり始めた時点で「その項目以外を選択不可 (`user-select: none`)」にする (`useSelectionContainment.ts`、`:root[data-select-contained]` と `[data-select-host]`)。閉じ込め先は選択が始まった場所 (`selectstart`) で決め、入れるのは押したまま pointer が動いた最初の `pointermove` か、選択が畳まれていない状態になった時 (ダブルクリックの語・長押し・Shift+矢印)。押しただけ (fold の見出しのクリック等) では入れない: `:root` の user-select の切り替えは継承で文書全体の style を計算し直させ、Timeline を 2 つ開いた画面で 1 回 100ms を超える (等速)。`pointermove` は選択を広げる処理より先に配られるので、動いた最初の一歩から閉じ込めが効く。選択の端をどこに置けるかの判断はブラウザが持ったままなので、操作の種類 (マウスの drag・タッチのハンドル・Shift+矢印) によらず同じ user-select の規則で決まる。JS は始点を覚えて属性を付け外すだけで、Selection を書き戻さない (`selectionchange` で端を戻す方式は、ユーザが動かしているタッチのハンドルと JS の書き換えが同じ選択を奪い合う。実機では確かめていない)。閉じ込めは、項目の外を押した時 (別の場所から選び始められるよう、ブラウザが押下を処理する前に) と、押していない間に選択が畳まれた時に外す。

Chrome と WebKit の実画面でマウスの drag が項目に収まることを確かめた: コードの塊と inline code の中から始め、同じ行の左右、上下の行、サイドバーの上の 2 点、画面の右下の 7 か所で離して、選択はどれも始点のコードの中に収まる。本文から始めて inline code をまたいだ drag は code を含めて本文を選ぶ。タッチは Chrome の Pixel エミュレーションで長押し選択が閉じ込めを起動することまで確かめた。ハンドルの drag はエミュレーションで再現できない (閉じ込めなしでも動かない) ため、実機のハンドル操作での挙動は未確認 [保留]。`user-select: contain` が実装されたら置き換える。

### 10. コードにコピーボタンを添える [kawaz 経由]

fence (`CodeBlock`)、Timeline の tool 入出力・raw 行・system message 等の `pre`、吹き出しの source 表示、Timeline 内のファイル表示、markdown の inline code に、そのコード全体をクリップボードへ書くボタンを付ける (`CodeCopyFrame.tsx`)。成功の印は他のコピーボタン (`CopyButton`) と同じく 1.5 秒の ✓ で、ボタンの幅を動かさない。

- ボタンはコードの左上の真上に、コードに重ねずに置く (ボタンの下端 = コードの上端、左端 = コードの左端)。コードに重ねると下の文字が隠れ、`pre` の中に置くとスクロールで内容と一緒に流れる。markdown の中の塊 (コードブロック、§12 の箱) の上には、ボタンの高さだけの余白を取る。段落の間の余白 (0.7rem) はボタン (約 1.2rem) より狭く、そのままでは出たボタンが前の段落の文字を覆う (Chrome / WebKit で実測、7.6px 重なった)。コードを包む要素 (fence 等は `div`、inline code は文の組みを変えない `span`) を基準にした絶対配置で、行をまたいで折り返した inline code でも 1 行目の始まりを指す
- 出す条件は 3 つ: hover できる端末での hover、tab キーでの focus、コードのクリック (タップ)。クリックで出したボタンと押したボタンは、包みの外を押すまで残る (コピー後の ✓ もその間見える)。通常は不可視で、押せない (コードの上の行の文字を見えないボタンが塞がない)
- クリックか選択操作かは、ブラウザが `click` を出したかと、その時点で選択が畳まれているかで分ける。タッチのスクロールや長押しには `click` が来ず、コードの中で drag して選んだ後の `click` では選択が残っている (その時は出ていたボタンも消す)。inline code の URL・ファイルのリンクのクリックは遷移なので出さない
- リンクの文言の中の inline code (``[see `x`](…)``) には付けない (`<a>` の中のボタンは不正な HTML で、押下がリンクの押下も兼ねる)。URL・ファイルのリンクになった inline code では、ボタンはリンクの外に置く
- 中身が空で「(出力なし)」「(空のコマンド)」等の代わりの文字を出している塊には付けない (写す中身が無い)
- ボタンの文字は CSS の `content` で出し、DOM のテキストにしない。コードは Timeline の検索単位 (描画済みテキストを走査する) と選択範囲の中にあり、DOM に文字を置くと「コピー」が検索に当たり、本文を選択してコピーした文字列にも混ざる。読み上げる名前は `aria-label` が持つ

CSS anchor positioning は使わない [提案、2026-10-23 確認]。web-features の `anchor-positioning` は Limited (2026-10 時点、Safari 27 だけが全項目を満たす)。使うはずだった項目 (`anchor-name` / `anchor-scope` / `anchor()`) は個別には Chrome 131+ / Safari 26+ / Firefox 147+ にある (MDN browser-compat-data 8.1.7) が、ここでは包みを基準にした配置より良くならない:

| 確認 | 結果 |
|---|---|
| ボタンの下端 − コードの上端 (Chrome 156 / WebKit 26.6 で実測) | `anchor(top)` で 0〜−1.0px、包みの `bottom: 100%` で 0〜−1.2px (負はコードとの間の隙間)。どちらも重ならず、差は 1.2px 以内 |
| 3 行に折り返した inline code の左端 (同上で実測) | `anchor(left)` は全行を囲む矩形の左端 (2 行目の行頭) を指し、コードの始まりより 120px 左に出る。包みの `left: 0` は 1 行目の始まり (コードの始まり) と一致する |
| ボタンをコードの外に置く包み | どちらでも要る (`pre` の中に置けない、`<code>` の中に置くと選択の閉じ込め先に入る) |

既知の制約 [保留]: 横スクロールする箱の中のコード (表の見出し行の inline code 等) では、箱の上端より上に出るボタンが箱に切られて一部しか見えない (表の 2 行目以降はボタンが前の行に重なるので見える)。

### 11. 見出しと段落の文字の末尾に改行を置く [kawaz 経由]

見出し (`h1`〜`h6`) と段落 (`p`) の文字の後ろに、改行 1 字のテキストノード (`LINE_END`) を置く (kawaz 2026-11-21、段落は 2026-11-22)。リストの項目 (`li`) の文字も段落なので同じく改行で終わる。Timeline の画面内検索は描画済みのテキストノードをそのまま繋いだ文字列に当てるので、置かないと画面で別の行にある字が 1 続きになり、入れ子の項目 (`- 👺XXXX` の下の `- Q1 …`) や次の段落・リストを探す語が前のブロックの文字から続けて当たる。検索の側で要素ごとに区切りを判断する形は取らない (要素ごとの扱いを抱え、全体を走査する検索の処理を重くするため)。

- 置き場はブロックの中、文字の末尾。Timeline の吹き出しは `white-space: pre-wrap` で、ブロックの末尾の改行は行を増やさないが、ブロックとブロックの間 (`</p>` の後ろ、入れ子のリストの後ろの `</li>` の直前) に置いた改行は空の行として描かれる (Chrome で実測、同じ発言の高さが 427px から 640〜700px に増えた)。`li` の末尾では入れ子のリストの後ろになり、項目の文字と入れ子の項目の文字の間を区切れない
- 項目の文字はパーサが詰まったリストでも段落にするので、項目にも段落の改行がそのまま効く (task の項目は `.md-task-body` の中の段落)
- 引用 (`blockquote`) の中の文字も段落なので、引用と後ろのブロックの間も区切られる
- 選択してコピーした文字は置かない時と変わらない (Chrome で実測)
- 表のセル (`th` / `td`) には置かない。pre-wrap のセルの末尾の改行はコピーに残り、セルの区切りのタブが改行に変わって表の形が崩れる (Chrome で実測、`"左\t右\nc1\tc2"` が `"左\n右\nc1\nc2"` になる)。そのためセルとセル、表の行と行の間は区切られない

### 12. ```svg のコードブロックは図として見せる [kawaz 経由]

言語が `svg` (大文字小文字を問わない) のコードブロックは、中身を data URL にした `<img>` で図として描く (kawaz 2026-11-22)。エージェントに「図で説明して」と頼めるようにするため。Timeline の吹き出し (応答とユーザ発言、§6) と Files の markdown プレビューの両方 (`MarkdownView` を通る全部) に効く。

- **img にする理由 (安全)**: SVG を文書に直に入れる (inline `<svg>`、`innerHTML`) と、`<script>`・`onload` 等のイベント属性・`<foreignObject>` の HTML・外部の画像や CSS の参照がこの webui の文書の中で動く。img として読ませた SVG は、ブラウザが script を動かさず外部の資源も読まない (secure static mode。Chrome / WebKit で実測、`<script>` の fetch・`onload`・`<style>` の `@import`・`<image href>`・`<foreignObject>` の中の `<img>` のどれも要求を出さず、図は描かれた)。応答に第三者の入力 (読んだ web ページ、tool の出力) が写っていても、webui の文書には何も入らず、外へも何も取りに行かない。§5 の「描いた瞬間に第三者へ到達しない」もそのまま守れる (data URL の中身は応答の文字そのもの)。`<iframe sandbox>` も考えたが、大きさを中身に合わせる仕組みが要り、図 1 つのためには重い。script を動かしたい図は、下の「実行」で別のタブに開く
- **data URL**: `data:image/svg+xml;charset=utf-8,` に中身を `encodeURIComponent` したもの。base64 にしない (中身は UTF-8 の文字で、`btoa` は Latin-1 しか受けず、英数字の多い SVG では percent-encode の方が短い)。`charset=utf-8` は percent-encode したバイト列が UTF-8 であることを XML の読み手に伝える
- **`xmlns` の補い**: img は SVG を XML として読むので、根の `<svg>` に `xmlns="http://www.w3.org/2000/svg"` が無いと SVG の要素にならず壊れた画像になる。HTML に直に書く `<svg>` は省けるので書き手は省きがちで、根が名前空間を持たない `<svg>` の時だけ最初の `<svg` の直後に足す (Chrome / WebKit で実測、足さないと壊れた画像になる)。他の修復はしない
- **箱と切り替え**: 罫で囲んだ 1 つの箱に、上から切り替えの列 (「描画 / ソース」のタブと、種類ごとの切り替え。§13 の mermaid の配色)、図かソースを置く。既定は描画で、ソースはハイライトしたコード (`xml` の文法を持たないので `html` の文法で読む)。タブは Timeline の小さなタブ (`.tl-thinking-tab`、`Tabs`) で、svg と ```math の切り替えの状態はブロックごとで保存しない (svg の中身は任意の画像で、図ごとに見たい方が違う。mermaid だけが §13 の共通の選択を持つ)。§10 のコピーボタンは箱を包んで 1 つだけ付け (箱の左上の真上、箱の外に出るのでタブと重ならない)、写すのはソース
- **切り替えで位置を保つ** (kawaz 2026-11-22: 見ている位置を見失わない、瞬間移動しない): 切り替えを押した時 (ポインタは pointerdown、キーは keydown) に切り替えの列の画面上の縦位置を測り、選択が変わって描き直された後の次の frame の描画の前 (requestAnimationFrame) に、ずれた分だけ列を含むスクロールの容器 (縦にスクロールしている一番近い祖先) を一瞬で動かす (機械的な寄せ直し、DR-0056)。mermaid の選択は全部の図に効くので、押した図より上の図も一斉に伸び縮みするが、押した列は動かない。後から図が描き上がった時も、最後に押した列が同じ容器の中で見えていればそれを、無ければ見えている範囲より上から始まる図の下端を留める (`keep-scroll.ts`)。
  - 容器の範囲を超えて動かす必要がある時 (末尾の近くで後ろが縮んだ、先頭より上が要る) は、容器の末尾 (先頭) に一時的な余白を置いて位置を保ち、余白を CSS の transition (0.35 秒) で縮めて滑らかに動かす。余白の高さは置いて測ったずれが消えるまで合わせる (Timeline の末尾の子は負の margin で前の子に重なっていて、余白の高さの一部は範囲を伸ばさない)。OS の「視差効果を減らす」設定の時は余白を置かず範囲の端で止める
  - スクロールの位置は整数 px に丸められるので、補正のたびに 1 px 未満のずれが残る。図が次々に描き上がって補正が続く時は、前の補正で残ったずれを次の補正の基準から差し引き、積み重ねない (補正の後に容器が動いていれば使わない)
  - 容器に `overflow-anchor: none` は付けない。Timeline は、何も保っていない読書中に上の内容が伸びた時の位置の維持をブラウザの scroll anchoring に任せていて (`useScrollHold.ts`)、止めると図以外の伸び (画像・ハイライト・翻訳) で読んでいる位置がずれる。ずれは変わった後の実際の位置から測るので、scroll anchoring が先に動いていても二重には動かさない。Timeline の実画面 (Chromium と WebKit) で、切り替え (ポインタとキー) と描き上がりの前後の位置が 1 px 以内に保たれ、範囲の端では余白が縮むまで一方向に滑らかに動くことを確かめた (`e2e/markdown-mermaid-prefs.e2e.ts`)
  - Timeline が末尾や位置を保っている間 (`useScrollHold`) は、その保持が同じ frame の ResizeObserver で置き直すので保持が勝つ。切り替えを押すと押下で保持は手放されるので、末尾を追っている時に押した列も動かない
- **描画できない中身**: XML として壊れている、根が SVG でない等で img の読み込みが失敗したら (img の `error` の event)、ソースに切り替え、描画のタブを押せなくし、タブの下に「この SVG は描画できないのでソースを表示している」と出す。中身が替われば描画をもう一度試す
- **実行** ([DR-0067](./DR-0067-svg-script-run.md)): svg の箱のタブには「描画 / ソース」の後に「実行」の区画が付く (sandbox origin のある環境だけ)。図の script は、人が「実行」を押した時だけ、webui とは別の origin (preview と同じ sandbox origin) の別のタブで動き、箱の中の img では動かない。「実行」は切り替えでなく開く操作で、押しても選択は動かない。mermaid と ```math の箱には付かない
- **種類の足し方**: 言語ごとの描き分けは `renderCodeFence` の 1 か所で、描いて見せる種類はそこに 1 つ足す。箱 (`FenceFigure`) は種類によらず共通で、描いたもの・知らせの文・ソースを受け取る (描いたものがまだ無い・作れない時は描画のタブを押せず、ソースを出す)。描画 / ソースの選択を箱の外で持つ種類 (§13 の mermaid) は選択と、描画のタブを押せない理由を渡し、描画を選んでいても描いたものがまだ無い間はソースを出す。切り替えの列には種類ごとの切り替え (mermaid の配色) を並べられる。```svg の図は `SvgFigure` が img にして箱に入れる。記法から SVG を作る種類 (§13 の mermaid) も img の data URL・白の下地の経路で出す
- **alt**: 根の `<title>` の文字。無ければ「SVG の図」(mermaid は「mermaid の図」)
- **大きさ**: 箱の幅を超えない (`max-width: 100%`)。根の `<svg>` が長さの `width` を持たない図 (viewBox だけ、`width="100%"`) は img としての大きさが無く、枠いっぱいに伸びたり 300×150 に縮んだりするので、幅を 30rem にし、高さは縦横比から決まる (添付の画像のリンクの 20rem より一回り大きい)
- **白い下地**: img として読んだ SVG は文書の色を継がず、色を書かない図形と文字は黒、地は透明になる。書き手は白い紙の上に描くつもりで書くので、図はテーマによらず白い下地 (余白付き) に置く (dark の面にそのまま置くと黒い線と文字が消える)。mermaid の図は §13 の配色に従い、ダークの時は暗い下地にする
- **検索・選択・コピー**: タブの文字は §10 のボタンと同じく CSS の `content` で出し、DOM のテキストにしない (画面内検索に当たらず、本文を選んでコピーした文字にも混ざらない)。描画の間、SVG の文字は DOM に無いので、Timeline の検索で発言が当たってもその中の文字には印が付かない (ソースに切り替えれば付く)。§9 の選択の閉じ込めはソースの表示では他のコードと同じ。§11 の改行は前後の段落が持つので、図の前後の文字は検索で繋がらない

### 13. ```mermaid のコードブロックは描いて図として見せる [kawaz 経由]

言語が `mermaid` のコードブロックは、mermaid で SVG に描き、§12 と同じ経路で見せる (kawaz 2026-11-22)。描いた SVG は img の data URL にして DOM に入れず、箱・「描画 / ソース」のタブ・コピーボタンは §12 と同じ。ソースは mermaid の記法の文字 (ハイライトの文法は持たないので色は付かない)。描き方と見せ方は、同じ人の別のツール (単一 html のファイルビューア) の mermaid の図に揃える。

- **選択はページ全体で共通** (kawaz 2026-11-22: 複数の図を 1 つずつ切り替えるのは面倒): 「描画 / ソース」と配色 (「ライト / ダーク / システム」) の選択は、どの図で選んでもページ上の全部の mermaid の図に効き、localStorage (`ccmsg.mermaid.view` / `ccmsg.mermaid.theme`) に残る (`mermaid-prefs.ts`)。既定は描画とシステム。mermaid は daemon が配るので外への通信が無く、既定を描画にする (ファイルビューアは CDN から読むので既定がソース)。ソースを選んでいる間は mermaid で描かず、描画を選んだ時点で描く。描けた図はソースに切り替えても結果を持ち、描画に戻しても描き直さない
- **配色** (kawaz 2026-11-22: OS が dark の時に白い下地が夜に眩しい): 各図を mermaid の theme `default` と `dark` の 2 通りで描き、2 つの img として持つ。どちらを見せるかは CSS だけで決め (img の `data-mermaid-theme`)、切り替えで描き直さない。システムは `prefers-color-scheme` に従い、OS の切り替えにも追う。ダークの時は下地も暗くする (dark の `--bg` と同じ値を固定で持つ `--figure-dark-bg`。`--bg` は OS の配色で入れ替わるので、OS がライトの時のダークに使えない)。配色のタブは描けた図を見せている時だけ出す。図の中の `%%{init}%%` や front matter で theme を書いた図は、そちらが勝つので 2 通りとも同じ見た目になる
  - theme は mermaid の全体の設定 (`initialize`) なので、描くたびに設定してから `render` する。描画は 1 本の列に並べ、別の図の描画が間に入って theme が変わらないようにする
- **差し込み**: 描いた 2 枚は文書に入れる前に `new Image()` で decode し、読めた画像を差し込む (同じ文書で読み終えた画像は同じ src の img に差し込んだ時点で大きさを持つ。HTML の list of available images。Timeline の実画面で、差し込んだ後に高さが変わらず位置が 1 回の補正で保たれることを確かめた)。差し込みで図の高さが変わる位置を §12 の「切り替えで位置を保つ」で 1 回で保つ。decode できない図は「この mermaid は描画できないのでソースを表示している」

- **配り方**: mermaid は外 (CDN) から読まず、daemon が配る。webui の本体の bundle には入れず、mermaid のコードブロックが描かれた時だけ、フロントが入口を dynamic import する。外への通信が無いので、描くかどうかを人に尋ねるボタンは置かず、すぐ描く
  - 配るのは配布物の ESM の最小化版の入口 (`dist/mermaid.esm.min.mjs`、32KB) と、それが相対で読む `dist/chunks/mermaid.esm.min/*.mjs` (105 個、5.5MB。図の種類ごとに分かれていて、描く図の種類の分だけ読まれる)、パッケージの `LICENSE`。中身は配布物のまま配り、Bun.build に通さない (起動のたびに 5.5MB をビルドし直さないため)。chunk は外の名前を import せず、外の URL も含まない (12.3.0 で確認) ので、ディレクトリの形のまま配れば自己完結する
  - URL は `/assets/mermaid-<版>/` の下で、版が入るので immutable で返す (本体と同じ `cache-control`)。配れる名前は最初の要求の時に配布物のディレクトリを読んで決め、それ以外 (`..` を含むもの、`.map`、他の版の配布物) は 404。各ファイルは最初に求められた時に読んで gzip し、プロセスの間覚える。brotli は作らない (最初の表示を待たせるものではなく、5.5MB を作るのに数秒かかる)
  - 版は `packages/webui/package.json` の dependencies で固定し (`12.3.0`)、URL の版 (`client/mermaid-asset.ts`) と一致することをテストが確かめる。入っている mermaid の版が違えば、配る時に `bun install --frozen-lockfile` を促すエラーにする
  - webui の文書には CSP が無い (CSP を付けているのは preview の sandbox の origin だけ、DR-0030) ので、同じ origin からの module の読み込みを止めるものは無い
- **mermaid の設定**: `securityLevel: "strict"` (記法の中の HTML とクリックの動作を止める)、`htmlLabels: false` (ラベルを foreignObject でなく SVG の文字にする。img の中では foreignObject の HTML が描かれない)、図の種類ごとに `useMaxWidth: false` (図の大きさを width / height で明示する)、`suppressErrorRendering: true`。読み込みはページで 1 回で、読み込めなかった時は次に描く時にもう一度読む
- **描くまでと描けない時**: 描画を選んでいて描くまでは、描画のタブを選んだままソースを出し、「mermaid で描画中…」と知らせる。記法の誤りは「図を描画できない: <mermaid のエラー文>」、mermaid を読み込めない時は「図を描画できない (mermaid を読み込めない)」をタブの下に出し、ソースのまま残す。どちらもその図の描画のタブは押せない (他の図の選択は変わらない)。描いた SVG を img が読めなかった時は §12 と同じく「この mermaid は描画できないのでソースを表示している」
- **ライセンス**: mermaid は MIT。chunk には同梱の依存の license の注記 (DOMPurify 等) が配布物のまま残る。mermaid 自身の著作権表示は最小化版の中に無いので、`LICENSE` を同じディレクトリで配る (`/assets/mermaid-<版>/LICENSE`)

### 14. TeX の数式を MathML で描く [kawaz 経由]

markdown の中の TeX の数式を、Temml で MathML にして描く (kawaz 2026-11-22)。書き方と描き方は、同じ人の別のツール (単一 html のファイルビューア) の実装に揃える。

書き方は GitHub に揃え、GitHub 自体が一貫しない細部 (強調や `$` の連なりと重なる時) は pandoc の規則に合わせる。

- 文中: `$…$` と `` $`…`$ ``。どちらも行をまたがない
  - `$…$` は pandoc と同じ規則: 開きの `$` の直後と閉じの `$` の直前が空白でない、閉じの `$` の直後が数字でない。中の `\x` (バックスラッシュと次の 1 文字) は組で読むので、`\$` では閉じない。`$5 and $10`、`$ x$`、`$x $`、`$x$1` は数式にならない
  - `` $`…`$ `` は最初の `` `$ `` までを TeX として読む (中に markdown の記号を書くための GitHub の形)
- 別行立て: 1 行に収まる `$$…$$` (文の間でも、前後の文とは別の行に出す)、段落全体が `$$…$$` のもの (中の改行は可。空行は段落を終えるので途中に置けない)、言語が `math` のコードブロック
- 文と同じ段落で行をまたぐ `$$…$$` と、詰めた箇条書きの項目 (GitHub では段落を作らない) の中の行をまたぐ `$$…$$` は数式にしない。中身が空白だけのものも数式にしない
- `\$` は文字の `$`。inline code とコードブロックの中は対象外
- 数式の中身は markdown として読まない。前後の空白は除く (末尾の制御空白 `\ ` は残す)

読み方:

- 文中の数式は micromark の text の構成要素 (`math-syntax.ts`) として読む。数式は inline code と同じく 1 つの単位になるので、中の `*`・`_`・`~` が外で開いた強調や取り消し線を閉じることはない。inline code と文字の escape は先に取られるので、コードの中と `\$` は数式にならない。同じ位置から始まる記法では数式を先に取る
- 段落全体の `$$…$$` は、行をまたぐ `$$…$$` を段落の頭から始まり段落の終わりで閉じる時だけ 1 つの単位として読み、パースの後に段落の代わりのブロック (`math`) にする。詰めた箇条書きの中のものと、中身が空白だけのものは、パースの後に書かれた文字へ戻す
- 行をまたぐ `$$…$$` の中は micromark の inline code と同じ組み立て (区切り・中身・行の終わりを別の token) にする。行の終わりを中身と同じ token に入れると、段落の終わりで閉じた時に micromark の後処理が止まらなかった (実測)

描き方:

- Temml は `temml.render` で DOM として組み立て (MathML の名前空間付き)、それをその場で DOMPurify (MathML の profile) に通す。文字列 (`renderToString`) で受けて HTML として読み直すと、`mo` の中に置かれた MathML の要素が HTML の要素として読まれ、サニタイズで消えるため。サニタイズした DOM は文書に入れず、タグ・属性・文字の木にして、Preact の節点として描く (`math` の下の要素は Preact が MathML の名前空間で作る)。§1 の「DOM の文字列を HTML として入れない」はそのまま守れる
- Temml の option: `annotate: true` (TeX を annotation に残す)、`throwOnError: true`、`trust: false` (`\href`・`\url`・`\includegraphics`・`\class`・`\style`・`\id`・`\data` を断る)、`maxExpand: 1000` (マクロの暴走を止める)、`maxSize: [50, 600]` (`\rule`・`\raisebox` など利用者が書く大きさの上限。50em / 600pt)
- DOMPurify の profile が落とすもののうち、Temml が使うものだけを足す: `semantics` / `annotation` と `encoding` (TeX の原文。落とすと原文が数式の横に文字として出る)、`class` / `style` (Temml の CSS と、間隔・色・枠)、`form` (演算子の前後の間隔)、`span` (式番号を入れる `mtext` の中の要素)。`id` (`\label` から来る) は落とし、webui の要素の id と重ならないようにする
- 描けない数式 (記法の誤り、`trust: false` で断るもの、入れ子が深すぎるもの) は、TeX をコードの見た目で出し、「数式を描画できない: <Temml のエラー文の 1 行目>」を添える
- 自動の式番号 (`equation`・`align` など) は、1 つの markdown の文書 (吹き出し 1 つ、ファイル 1 つ) の頭から数えて文字で入れる。Temml の CSS は CSS の counter で数えるが、counter は吹き出しや折りたたみの containment で閉じ、全部 (1) になるため。`\ref` / `\eqref` は何も出さない
- 番号付きの環境の全幅の表を持つ `semantics` だけを全幅にする (annotation を付けると Chromium が `semantics` を内容の幅に縮め、番号が式の直後に寄る)。WebKit ではこれでも番号が式の直後に寄る (未対応)
- ```math のコードブロックは §12 の箱 (描画 / ソースのタブ) に入れる。描けない時はソースのまま理由を出す。`$$…$$` と文中の数式は箱に入れず、文の中・文の間に描く (行の中にも置ける `$$…$$` は箱に入れられず、数式の多い文で全部の数式に罫とタブが付くと重い)。数式は文字の色を継ぐので、箱の白い下地は画像 (SVG・mermaid) の時だけにする
- 配り方: Temml・DOMPurify・Temml の stylesheet は webui の本体の bundle に入れず、数式のある markdown が描かれた時だけ dynamic import で読む (`math-typeset.ts`)。シンタックスハイライトの文法と同じく Bun.build が別の chunk に分け、本体と同じ hash 付きの URL で配る (mermaid と違い 260KB ほどで、起動のたびのビルドに入れてよい大きさ)。読み込みはページで 1 回で、読み込む間は TeX をそのまま出す。読めなかった時は「数式の描画の部品を読み込めない」を出し、次に数式を描く時にもう一度読む
- Temml の stylesheet (`Temml-Local.css`) は全体を読み、数式の chunk が読まれた時に constructed stylesheet で文書に 1 回だけ足す。フォントは OS の数式フォントに任せ、`\mathscr` 用の `Temml.woff2` (約 9KB) だけを Bun.build の plugin (`temml-font-plugin.ts`) で data URL にして stylesheet に埋める
- 検索・選択・コピー (Chrome / WebKit で観測): annotation は描かれない (大きさ 0) が、文字の節点としては残るので、描画済みの文字を走査する画面内検索は TeX の原文にも当たる (当たっても見える印は付かない)。描かれた記号の文字 (`eiπ+1=0`) と TeX の原文が続けて並ぶので、記号と原文をまたぐ語にも当たりうる [保留]。数式を含めて選んでコピーした文字は、annotation を含まず、記号が 1 つずつ改行で区切られる (ブラウザの MathML のコピーの振る舞い)

### 15. 本文を書く欄に md | source の切り替えを置く [kawaz 経由]

kawaz 2026-11-25: 「コメント/プロンプト入力のフォームに md プレビューモードつけてほしい」。書いている本文が送った先でどう描かれるかを、送る前に見るため。

- 対象は本文を書く textarea の全部: 右下の入力欄 (`SessionInputComposer`)、コメントのフォーム (`CommentForm`)、未送信のコメントの「直す」(`CommentEdit`)、Status の新セッションの起動・再起動等の prompt (`StatusSessionForms`)、サイドバーの新規セッションの PROMPT (`SessionCreator`)
- 切り替えの部品は吹き出しの足元と同じ `BodyViewTabs` (md | source)。source が書く側 (textarea) で既定、md がプレビュー
- md | source の切り替えは、2 つの離れたボタンでなく、選択肢を隙間なく 1 つの枠に繋げた 1 つのボタン (合体ボタン) にする。外側の角だけが丸く、間は 1 本の縦線で仕切り、選ばれている方を塗る。外枠と仕切りは選ばれた区画の塗りと同じ色 (`--accent`) で描く (kawaz 2026-11-25: ボタンの色で描いた方が組としての一体感が分かりやすい。`.joined-buttons` に載る全部の組に効く)。形は 3 分割の送信のボタン ([DR-0062](./DR-0062-comments.md) §3) と同じ CSS の規則 (`.joined-buttons`) を共有し、字の大きさ・高さは今のまま。区画の横の決まりは 3 つ: 字と字の間隔は「仕切りの幅」(`--joined-divide`、1.5ch) だけで決め、隣り合う 2 つの区画が半分ずつ持つ (選ばれた区画の塗りが仕切りの線まで届く)。両端は角丸の分 (`--joined-radius`) だけ空ける。区画には最小の幅 (`--joined-min`、5ch) を置き、字を中央に寄せる。仕切りの幅と最小の幅は字の幅の単位で、繋がったボタンを大きく・小さく出しても字の大きさに付いて変わる (kawaz 2026-11-25: 数字を個別に詰めるのでなく、仕切りが間隔を受け持つ決まりにする。字の短い 3 分割の送信のボタンの余白は変えない)。吹き出しの足元でも本文を書く欄でも同じ部品で、足元で翻訳のタブと隣り合う時は 2 つの合体ボタンを間を空けて並べる ([DR-0049](./DR-0049-webui-plamo-translation-tab.md) §8) (kawaz 2026-11-25)
- 置き場 (kawaz 2026-11-25: 「ファイル添付のクリップが一番左、次が貼り付け、次が (md|source) です」): その欄の操作の行の左から、📎 (添付)、貼り付けのボタン (📋、[DR-0065](./DR-0065-paste-html-as-markdown.md) §8)、md | source の順。📎 の無い欄 (Status の起動と再起動・fork の prompt、新規セッションの PROMPT) は左から 📋、md | source。入力欄とコメントのフォームはこの 3 つが行の左の組で、「直す」は行の右寄せの並びの頭、Status の prompt は保存の左。新規セッションの PROMPT は欄のすぐ下の行に 📋 と md | source を並べる
- md は今の本文を、textarea と同じ場所・同じ大きさの箱に、送った後のユーザ発言の吹き出しと同じ markdown の描画 (`MarkdownView`、§6) で描く。コメントのフォームと「直す」のプレビューは送った後のコメントの吹き出しと、入力欄のプレビューは「後で」にした下書きの吹き出しとも同じ描画になる (§6)。段落の中の単独の改行も、吹き出しと同じ指定 (`white-space: pre-wrap`、app.css で `.tl-text` と同じ規則) で改行として見せる。本文が箱より長ければ箱の中でスクロールする。空の本文は空の箱
- 添付の `[FILE<N>]` は送る時と同じ `[FILE<N>:<名前>](<添付のパス>)` に置き換えてから描くので、添付の画像は吹き出しと同じく画像で、それ以外はリンクで出る。アップロードの終わっていない添付は打たれた文字のまま
- md の間は書けない。textarea は作り直さず見えなくするだけで (`visibility: hidden`、箱の大きさは残る)、中身・カーソル・選択・スクロールの位置・undo の履歴はそのまま残る。source に戻すと textarea にフォーカスを返し、続きから書ける
- md の間も、送る・後で・btw・閉じる・📎 は今までどおり押せる。送った後 (送れなかった時も)、閉じて開き直した後は source に戻る。選んだ表示は覚えない
- プレビューの箱は、パネルを掴んで動かす所に含めない (中でスクロールし、文字を選ぶため)

## Bundle size (実測、DR-0004 のビルドレス方針への影響評価)

`GET /assets/app.js` (createWebuiApp 経由、serve-time bundle) を導入前後で実測 [提案]:

| | raw (bytes) | gzip (bytes) |
|---|---:|---:|
| 導入前 | 124,060 | 32,913 |
| 導入後 | 453,389 | 74,630 |
| 差分 | +329,329 | +41,717 (**+40.7 KB gz**) |

委譲時点の見積もり「+22KB gz」に対し、実測は **約 1.85 倍の +40.7KB gz** だった [提案、確定事実として記録]。差分の主因は `@mizchi/markdown` の `js/api.js` が import する MoonBit コンパイル済みパーサー本体 (`_build/js/release/build/api/api.js`、未 minify で 456KB) で、シンタックスハイライト用の言語別サブモジュール (`highlight_typescript.js` 等、`./highlight/*` サブパス) は `markdown-view.tsx`/`CodeBlock.tsx` のどちらからも import していないため tree-shaking で含まれていないことを確認済み。gzip 後で +40.7KB という実測値は、DR-0008 §6 follow-up が評価した prismjs (+8.8KB gz) / highlight.js (+18.6KB gz) の代替候補と比べても大きいが、markdown パースという別種の機能を追加している比較なので単純比較はできない。次点候補 (`marked`) や不採用候補 (`micromark`/`snarkdown`) は mdast 標準 AST を返さないか XSS 対策が別途必要になるため、サイズ差だけで再検討する判断はしていない。

## Alternatives considered

- **`toHtml()`/`toHtmlLiteral()` を使い、結果を `dangerouslySetInnerHTML` で描画**: 不採用。`javascript:` URL を含む link/image がエスケープされずそのまま HTML 文字列に出力されることを実測確認済み ([kawaz 経由])。XSS を作り込むことになる
- **`marked` (次点候補)**: 不採用 [kawaz 経由]。標準 mdast を返さず、この walker 実装の「mdast → JSX」という設計方針にそのまま乗せられない
- **`micromark`/`snarkdown` (不採用候補)**: 不採用 [kawaz 経由]。`micromark` は低レベル tokenizer で mdast への変換を別途組む必要があり実装コストが高い。`snarkdown` は HTML 文字列を返す薄い実装で、`toHtml()` 系と同じ XSS リスクを抱える
- **ユーザ発言は打たれた文字のまま、URL・実在するパス・`[label](target)` だけをリンクにする**: 不採用 (kawaz 2026-11-25)。人が打った字を記法として消費しない利点はあるが、本文を書く欄のプレビュー (§15) で見えた形と送った後の吹き出しが食い違い、見出し・リスト・表・コードブロックを書いても読める形にならない (「ほぼ使えない」)。原文は source で読める
- **ユーザ発言だけ、段落の中の単独の改行を mdast の `break` にする**: 不採用。TL の本文は `white-space: pre-wrap` で改行が既に見えていて、`break` にすると描画済みの文字から改行が消え、TL の検索で前後の行の字が繋がる (§11)
- **画像を `<img src>` で自動表示**: 不採用 (DR-0008 §2 の「webui から到達できる = kawaz 本人」という trust boundary と同種の判断)。画像 URL のレンダリング即座フェッチは、閲覧者側 (kawaz) の IP/UA を任意の第三者へ漏らす経路になる

## Consequences

- assistant 発言が見出し・リスト・コードブロック・テーブル・リンク等を伴う読みやすい形で表示される
- bundle サイズが gzip で約 +40.7KB 増加する (webui は DR-0004 §4 の「ビルドレス方針」を維持しつつ、serve-time bundle 自体のサイズは増える)。将来 bundle サイズが問題になった場合、markdown レンダリングを遅延 import (dynamic `import()`) にする余地がある (本 DR ではスコープ外、Next steps に記載)
- `type:"html"` ノード・安全でない URL は情報を残したまま無害化されるため、悪意のある transcript 内容 (例: hook 経由で注入された markdown) が閲覧者のブラウザ上でコードを実行することはない

## Next steps

1. dogfood: 実際の assistant transcript (コードブロック・テーブル・リンクを含むもの) で表示を確認 (kawaz)
2. bundle サイズが実運用上問題になった場合、markdown レンダリングパスの dynamic import 化を検討 (未着手、DR 化は問題が顕在化してから)

## Addendum 2026-08-13 (kawaz): パーサを mdast-util-from-markdown へ差し替え — §上記の `@mizchi/markdown` 採用を supersede

`@mizchi/markdown` 0.6.5 に実バグ 7 種を実測確認した (リスト継続行が list を分断 —継続行が list 外へ脱出し後続 bullet が別 list になる / strong 内 inline 後のテキスト重複 / link reference 非対応 — definition が AST から消失 / inline HTML を link として誤生成 / ネスト emphasis 不発 / tab インデント非対応 — `\tcode` が先頭文字を食う /
position がコードポイント単位かつ入れ子でリセットされる破損)。週次 DL 42 の実質単独メンテでワークアラウンド蓄積のコストが上回るため、パーサのみ差し替える:

- **`mdast-util-from-markdown` + micromark/mdast の GFM 個別拡張 (table / strikethrough / task-list-item / autolink literal)** を採用。`parse(src): Root` の同型差し替えで、自前 JSX renderer (本 DR の本体) は無改修。比較調査の正本は`docs/findings/2026-08-13-markdown-parser-comparison.md`
- 本 DR 初版の micromark 不採用理由「mdast への変換を別途組むコストが高い」は実態と不一致だった (`mdast-util-from-markdown` が公式の mdast 変換)
- GFM の拡張は集約パッケージ (`mdast-util-gfm`) ではなく個別に登録し、使う構文だけを選ぶ。footnote は非搭載
- 地の文の裸の URL は §7 のとおりリンクにする。inline code の中身が丸ごと 1 つのリンク先として読める時 (link の行き先と同じ `classifyMarkdownLinkUrl` で許可された scheme の URL、空白なし) は、code の見た目のまま `<a>` で包む。scheme の無い綴り (`rows`、`docs/x.md`) は code のまま (ファイルパスはファイルの linker が daemon に確かめて判断する)
- ソース前処理 protect* は 4 → 1 に削減。残る `protectTagLikeAngleBrackets` は旧パーサのバグ回避ではなく CommonMark の HTML ブロックの貪欲さ (タグ形状行が後続を空行まで飲む) + no-raw-HTML ポリシーへの対策として存続
- サイズ実測: 実バンドル gzip +5.5KB (270.5 → 276.1KB)。§コスト節の +40.7KB gz はmizchi 導入時の値であり、本差し替え後の合計は上記が正
