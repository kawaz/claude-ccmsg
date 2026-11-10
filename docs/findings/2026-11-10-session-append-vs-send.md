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
- **append は「次の request に積む」口で、request を起こさない**。idle の main に 3 回 append しても 60 秒間 request は 0 回で、次に始まった turn の最初の request に 3 つが順に載った。断られるのは agent の loop が走っていない時だけで、main は idle でも断られない (下の「追加の観測」§2)
- **append の成功は「読まれた」を意味しない**。agent が最後の応答を stream している最中 (もう request を出さない段階) の append は成功を返すが、その turn では読まれない。teammate では、後で send で起こした request にも入らなかった (2/2、2 回起こしても入らない。transcript には最後の応答の親の行として残る)。subagent は resume の request に入った (2/2)。main は次の request に入った (2/2)。どちらも位置は最後の応答より前 (§4)
- **send の受け手から見た送り主は常に leader の会話** (subagent には「The coordinator」、teammate には `teammate_id="team-lead"`)。plugin の名前は model の読む文に出ない (agent の request で 0 件)。teammate がその封筒に SendMessage で返すと、宛先は `team-lead` になり、leader の main の会話に届いた (2/2)。本当の送り主 (別セッション) へは戻らない (§1)

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
| 6a. main (idle) | 成功 2/2 (agentId 無し。1 回は 3 回続けて)。turn は始まらない (12 秒間、60 秒間)。次に始まった turn の最初の request で、後から来た行と同じ user message の text block に載った | `{ sessionId: 自分 }` は断り (`no live session on this machine has id <自分の sid> (...)`)、`"main"` は断り (`You are the main conversation — "main" addresses you. Send to a named agent instead.`)、`"team-lead"` は `isDelivered: true`。teammate を起こしたことのある session では 0.4 秒後に新しい turn を始めた (1/1)。teammate のまだいない session では受信箱のファイルに未読で残り、約 150 秒後に最初の teammate を起こした時に読まれて main の turn になった (1/1、§3) |
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

## 追加の観測 (2 回目の session)

同じ隔離環境で session を起こし直して回した (tmux server も `env -i` の隔離した環境で起動)。代役の台本に次を足した:

- `SPAWN <sub|tm> end <tag>` の agent と `MAINSLOWEND <秒>` の main は、最後の応答 (tool を呼ばない end_turn の文) の stream を、`content_block_start` の後で 10 秒止めてから流す。この 10 秒が「最後の応答の最中」(もう request を出さない段階)
- agent の最新の user message に `PLEASE-REPLY` と `<teammate-message teammate_id="X"` があれば、`SendMessage { to: "X", message: "REPLY-FROM-<tag> to <印>" }` の tool_use を返す (封筒の送り主へ返す model の役)
- 観測 mod には、3 回続けて撃つ `append3` / `send3` と、その loop の `turn.start` から遅らせて撃つ arm を足した

Bun の既定の idle timeout (10 秒) が 10 秒止めた stream を 1 回切った (その turn は `ECONNREFUSED` の API error)。その回は数えず、`idleTimeout: 0` にしてやり直した。

### 1. 受け手から見た送り主と、返信の行き先 (send)

| 宛先 | model の読む封筒 (原文) | `session.receive` の `origin` | 返信の行き先 |
|---|---|---|---|
| 走行中の subagent | `The coordinator sent a message while you were working:\n<本文>\n\nAddress this before completing your current task.` | `{ kind: "coordinator", plugin: "probe-as" }` | 封筒にアドレスは無い。subagent の答えは turn の終わりの task-notification として main に行く |
| 終わった subagent (resume) | 同上 (新しい turn の最初の user message) | `session.receive` は起きない (resume の `agent.spawn` の prompt として渡る) | 同上 |
| in-process の teammate | `<teammate-message teammate_id="team-lead" summary="<本文の 1 行目>">\n<本文>\n</teammate-message>` | `{ kind: "coordinator", plugin: "probe-as", teammate: "team-lead", isVerified: true }` | `teammate_id` は `team-lead`。代役の model がそこへ SendMessage で返すと、SendMessage の結果は `Message sent to team-lead's inbox` (`routing.sender` は teammate の名前、`target` は `@team-lead`) で、leader の main の会話に `Another Claude session sent a message:\n<teammate-message teammate_id="<teammate の名前>" color="..." summary="reply">\nREPLY-FROM-...\n</teammate-message>` として入り、main の turn が始まった (2/2)。leader の `session.receive` は `{ kind: "peer", teammate: "<teammate の名前>", isVerified: true }` |
| split pane の teammate | in-process の teammate と同じ `<teammate-message teammate_id="team-lead" ...>` | そのプロセスで `{ kind: "peer", plugin: "probe-as", teammate: "team-lead", isVerified: false }` | 未試行 (封筒の上では in-process と同じく `team-lead`) |
| main 自身 (`"team-lead"`) | `Another Claude session sent a message:\n<teammate-message teammate_id="team-lead" summary="...">...</teammate-message>` + peer の注意書き | `{ kind: "coordinator", plugin: "probe-as", teammate: "team-lead", isVerified: true }` | — |

