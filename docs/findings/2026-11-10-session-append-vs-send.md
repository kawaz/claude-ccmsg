# `$.session.append` と `$.session.send` を agent に向けた時の実機比較

- Date: 2026-11-10
- 対象: Claude Code 2.1.322 (対話のセッション、tmux の中)。ccmsg は使っていない (比べたのは engine の 2 つの口そのもの。リポは v0.232.8 の時点)
- 動機: ccmsg は session の中の subagent / teammate に文を届けるのに `$.session.append({ message, agentId })` を使っている (`hooks/subagents.ts` の `appendToAgent`、DR-0039 §6)。待機中の teammate には `refused: no running loop is <agentId>` で断られる。`$.session.send({ to: { agentId } })` で代わりが利くか、2 つは補完か包含かを、宛先の状態ごとに確かめた

## 結論

- **補完関係で、どちらも他方を包含しない**。append にしかできないことと send にしかできないことが両方ある
- **append にしかできないこと**: 走行中の in-process teammate の、今の turn に割り込むこと。append は次の request (tool_result と同じ user message) に載った (2/2)。send は今の turn には入らず、turn が終わってから新しい turn として読まれた (2/2)。main の会話も同じで、append は今の turn の次の request に載り (2/2)、send (`"team-lead"` 宛て) は turn が終わってから新しい turn になった (2/2)
- **send にしかできないこと**: 走行中でない宛先に届けること。待機中の teammate は起きて新しい turn を始め (5/5)、終わった subagent は transcript から resume して新しい turn を始め (2/2)、split pane の teammate (別プロセス) にも届いた (2/2)。append はこれらを全部断った (待機中 0/2、終わった subagent 0/2、split pane 0/2、存在しない id 0/2)
- **走行中の subagent (name 無しの Agent) はどちらでも今の turn に入る** (各 2/2)。違いは載り方で、append は user の text block の本文そのまま、send は `role: "system"` の message に「The coordinator sent a message while you were working:」で始まり「Address this before completing your current task.」で終わる枠を付けて載る
- **両方とも宛先の外 (main) の request に本文は漏れない** (main の全 request で agent 宛ての印は 0 件)。ただし send で起こした agent は、turn の終わりに main を起こす (teammate は idle_notification、resume した subagent は task-notification)。append は誰も起こさない

## 方法

- 隔離した `CLAUDE_CONFIG_DIR` (`settings.json` は `{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"},"teammateMode":"in-process","crossSessionInbound":"accept"}`。認証の値は無し)、`.claude.json` に onboarding 済み・ダミー鍵の承認・作業ディレクトリの trust を置いた。作業ディレクトリは temp base の下の空の git リポ
- model は Messages API の代役 (reference `claude-mods/lab-setup`)。`env -i` の上に `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` とダミーの `ANTHROPIC_API_KEY`、`TMPDIR` / `XDG_*_HOME` を temp base の下に向けて起動した
- 起動: 専用 socket の tmux の中で `claude --plugin-dir <probe mod> --debug --permission-mode default --allowedTools "Agent,SendMessage,Bash" --name "🤖ccmsg-verify-append-send"`。split pane の行だけ、別の tmux server (server 自体を `env -i` の隔離した環境で起動) の中で `--settings '{"teammateMode":"tmux"}'` を足した 2 本目
- 代役の台本 (request の中身で答えを決める):
  - main の最新の user の文に `SPAWN <sub|tm> <slow|quick> <tag>` があれば Agent の tool_use (`subagent_type: general-purpose`、`run_in_background: true`、`tm` の時だけ `name: <tag>`。prompt は `PROBE-AGENT-<tag> SLOWBASH|QUICK`)。`MAINBASH <秒>` なら Bash の tool_use (`timeout <秒> tail -f /dev/null`)。他は `ok` で end_turn
  - 最初の user message に `PROBE-AGENT-<tag>` がある request は、その agent の loop。`SLOWBASH` で assistant の行がまだ無ければ Bash の tool_use (`timeout 12 tail -f /dev/null`)、他は文で end_turn
  - 全 request の body を jsonl に記録し、印の文字列 (`MK-<試行>-APP` / `MK-<試行>-SND`) がどの request の、どの message の、どの block に、どんな枠で載ったかを数えた
