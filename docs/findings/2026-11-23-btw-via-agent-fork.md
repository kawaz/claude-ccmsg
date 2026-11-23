# btw を mod から起こす「tool を持つ fork の subagent」で作れるか (実測)

- Date: 2026-11-23
- 対象: Claude Code 2.1.330 (対話、`--model haiku` = claude-haiku-5-5、auto mode)、個人面の config dir (ccmsg-v1 と context-notify は `--settings` の `enabledPlugins` で外した)
- 動機: 今の btw (別プロセスの `claude -p --resume … --fork-session`) は長いセッションで prompt cache が外れる ([findings 2026-11-22-btw-fork-cache-miss-opus-session](./2026-11-22-btw-fork-cache-miss-opus-session.md))。`$.model.fork` は cache を全部読むが tool を使えない ([findings 2026-11-22-native-btw-from-module](./2026-11-22-native-btw-from-module.md) §4)。kawaz の案 (2026-11-23): mod が本体の会話を引き継いだ fork の subagent (tool あり) を起こし、終わりの知らせが本体の会話に入る前に mod が握りつぶし、答えの文を daemon に送る
- 方法:
  - 信頼済みの cwd の pool の 1 つ (空の git repo に `note.txt` と `edit-me.txt` を置いた) で、使い捨てのセッション (`--name "🤖ccmsg-verify-agent-fork"`) を専用 socket の tmux で起こした。継いだ環境変数 (`CLAUDE_CODE_*`、`CLAUDECODE`、`HYOUI_SESSION_ID` 等) は外し、`--allowedTools "Read,Edit,Write,Bash(pwd)"`
  - 観測用の mod (`afork-probe`) を `--plugin-dir` で読ませた。`on('*')` で全 event を jsonl に書き (主な event は `e` と結果も)、外から書いた指示のファイル (1 行 1 指示) を読んで `$.agent.spawn` / `$.agent.call` / `$.session.messages` / `$.agent.list` / `$.agent.limits` を呼ぶ。`agent.report` の hook で `{ consumed }`、`prompt.submit` の hook で task-notification の `{ drop }` を切り替えられるようにした。自分の `$.agent.spawn` は自分の hook に現れないので、resume 以降は `agent.spawn` を書くだけの 2 つ目の mod (`afork-watch`) も読ませた
  - 最初の turn で合言葉を覚えさせ、何往復かしてから測った。usage は本体と subagent の transcript (`subagents/agent-<id>.jsonl`) の assistant の行、知らせの経路は全 event の記録と `--debug-file` で見た
  - API は 2.1.330 の型定義 (mod を読み込んだ時に engine が mod のフォルダに書く `.claude-plugin/types/`) を読んだ。リポの `.claude-plugin/types/` は 2.1.322 のもので、`subagentType: "fork"` の明記、`agent.report`、`$.agent.call`、`$.agent.limits`、`AgentSpawnArgs.parentAgentId` が無い

## 判明した事実

### 1. mod から fork を起こせる

| 項目 | 観測 | 根拠 |
|---|---|---|
| 起こし方 | `$.agent.spawn({ subagentType: "fork", prompt, description })` が通り、49ms で `{ model, agentId }` が返る | 実測。型定義 2.1.330 の `$.agent.spawn` の例にも `subagentType: "fork"` |
| 本体の会話 | 知っている (合言葉を答えた) | 実測 (fork 10 件以上) |
| `subagentType` 省略 / `"general-purpose"` | 本体の会話を知らない (UNKNOWN と答えた)。省略は `general-purpose` として起きる | 実測 (`agent.report` の `subagentType`) |
| `agent.spawn` の欄 | `subagentType: "fork"`、`fork: true`、`background: true`、`permissionMode: "auto"`、`tool_use_id: "toolu_plugin_…"` | 2 つ目の mod で観測 |
| tool | Read (`note.txt`)、Bash (`pwd`)、Edit (`edit-me.txt` の書き換え) を使えた。本体の auto mode を継ぎ、classifier が fork の tool を判定する | 実測 |
| model | 本体のもの。`model: "sonnet"` を渡しても `agent.spawn` の `model` は消えて本体の model で走った | 実測。型定義「Ignored for forks, which always inherit」 |
| effort | 本体のもの (`classic.SubagentStop` の `effort: { level: "medium" }`)。`AgentSpawnArgs` に effort の欄は無い | 実測、型定義 |
| fork の会話の形 | 本体の会話 (`fork-context-ref` で参照) の後ろに、合成の `Agent` の tool_use (`toolu_plugin_…`) と、tool_result「Fork started — that fork is you.」+ `<fork-boilerplate>` + 「Your directive: <prompt>」が付く | fork の transcript |
| 同時に起こせる数 | `$.agent.limits()` は `{ concurrent: 20, depth: 3, isBackgroundEnabled: true }` | 実測 |