- send は送り主を指定できず、受信箱の記録 (`teams/session-<sid8>/inboxes/<名前>.json`) の `from` は `team-lead` (leader のプロセスの plugin が送ったので)。plugin の名前は同じ記録の `from_plugin` と `session.receive` の `origin.plugin` にだけ入り、agent の request の中には一度も出なかった (全 agent の request で `probe-as` は 0 件)
- 本当の送り主 (別セッション) を model に伝える手段は本文だけ (1 行目の `ccmsg:<sid> から:` は、どの封筒の中でも残った)。teammate がその印を読んで別セッションに返そうとするかは、実の model で試していない
- 実の model での返信は試していない (代役が封筒の `teammate_id` に返す役をした。返信の宛先は、封筒の `teammate_id` に返すと決めた代役の振る舞いの結果で、model がそう選ぶかは見ていない)

### 2. append は request を起こすか、続けて積むとどうなるか、どこで断られるか

| 場面 | 返り値 | request | 載り方 |
|---|---|---|---|
| main が idle (人の prompt も queue も無い) で 3 回続けて | 3 回とも成功 (`{ message, uuid }`) | append の後 60 秒間 0 回、`turn.start` も無し (1/1)。1 回目の session の 1 回の append でも 12 秒間 0 回 (1/1) | 次に人が打った prompt の turn の最初の request で、1 つの user message の中に別々の text block として、append した順に載った (command の行と交互に、記録された順) |
| main が tool の実行中に 3 回 | 3 回とも成功 | 増えない (今の turn の次の request に載る) | tool_result と同じ user message に、3 つの text block が順に。tool の実行中に人が打った prompt (`The user sent a new message while you were working: ...`) の block は、append より後に打ったのに append の 3 つより前に並んだ |
| 走行中の subagent / teammate が tool の実行中に 3 回 | 3 回とも成功 (各 1/1) | 増えない | tool_result と同じ user message に、3 つの text block が順に |
| agent が待機中・終わった・存在しない・split pane | reject (`HooksError: $.session.append: refused: no running loop is <id>`) | — | — |

- 断りの文は、この調査の全場面で `refused: no running loop is <id>` の 1 種類だった。reference (events) にある `refused: this session keeps no conversation to append to` (起動時の `classic.SessionStart` の中の append) は、今回の場面では出ていない (その場面は試していない)
- 「次の request が期待できない時に断る」という見方とは合わない。main は idle でも、最後の応答の最中でも受け付けた。agent も最後の応答の最中 (この後に request が無い) に受け付けた。断られたのは、その `agentId` の loop が走っていない時だけ
- 断られた append も、自 plugin の hook には `session.append` (door `note`、`origin: { kind: "plugin" }`) として来る (command.run の hook から呼んだ時)

### 3. send は request を起こすか、続けて送るとどうなるか

| 場面 | event の列 (時刻は send からの経過) | turn |
|---|---|---|
| 待機中の teammate に 1 回 | `tool.call` (SendMessage、送り手) → `session.send` → `isDelivered: true` (10 ms) → 受け手の `session.receive` (約 270〜300 ms) → 受け手の `turn.start` (`agentId` 付き)。`prompt.submit` は起きない | 1 回 |
| 待機中の teammate に 3 回続けて (20 ms 以内) | 3 つの `session.receive` が 1 ms の間に続き、`turn.start` は 1 回 | 1 回。新しい turn の最初の user message の 1 つの text block に、3 つの `<teammate-message>` が空行区切りで順に並んだ |
| 走行中の teammate に 3 回 (tool の実行中) | 今の turn の間は何も起きず、`turn.complete` の 4 ms 後に 3 つの `session.receive`、続いて `turn.start` | turn の後に 1 回。並び方は上と同じ |
| 走行中の subagent に 3 回 (tool の実行中) | `session.receive` は tool が終わってから | 今の turn の次の request に入る (新しい turn は無い)。`role: "system"` の message の中に、3 つの「The coordinator sent a message while you were working: … Address this before completing your current task.」が順に並んだ |
| main (`"team-lead"`)、teammate を起こしたことのない session で 3 回 (tool の実行中) | `isDelivered: true` が 3 回。受信箱のファイル (`inboxes/team-lead.json`) に `read: false`、`from: "team-lead"` で 3 件残った。今の turn にも次の turn にも入らず、約 150 秒後に最初の teammate を起こした直後に 3 つの `session.receive` が起き、main の turn が始まった | 150 秒間 0 回、その後 1 回 |

