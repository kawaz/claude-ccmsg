# DR-0010: Timeline アシスタント発言の Markdown レンダリング

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

- 改行のタグ `<br>` (kawaz 2026-11-20)。表のセルに 2 つ以上の要素を入れる時に `<br>` で行を分ける書き方のため。`<br>` / `<br/>` / `<br />` を大文字小文字を問わず認め、属性が付いたものは文字のまま出す。地の文 (段落・見出し・表のセル・強調やリンクの文言の中) のものを mdast の `break` (CommonMark の強制改行と同じノード) にして、強制改行と同じ `<br>` の要素で描く。コードの中 (inline code、コードフェンス) のもの、`&lt;br&gt;` と実体参照で書いたもの、`\<br>` と前にバックスラッシュを置いたものは文字のまま。パーサの前の `protectTagLikeAngleBrackets` が `<br>` に専用の印を付け、パース後に `text` ノードの中の印だけを `break` に分ける (`splitLineBreakTags`)。`<details>` の折りたたみが段落を行に分けて組み直す時も、`break` で終わった行の後には `break` を戻す (`"\n"` にすると改行の要素が消える)。生の HTML をパーサに通して許可リストで選ぶ方式は取らない: 行頭の `<br>` が CommonMark の HTML ブロックとして後続の行を空行まで飲み込むため。`MarkdownView` (Files の markdown プレビュー、Timeline のバブル、InlineFileViewer、カタログ、permit の本文) の全部に効く。ユーザ発言の描画 (§6) は markdown として読まないので対象外

- `<details>` / `<summary>` の折りたたみ (`foldDetailsBlocks`)
- 文書の中の場所に名前を付ける空のアンカー `<a id="…"></a>` / `<a name="…"></a>` (kawaz 2026-11-10)。属性が `id` か `name` の 1 つだけで、タグの間が空のものに限る (`DOCUMENT_ANCHOR_RE`)。その位置に `id` だけを持つ空の要素を描き、タグの文字は出さない。見出しの中に書けば目次の文字にも出ない。`…/files?path=…#<id>` でその位置へ飛べる (hash の扱いは [webui-url-grammar](../design/webui-url-grammar.md))。これをするのは Files の markdown プレビューだけで (1 つの文書だけが画面にある)、Timeline のバブルではタグの文字のままにする (バブルごとに別の文書なので、同じ id が画面に 2 つ出うる)。コードの中 (inline code、コードフェンス) のものは書いたとおりに出す

### 4. コードフェンスは `CodeBlock` コンポーネントに委譲、fence の info-string を拡張子とみなして既存の `detectLanguage` テーブルへ通す [提案]

`packages/webui/src/client/components/CodeBlock.tsx` を新規実装。FileViewer.tsx と同じ「非同期 tokenize、完了まではプレーン表示」パターンを再利用する。fence の `lang` (例: `ts`, `py`) を検出済み拡張子マップにそのまま通す (`detectLanguage("_.${lang}")`) ことで、`EXTENSION_LANGUAGE_MAP` (highlight.ts) を二重管理せずに済む。未対応言語は plain フォールバック。

### 5. 画像は URL を自動フェッチせず、alt + リンク表示に留める [kawaz 経由]

markdown の画像 (`![alt](url)`) の URL からは `<img src=...>` を生成しない。安全な URL であれば alt テキストとその URL への `<a>` リンクとして表示し、ユーザが明示的にクリックした場合のみ画像へ到達する。理由: markdown 本文にリモート画像 URL を埋め込むだけで、レンダリングした瞬間に閲覧者の IP/UA が任意の第三者サーバへ到達する情報漏洩ベクタになり、この webui の CSP 制御範囲外の挙動になる。

### 6. Markdown レンダリングはアシスタント発言のみ、ユーザ発言はプレーンテキストのまま [提案]

`SegmentView` で `segment.role === "assistant"` の場合のみ `MarkdownView` を通す。ユーザ発言は人間が実際にタイプした生テキストであり、markdown 構文として解釈すべき対象ではない (かつ既存のチャットバブルスタイル `tl-text-user` は維持する)。

ただしユーザ発言でも、裸の URL と実在する絶対パスはアシスタント発言と同じ規則でリンクにする (`renderPlainTextWithLinks`)。文字は 1 つも記法として消費せず、打たれたとおりに出したうえで href だけを付ける。URL は下記 §7 の GFM autolink literal の規則を markdown パーサを通さずにテキストへ直接当てて見つけ、パスは §8 と同じ linker で実在確認する。

markdown の記法のうち `[label](target)` だけはユーザ発言でも読む。添付をこの app 自身が `[FILE1:name](<添付のパス>)` の形で発言へ埋め込むため。target が http(s) の URL・添付 (daemon の添付配信経路で開き、ファイルの許可判定は通さない)・§8 の linker が実在を確かめた絶対パス / `~/` パスのどれかの時だけ label のリンクにし、それ以外 (相対パス、確かめられないパス、`![alt](url)`、素の `[x]`) は打たれた文字のまま出す。リンクの描画は markdown 本文の `link` と同じ処理なので、画像の添付は本文と同じく画像として出る。

