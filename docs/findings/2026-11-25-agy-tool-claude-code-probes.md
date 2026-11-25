# agy の tool のための Claude Code の実測 (M10: 判定を通して mod が答える形、M14: append の大きさ、M19・M20: 起こした turn に append が載るか)

- Date: 2026-11-25
- 対象: Claude Code 2.1.332 (試験用の plugin を `--plugin-dir` で読ませた対話のセッション)
- 動機: [DR-0066](../decisions/DR-0066-agy-conversation-tool.md) の「要る実測」のうち M10・M14・M19・M20。今の ccmsg の tool は `tool.call` で `next` を呼ばずに答えるので permission の判定を一切通らない (DR-0066 の C1)。agy に依頼を書く tool は外のサービスに中身を送るので、判定を通した上で mod が答える形があるかを確かめる。M14 は応答の本文を `$.session.append` で会話に足す時の大きさの上限。M19・M20 は、止まっている相手に本文を append して起こす知らせで起こす形 (DR-0066 の K14・K15) で、本文が起きた turn の最初の request に載るか
- 方法:
  - リポの外の一時ディレクトリに、隔離した config dir・手元の代役の Messages API・試験用の plugin を置き、専用の socket の tmux で試験用のセッションだけを操作した。API key はダミー
  - 試験用の plugin が `session.start` で `$.tool.register` した tool と、plugin の `.mcp.json` の stdio MCP server の tool に、下の 5 つの形で答えさせた。代役は user の文の `CALL <tool> {json}` でその tool を呼ぶ tool_use を返し、`SUB <tool> {json}` で subagent (general-purpose、background で起きる) を起こしてその中で呼ばせる
  - 判定を通ったかは、plugin の hook の記録 (`classic.PreToolUse`・`tool.check`・`tool.judge`・`classic.PermissionRequest`・各形の handler)、代役が受けた request の tool_result、画面のダイアログで見た
  - auto mode の判定は、2.1.332 では server 側の classifier の判定を API の応答で受け取る形だった (下の「auto mode の判定を代役で模したこと」)。代役は tool の入力に `FLAG` を含む tool_use を flagged、それ以外を not_flagged と答えた。本物の server 側の classifier は通していない

形の定義:

| 形 | 答え方 |
|---|---|
| f1 | `tool.call` で `next` を呼ばずに `{ result }` を返す (今の ccmsg の形) |
| f2 | `tool.call` で `await next(e)` で判定を通し、core が返す「no hook answered」のエラーの結果を自前の `{ result }` に差し替える |
| f3 | `tool.call` で `$.tool.check` に判定を聞き、`deny` でなければ `{ result }` を返す |
| f4 | `tool.run` で `{ result }` を返す (2.1.332 の型定義にある event。呼び出しが許可された後にだけ上がる) |
| f5 | plugin の `.mcp.json` の stdio MCP server の tool を `tool.call` で `next(e)` に通し、server の結果を mod が差し替える |

## 判明した事実 (観測)

### M10: 形 × permission mode × 呼び手

各升は 2 回以上取った。default の「ダイアログ」は Yes (1 回だけ許可) を選んだ時の結果で、No の結果は別に書く。auto は代役の判定が not_flagged / flagged の 2 通りを、それぞれ 2 回ずつ取った。

| 形 | default・本体 | default・subagent | auto・本体 | auto・subagent |
|---|---|---|---|---|
| f1 | 判定の hook が 1 つも上がらず、ダイアログ無しで答えた (5 回) | 同じ (2 回) | `tool.judge` が上がらず、flagged の呼び出しにも答えた (各 2 回) | 同じ (各 2 回) |
| f2 | PreToolUse → `tool.check` が ask → ダイアログ。Yes で `next` が core のエラーを返し、差し替えて答えた (2 回)。No で `next` が拒否の文を返した (2 回) | ダイアログが本体の画面に出て、Yes で差し替えて答えた (2 回) | not_flagged: `tool.judge` が allow、差し替えて答えた。flagged: `tool.judge` が deny、`next` が classifier の拒否の文を返した (各 2 回) | 同じ (各 2 回) |
| f3 | `$.tool.check` は ask を返し、ダイアログも PreToolUse も無しに答えた (2 回) | 同じ (2 回) | `tool.judge` が上がらず、flagged の呼び出しにも答えた (各 2 回) | 同じ (各 2 回) |
| f4 | PreToolUse → `tool.check` が ask → ダイアログ。Yes で `tool.run` が上がって答えた (2 回)。No で `tool.run` は上がらず、拒否の結果になった (2 回) | ダイアログが本体の画面に出て、Yes で答えた (2 回)。No で `tool.run` は上がらなかった (2 回) | not_flagged: `tool.judge` が allow、`tool.run` が上がって答えた。flagged: `tool.judge` が deny、`tool.run` は上がらなかった (各 2 回) | 同じ (各 2 回) |
| f5 | PreToolUse → `tool.check` が ask → ダイアログ。Yes で server が答え、mod の差し替えが tool_result になった (2 回) | 同じ (2 回) | not_flagged で差し替えた答え、flagged で classifier の拒否 (各 2 回) | 同じ (各 2 回) |

