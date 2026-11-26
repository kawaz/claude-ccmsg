# teammate の待機通知 (idle_notification) は module のどの event に現れ、足した文がどこに載るか

- Date: 2026-11-26
- 対象: Claude Code 2.1.332 (対話のセッション、tmux の中)。teammate は in-process (`teammateMode: "in-process"`)。代役の API に送られた model 名は `claude-opus-5-5`。ccmsg は使っていない (試験用の観測 mod だけ)
- 動機: 統括のセッションに teammate の待機通知が届くたびに、統括が「やることはありません」の応答を返して TL の雑音になる。待機通知が届いた時にだけ、ccmsg の module が「新しく伝えることが無ければ本文を `nothing_to_reply` の 1 語だけにする」文を context に足す (kawaz の裁定 2026-11-26)。その前に、(1) 待機通知がどの event に現れるか、(2) 入力から待機通知と見分けられるか、(3) 足した文がその通知に応える turn の request に間に合うか、を確かめた
- 方法:
  - リポの外の一時ディレクトリに、隔離した config dir (`settings.json` は `{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"},"teammateMode":"in-process","crossSessionInbound":"accept"}`、`.claude.json` は onboarding 済み・ダミーの API キーの承認・作業ディレクトリの trust)、空の git リポの作業ディレクトリ、手元の Messages API の代役、試験用の plugin (`idleprobe`) を置いた。`env -i` の上に `ANTHROPIC_BASE_URL` を代役に向け、ダミーの `ANTHROPIC_API_KEY` を渡し、専用の socket の tmux (`tmux -f /dev/null -S <sock>`、tmux server も `env -i` で起動) の中で `claude --plugin-dir <plugin> --debug --model claude-opus-5-5 --permission-mode default --allowedTools "Agent,SendMessage,Bash" --name "🤖ccmsg-verify-idle-notice"` を起動した
  - 代役の台本: main の最新の user の文が `SPAWNTM <name> <QUICK|MSG>` なら名前付きの Agent (teammate を起こす)、`SPAWNSUB <tag>` なら背景の subagent、`BGBASH <tag>` なら背景の Bash (`sleep 3; echo ...`)、`SENDTM <name> <語>` なら teammate への SendMessage (止まっている teammate を起こし、turn の後にもう一度待機させる)、`SENDWAIT <name> <語> <秒>` なら SendMessage の後に前景の `sleep <秒>` (main が turn の途中にいる間に待機通知を来させる)。teammate は `QUICK` なら文 1 つで end_turn、`MSG` なら先に `team-lead` へ SendMessage してから end_turn。全 request の `messages` を記録した
  - 観測 mod: `*` hook で ui 以外の全 event を記録し、`session.receive` / `session.append` / `prompt.submit` / `turn.start` / `agent.report` などは入力の全体と `next` の結果も記録した。環境変数で選んだ「文を足す口」(下の表) で、待機通知などの配達に印 (`MARK-<口>-<種類>-<連番>`) を足し、その印が代役への request のどこに載ったかを見た
  - 別のセッションからの文は、参照知識の `uds-send.py` で試験用セッション自身の peer socket に `<cross-session-message from="lab">` の封筒を書いた
  - 待ちは記録ファイルの監視 (`tail -F` と `grep`、上限付き) で取った
  - 回した session は 4 本: r1 (観測だけ)、r2 (足す口を全部同時に)、r3 (`turn.start` の口だけ)、r4 (`session.append` の後の口だけ)。待機通知は計 18 回 (r1 4・r2 3・r3 5・r4 6)

## 結論