`<fork-boilerplate>` は「worker fork として 1 つの指示を実行して 1 回報告して止まれ」「最初に課題を言い直す 1 行を書け」「Agent tool で subagent を起こすな」等を書き、「Your directive may override any of these」と添える。

### 2. prompt cache

| 場面 | 本体の直前の request の prefix | fork の最初の request | 本体の次の request |
|---|---|---|---|
| idle (3 往復の後) | 63,265 (read 63,247 + create 18) | read 63,265 / create 671 | read 63,265 / create 68 |
| idle (別の 2 件) | 64,569 | read 64,569 / create 752、read 64,569 / create 906 | |
| 本体が応答を stream している途中 (3 件同時) | 64,821 | 3 件とも read 64,821 / create 718 | read 64,569 / create 252 (その turn の request) |
| 本体が Bash を実行している途中 | 62,870 | read 62,870 / create 632 | read 62,870 / create 427 |
| resume の直後 (本体が 1 回も request を送る前) | 70,097 (終了前の最後) | read 70,097 / create 1,243 | |
| `/compact` の直後 (本体が request を送る前) | | read 16,052 / create 58,074 | read 16,052 / create 57,455 (fork の書いた cache は本体に効かなかった) |
| `/compact` の後に本体が 1 turn 進んだ後 | 72,556 | read 72,556 / create 581 | |
| `/clear` の直後 | | read 16,052 / create 45,571 | |

- fork の prefix は本体が最後に送った request そのもので、create は合成の tool_use・boilerplate・指示の分 (600〜1,250) だけ
- fork が走っても本体の次の request の cache は外れない

### 3. 終わりの知らせ: plugin が起こした fork は本体に入らない

| 起こし方 | 本体に入ったもの | 根拠 |
|---|---|---|
| plugin の `$.agent.spawn` で fork (握りつぶし無し) | **何も入らない**。`prompt.submit` は来ず、本体の turn は始まらず idle のまま。本体の transcript に会話の行は増えない (増えたのは `type: "tools-used"` の行で、fork が使った tool の名前の一覧)。本体に「background task や fork の知らせを受けたか」と聞くと No | debug log `[enqueueAgentNotification] skipped taskId=<id> status=completed taskPresent=true reason=already-notified`、全 event の記録、本体の答え (consume しなかった fork 8 件、idle・turn の途中・resume の後・`/compact` の後とも) |
| plugin の `$.agent.spawn` で general-purpose | subagent が `SubagentHandback` tool で報告し、本体に `prompt.submit` (`origin.kind: "peer"`、`<agent-message from="<agentId>">[Subagent hand-back] …`) が入って本体の turn が始まった | 実測 (2 件) |
| 本体の model が Agent tool で fork (対照) | `prompt.submit` (`origin.kind: "task-notification"`、`<task-notification><task-id><agentId>…`) が入って本体の turn が始まった | 実測 |

握りつぶす口は 2 つあり、`agent.report` の方が後に何も残さない。

| 口 | 結果 |
|---|---|
| `agent.report` の hook で `{ consumed }` | 知らせが届かない (debug `agent.report (agent <id>, completed): consumed by a hook (…); not delivered`)。本体の transcript に何も残らない。e に `agentId` / `subagentType` / `status` / `provider` / `text` があり、自分が起こした agentId だけに絞れる (plugin の general-purpose 1 件と fork 1 件だけを消し、本体の model の fork は通した)。本体の model の fork の知らせを消した時は、画面の「Waiting for 1 background agent to finish」が消えずに残った |
| `prompt.submit` の hook で task-notification を `{ drop }` | 本体の turn は始まらないが、transcript に `queue-operation` の行 (知らせの全文) と `system` の行「Prompt dropped by a hook: <理由>」が残り、画面にも同じ行が出る。drop した知らせの task は終わっていない扱いで残り、/exit → resume の後に「Background agent "<description>" didn't finish before the previous session ended」と出た |

- `agent.report` は「auto mode の hand-off review」を通る (`next(e)` の結果に `review: "cleared"`、review の request に約 2.2 秒)。`next` を呼ばずに `{ consumed }` を返せば review を待たない (型定義。この実測では `next` を呼んでから consumed を返した)

### 4. 答えを拾う

| 場所 | 中身 |
|---|---|
| `turn.complete` (`e.agentId` が fork の id) | `answer` に最後の応答の全文。tool を使った後の最後の文だけで、途中の文 (「Task: read note.txt, …」) は含まない。`usage` は fork の全 request の合計 (例: read 191,858 / create 1,607 / output 849、3 request) |
| `agent.report` | `text` に同じ全文。`status` は `completed` / `failed` / `stopped` |
| `classic.SubagentStop` | `agent_type: "fork"`、`effort`、`permission_mode` 等 |
| 途中経過 | `session.append` が fork の 1 message ごとに `agentId` 付きで来る (thinking、text、tool_use、tool_result)。token 単位の逐次ではない |
| `$.session.messages({ agentId })` | 終わった fork でも読めた (rows 13 件、`as: "api"` で 7 件)。合成の Agent の tool_use から始まり、本体の会話の分は含まない |
| `$.agent.list()` | 終わった後は `[]` (走っている間の中身は見ていない) |

