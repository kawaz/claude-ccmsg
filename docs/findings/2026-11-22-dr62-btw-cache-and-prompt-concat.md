# 対話のセッションからの btw の fork の cache と、turn の最中に続けて送ったプロンプトの届き方 (実測)

- Date: 2026-11-22
- 対象: Claude Code 2.1.330、ccmsg の daemon 0.310.0 (計測の途中で 0.311.0 に替わり、btw の 2 件は `btw_end:` の行の token の数で読んだ)
- 動機: [DR-0062](../decisions/DR-0062-comments.md) (提案) の「受理の前に測ること」の 1 と 2。1 は btw の fork ([DR-0060](../decisions/DR-0060-btw-mode.md)) が対話のセッションの prompt cache を読めるか (ccmsg の tool は対話のセッションにだけ登録され、`-p` の fork には無い)。2 は人の入力 (op `user_prompt`、[DR-0035](../decisions/DR-0035-user-input-via-composer-fill.md)) を turn の最中に続けて送った時に、transcript の人の行が連結されるか。あわせて、送った文が transcript の人の行にどう書かれるか (文の書き換え) を見た (FAB の「届いたか分からない」を transcript の照合で消す直しの、照合の正規化の根拠)
- 方法: ccmsg の launch で使い捨ての対話のセッションを 2 つ起こした。cwd はこのリポの jj workspace (中身は main と同じ、起動コマンドが信頼するパスの下にしか起こせないため)。セッション A は `sonnet` / effort `low`、セッション B は `haiku` / effort `low`。どちらも ccmsg の plugin が載り、ccmsg の tool は deferred。人の入力は、user role で daemon の `/ws` に hello する小さいスクリプトから op `user_prompt` を送った (webui の FAB と同じ経路)。transcript の行は `tail -F` に受信の時刻を付けて記録した。btw の fork は、同梱の組み込みの btw コマンド (`default-btw-command.sh`) に daemon と同じ形の入力 (`BtwCommandInputSchema`、prompt は `btwPrompt`) を標準入力で渡して自分で走らせ、標準出力の stream-json の `result` の `usage` を読んだ (daemon は 0.310.0 では usage を出さなかったため)。daemon の op `btw_ask` でも 2 回 (A と B に 1 回ずつ) 走らせ、同じ数になることを確かめた。fork の request の中身の比較には、Claude Code が transcript に書く `api-request` / `api-request-shape` / `api-request-blob` の行を使い、そのために btw コマンドから `--no-session-persistence` だけを外した診断の fork も走らせた
- 下の「total」は、その request の `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。「read」は `cache_read_input_tokens`、「create」は `cache_creation_input_tokens`

## 判明した事実

### 1. btw の fork の cache

#### 結果の表

| # | 元 | 状態 | fork に渡した model | fork の直前の元の request の total | fork の read / create |
|---|---|---|---|---|---|
| A-a | A | ccmsg の tool 未ロード、履歴に thinking が 1 つ | `sonnet[1m]` | 84,547 | 15,396 / 69,815 |
| A-a2 | A | A-a の直後にもう 1 件 | `sonnet[1m]` | 84,547 | 84,488 / 725 |
| A-b | A | ToolSearch で ccmsg の say / send を読み込んだ後 | `sonnet[1m]` | 84,960 | 84,488 / 1,230 |
| A-m | A | A-b と同じ | `claude-sonnet-5-5[1m]` | 84,960 | 84,958 / 897 |
| A-d | A (daemon の `btw_ask`) | A-b と同じ | `sonnet[1m]` (daemon が渡した値) | 84,960 | 15,396 / 70,322 |
| B-a | B | ccmsg の tool 未ロード、thinking 無し | `claude-haiku-5-5` | 66,523 | 66,519 / 715 |
| B-b | B | ToolSearch で ccmsg の say / send を読み込んだ後 | `claude-haiku-5-5` | 66,979 | 66,975 / 819 |
| B-c | B | thinking のある turn の後にもう 1 turn | `claude-haiku-5-5` | 67,896 | 67,892 / 819 |
| B-e | B | thinking + tool_use の応答の stream 中に人の入力が待ちに入り、turn の途中で取り込まれた後 | `claude-haiku-5-5` | 68,410 | 68,406 / 1,074 |
| B-d | B (daemon の `btw_ask`) | B-e と同じ (元の最後の request から約 7 分後) | `claude-haiku-5-5` (daemon が渡した値) | 68,410 | 68,406 / 1,074 |

- **B では、どの状態でも fork は元のセッションの cache をほぼ全部読んだ** (read が元の total から 4 少ないだけ)。ccmsg の tool が未ロードでも読み込み後でも、thinking のある turn の後でも、turn の途中で人の入力を取り込んだ後でも同じ
- **A で `sonnet[1m]` を渡した fork は 15,396 しか読まず、約 7 万を書き直した** (A-a、A-d)。費用は 1 回 約 0.44 USD (sonnet、5 分の cache の書き込み)。daemon の `btw_ask` は model に `sonnet[1m]` を渡し (daemon.log の `btw_ask:` の行)、同じ数になった
- **同じ A の同じ状態で `claude-sonnet-5-5[1m]` を渡すと、ほぼ全部読んだ** (A-m: 84,958 / 元の 84,960)
- A-a2・A-b の 84,488 は、元のセッションの cache ではなく、その少し前の fork (A-a) が書いた cache の読み (fork の書いた cache は 5 分。2 件目からは fork 同士で当たる)。元のセッションの cache は 1 時間で書かれていて、B-d は元の最後の request から約 7 分後 (fork 同士の 5 分の cache は切れた後) でも全部読んだ

#### tools 列の違い (ccmsg の tool が fork に無いこと) は cache を切らない

- fork の `system` + `tools` の形 (`api-request-shape` の `shapeHash`) は、どの fork でも、その時点の元のセッションと一致した
  - 未ロードの間: 元も fork も、tools は組み込みの tool と `DeferredToolPlaceholder` と常時の MCP の tool。ccmsg の tool の名前は deferred の一覧の添付 (`attachment.type: "deferred_tools_delta"`) として会話の中にあり、fork は履歴を同じ文で送る
  - ToolSearch で読み込んだ後: 元の `tools` に `mcp__ccmsg-v1__say` / `send` が加わる (形が変わる)。fork の形も同じに変わった。fork の init の tool の一覧 (`system` / `init` の `tools`) には ccmsg の tool が無いのに、request の形には読み込んだ ccmsg の tool が入っていた
  - 読み込みで元の形が変わった直後の元の request も 84,625 を読んでいて (total 84,960)、元のセッション自身の cache も切れなかった
- fork は会話の末尾 (新しい質問の後) に system の 1 件を足す: 「`# Environment update` / Additional working directories removed: (セッションの一時ディレクトリ)」と「The following deferred tools are no longer available. Do not search for them — ToolSearch will return no match: mcp__ccmsg-v1__launch, …」。末尾なので、その前の前方一致は切らない
- 対話のセッションは起動コマンドの `--add-dir` (セッションの一時ディレクトリ) を持ち、btw コマンドは持たない。この違いも上の末尾の 1 件になるだけで、会話の先頭の環境の節 (Additional working directories の一覧を含む) は元の文のまま送られた