1. **待機通知は `session.receive` と `session.append` と `turn.start` に現れる。`prompt.submit` と `agent.report` には現れない** (18/18 回とも同じ)。`classic.TeammateIdle` は teammate の turn の終わりに起きるが、これは通知が main に届く前で、中身 (`result`) を持たない
2. **見分けられる**。`session.receive` の入力は `origin: { kind: "peer", teammate: "<名前>", isVerified: true }` で、`text` が通知の JSON そのもの (`{"type":"idle_notification",...}`)。teammate の普通のメッセージは同じ `origin` で `text` が本文。背景の task と subagent の報告は `session.receive` を通らず `prompt.submit` (`origin.kind: "task-notification"`) を通る。別のセッションの文は `session.receive` を通るが `origin` に `teammate` が無い (`{ kind: "peer" }`)。会話に入る行 (`session.append`) では、待機通知は `door: "note"`・`origin: { kind: "engine" }` の行の text の中の `<teammate-message teammate_id="<名前>" ...>` の封筒の中身として現れる
3. **足した文が通知の turn の request に確実に載ったのは、その `note` の行の `session.append` の hook で `next` の後に `$.session.append` した時だけ** (r4 で 6/6、r2 で 3/3。main が待機中・main の turn の途中に届いた・普通のメッセージと 1 行にまとまった、のどれでも)。model からは、同じ user message の中で通知の封筒より前に、`<system-reminder>\nNote from the <plugin> plugin, not from the user:\n<文>\n</system-reminder>` として見える。`turn.start` で足した文は main では多くが間に合わず次の turn に回り (r3 で 0/5)、`session.receive` で足した文は main が turn の途中の時にその走行中の turn に入った (1/1)

## 判明した事実 (観測)

### 1. 待機通知が現れる event

1 回の待機通知の main 側の列 (r1 の 1 回目。番号は観測 mod の連番、時刻は teammate の `turn.complete` からの経過):

| 順 | event | 入力の要点 |
|---|---|---|
| 1 | `classic.SubagentStop`・`classic.TeammateIdle`・`turn.complete` (`agentId` = teammate) | teammate の turn の終わり。通知の中身は持たない |
| 2 | `session.receive` (`agentId` 無し、+813 ms) | `origin: {"kind":"peer","teammate":"t1","isVerified":true}`、`text: {"type":"idle_notification","from":"t1","timestamp":"2026-11-26T03:48:37.544Z","idleReason":"available","result":"TM-REPLY-t1-0"}` |
| 3 | `session.append` (+2 ms) | `door: "note"`、`origin: {"kind":"engine"}`、`message: { type: "user", role: "user" }` (`isMeta` 無し)、content は text 1 つ (下の原文) |
| 4 | `turn.start` (`agentId` 無し) | `text` は 3 の行の text と同じ (`Another Claude session sent a message:\n<teammate-message ...` で始まる) |
| 5 | `turn.step` → 代役への request → `turn.complete` | 通知の turn。request の最後の user message が 3 の行 |

3 の行の text (原文、末尾の注意書きは途中まで):

```text
Another Claude session sent a message:
<teammate-message teammate_id="t1" color="blue">
{"type":"idle_notification","from":"t1","timestamp":"2026-11-26T03:48:37.544Z","idleReason":"available","result":"TM-REPLY-t1-0"}
</teammate-message>

This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings. ...
```

- 18 回とも同じ列だった。`prompt.submit` は 18 回とも起きず (同じ session の composer・task-notification・peer では起きた)、`agent.report` も teammate では一度も起きなかった
- `session.receive` は teammate の `turn.complete` から 47〜936 ms 後 (18 回)。main が待機中なら、`note` の行はその 1〜16 ms 後に入り、すぐ turn が始まった (12 回)
- **main が turn の途中 (前景の `sleep 8` の最中) に通知が来た時** (6 回): `session.receive` はその時点で起き、`note` の行と `turn.start` は main の今の turn の `turn.complete` の後まで待った (`session.receive` から行まで 7.2〜8.0 s)。通知は今の turn には入らず、turn の後の新しい turn になった。これは [2026-11-10-session-append-vs-send](./2026-11-10-session-append-vs-send.md) の「teammate から main への文は今の turn に入らず turn の後に回る」と合う
- **普通のメッセージとまとまる** (r1・r2・r4 各 1 回): teammate t2 が SendMessage で `team-lead` に送ってから待機した時、`session.receive` は 2 回 (本文 `TM-MSG-t2`、続けて待機通知の JSON) 起き、`note` の行は 1 つ、turn も 1 つだった。行の text の中に `<teammate-message teammate_id="t2" color="green" summary="tm msg t2">` と待機通知の `<teammate-message teammate_id="t2" color="green">` (`summary` 無し) が空行区切りで並ぶ
- 待機通知の JSON で見たのは `idleReason: "available"` だけ。`result` には teammate の最後の応答の文が入った (SendMessage を呼んだ t2 では、その後の最後の文 `TM-AFTER-TOOL-t2`)