- 観測 mod (`probe-as`):
  - `*` hook で `session.append` / `session.send` / `session.receive` / `prompt.submit` / `turn.*` / `agent.*` / `classic.Subagent*` / `classic.Teammate*` と、Agent / SendMessage / Bash の `tool.call` を記録した
  - `/probe` command で append / send を撃つ。`/probe append <main|agentId> <印>`、`/probe send <宛先> <印>` (宛先は `{ agentId }` / `{ sessionId }` / 文字列)、`/probe arm <loop> ...` (その loop の次の Bash の `tool.call` の 1.5 秒後に撃つ。走行中の turn の途中に当てるため)、`/probe after <ms> ...` (timer)
  - 送る本文は 2 行で、1 行目は ccmsg の印に似せた `ccmsg:PROBEFROM から:`、2 行目が `MK-...`
- 「起こすか」は、宛先の `turn.start` (`agentId` 付き) と代役への新しい request の有無で見た
- 待ちは記録ファイルの変化 (fs.watch) で取った

## マトリクス

「読む時機」の「次の request」は今の turn の続きの request、「新しい turn」は今の turn が終わってから (または待機中から) 始まった turn。

| 宛先 | append | send |
|---|---|---|
| 1. 走行中の subagent (tool の実行中) | 成功 2/2。返り値 `{ message: { type: "user", role: "user", isMeta: true, content }, uuid }`。次の request で tool_result と同じ user message の text block に本文そのまま | `{ agentId }` 1/1、agent id の文字列 1/1 で `isDelivered: true`。次の request で `role: "system"` の message に枠付きで載る (下の「枠」)。起こすまでもなく今の turn で読まれる |
| 2. 走行中の in-process teammate (tool の実行中) | 成功 2/2。1 と同じ形で次の request に載る | `{ agentId }` 1/1、名前の文字列 1/1 で `isDelivered: true`。今の turn には入らず、turn の終わりに受け取られ、新しい turn の最初の user message になる (2/2) |
| 3. 待機中の in-process teammate | 断り 2/2 (reject: `HooksError: $.session.append: refused: no running loop is <agentId>`) | 起きて新しい turn (計 5/5): `{ agentId }` 2/2、名前の文字列 1/1、agent id の文字列 1/1、`{ agentId: <teammateId> }` 1/1。teammateId の文字列は断り 1/1 (`<tool_use_error>to must be a bare teammate name — there is only one team per session</tool_use_error>`) |
| 4. 終わった subagent (`agent.list()` で `completed`) | 断り 2/2 (3 と同じ文) | `{ agentId }` 1/1、agent id の文字列 1/1 で resume。新しい turn の最初の user message (isMeta) に枠付きで載る。その turn の終わりに main に task-notification が来て main の turn が始まる |
| 5. 存在しない agent id | 断り 2/2 (3 と同じ文) | `{ agentId }`: `Agent "<id>" could not be resumed: No transcript found for agent ID: <id>. If you read this id in a message from another Claude Code process (...) it never ran in this session — reply through "team-lead" or the session that sent it instead of the raw id.`。名前: `No agent named 'nobody' is reachable.\nUse ListAgents to see everyone you can message.`。`{ sessionId }`: `no live session on this machine has id <id> (...)` (各 1/1) |
| 6a. main (idle) | 成功 1/1 (agentId 無し)。turn は始まらない (12 秒間)。次に始まった turn の request で、後から来た行と同じ user message の text block に載った | `{ sessionId: 自分 }` は断り (`no live session on this machine has id <自分の sid> (...)`)、`"main"` は断り (`You are the main conversation — "main" addresses you. Send to a named agent instead.`)、`"team-lead"` は届いて 0.4 秒後に新しい turn を始めた (各 1/1) |
| 6b. main (tool の実行中) | 成功 2/2。次の request で tool_result と同じ user message に載る | `"team-lead"` 2/2。`session.receive` は約 1 秒後に起きたが今の turn には入らず、turn が終わった直後の新しい turn で読まれた |
| 7. split pane の teammate (別プロセス) | 断り 2/2 (`no running loop is <name>@session-<sid8>`) | 名前の文字列 2/2 で `isDelivered: true`。teammate のプロセスで `session.receive` が直ちに起き、今の turn には入らず、turn の終わりの後に新しい turn の最初の user message になった (1/1。もう 1 回は teammate のプロセスに API の鍵が渡っておらず、新しい turn の request の記録までで止まった) |

