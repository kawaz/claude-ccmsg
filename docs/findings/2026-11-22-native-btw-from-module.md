# Claude Code の `/btw` を module から使えるか、`$.model.fork` との比較 (実測)

- Date: 2026-11-22
- 対象: Claude Code 2.1.330 (対話、`--model haiku`)、ccmsg-v1 を読み込んだ個人面の config dir
- 動機: btw の fork (`claude -p --resume <sid> --fork-session ...`、DR-0060 / DR-0064) は transcript から組み直した会話が本体の送った会話と途中から違い、長いセッションで prompt cache が外れる ([findings 2026-11-22-btw-fork-cache-miss-opus-session](./2026-11-22-btw-fork-cache-miss-opus-session.md))。本体の組み込みの `/btw` を module から打たせて答えを拾えれば fork が要らない、という案を確かめた
- 方法:
  - リポの外の一時ディレクトリ (git init 済み) を cwd に、使い捨てのセッション (`--name "🤖ccmsg-verify-native-btw"`) を hyoui の端末で起こし、観測用の mod を `--plugin-dir` で読ませた。mod は `on('*')` で全 event を jsonl に書き (`command.run` / `classic.SubagentStop` / `http.fetch` / `ui.render` 等は `e` も)、外から書いた指示のファイルを読んで `$.command.run` / `$.model.fork` / `$.prompt.submit` を呼び、結果を同じ jsonl に書く
  - 最初の turn で合言葉を覚えさせ、btw の答えが本体の文脈を踏まえているかを合言葉で見た
  - usage は `--debug-file` の `Forked agent [<label>] finished: ... totalUsage: input=… output=… cacheRead=… cacheCreate=…` と、`$.model.fork` の結果の `usage` で読んだ。本体の usage は transcript の assistant の行
  - `/btw` の実装は Claude Code のバイナリに埋め込まれた JS を読んだ (`/btw` の command 定義、side question の関数、`$.model.fork` の実装)
  - 公式の docs: `code.claude.com/docs/en/interactive-mode` の「Side questions with /btw」

## 判明した事実

### 1. 組み込みの `/btw` の動き

| 項目 | 観測 | 根拠 |
|---|---|---|
| 種類 | `type: "local-jsx"`、`immediate: true` の command。答えは端末の overlay (panel) に出る | 実装 |
| 本体の文脈 | 踏まえる (合言葉を答えた) | 実測 |
| transcript | 質問も答えも書かれない (`/btw` の行も無い) | 実測 (transcript を grep) |
| prompt cache | 本体の最後の request の prefix を全部読む。本体の 1 turn 目 (read 13,176 + create 50,231) の後の `/btw` が read 63,407 / create 322 | 実測 (debug log) |
| 本体の応答中 | 打てる。本体が長い応答を stream している途中に composer から打ち、本体の turn と並んで答えた (read 71,745) | 実測。docs も「Available while Claude is working ... except the reply Claude is still writing」 |
| tool | 使えない (全 tool を deny、`maxTurns: 1`) | 実装、docs「No tool access」 |
| 続けて聞く | 同じ process の中の前の btw の組 (最新 20 件) を毎回会話の後ろに並べて送る。`x` で消すまで残り、process の終了で消える | 実装、docs |
| resume の直後 | 答える。本体がまだ 1 回も request を送っていなくても、system prompt を組み直して送り、cache もほぼ全部読んだ (read 74,475 / create 2,622) | 実測 |
| 取り消し | 答えの途中の Esc で `side question settled: cancelled` | 実測 |

- 実装の中身は `runForkedAgent` に本体の cache-safe な params (system prompt・tools・会話) を渡し、`skipTranscript: true` / `skipCacheWrite: true` / `querySource: "side_question"` で 1 回の completion をするもの。質問の前に「これは side question、本体は止まっていない、tool は無い」の system-reminder が付く
- panel を開いている間は panel がキー入力を取る。`c` は copy、`f` は「この質問と答えを tool 付きの background subagent に fork」、`x` は前の btw の組を消す、Space / Enter / Esc は閉じる。composer に打つつもりの文字が panel に入る (この実測では打った文の空白で panel が閉じた)

### 2. module から `/btw` を打てるか