#### `sonnet[1m]` の fork で切れた場所

- `sonnet[1m]` の fork の stderr に毎回 `[claude-code:unrecognized_model] {"model":"sonnet[1m]","query_source":"sdk"}` が出た (`claude-sonnet-5-5[1m]` と `claude-haiku-5-5` では出ない)。元の対話のセッションは同じ綴り (`requestedModel: "sonnet[1m]"`) で動いていて、この行は出ていない
- `api-request` の行から組み立てた message の並び (元 47 件、fork 50 件) を比べると、違うのは 1 か所 (17 番目) だけで、それは履歴の中で唯一 thinking を持つ応答 (thinking + tool_use) だった。fork の request の 17 番目は `tool_use` 1 つだけで、thinking が無い。`claude-sonnet-5-5[1m]` の fork では 17 番目が元と一致した
- 切れた場所が末尾から約 30 件前だったので、fork の cache の区切り (末尾の近く) からは手前の元の cache の区切りに届かず、read は `system` の区切りまで (15,396) になったと読む (区切りの位置は `api-request` の `cacheControl` で見た。15,396 が tools + system だけの量であることの直接の確認はしていない)
- B (`claude-haiku-5-5`) では thinking を持つ応答が 4 つあり、どれも fork で元と一致した

### 2. turn の最中に続けて送ったプロンプト

どの状態でも、続けて送った 2 件 (どちらも `user_prompt` の結果は `accepted`) は transcript で **連結されず、1 件 1 行** になった。違うのは行の種類と書かれる時機。

| 送った時 | Enter の時 (module が Enter した直後) | 届いた時 | 人の行の形 | 行の `timestamp` | model への渡り方 |
|---|---|---|---|---|---|
| 待機中 | (待ちに入らない) | すぐ | `type: "user"`、`promptSource: "typed"`、`origin.kind: "human"`、`message.content` は文字列 | Enter の時 | 新しい turn の user message |
| tool の実行中 | `type: "queue-operation"`、`operation: "enqueue"`、`content` は文 (1 件ずつ) | tool の結果の直後に、同じ turn の中で | `type: "attachment"`、`attachment.type: "queued_command"`、`attachment.prompt` は文、`origin.kind: "human"`、`commandMode: "prompt"`。続けて `queue-operation` の `remove` (`reason: "absorbed_mid_turn"`)。`type: "user"` の行は出ない | enqueue の時 (書かれるのは tool の結果の後) | tool_result と同じ user message の中の、1 件ずつ別の text block (「The user sent a new message while you were working:\n<文>\n\nThis is how Claude Code surfaces …」) |
| 応答の文の stream 中 | 同上 (enqueue) | turn の終わり (`turn_duration` の後) に `dequeue` が 2 つ | `type: "user"`、`promptSource: "queued"`、`origin.kind: "human"` が 1 件ずつ、新しい 1 つの turn に入る | dequeue の時 (Enter の時ではない) | 1 つの user message の 2 つの text block。前の block の末尾に `\n` が足される |