ユーザ発言の吹き出しの足元にも assistant と同じ md / source の切り替えを置く (kawaz 2026-11-20)。md は上の描画 (打たれた文字のまま、URL・実在するパス・`[label](target)` だけをリンクにする) で、markdown の記法は解釈しない。source は打たれた文字そのもの (リンクも付けない、コピペ用の `tl-bubble-source`)。md の側を markdown の描画に替えないのは、この節の理由 (人が打った文字を記法として消費しない) が足元の切り替えを置いても変わらないため。2 つの違いは、リンク (添付の画像を含む) を付けるかどうかと、選んで写した時に label でなく target の文字まで写るかどうか。翻訳のタブで訳文を選んでいる間は、assistant の source と同じく訳文の文字を出す。

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

- ボタンはコードの左上の真上に、コードに重ねずに置く (ボタンの下端 = コードの上端、左端 = コードの左端)。コードに重ねると下の文字が隠れ、`pre` の中に置くとスクロールで内容と一緒に流れる。コードを包む要素 (fence 等は `div`、inline code は文の組みを変えない `span`) を基準にした絶対配置で、行をまたいで折り返した inline code でも 1 行目の始まりを指す
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

言語が `svg` (大文字小文字を問わない) のコードブロックは、中身を data URL にした `<img>` で図として描く (kawaz 2026-11-22)。エージェントに「図で説明して」と頼めるようにするため。Timeline の吹き出しと Files の markdown プレビューの両方 (`MarkdownView` を通る全部) に効く。ユーザ発言 (§6) はコードフェンスを markdown として読まないので対象外。

- **img にする理由 (安全)**: SVG を文書に直に入れる (inline `<svg>`、`innerHTML`) と、`<script>`・`onload` 等のイベント属性・`<foreignObject>` の HTML・外部の画像や CSS の参照がこの webui の文書の中で動く。img として読ませた SVG は、ブラウザが script を動かさず外部の資源も読まない (secure static mode。Chrome / WebKit で実測、`<script>` の fetch・`onload`・`<style>` の `@import`・`<image href>`・`<foreignObject>` の中の `<img>` のどれも要求を出さず、図は描かれた)。応答に第三者の入力 (読んだ web ページ、tool の出力) が写っていても、webui の文書には何も入らず、外へも何も取りに行かない。§5 の「描いた瞬間に第三者へ到達しない」もそのまま守れる (data URL の中身は応答の文字そのもの)。`<iframe sandbox>` も考えたが、大きさを中身に合わせる仕組みが要り、図 1 つのためには重い
- **data URL**: `data:image/svg+xml;charset=utf-8,` に中身を `encodeURIComponent` したもの。base64 にしない (中身は UTF-8 の文字で、`btoa` は Latin-1 しか受けず、英数字の多い SVG では percent-encode の方が短い)。`charset=utf-8` は percent-encode したバイト列が UTF-8 であることを XML の読み手に伝える
- **`xmlns` の補い**: img は SVG を XML として読むので、根の `<svg>` に `xmlns="http://www.w3.org/2000/svg"` が無いと SVG の要素にならず壊れた画像になる。HTML に直に書く `<svg>` は省けるので書き手は省きがちで、根が名前空間を持たない `<svg>` の時だけ最初の `<svg` の直後に足す (Chrome / WebKit で実測、足さないと壊れた画像になる)。他の修復はしない
- **箱と切り替え**: 罫で囲んだ 1 つの箱に、上から「描画 / ソース」のタブ、図かソースを置く。既定は描画で、ソースはハイライトしたコード (`xml` の文法を持たないので `html` の文法で読む)。タブは Timeline の小さなタブ (`.tl-thinking-tab`、`Tabs`) で、切り替えの状態はブロックごとで保存しない。§10 のコピーボタンは箱を包んで 1 つだけ付け (箱の左上の真上、箱の外に出るのでタブと重ならない)、写すのはソース
- **描画できない中身**: XML として壊れている、根が SVG でない等で img の読み込みが失敗したら (img の `error` の event)、ソースに切り替え、描画のタブを押せなくし、タブの下に「この SVG は描画できないのでソースを表示している」と出す。中身が替われば描画をもう一度試す
- **種類の足し方**: 言語ごとの描き分けは `CodeFence` の 1 か所で、図にする種類はそこに 1 行足す。図の箱 (`SvgFigure`) は図にする SVG とタブに出すソースを別に受け取るので、ソースが SVG でない種類 (記法から SVG を作るもの) も同じ箱と同じ経路 (img の data URL、描画 / ソース、白の下地) で出せる
- **alt**: 根の `<title>` の文字。無ければ「SVG の図」
- **大きさ**: 箱の幅を超えない (`max-width: 100%`)。根の `<svg>` が長さの `width` を持たない図 (viewBox だけ、`width="100%"`) は img としての大きさが無く、枠いっぱいに伸びたり 300×150 に縮んだりするので、幅を 30rem にし、高さは縦横比から決まる (添付の画像のリンクの 20rem より一回り大きい)
- **白い下地**: img として読んだ SVG は文書の色を継がず、色を書かない図形と文字は黒、地は透明になる。書き手は白い紙の上に描くつもりで書くので、図はテーマによらず白い下地 (余白付き) に置く (dark の面にそのまま置くと黒い線と文字が消える)
- **検索・選択・コピー**: タブの文字は §10 のボタンと同じく CSS の `content` で出し、DOM のテキストにしない (画面内検索に当たらず、本文を選んでコピーした文字にも混ざらない)。描画の間、SVG の文字は DOM に無いので、Timeline の検索で発言が当たってもその中の文字には印が付かない (ソースに切り替えれば付く)。§9 の選択の閉じ込めはソースの表示では他のコードと同じ。§11 の改行は前後の段落が持つので、図の前後の文字は検索で繋がらない

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