### 枠 (受け手の request の中の形)

| 経路 | request の中の形 | 本文の 1 行目の印 |
|---|---|---|
| append (どの宛先でも) | user message の text block。枠は無く、本文そのまま | 残る |
| send → 走行中の subagent | `role: "system"` の message の text (直前の agent_listing の reminder と 1 つの block に連結)。`The coordinator sent a message while you were working:\n<本文>\n\nAddress this before completing your current task.`。transcript の記録には `<system-reminder>` の囲みがあるが、request の system message の中には無い | 残る |
| send → 終わった subagent (resume) | 新しい turn の最初の user message。文面は上と同じ「while you were working」の枠 (resume の turn でも同じ文) | 残る |
| send → in-process / split pane の teammate | 新しい turn の user message。`<teammate-message teammate_id="team-lead" summary="<本文の 1 行目>">\n<本文>\n</teammate-message>` | 残る。`summary` 属性に本文の 1 行目がそのまま入る (今回は `ccmsg:PROBEFROM から:`) |
| send → main (`"team-lead"`) | user message の text block。`Another Claude session sent a message:\n<teammate-message teammate_id="team-lead" summary="...">...</teammate-message>\n\nThis came from another Claude session — not typed by your user, ...` (peer の注意書きの段落付き) | 残る |

### transcript (jsonl) に残る行

| 経路 | 行 |
|---|---|
| append (main・agent とも) | `type: "user"`、`isMeta: true`、`origin: { kind: "plugin", name: "<plugin>" }` |
| send → 走行中の subagent | `type: "attachment"`、`attachment.type: "queued_command"`、`attachment.origin: { kind: "coordinator", plugin: "<plugin>" }`、`renderedRole: "system"` |
| send → 終わった subagent | `type: "user"`、`isMeta: true`、`origin: { kind: "coordinator", plugin: "<plugin>" }` |
| send → in-process teammate | agent の jsonl に `type: "user"`、content は文字列の `<teammate-message ...>`。`isMeta` も `origin` も無い |
| send → main (`"team-lead"`) | main の jsonl に `type: "user"`、content は文字列の `Another Claude session sent a message: ...`。`isMeta` も `origin` も無い |

agent 宛ての印は main の jsonl に 0 件。

### event

- 受け手の `session.receive` (send の時だけ。append では起きない):
  - 走行中の subagent: `origin: { kind: "coordinator", plugin }`、`agentId` 付き。起きたのは送った時点でなく、tool が終わって loop が受信箱を空ける時点 (送ってから約 10.7 秒後)
  - in-process の teammate: `origin: { kind: "coordinator", plugin, teammate: "team-lead", isVerified: true }`、`agentId` 付き。走行中なら turn の終わり、待機中なら直ちに
  - main (`"team-lead"`): `origin: { kind: "coordinator", plugin, teammate: "team-lead", isVerified: true }`、`agentId` 無し
  - split pane の teammate: そのプロセスで `origin: { kind: "peer", plugin, teammate: "team-lead", isVerified: false }`、`agentId` 無し (そのプロセスでは main の会話)
- 受け手の `session.append` (`door` / `origin`): append は `note` / `{ kind: "plugin", name }` (agentId 付きの断られた append でも hook には来る)。send は、走行中の subagent が `delivery` / `{ kind: "coordinator" }` (`type: attachment`、`name: queued_command`)、teammate と resume した subagent が `prompt` / `{ kind: "coordinator" }`、main と split pane の teammate が `note` / `{ kind: "engine" }`
- `turn.start` (`agentId` 付き) は、send で起こした時 (3・4・2 の turn 後) に起きる。append では起きない
- `prompt.submit` は agent の turn にも、mailbox 経由の main の turn にも起きなかった (起きたのは composer と task-notification だけ)
- 送り手の側: `$.session.send` を command.run の hook の中から呼ぶと、自分の `*` hook に `tool.call` (SendMessage、`by: { plugin }`) と `session.send` が現れた。`session.send` の `e.to` は綴り直されていて、teammate の `{ agentId }` は名前 (`"t2a"`)、subagent の `{ agentId }` は id の文字列。終わった subagent への send では、加えて `agent.spawn` (prompt に本文) が起き、SendMessage の結果は `Resuming agent <id>`。timer callback (`$.clock.after`) から呼んだ send は自分の hook に何も現れなかった
- `isDelivered: true` は受信箱に入った時点で返る (13〜30 ms)。読まれた時点ではない (上の `session.receive` の時機を参照)