- 観測した回数: tool の実行中 3 回 (2 件、3 件、3 件)、応答の文の stream 中 3 回 (2 件、2 件、3 件)。ほかに tool を呼ぶ応答 (thinking + tool_use) の stream 中に送ったものが 2 回 (A で 2 件、B で 1 件) あり、どちらも tool の実行中と同じ `queued_command` の形になった (応答が tool_use で終わり、tool の結果の後に取り込まれる)
- どの場合も model は 1 つの応答で両方に答えた (「了解A\n\n了解B」)。transcript の行は別々でも、model には同じ turn・同じ user message に並んで届く
- `@<パス>` を含む prompt は、stream 中の待ちでは前の 2 件とまとめられず、次の turn に 1 件で入った (3 件送って、2 件の turn と 1 件の turn)。その行には `attachment.type: "already_read_file"` の添付が付いた
- `queue-operation` の行は `uuid` / `parentUuid` を持たない ([2026-10-09-transcript-line-readers](./2026-10-09-transcript-line-readers.md) と同じ)

### 3. 文の書き換え

送った文と transcript の文 (待機中は `message.content`、tool の実行中は `attachment.prompt`、stream 中は `message.content`。どれも文字列)。

| 送った文 | 待機中 | turn の最中 (tool の実行中・stream 中とも) |
|---|---|---|
| 先頭に空白 3 つ | そのまま残る | 落ちる |
| 末尾に空白 2 つと改行 2 つ | 落ちる | 落ちる |
| 複数行 (空行、行頭の空白、タブを含む) | そのまま | そのまま (2 行目以降の行頭の空白も残る) |
| 約 2,900 字・61 行 | 畳まれず全文が一致 (`[Pasted text …]` にならない) | 同じ |
| `[FILE1:x.txt](/tmp/…)` | そのまま | そのまま |
| `@/tmp/…` | 文はそのまま。別に `attachment.type: "file"` の行が付き、ファイルの中身が読まれて model に渡る | 文はそのまま。tool の実行中は添付の行が無く、stream 中は `already_read_file` の行が付いた |

- 待機中は末尾だけを落とす (trimEnd)。turn の最中は両端を落とす (trim)。中の改行・空行・タブ・行頭の空白は変えない
- `queue-operation` の enqueue の `content` も、両端を落とした文
- **先頭に空白のある文を turn の最中に送ると、`user_prompt` の結果が `unconfirmed` (約 3 秒) になった** (3 回中 3 回。文は届いていて、待機中に送った先頭の空白の文は `accepted`)。module の `samePrompt` (`hooks/prompt-send.ts`) は submit された文が入れた文と同じか、入れた文の trimEnd と同じ時だけを同じとみなす。turn の最中の submit の文は両端が落ちているので一致しない、と読む (module の側の記録は見ていない)
- 末尾だけに空白のある文、複数行の文、長い文、リンクを含む文は、turn の最中でも `accepted`

## 分かっていないこと

- `sonnet[1m]` を `-p` に渡すと履歴の thinking が送られない理由。観測は「unrecognized_model の行が出る綴りで thinking が落ち、出ない綴りでは落ちない」の相関 (sonnet で 1 セッション、haiku で 1 セッション)。`opus[1m]` / `fable[1m]` など他の `[1m]` 付きの別名でも同じかは測っていない (unrecognized_model の行は、resume する会話が無くて終わる起動では出ず、model の request を伴う起動でしか確かめられない)
- 綴りを変えた時に 1M の context が保たれるか (`claude-sonnet-5-5[1m]` の fork の `modelUsage` の `contextWindow` は見ていない)
- `api-request-blob` の `hash` は文以外も含むらしい。A-m の fork の 1 番目の message は元と文が一字一句同じで hash が違ったが、read は全部だった。hash の一致・不一致は「request の文の一致」の確かな代わりにはならない (上の 17 番目の判定は、hash に加えて fork の blob の中身 (`tool_use` 1 つ) と read の数で読んだ)
- `queued_command` の行が tool の実行中の待ちだけで出るのか、他の割り込み (subagent の実行中、permission の確認中) でどうなるか
- B-d で daemon が fork に渡した effort は `xhigh` だった (B は effort `low` で起動し、人の入力 3 件に一回限りの effort `high` / `max` を付けた)。daemon がどこからこの値を読んだかは調べていない