- 1 回目の session の「`"team-lead"` 宛ての send で main に新しい turn が始まる」は、teammate を既に起こしていた session での観測だった。leader の受信箱を読むのは、team に teammate がいる時だけと見られる (2 回目の session の 1 例。条件は切り分けていない)
- 3 回の send が 1 つの turn にまとまったのは、20 ms 以内に送った時と、走行中に溜まった時。間を空けて送った時に turn が分かれるかは試していない

### 4. 最後の応答を stream している最中に足した文

| 宛先 | append | send | 人の prompt (TUI の queue) |
|---|---|---|---|
| 走行中の subagent | 成功 (2/2)。その turn では読まれずに turn が終わる。後で send で resume した時の request では、最初の user message の中 (最後の応答より前) に入っていた (2/2) | 今の turn には入らず、turn の終わりの直後に resume (`agent.spawn`、prompt に本文) で新しい turn を始めた (1/1)。枠は「while you were working」 | — |
| 走行中の teammate | 成功 (2/2)。その turn では読まれない。後で send で起こした request にも入らなかった (2/2。te1 は 2 回起こしてどちらにも無い)。transcript には `type: user`、`isMeta: true`、`origin: plugin` の行として、最後の応答の行の親 (`parentUuid` の連鎖で最後の応答の直前) に残る | turn の後に新しい turn (1/1) | — |
| main | 成功 (2/2)。その turn では読まれない。次の request (queue に積んだ人の prompt の turn) で、最後の応答の前の user message (この turn の prompt と同じ message) の中に入っていた (2/2) | 未試行 (この session には teammate がおらず、`"team-lead"` 宛ては受信箱に残るため) | turn の後に新しい turn の prompt になった (2/2)。今の turn の request には入らない |

- 「append が成功を返した」と「agent が読んだ」は一致しない場面がある。最後の応答の最中の append は、その turn では必ず読まれず、teammate では後の turn でも読まれなかった (in-process の teammate の loop が持ち続けている会話に、その行が入らなかったと読める。subagent は transcript から resume するので入ったと読めるが、内部は見ていない)
- 読まれる場合も、位置は最後の応答より前になる。model から見ると「自分が答える前に来ていた文を無視して答えた」形の会話になる
- tool の結果を待っている最中 (§2・§3 の tool の実行中) は、append は今の turn の次の request に入り、send は subagent なら同じ request に、teammate・main なら turn の後に入る。append と subagent 宛ての send は「今の turn にまだ request があれば、その request に入る」。teammate と main 宛ての send は、今の turn にまだ request があっても入らず、turn の後に回る (受信箱の文は turn の間は model に渡らない)

## 問いへの答え

観測から言えること:

- 包含ではない。append は「今走っている loop の今の turn」だけに届き、send は「loop が走っていない宛先」に届く。走行中の teammate と main では、send は今の turn に入らないので、割り込みには append しか使えない。待機中・終わった・別プロセスの agent には append は必ず断られるので、send しか使えない
- 重なるのは走行中の subagent だけで、そこでは両方とも今の turn の次の request に入る。載る枠・role・transcript の行の形が違う
- send は受け手に engine の枠を付け、送り手を「coordinator」「team-lead」として見せる (plugin の名前は `session.receive` の `origin.plugin` にだけ残り、model の読む文には出ない)。本文の 1 行目に付けた印は、どの経路でも残る
- 「append は次の request 用に積む口で request を起こさない、send は届いた時点で request を起こし、相手が走っている時だけ積まれる側に回る」という見方は、観測と合う。ただし send が積まれた時に今の turn に入るのは subagent だけで、teammate と main は turn の後に回る。また append の断りの条件は「次の request が期待できるか」ではなく「その agentId の loop が走っているか」で、main は idle でも、agent は最後の応答の最中 (この後に request が無い) でも受け付けた。そのため、受け付けたのに読まれない append がある (§4)