### 2. ほかの起点との見分け

| 起点 | `session.receive` | `prompt.submit` | 会話に入る行 (`session.append`、main) | `turn.start` の `text` |
|---|---|---|---|---|
| teammate の待機通知 | 起きる。`origin: { kind: "peer", teammate, isVerified: true }`、`text` は通知の JSON | 起きない (0/18) | `door: "note"`、`origin: { kind: "engine" }`、`isMeta` 無し。text は `Another Claude session sent a message:` + `<teammate-message teammate_id="<名前>" color="...">` + JSON + 注意書き | 行の text と同じ |
| teammate の普通のメッセージ (SendMessage で `team-lead` へ) | 起きる。`origin` は待機通知と同じ、`text` は本文 | 起きない | 待機通知と同じ形 (封筒に `summary` が付く)。同じ時に来た待機通知と 1 行にまとまる | 行の text と同じ |
| 背景の task (Bash の `run_in_background`) | 起きない | 起きる。`origin: { kind: "task-notification" }` | `door: "queue"` (`origin: engine`) の行と、`door: "prompt"`・`origin: { kind: "task-notification" }` の行。model には `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]...<task-notification>...` として見える | `<task-notification>` の本文 |
| 背景の subagent の報告 | 起きない | 起きる (task-notification、`<result>` に報告) | 背景の task と同じ | 同上 |
| 別のセッションの文 (peer socket の `<cross-session-message>`) | 起きる。`origin: { kind: "peer" }` (`teammate` 無し)、`text` は封筒 | 起きる。`origin: { kind: "peer" }` | `door: "prompt"`、`origin: { kind: "peer" }`、`isMeta: true`。text は `Another Claude session sent a message:` + 封筒 + 注意書き | 封筒だけ (前置きの行無し) |

- 背景の subagent の報告では、加えて `agent.report` が `{ agentId, subagentType: "general-purpose", status: "completed", provider: { plugin: "engine", tier: "core" }, text: "SUB-REPLY-s1" }` で起き、その後に task-notification が `prompt.submit` を通った (r1 2 回・r2 1 回)
- 代役の Agent の呼び出しに `run_in_background` を付けなかった回 (r1 の `SPAWNFG`) も、tool の結果は起動の知らせで、報告は turn の後の task-notification として来た (この版のこの設定では前景にならなかった)。subagent に SubagentHandback の tool は渡されていなかったので、hand-back の tool を呼ぶ形は見ていない
- main の `door: "note"`・`origin.kind: "engine"` の行は、4 本の session で teammate からの配達 (待機通知と普通のメッセージ) 以外に現れなかった。同じ形の行は agent の側 (`agentId` 付き) にも出た (subagent / teammate の turn の始まりの「Other agents active in this session ...」、`isMeta: true`)

### 3. 足した文が載る所

足す口:

| 記号 | 口 | 足し方 |
|---|---|---|
| RA | `session.receive` (main 宛て) | `next` の前に `$.session.append` (`type: "user"`) |
| RT | `session.receive` | `next({ ...e, text: e.text + "\n" + 印 })` |
| AW | `session.append` (配達の行) | `next` に渡す `message.content` の後ろに text block を 1 つ足す |
| AA | `session.append` (配達の行) | `next` の後に `$.session.append` (`type: "user"`) |
| TA | `turn.start` (main) | `next` の前に `$.session.append` を await |
| PC | `prompt.submit` | `next({ ...e, context: [...context, 印] })` |
| RW | `agent.report` | `next({ ...e, text: e.text + "\n" + 印 })` |