## 問いへの答え

観測から言えること:

- 包含ではない。append は「今走っている loop の今の turn」だけに届き、send は「loop が走っていない宛先」に届く。走行中の teammate と main では、send は今の turn に入らないので、割り込みには append しか使えない。待機中・終わった・別プロセスの agent には append は必ず断られるので、send しか使えない
- 重なるのは走行中の subagent だけで、そこでは両方とも今の turn の次の request に入る。載る枠・role・transcript の行の形が違う
- send は受け手に engine の枠を付け、送り手を「coordinator」「team-lead」として見せる (plugin の名前は `session.receive` の `origin.plugin` にだけ残り、model の読む文には出ない)。本文の 1 行目に付けた印は、どの経路でも残る

観測から言えないこと:

- 実の model が、append の枠の無い文と send の枠付きの文を、どう扱い分けるか (代役なので読み方は見ていない。届いたこと = request に載ったこと)
- first-party の API に送る request でも、`role: "system"` の message という形になるか (代役の host は first-party でない)
- 走行中の teammate の send が、tool を何度も回す長い turn の途中 (2 回目以降の tool の合間) で入ることがあるか。今回の teammate の turn は tool 1 回で、tool の後の request には入らず turn の後に回った
- subagent が tool でなく応答の stream の途中の時の、append / send の載る位置

## ccmsg が agent に届ける口を選ぶ材料

| 軸 | append | send |
|---|---|---|
| 今の turn に割り込めるか | 走行中なら常に (subagent・teammate・main) | 走行中の subagent だけ。teammate と main は turn の後 |
| 止まっている宛先を起こせるか | 起こせない (断られる) | 起こせる (待機中の teammate、終わった subagent の resume、split pane の teammate) |
| 本文の印をそのまま付けられるか | 付けられる。枠は無く、印が model の見る唯一の出どころ表示 | 付けられるが、engine の枠 (coordinator / team-lead) が外側に付く。teammate 宛てでは本文の 1 行目が `summary` 属性にもなる |
| 送り手が誰に見えるか | 本文の印だけ | 「coordinator」「team-lead」(親の会話) からの文。人 (ccmsg 経由) や別セッションからの文であることは印でしか伝わらない |
| 宛先の外に漏れないか | 漏れない。誰も起こさない | 本文は漏れないが、起こした agent が turn の終わりに main を起こす (idle_notification に teammate の最後の答え、task-notification に subagent の結果が載る) |
| 届く範囲 | 自プロセスで走行中の loop だけ | 自 session の agent 全部 (終わった subagent は transcript があれば)、split pane の teammate (名前で)。teammateId の文字列は不可 (`{ agentId: <teammateId> }` は可) |
| 失敗の知らせ | reject (`refused: no running loop is <id>`) | `{ isDelivered: false, reason }`。reason は SendMessage の文 |
| 送った結果の確定 | 返り値の行は保存済みで、次の request に必ず載る | `isDelivered` は受信箱に入っただけ。いつ読まれるかは宛先の状態次第 |

判断の分かれ目は「止まっている agent を起こしてでも届けたいか」と「走行中の teammate の今の turn に割り込みたいか」の 2 つで、1 つの口では両方を満たせない。走行中か否かは `$.agent.list()` の `status` と `turn.start` / `turn.complete` で分かる (ccmsg が既に持っている情報)。

## reference (`claude-mods/`) との食い違いと、足すべき点