- **判定を通した上で mod が自前で答える形は f4 (`tool.run`) で作れる**。f4 は default のダイアログ (Yes / No)、auto の classifier の判定 (allow / deny) のどちらにも従い、拒否された呼び出しでは handler が呼ばれなかった。本体と subagent で同じだった
- subagent からの呼び出しも判定を通る (f2・f4・f5)。default のダイアログは本体の画面に出た。`tool.check`・`tool.judge`・`tool.run` の `e.agentId` には subagent の id が入っていた
- f2 も判定を通るが、core が返すエラーの文言に合わせて差し替える形で、文言は版で変わっている。2.1.299 の観測 (reference の `claude-mods/dollar-api`) では `no tool.call hook answered`、2.1.332 では `<plugin> registered the tool <name> but no hook answered this call: add on("tool.run", { tool: "<name>" }, ($, e) => ({ result: ... })) to the plugin.`。文言に合わせる作りは版の更新で壊れる
- f1 と f3 は判定を通らない。f3 の `$.tool.check` は判定を聞くだけで、ダイアログも PreToolUse も classifier も起こさず、ask を返した呼び出しでも mod が答えれば実行になる
- 判定を通る形 (f2・f4・f5) では、permission mode が default の時、呼び出しのたびにダイアログが出た (plugin の tool は mode の ask になる)。auto では ask の呼び出しが classifier に回った
- auto で代役が判定を返さなかった時 (応答に判定が無い・形が違う)、f4 の呼び出しは「server-side auto mode classifier gave no verdict」の拒否になり、`tool.run` は上がらなかった。判定が取れない時は止まる側に倒れる。代役の応答に判定を足す前は、セッションの最初の呼び出しで「Auto mode can't check actions in this session」の画面が出た

### M10 の追加: f4 の tool 名の完全一致の allow rule

試験用の config dir の settings の `permissions.allow` に `mcp__permprobe__f4` (mod が `$.tool.register` で登録した tool の名前そのまま、`mcp__<plugin>__<name>`) を入れて、同じように呼んだ。

| mode | 本体 | subagent |
|---|---|---|
| default | ダイアログ無し。`tool.check` が `{ decision: "allow", rule: "mcp__permprobe__f4" }` を返し、`tool.run` が上がって答えた (2 回) | 同じ (2 回) |
| auto | `tool.check` が上と同じ allow を返し、`tool.judge` は上がらず (classifier に聞かない)、`tool.run` が上がって答えた。代役が flagged と答えた呼び出しも同じく通った (not_flagged・flagged 各 2 回) | 同じ (各 2 回) |

- permission の rule での名前は `mcp__<plugin>__<name>` の形で効いた。PreToolUse はこの時も上がった
- allow rule の無い f4 は、同じ版で default ではダイアログ、auto では classifier の判定に従った (上の表)。完全一致の allow を足すと、その範囲では判定を通らずに呼べる

### M14: `$.session.append` で足せる本文の大きさ

`tool.call` の handler の中 (本体が tool を実行中) で、ASCII の n bytes の文を `type: "user"` の行として足し、次の request の body に載った長さを測った。各大きさで 2 回取り、2 回目は n+1 bytes にした。1 MiB までは 1 つのセッションで順に足し、4 MiB と 8 MiB はそれぞれ新しいセッションで足した。