待機通知の turn の最初の request に載ったか (印がどの request に初めて現れたか):

| 口 | main が待機中 | main の turn の途中に届いた | 普通のメッセージとまとまった | 載った形 (model から) |
|---|---|---|---|---|
| AA | r2 1/1、r4 3/3 | r2 1/1、r4 2/2 | r2 1/1、r4 1/1 | 同じ user message の中で、通知の封筒より前の text block。`<system-reminder>\nNote from the idleprobe plugin, not from the user:\n<印>\n</system-reminder>` |
| RA | r2 1/1 | **0/1**。印は main の今の turn の次の request (前景の Bash の tool_result の後ろの `role: "system"` の message) に入り、通知の turn には無かった | r2 1/1 | AA と同じ (載った回) |
| TA | r2 1/1、**r3 0/3** | r2 0/1、r3 0/2 | r2 1/1 | 載らなかった回は、どれも次の turn (次に打った prompt の turn) の最初の request に回った。載った回の形は AA と同じ |
| RT | r2 1/1 | r2 1/1 | r2 1/1 | `<teammate-message teammate_id="t1" ...>` の封筒の中、JSON の次の行 (まとまった回は最後の封筒の中) |
| AW | r2 1/1 | r2 1/1 | r2 1/1 | 封筒と注意書きの text block の後ろに、枠の無い text block |
| PC | 口が無い (`prompt.submit` が起きない) | 同左 | 同左 | — |
| RW | 口が無い (`agent.report` が起きない) | 同左 | 同左 | — |

- **AA は計 9/9**。r4 (AA だけ) の 6 回は、どれも通知の turn の唯一の request に載った。`session.append` の hook が終わってから `turn.start` が起きていて (観測 mod の連番で `session.append` の結果 → `turn.start` の順)、足した行は turn が始まる前に積まれている
- **TA は main では当てにならない**。r3 (TA だけ) で待機通知 0/5、背景の task 1/1。r2 (ほかの口と同時) で待機通知 2/3、背景の task 0/2、別のセッション 0/1。載らなかった回の印は、どれも次の turn の最初の request に入った (失われはしない)。載らなかった r2 の待機通知の 1 回も、`turn.start` の hook の中の append は `turn.step` の 1 ms 前に解決していた (載った r2 の 1 回は 6 ms 前)。agent の loop の `turn.start` で足すと最初の request に載る ([2026-11-25-agy-tool-claude-code-probes](./2026-11-25-agy-tool-claude-code-probes.md) の M20、型定義の `agentId` の説明「A run counts from its `turn.start`, where an awaited `user` row rides its first request」) のとは違う。main で何が載る・載らないを分けているかは切り分けていない
- **RA は main の状態次第で行き先が変わる**。`session.receive` は main の turn の途中でも通知が来た時点で起きるので、そこで足した行は走行中の turn の次の request に入る (`$.session.append` の「A `user` row waits for the next request of its loop」の通り)
- **RT と AW は通知の turn に載るが、通知そのものを書き換える**。RT の文は teammate の封筒の中に入り、model からは teammate の書いた文に見える。AW の行は transcript の通知の行そのものに残り (jsonl の `type: "user"` の行の content)、TUI では `❯ MARK-AW-idle-3` と人が打った prompt の行として描かれた。RT と AW を入れた r2 では、TUI の通知の描き方が「Teammate @t1 finished」から「› Message from @t1」に変わった (どちらの口のせいかは分けていない)。AA だけの r4 では「Teammate @t1 finished」のままだった
- PC (`prompt.submit` の `context`) は背景の task・subagent の報告・別のセッションの文には効き、その turn の user message の最初の block に `<system-reminder>\nprompt.submit hook additional context: <印>\n</system-reminder>` として載った (task 2/2、peer 1/1)
- RW (`agent.report` の `text`) は subagent の報告に効き、task-notification の `<result>` の中、報告の次の行に載った (1/1)
- `$.session.append` で足した行は、transcript に `type: "attachment"`、`attachment.type: "plugin_note"` の行 (`heldContent` の行と、送った後の `content`・`sentAs: "beside"` の行の 2 つ) として残り、TUI には描かれなかった。足した行は会話に残り、後の request にも毎回載った
- 自 plugin の `$.session.append` は自分の `session.append` hook を通らなかった (debug log `session.append: hooks 3 left out for re-entry (origin idleprobe#3)`)。`*` hook には `by: { plugin: "idleprobe" }` で現れた