- general-purpose は最後の報告を `SubagentHandback` tool で返すので `turn.complete` の `answer` が空で、答えは `agent.report` の `text` にだけ来た

### 5. 前置きの有無と答えの体裁

同じ質問「さっき覚えてもらった合言葉は何だった? ついでに note.txt に何が書いてあるか見て教えて。」で比べた。

| 前置き | 答え |
|---|---|
| 無し | `Passphrase: BLUE-HERON-82` / `note.txt contains one line: "The vault code is MAPLE-4471."` (日本語で聞いたのに英語の報告の体裁) |
| 「これは横道の質問です。本体の作業は続けないでください。親のエージェントへの報告ではなく、質問した人に直接答える文で返してください (課題の言い直しの行や報告の見出しは付けない)。」 | `合言葉は BLUE-HERON-82 です。` / `note.txt には次の 1 行が書いてありました: 「The vault code is MAPLE-4471.」` |
| 上から「(課題の言い直しの行や報告の見出しは付けない)」を抜いた形 | `横道の質問「合言葉は?」に答えます。合言葉は BLUE-HERON-82 です。` (言い直しの 1 行が付いた) |
| 前置き無し・英語の 1 語の指示 (「Reply with the single word GRAPE.」等) | `Task: reply with the single word GRAPE.` + 空行 + `GRAPE`。7 件中 5 件 (本体の model が起こした 3 件を含む) で言い直しの行が付き、2 件は語だけだった |

- 言い直しの行は boilerplate の「Open with one line restating your task」から来ると読める。前置きで明示的に断った fork は 7 件とも付かなかった
- 本体の turn の途中に起こした fork は、本体の書きかけの応答や実行中の tool_use を見ていない (「本体はまだ答えておらず」「sleep はまだ実行されていません」と答えた)。fork の prefix が本体の最後の request であること (§2) と合う

### 6. 本体の turn の途中・同時

- 本体が 300 行の応答を stream している途中に 3 件を同時に起こした: 3 件とも 11〜44ms で `turn.start`、約 3 秒で答えた。本体の turn は止まらずに最後まで書いた (本体の turn は fork の後 4 秒で完了)
- 本体が Bash (`sleep 15`) を実行している途中に起こした: すぐ走り 3 秒で答えた。本体の turn は影響なく完了した

### 7. 止め方

- `$.agent.call({ tool: "TaskStop", input: { task_id: <agentId> } })` で止まった。結果 `Successfully stopped task: <id> (<description>)`、fork の `turn.complete` は `reason: "aborted"`、`agent.report` は `status: "stopped"`・`text: ""`。本体の transcript に何も残らない
- `$.tool.call({ tool: "TaskStop", input: … })` は `InputValidationError: Unrecognized key: "input"` (`$.tool.call` の引数の形が違う。正しい形では試していない)

### 8. 端の場合

| 場面 | 結果 |
|---|---|
| resume の直後 (本体が 1 回も request を送る前) | 答える (合言葉を答えた)。cache は終了前の本体の最後の request を読んだ (§2) |
| `/compact` の直後 (本体が request を送る前) | 答える (要約から合言葉を答えた)。ただし fork の会話の指示の**後ろ**に instructions (CLAUDE.md・rules)・session_context・date の attachment が付き、3 件中 1 件は指示を見失って本体のつもりで答えた (「現時点で依頼はありません。直近の作業は未完了の fork を 1 件起動したことだけ」)。cache は 58k を新規作成 |
| `/compact` の後に本体が 1 turn 進んだ後 | attachment は付かず、cache も本体の prefix を読んだ |
| `/clear` の後 | 答える。会話は消えた後のもの (「知らない。この会話では合言葉を教えてもらっていない」)。指示の後ろに attachment が付き、cache は 45k を新規作成。session id が変わり、fork の transcript は新しい session の下に書かれる |

### 9. 本体の会話・画面への残り方