観測から言えないこと:

- 実の model が、append の枠の無い文と send の枠付きの文を、どう扱い分けるか (代役なので読み方は見ていない。届いたこと = request に載ったこと)
- first-party の API に送る request でも、`role: "system"` の message という形になるか (代役の host は first-party でない)
- 走行中の teammate の send が、tool を何度も回す長い turn の途中 (2 回目以降の tool の合間) で入ることがあるか。今回の teammate の turn は tool 1 回で、tool の後の request には入らず turn の後に回った
- 実の model が、teammate 宛ての send の封筒 (`teammate_id="team-lead"`) と本文の `ccmsg:<sid> から:` のどちらを返信先と読むか

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
| 送った結果の確定 | 返り値の行は保存済み。今の turn にまだ request があればそこに載る。最後の応答の最中に足すと、その turn では読まれず、teammate では後の turn でも読まれなかった | `isDelivered` は受信箱に入っただけ。いつ読まれるかは宛先の状態次第 (teammate のいない session の `"team-lead"` 宛ては 150 秒読まれなかった) |
| request を起こすか | 起こさない (積むだけ) | 走行中でない宛先なら起こす (続けて送ると 1 つの turn にまとまった) |
| 受け手から見た送り主と返信先 | 封筒が無い。送り主は本文の印だけで伝わり、返信先の手掛かりもその印だけ | leader の会話 (coordinator / `team-lead`)。teammate の返信は `team-lead` に向かい、leader の main の会話に入る (2/2)。本当の送り主には戻らない |

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
- lab-setup に足す: 代役を Bun で書いて応答を遅らせる時は `Bun.serve` の `idleTimeout` (既定 10 秒) を 0 にする
- `capabilities` の append の行と `events` の queue の箇条に足す: 最後の応答の stream の最中に足した append はその turn で読まれず、in-process の teammate では後の turn でも読まれなかった (§4)。main と resume した subagent では、次の request で最後の応答より前に置かれる
- `dollar-api` の `$.session.send` に足す: `"team-lead"` 宛て (main から自分へ) は、teammate のいない session では受信箱のファイルに残り、teammate を起こすまで読まれなかった (§3)。受信箱の記録の `from` は送った plugin のいる会話 (`team-lead`) で、plugin の名前は `from_plugin` にだけ入る

## 試験の環境に由来すること

- 1 本目の tmux server は Claude Code の中の Bash から起動したので、split pane の 1 回目 (p7a) の teammate のプロセスは親 (この調査を委ねたセッション) の `CLAUDE_CODE_SESSION_ID` と `CLAUDE_CODE_CHILD_SESSION=1` を引き継ぎ、API の鍵を持たなかった。`CLAUDE_CONFIG_DIR` と `ANTHROPIC_BASE_URL` は隔離した値で、messaging socket の変数は入っていなかった。transcript は隔離した config dir の中にだけ書かれていた。気付いた時点でそのプロセスを止め、2 回目 (p7b) は隔離した環境の tmux server で回した
- teammate の turn は tool 1 回の短いもの。待機中の判定は `$.agent.list()` の `status: "idle"` と `classic.TeammateIdle`

## 未検証

- 実の model での読み方 (枠の無い append と、coordinator / team-lead の枠付きの send の扱いの差)
- first-party の API での request の形 (`role: "system"` の message になるか)
- 走行中の teammate の、tool を複数回回す turn の途中での send
- 実の model での返信の宛先 (代役は封筒の `teammate_id` に返す役をした)。split pane の teammate の返信
- 間を空けて続けて送った send が turn を分けるか
- main の最後の応答の最中の send (teammate のいる session で)
- teammate の最後の応答の最中の append が失われる理由 (engine の内部は見ていない)。agent の tool を呼ぶ応答の stream の途中 (最後の応答でない stream) の append
- 起動時の `classic.SessionStart` の中の append の断り (`this session keeps no conversation to append to`) を今回の版で
- `$.agent.list()` から消えた後の、終わった subagent への send (transcript で resume するかは見込み)
- 別の `CLAUDE_CONFIG_DIR` の session の agent への send (agent は session の中の宛先なので試していない)
- iTerm2 の split pane、`claude -p` の中の agent、subagent から subagent への send、compaction を挟んだ append
- `on('session.send')` / `on('session.append')` を名指しした hook での、自 plugin の呼び出しの見え方