| 口 | 結果 |
|---|---|
| `$.command.run({ command: "btw", args })` | 走る。端末に「Prompt from the nbtw-probe plugin」と `/btw <質問>` の行が出て、panel に答えが出る。transcript には書かれない |
| 同上を本体の turn の途中で | **turn の終わりまで待たされる** (debug `$.command.run (nbtw-probe): 52 chars queued`、panel が開いたのは turn の完了の直後)。型定義も「queued and run once the session is idle」 |
| `$.prompt.submit({ text: "/btw ..." })` | 拒否: `prompt.submit: submits a prompt to the model; a text beginning with / would run a command as the user; run one with $.command.run({ command }) (host check)` |
| composer に置いて端末から Enter (`$.prompt.fill` + hyoui の Enter) | 人が打つのと同じなので turn の途中でも走る (人が composer から打った形で確認。fill からの一巡は試していない) |

### 3. module が答えを拾えるか

- `$.command.run` の結果は答えを含まない。人が panel を閉じた時に `{}` で resolve する (実測 17.9 秒。閉じるまで resolve しない)。人の composer からの `/btw` を hook した `command.run` の `next(e)` も、panel を閉じた時に `{ ref: 1 }` で resolve し、答えを含まない
- 答えの文が出る event は **`classic.SubagentStop` の `last_assistant_message`** だけだった。欄は `agent_id` / `agent_type: ""` / `prompt_id` / `effort` / `agent_transcript_path` (ファイルは作られない) 等で、**質問の文も btw である印も無い**。`$.model.fork` も同じ形 (`agent_type: ""`) の `classic.SubagentStop` を出すので、btw と区別できない
- 取り消した時は `classic.SubagentStop` が出ない。`command.run` は閉じた時と同じ `{ ref: 1 }` で resolve する。完了と取り消しは「SubagentStop が来たか」でしか分けられない
- API error の時の event は未確認
- `ui.render` の component に btw の panel は出てこない (`UserMessage` に `/btw <質問>` の文が出るだけ)
- engine の request は `http.fetch` の op event を通り、hook から request の body が見える。応答の stream を hook から読めるかは試していない

### 4. `$.model.fork` (同じ仕組みを module から呼ぶ口)

`$.model.fork({ prompt, effort? })` は `/btw` と同じ `runForkedAgent` を、本体の main thread が最後に送った request の params で呼ぶ (`skipTranscript` / `skipCacheWrite`、tool は全部 deny、`maxTurns: 2`、`forkLabel: "plugin_model_fork"`)。結果は `{ isAnswered, text, usage, effort }` か `{ isAnswered: false, reason }`。

| 項目 | 観測 |
|---|---|
| 答え | 本体の文脈を踏まえる (合言葉を答えた)。結果の `text` に答えの全文が来る |
| 端末 | 何も出ない |
| transcript | 書かれない |
| prompt cache | 本体の prefix を全部読む。idle の時 read 63,729 / create 0、本体の turn の途中 read 74,452 / create 0。本体の次の request の cache も外れない (本体の read は伸び続けた) |
| 速さ | 0.8〜1.3 秒 (短い答え) |
| 本体の turn の途中 | すぐ走る (本体の turn の完了を待たない)。本体が書いている途中の応答は見えない |
| 同時に複数 | 2 件・3 件を同時に呼んで、どれも全部の cache を読んで答えた |
| effort | haiku (per-turn effort が効く model) で `low` / `high` / 指定なしの 3 件とも read 77,332 / create 4 |
| resume の直後 (本体が request を送る前) | `{ isAnswered: false, reason: "nothing-to-fork" }` |
| `/clear` の後 | `nothing-to-fork` |
| model | 本体の model で走る (選べない) |
| 取り消し | 呼び手から止める口が無い (引数に signal が無い)。`aborted` になるのは、fork を呼んだ hook の turn が中断された時 (型定義) |
| 逐次の表示 | 無い。終わってから全文が返る |

- **turn の途中の fork は、本体がいま答えている人の発言の後ろに質問が並ぶ**。前置き無しの質問 (「合言葉は?」) では、答えの後に本体の作業 (1 から順に数える) を続けて 3,817 token 書いた (2 回の応答)。ccmsg の btw の前置き (`BTW_PROMPT_PREFIX`) を付けると質問にだけ答えた (1 回の応答、8 token)。ただし「本体はいま何をしているか」には「完了して待機中」と答え、turn の途中であることは分かっていなかった
- 組み込みの `/btw` の前置きは「本体は止まっていない、独立に作業を続けている」と伝える。ccmsg の前置きにはこの文が無い