- 本体の transcript: 会話の行は残らない。fork が tool を使うと `type: "tools-used"` の行 (tool 名の一覧) が増え、`/compact` の要約の `<tools-used-before-summary>` に fork の使った tool の名前 (`SubagentHandback`、`TaskStop` も) が入った
- `/compact` の後の context: **consume していない** fork の `task_status` の attachment (`description`・`status: "completed"`・`outputFilePath`・`canContinueAgent: true`) が入り、画面に「Task "<description>" completed in background」と出た。consume した fork は入らなかった (consume した 1 件・しなかった 1 件を同じ間隔で起こして比べた)
- 画面: 本体の会話の欄には何も出ない。下の行に「/tasks to see subagents」が出て、走っている間・止めた後は agent の一覧 (`◯ fork  <description>  stopped · 2s · ↑ 70.7k tokens` 等) が出る
- fork の transcript は `subagents/agent-<id>.jsonl` と `.meta.json` (`agentType: "fork"`, `isFork: true`, `pluginSteered: true`, `requestShape: "background"`) に書かれ、output は一時ディレクトリの `tasks/<id>.output` に作られる

## 実用的な示唆

### 結論: (a) 作れる

`$.agent.spawn({ subagentType: "fork", prompt: <前置き + 質問>, description })` で起こし、`turn.complete` (`e.agentId` が起こした id) の `answer` で答えを拾い、`agent.report` の hook で自分の起こした id の報告を `{ consumed }` で取る。止めるのは `$.agent.call({ tool: "TaskStop", input: { task_id } })`。

- 終わりの知らせの握りつぶしは、plugin が起こした fork では今の版では要らない (入ってこない)。それでも `agent.report` の consume は入れる: `/compact` の後に `task_status` が本体の context に入るのを防ぎ、general-purpose 等を起こした時の hand-back も止め、知らせの扱いが版で変わっても本体に入らない
- `prompt.submit` の `{ drop }` は transcript と画面に跡を残し、task も終わらない扱いになるので使わない
- 前置きで「質問した人に直接答える。課題の言い直しの行や報告の見出しは付けない」を明示する。無いと報告の体裁 (英語・言い直しの行) になった
- 端の場合の扱いが要る: `/compact` と `/clear` の直後 (本体が次の request を送るまで) は、指示の後ろに attachment が付いて指示を見失うことがあり、cache も新規作成になる。本体の次の request を待つか、指示を attachment に埋もれにくい形にするか、のどちらかの判断が要る (どちらが効くかは未確認)
- daemon への受け渡し (mod が答えの文を daemon に送る) はこの実測の範囲外 (mod の既存の経路を使う前提)

### `$.model.fork` との比較

| 項目 | `$.agent.spawn` の fork | `$.model.fork` |
|---|---|---|
| tool | 使える (本体の tool・権限・auto mode の classifier) | 使えない |
| 本体の会話 | 本体の最後の request を引き継ぐ | 同じ |
| cache | 本体の prefix を全部読み、create 600〜1,250 | 本体の prefix を全部読み、create 0 |
| 速さ (短い答え) | 2.5〜5 秒 (tool を使うと伸びる) | 0.8〜1.3 秒 |
| 本体の turn の途中 | すぐ走る | すぐ走る |
| 同時に複数 | 走る (上限 20) | 走る |
| 答えの拾い方 | `turn.complete` の `answer` / `agent.report` の `text` | 戻り値の `text` |
| 途中経過 | message 単位で `session.append` (token 単位は無し) | 無し |
| 止め方 | `$.agent.call` で `TaskStop` | 無し |
| model / effort | 本体のもの。model は指定しても無視、effort の欄は無い | model は本体のもの、effort は指定できる |
| resume の直後 | 答える | `nothing-to-fork` |
| `/compact` / `/clear` の直後 | 答えるが指示を見失うことがあり、cache は新規作成 | `/clear` の後は `nothing-to-fork` (`/compact` の後は未確認) |
| 本体の transcript | 会話の行は残らない (`tools-used` の行だけ) | 残らない |
| 画面 | 下の行に subagent の一覧・ヒント | 何も出ない |
| 前置き | boilerplate の報告の体裁を断つ文が要る | 本体の作業を続けないための文が要る |
| 体裁の後処理 | 要らない (前置きで直接の答えになった) | 要らない |

## 未確認

- 長い Opus のセッションでの cache (今回は haiku の 70k 前後だけ)
- `agent.report` で `next` を呼ばずに `{ consumed }` を返した時に auto mode の review を飛ばせるか (型定義の読み取りだけ)
- `/compact` の直後の fork が指示を見失う率と、前置きや指示の書き方で防げるか (1/3 件の観測だけ)
- 前置き無しの fork が日本語の質問に英語で答えた件が、常にそうなるか (1 件)
- `turn.step` の hook から fork の応答の stream を token 単位で読めるか
- `$.agent.list()` に走っている fork がどう載るか
- fork が書き換えたファイルを本体が後で編集する時の振る舞い (測らない範囲)
- default (Manual) の permission mode で fork の tool が確認を要る時に何が起きるか (今回は auto mode)
- fork が API error で終わった時の `agent.report` / `turn.complete`
- `$.model.fork` の `/compact` の後の挙動