| n (bytes) | append | 次の request に載った長さ | 回数 |
|---|---|---|---|
| 1,000 / 4,096 / 16,384 / 65,536 / 262,144 / 1,048,576 | 成功 (14 ms 以内) | n と同じ (欠けなし) | 2 回 |
| 4,194,304 | 成功 | n と同じ | 2 回 |
| 8,388,608 | 成功 | n と同じ | 2 回 |

- 8 MiB まで、append は成功し、次の request に欠けずに載った。それより大きい値は試していない
- 載った場所は、tool_result の user message の後ろの `role: "system"` の message の text block で、本文の前に `Note from the <plugin> plugin, not from the user:` の 1 行が付く (同じ block の先頭には `<total_tokens>…</total_tokens>` も入っていた)
- 足した行は会話に残り、後の request にも毎回載る (1 MiB までの 6 回分を足した後の request に 6 つとも載っていた。8 MiB を足した後の次の turn の request にも載っていた)
- 代役は usage を常に小さく返すので、Claude Code は大きな本文を足した後も autocompact に入らなかった。本物のモデルの context の上限と、API の request の大きさの上限に当たった時の挙動は見ていない

### M19: 止まっている本体に append してから起こす

本体が turn を終えて止まっている時に、mod の command (`/probe`) の中で `$.session.append` (`type: "user"`、本文は `agyid:PROBE から:` の行と印の行) で足し、それから起こす文 `この知らせ自体への対応は不要。足された文があれば読んで続けよ` を 3 つの経路で入れた。permission mode は default、model 名は `claude-haiku-5-5`。

| 起こす経路 | 回数 | append から起こすまでの request | 起きた turn の最初の request に append が載ったか | 並び |
|---|---|---|---|---|
| tmux の入力 (人の prompt と同じ) | 2 | 0 | 載った (2/2) | append が先。同じ user message の中で、append の block が先頭にあり、起こす文の block が最後 |
| mod の `$.prompt.submit` (command の後に timer から) | 2 | — (submit は 300 ms 後) | 載った (2/2) | append が先。同じ user message の中で append の block が先頭、起こす文 (`The permprobe plugin sent a message:` の枠付き) が最後 |
| 試験用セッション自身の peer socket に書いた封筒 (`<cross-session-message from="ccmsg:wakeup">`) | 2 | 0 | 載った (2/2) | append が先。同じ user message の中で append の block が先頭、封筒の block (`Another Claude session sent a message:` の peer の注意書き付き) が最後 |

- 止まっている本体への append は request を起こさなかった (append から起こすまでに request 0 件。各 2 回)
- `$.prompt.submit` を command.run の hook の中から呼ぶと `prompt.submit: called from a command.run hook, it would wait on the turn this hook is holding; submit from a later event` で断られた (2/2)。timer (`$.clock.after`) から呼ぶと通った
- 起きた turn の最初の request の user message は、tmux の回が `[append, context の reminder 2 つ, command の行, 起こす文]`、peer の回が `[append, command の行, 封筒]` の順だった (command の行はこの試験の `/probe` の行)

### M20: 待機中の teammate・終わった subagent を起こし、その turn の始まりで append する

mod の command の中で、相手の `agentId` に `$.session.append` を試し (断られることの確認)、`$.session.send({ to: { agentId }, text: "ccmsg:wakeup から:\n<起こす文>" })` で起こし、その agent の新しい turn の `turn.start` (`next(e)` の前に append を await) か、最初の `turn.step` (`next(e)` の前に append を await) で本文を足した。teammate は in-process (agent teams を有効にした試験用の settings)。

| 相手 | 足した所 | 起こす前の append | 起きた turn の最初の request に載ったか | 並び |
|---|---|---|---|---|
| 終わった subagent (`completed`) | `turn.start` | `refused: no running loop is <agentId>` (3/3) | 載った (3/3) | append が先。同じ user message の中で、append の block、続けて「The coordinator sent a message while you were working: … Address this before completing your current task.」の枠の起こす文 |
| 終わった subagent | 最初の `turn.step` | 断られた (2/2) | 載らなかった (2/2)。append は成功を返した | 起こす文だけ |
| 待機中の teammate (`idle`) | `turn.start` | 断られた (3/3) | 載った (3/3) | append が先。同じ user message の中で、append の block、続けて `<teammate-message teammate_id="team-lead" summary="ccmsg:wakeup から:">` の起こす文 |
| 待機中の teammate | 最初の `turn.step` | 断られた (2/2) | 載らなかった (2/2)。append は成功を返した | 起こす文だけ |