## 読んだだけのこと

- 2.1.332 の型定義 (engine が試験用 plugin の `.claude-plugin/types/claude-code/index.d.ts` に書いたもの。ccmsg のリポの `.claude-plugin/types/` に今ある型定義は 2.1.322 で古い)
  - `SessionReceiveInput`: 「one inbound delivery, sanitized, before it is queued (a relay's event, a peer's message, a message for an agent)」。`origin` の 3 つ目の形が「A delivery through this session's agent-team mailbox: `coordinator` from the lead's harness, `peer` from a teammate's or when unverified」で、`teammate` (送った member の名前) と `isVerified` を持つ。結果は `{ text }` か `{ consumed }` で、`next({ ...e, text })` で書き換えられ、`next` を呼ばずに `{ consumed }` を返すと「not queued, not written to the transcript and never reaches the model」
  - `SessionAppendInput`: `door` は `prompt` / `command` / `response` / `tool-result` / `tool-message` / `delivery` / `attachment` / `hook-context` / `note` / `compaction` / `notice` / `queue` の閉じた集合で、matcher のキー。`message.content` の text block は書き換えられる。結果は「A hook relays it unchanged: one that answers without `next`, or another row, is skipped」で、結果を書き換える口は無い
  - `SessionAppendArgs.message` (`$.session.append`): 「A `user` row waits for the next request of its loop (on an idle main, the next turn that calls the model)」「It goes out as a reminder under a line naming the plugin」「Anywhere else it is fenced in the user turn」。観測の載り方と合う
  - `PromptOrigin` の `unclassified`: 「An idle notice or a delivery receipt the engine queued isMeta with no stamp is one too」。この試験の待機通知は `prompt.submit` を通らなかったので、この origin の待機通知は見ていない
  - `agent.report`: 「one report of an agent, before it reaches the loop that waits for it」。teammate の待機通知はこれを通らなかった (観測)
- ccmsg の module (`hooks/bus.ts`) は今 `session.receive` を登録していない。`session.append` は transcript-push が 1 つの hook で取っている (bus.ts は 1 event に 1 つの登録)
- 待機通知の JSON の形 (`{"type":"idle_notification",...}` が `<teammate-message>` の中に入る) は [2026-07-17-transcript-teams-context-shapes](./2026-07-17-transcript-teams-context-shapes.md) と同じ。待機通知が main を起こすことは [2026-11-10-session-append-vs-send](./2026-11-10-session-append-vs-send.md) にある

## 実装するならの所見 (断定ではない)

### 筋が良さそうな口: `session.append` の `note` の行で、`next` の後に `$.session.append`

- 根拠
  - 測った中で、main の状態 (待機中・turn の途中) とまとまり方によらず、通知の turn の最初の request に載ったのはこれだけ (9/9)
  - 通知の行・封筒・TUI の描き方・transcript の通知の行を変えない。足した文は plugin の note として fence され、model から「plugin の文で、人の文ではない」と分かる形で載る
  - ccmsg は `session.append` を既に hook している (transcript-push)。bus.ts の concern を 1 つ足す形で収まる
- 見分け方の候補
  - 行で見る: `agentId` が無く、`door === "note"`、`origin.kind === "engine"`、text の中の `<teammate-message ...>` の中身が `{"type":"idle_notification",...}` の JSON
  - `session.receive` と組み合わせる: `session.receive` の構造化された `origin.teammate` と、JSON そのものの `text` で待機通知を覚えておき、次に来る `note` の行にその JSON が入っているかで照らす。封筒の文面 (`Another Claude session sent a message:`・注意書き) を読まずに済む。代わりに `session.receive` の登録が 1 つ増え、受け取りから行までの間 (turn の途中なら数秒以上) の状態を持つ