## 置き換えの可否

### 組み込みの `/btw` を module から打つ形: 採れない

1. turn の途中で聞けない。`$.command.run` は idle まで待つ。turn の途中で打てるのは composer からだけで、それは人の入力の口 (fill と端末の Enter) を btw に使うことになる
2. 答えを確実に拾えない。答えは `classic.SubagentStop` にしか出ず、質問との対応も btw である印も無い。`$.model.fork` や他の fork の SubagentStop と混ざる
3. 端末の人を邪魔する。panel が開くとキー入力を取り、人が composer に打った文字が copy / fork / 履歴の消去 / 閉じる として働く。`$.command.run` は人が panel を閉じるまで resolve しない
4. btw 同士の文脈が混ざる。組み込みの `/btw` は同じ process の前の btw の組を毎回並べる。DR-0062 §14 の「まとめて聞かない (btw 同士の文脈が混ざるため)」と逆で、端末で人が打った `/btw` とも混ざる
5. tool が使えない (下の `$.model.fork` と同じ)

### `$.model.fork` に置き換える形: 成り立つが、tool を手放すかの判断が要る

得るもの:

- cache の外れが無くなる。fork が本体の最後の request をそのまま使うので、transcript からの組み直し (tool_use の `input` の形、ToolSearch の結果の block、model の綴り) の差が起きない
- turn の途中でもすぐ答える。同時に複数走る
- 起動の仕組みが要らない (起動コマンドの print の起動、`sessions/<pid>.json` の行、SESSIONS の `Non-interactive`、fork の中の module・hook)
- 1 秒前後で答える

失うもの・新しく要るもの:

- **tool が使えない**。DR-0060 の「btw で一発指示して修正させる使い方」(kawaz 2026-11-22) ができなくなる。組み込みの `/btw` も同じ制約で、docs は tool が要る時は fork (background subagent) を勧めている
- 逐次の表示 (DR-0060 §5) が無くなる。答えは終わってから一度に来る
- 取り消し (`btw_cancel` / DR-0062 の `comment_btw_cancel`) ができない
- 本体が 1 回も request を送っていない間 (resume の直後、`/clear` の後) は `nothing-to-fork` で答えられない
- model は本体のもの。effort は選べ、per-turn effort の効く model では cache を保つ (per-turn effort の効かない model での効き方は型定義の remarks のとおりで、この実測では確かめていない)
- daemon から module に聞いてもらい、答えを daemon に返す口が要る (今の btw は daemon が process を起こすので module を通らない)
- 前置きに「本体は止まっていない、turn の途中なら本体はまだ答えを書いている」旨を足す必要がある (turn の途中の fork が本体の作業を続けた件)
- module の無いセッションでは btw ができない (fallback は作らない方針と合う)

### DR-0062 段階 5 との関係

段階 5 は DR-0060 の「btw コマンドと標準入力・標準出力の契約、stream-json の読み方」を変えずに使う前提で、記録・保存・配り方をコメントに寄せる。`$.model.fork` に替えると、変えないとしていた部分 (起こし方、逐次の読み方、`status` の `canceled`、`tool` の欄) が変わる。答えの記録 (`author: "btw"`) と送った時点 (`sent.after_uuid`) の作りはそのまま使える。`$.model.fork` の fork は本体の最後の request を基にするので、「少なくともこの行までは見て答えた」位置は daemon が聞いた時点の transcript の末尾でなく、本体の最後の request の会話の末尾になる (turn の途中では、人の発言までで本体の書きかけの応答を含まない)。

## 未確認

- `$.prompt.fill` + 端末の Enter で `/btw` を打った一巡 (人が composer から打った形だけ確かめた)
- 組み込みの `/btw` が API error で終わった時の event
- `http.fetch` の hook から応答の stream を読めるか (`$.model.fork` の逐次の表示に使えるか)
- per-turn effort の効かない model (本体が別名で走るセッション) での `$.model.fork` の effort 指定と cache
- 長い Opus のセッション (findings 2026-11-22-btw-fork-cache-miss-opus-session の S のような) での `$.model.fork` の cache。今回は haiku の短いセッションだけ
- docs の「press `f` to fork ... into a background subagent」の fork が、答えを本体の会話に入れるか (tool の要る btw の代わりになるか)