- **`turn.start` で足せば、起きた turn の最初の request に載る**。並びは append が起こす文より前で、DR-0066 の K14・K15 が想定した「後に来る」とは逆だった
- `turn.step` で足した行は失われず、その agent の次の request に回った。上の 2 回の後に同じ agent をもう一度起こした (今度は `turn.start` で別の印を足した) ところ、その turn の最初の request に、新しい印・`turn.step` で足した印・2 回目の起こす文の順で載った (subagent 1 回、teammate 1 回)。起こした turn が 1 回の request で終わる時は、その turn では読まれない
- `turn.start` の型定義の説明: 「An agent's first request waits for these hooks, 3 seconds at most」、`$.session.append` の `agentId` の説明: 「A run counts from its `turn.start`, where an awaited `user` row rides its first request」。観測はこれと合う。3 秒を超える hook でどうなるかは試していない
- `turn.start` の回数には、下の「起こし直し」の回 (subagent・teammate 各 1 回) を含む
- teammate の `turn.step` の 1 回は、試験の手順の誤り (agent の id を取る前に起こした) で数えていない

### append の載り方 (DR-0066 の C10・§7 との食い違い)

DR-0066 の C10 と §7 は「append の本文は user の文の text block に枠の無いまま入る」と書く。根拠の findings [2026-11-10-session-append-vs-send](./2026-11-10-session-append-vs-send.md) は Claude Code 2.1.322 で、どの宛先でも「user message の text block。枠は無く、本文そのまま」だった。2.1.332 で見た形:

| 条件 | model 名 | 載った形 | 回数 |
|---|---|---|---|
| 本体が tool を実行中 (M14) | claude-haiku-5-5 | tool_result の user message の後ろの `role: "system"` の message。text は `<total_tokens>…</total_tokens>` の後に `Note from the permprobe plugin, not from the user:` の行、続けて本文 | 1 MiB までの 6 種 × 2 回、4 MiB・8 MiB 各 2 回 |
| 走っている subagent が tool を実行中 (`agentId` 付き) | claude-haiku-5-5 | 同じ (`role: "system"` の message、`Note from …` の行付き) | 2 回 |
| 本体が tool を実行中 | claude-sonnet-4-5 | 別の message にならず、tool_result の content の中に `<system-reminder>\nNote from the permprobe plugin, not from the user:\n<本文>` として畳み込まれた | 2 回 |
| 止まっている本体に足し、次の turn で読まれる (M19) | claude-haiku-5-5 | その turn の user message の text block。`<system-reminder>\nNote from the permprobe plugin, not from the user:\n<本文>\n</system-reminder>` | 6 回 |
| 起こした subagent / teammate の `turn.start` で足す (M20) | claude-haiku-5-5 | 同じ (user message の text block、`<system-reminder>` と `Note from …` の行付き) | 6 回 |

- どの条件でも `Note from the <plugin> plugin, not from the user:` の行が付いた。2.1.322 の findings では同じ条件 (本体の tool の実行中、止まっている本体の次の turn) で枠は無かったので、この行は条件でなく版の違いと見る
- tool の実行中に足した時に `role: "system"` の message になるか tool_result に畳み込まれるかは model 名で変わった。2.1.332 の型定義の説明 (`SessionAppendArgs.message`) は「tool result のすぐ後ろでは、それを受け付ける model なら system message にする。他の model では result に畳み込む。それ以外の所では user の turn の中に囲って入れる」と書いていて、観測と合う
- 本文の頭の印 (`agyid:PROBE から:`) はどの形でも残った
- 本物のモデル (first-party の API) に送る request でも同じ形かは見ていない (代役に向けた request だけ)

## コードを読んだだけのこと