- 弱点
  - 足した文は通知の封筒より**前**に載る。「この通知に新しく伝えることが無ければ」と後ろの通知を指す文面にする必要がある (前にある前提で書く)
  - 1 行に普通のメッセージと待機通知がまとまることがある (観測 3/3)。行の全部が待機通知の時だけ足すのか、どれか 1 つでも足すのかは決める必要がある。全部が待機通知の時だけにしないと、返事の要るメッセージに「伝えることが無ければ 1 語」の文を添えることになる
  - 行の見分けは engine の文面と封筒の形 (`<teammate-message>`) に依る。版で変わりうる
  - 足した行は会話に残り続け、以後の全 request に載る。待機通知のたびに 1 行ずつ増える
  - 自 plugin の `$.session.append` は自分の `session.append` hook を通らない (re-entry で外される) ので、足した行は transcript-push の hook を通らない (jsonl には `plugin_note` の行として残る)。webui での見え方は見ていない

### 使わない方が良さそうな口

- `turn.start` で append (TA): main では間に合わない回が多く (r3 で 0/5)、その時は次の turn (人の次の prompt の turn) に回る。待機通知への注意書きが、人の prompt の turn に紛れ込む
- `session.receive` で append (RA): main が turn の途中だと、走行中の turn に入る。通知の turn には載らない
- `session.receive` の `text` の書き換え (RT): 文が teammate の封筒の中に入り、teammate の言葉として読まれる
- `session.append` の `content` の書き換え (AW): 通知の行そのものを変え、TUI に人の prompt の行として出る。transcript の通知の行も変わる (webui の待機通知の読み取り `parsePeerRelay` 等が影響を受けうる。未確認)
- `prompt.submit` の `context` と `agent.report` の `text`: 待機通知はこれらを通らない

### 同じ雑音の出るほかの起点

- 背景の task の通知・subagent の報告は `prompt.submit` (`origin.kind: "task-notification"`) を通るので、`context` を足す口 (guidance.ts と同じ event) が使える。`session.append` の `door: "prompt"`・`origin.kind: "task-notification"` の行で `next` の後に append しても、その turn に載った (r4 の task 2/2)
- 別のセッションの文 (ccmsg の `<cross-session-message>` も peer socket を通る。ccmsg の配達が同じ形かは今回は見ていない) は `prompt.submit` (`origin.kind: "peer"`) を通る。ただしこちらは返事の要る文なので、雑音の対象かどうかは別の判断

## 試験の環境に由来すること

- model の応答は代役の固定の文。実の model が足した文をどう読むか (`nothing_to_reply` の 1 語で答えるか) は見ていない
- 載り方は代役 (first-party でない host) に送られた request の形。first-party の API でも同じ形かは見ていない。model 名で載り方が変わる所 (tool_result の後ろが `role: "system"` になるか) があり、今回は `claude-opus-5-5` だけ
- teammate は in-process だけ。split pane (tmux の別プロセス) の teammate の待機通知は、leader のプロセスで `isVerified: false` になると型定義から読めるが、見ていない

## 未確認

- split pane の teammate の待機通知 (`session.receive` の `origin`、行の形)
- 複数の teammate の待機通知が 1 行にまとまる場合 (今回まとまったのは同じ teammate の普通のメッセージと待機通知だけ)
- `idleReason` が `available` 以外の待機通知 (teammate が失敗・中断した時)
- 待機通知が `prompt.submit` (`origin.kind: "unclassified"`) を通る場合があるか (型定義の `unclassified` の説明にある「idle notice」)
- `turn.start` の append が main で載る回と載らない回を分ける条件
- 実の model での読み方、webui の TL での `plugin_note` の行の見え方
- compaction を挟んだ後の、足した行の扱い