- `dollar-api` の `append`: 「上の plugin が拒めば `{ deny }`」とあるが、走行中でない `agentId` (待機中・終わった・存在しない・split pane) の断りは `{ deny }` で返らず reject (`HooksError: $.session.append: refused: no running loop is <id>`)。足す: agentId 付きの append が届くのは自プロセスで走行中の loop だけ
- `dollar-api` の `$.session.send`: 足す: agent 宛ての枠 (subagent は「The coordinator sent a message while you were working」、teammate は `<teammate-message teammate_id="team-lead" summary="<1 行目>">`)、走行中の teammate と main には今の turn に入らないこと、待機中の teammate を起こし終わった subagent を resume すること、起こした agent が main を起こすこと。自分の session は `{ sessionId }` でも `"main"` でも断られ、`"team-lead"` なら自分の会話に届いて新しい turn になること
- 型定義の `{ agentId }` の説明「A live teammate's `teammateId` reaches it too」は `{ agentId: <teammateId> }` の形でだけ成り立つ。teammateId を文字列で `to` に渡すと SendMessage の検査で断られる
- `events` の「plugin 自身の `$.session.send` は自 plugin の `session.send` hook を通らない (`skipped: re-entry`)」: command.run の hook の中から呼んだ send は、自分の `*` hook に `tool.call` (SendMessage) と `session.send` として現れた。現れなかったのは timer callback から呼んだ時 (debug log には timer からの `$` 呼び出しの `skipped: re-entry` が並ぶ)。`on('session.send')` を名指しした hook でどうなるかは見ていない
- `capabilities` の「event を待たずに会話へ 1 行足す」(append、`agentId?`): 足す: agentId 付きは走行中の loop だけ、main は idle でも足せて次の turn の request に載る (turn は始まらない)
- 2026-10-18 の findings の `$.agent.list()` の `completed`: 終わった subagent はしばらくすると一覧から消えた。終わってから 0.1 秒後・10 秒後の一覧には `completed` で載り、44 秒後・118 秒後の一覧には無かった (4 つの subagent、一覧は 4 回)。消える条件 (時間か、次の subagent の完了か) は切り分けていない
- lab-setup に足す: 代役で teammate (agent teams) も回せる (`settings.json` の `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"`、Agent の tool_use の入力に `name`)。split pane の teammate は tmux server の環境を引き継ぐので、tmux server を Claude Code の中の Bash から素で起こすと teammate のプロセスに親の `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_CHILD_SESSION` / `CLAUDECODE` が入り、`ANTHROPIC_API_KEY` は入らない。tmux server 自体を `env -i` の隔離した環境で起動する。split pane の teammate の tool の許可は leader の画面に出る (`--allowedTools` は引き継がれない)
- lab-setup に足す: この版では代役への request の `messages` に `role: "system"` の message が入る (attachment の reminder、走行中の subagent への send)

## 試験の環境に由来すること

- 1 本目の tmux server は Claude Code の中の Bash から起動したので、split pane の 1 回目 (p7a) の teammate のプロセスは親 (この調査を委ねたセッション) の `CLAUDE_CODE_SESSION_ID` と `CLAUDE_CODE_CHILD_SESSION=1` を引き継ぎ、API の鍵を持たなかった。`CLAUDE_CONFIG_DIR` と `ANTHROPIC_BASE_URL` は隔離した値で、messaging socket の変数は入っていなかった。transcript は隔離した config dir の中にだけ書かれていた。気付いた時点でそのプロセスを止め、2 回目 (p7b) は隔離した環境の tmux server で回した
- teammate の turn は tool 1 回の短いもの。待機中の判定は `$.agent.list()` の `status: "idle"` と `classic.TeammateIdle`

## 未検証

- 実の model での読み方 (枠の無い append と、coordinator / team-lead の枠付きの send の扱いの差)
- first-party の API での request の形 (`role: "system"` の message になるか)
- 走行中の teammate の、tool を複数回回す turn の途中での send
- 応答の stream の途中の append / send
- `$.agent.list()` から消えた後の、終わった subagent への send (transcript で resume するかは見込み)
- 別の `CLAUDE_CONFIG_DIR` の session の agent への send (agent は session の中の宛先なので試していない)
- iTerm2 の split pane、`claude -p` の中の agent、subagent から subagent への send、compaction を挟んだ append
- `on('session.send')` / `on('session.append')` を名指しした hook での、自 plugin の呼び出しの見え方