- 2.1.332 の型定義 (plugin の `.claude-plugin/types` に engine が書くもの) の `tool.run`: 「呼び出しが許可されて実行される直前に上がる。`tool.call`・PreToolUse・`tool.check` と ask を決めた者の後で、拒否された呼び出しには上がらない」「`{ result, context? }` で tool の代わりに答える」「`e` は許可された呼び出しで、書き換えは拒まれる」
- 同じ型定義の `$.tool.register`: 「`{ tool: "mcp__<plugin>__<name>" }` の hook で答える。許可された後の `tool.run` か、permission の判定より前の `tool.call` で」
- `tool.judge`: auto mode が classifier に聞く直前に上がる event。`next(e)` は server の判定 (model の呼び出しを server が判定した場合) か手元の classifier の判定を返す
- auto mode の判定を代役で模したこと: 2.1.332 は auto mode の request の body に `safeguards: [{ type: "dangerous_tool_use", classifier_context: {…} }]` を付け、判定を応答の `message_delta` の `delta.safeguard_results` (`[{ type: "dangerous_tool_use", status: { type: "available", tool_uses: { <tool_use_id>: { type: "evaluated", outcome: "flagged" | "not_flagged", explanation? } } } }]`) で受け取る。この形は Claude Code の実行ファイルの中の schema の文字列から読んだもので、本物の server の応答では確かめていない

## 取れなかったこと

- teammate からの tool の呼び出し (M10 は subagent だけを試した)
- M19・M20 の auto mode での並び、本物の ccmsg の daemon が書く封筒・`agent.send` での並び (この試験は mod と試験用の道具で同じ形を作った)
- M20 の `turn.start` の hook が 3 秒を超えた時
- 本物の server 側の classifier の判定 (代役が模した判定だけ)
- 8 MiB を超える append、日本語など複数 byte の文字の append、subagent (`agentId` 付き) への大きな append
- 本物のモデルの context の上限・API の request の大きさの上限に当たる大きさの append の扱い
- auto mode で subagent が報告を返す時に、手元の classifier ("security monitor") への request が出ることがあった (subagent の報告の扱いが代役と合わずに繰り返した回)。何を判定しているかは調べていない

## 実用的な示唆

- M10 の答え: 判定を通して自前で答える形は、tool を `$.tool.register` で登録し、答えを `tool.call` でなく `tool.run` の hook で返す形 (f4)。DR-0039 の Alternatives の表の「permission を通しつつ自前で答える形は見つかっていない」は、2.1.332 では当たらない
- f4 にすると、allow rule の無い時は、default の permission mode では呼び出しのたびにダイアログが出る。tool 名 (`mcp__<plugin>__<name>`) の完全一致の allow rule を入れると、default でも auto でも判定を通らずに呼べた (DR-0066 の K12 が依る点)
- M19・M20 の答え: 止まっている本体は、append の後にどの経路で起こしても、起きた turn の最初の request に append が載る。待機中の teammate・終わった subagent は、起こした後のその agent の `turn.start` で append すれば最初の request に載る (`turn.step` では遅い)。どちらも並びは append が起こす文より前
- M14 の答え: 代役に向けた request では、8 MiB までの本文が append で欠けずに載る。DR-0066 の Q7 の判断材料としては、append の口の上限は退避の大きさを決める制約にならず、決めるのはモデルの context に載せてよい量の方。足した行は会話に残り続け、後の request のたびに載る

## 検証の詳細

- 試験用の plugin の hook: `session.start` (tool の登録)、`tool.check` / `tool.judge` (`next(e)` の結果を記録して返す)、`classic.PreToolUse` / `classic.PermissionRequest` (記録して `next`)、形ごとの `tool.call` / `tool.run`、M14 用の tool `ap` (`tool.call` で n bytes を `$.session.append` してから `next` を呼ばずに答える)
- ダイアログが出たかは、10 秒以内に代役へ次の request が来ず、画面に `Do you want to proceed?` が出ていることで判定し、Enter (Yes) か `3` (No) で答えた
- 代役は Claude Code 2.1.332 の request の形に合わせて次を足した: `messages` に入る `role: "system"` の message を指示の読み取りから外す、起動ごとに tool_use の id を変える (同じ id が会話に 2 回出ると Claude Code が tool_result の組を直して `[Tool use interrupted]` にする)、auto mode の subagent には `SubagentHandback` を呼ばせる (呼ばないと報告を催促する request が繰り返される)
