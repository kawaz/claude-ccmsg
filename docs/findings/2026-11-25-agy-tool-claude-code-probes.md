# agy の tool のための Claude Code の実測 (M10: 判定を通して mod が答える形、M14: append の大きさ)

- Date: 2026-11-25
- 対象: Claude Code 2.1.332 (試験用の plugin を `--plugin-dir` で読ませた対話のセッション)
- 動機: [DR-0066](../decisions/DR-0066-agy-conversation-tool.md) の「要る実測」のうち M10 と M14。今の ccmsg の tool は `tool.call` で `next` を呼ばずに答えるので permission の判定を一切通らない (DR-0066 の C1)。agy に依頼を書く tool は外のサービスに中身を送るので、判定を通した上で mod が答える形があるかを確かめる。M14 は応答の本文を `$.session.append` で会話に足す時の大きさの上限
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

## コードを読んだだけのこと

- 2.1.332 の型定義 (plugin の `.claude-plugin/types` に engine が書くもの) の `tool.run`: 「呼び出しが許可されて実行される直前に上がる。`tool.call`・PreToolUse・`tool.check` と ask を決めた者の後で、拒否された呼び出しには上がらない」「`{ result, context? }` で tool の代わりに答える」「`e` は許可された呼び出しで、書き換えは拒まれる」
- 同じ型定義の `$.tool.register`: 「`{ tool: "mcp__<plugin>__<name>" }` の hook で答える。許可された後の `tool.run` か、permission の判定より前の `tool.call` で」
- `tool.judge`: auto mode が classifier に聞く直前に上がる event。`next(e)` は server の判定 (model の呼び出しを server が判定した場合) か手元の classifier の判定を返す
- auto mode の判定を代役で模したこと: 2.1.332 は auto mode の request の body に `safeguards: [{ type: "dangerous_tool_use", classifier_context: {…} }]` を付け、判定を応答の `message_delta` の `delta.safeguard_results` (`[{ type: "dangerous_tool_use", status: { type: "available", tool_uses: { <tool_use_id>: { type: "evaluated", outcome: "flagged" | "not_flagged", explanation? } } } }]`) で受け取る。この形は Claude Code の実行ファイルの中の schema の文字列から読んだもので、本物の server の応答では確かめていない

## 取れなかったこと

- teammate からの呼び出し (subagent だけを試した)
- 本物の server 側の classifier の判定 (代役が模した判定だけ)
- permission の allow rule (`mcp__<plugin>__<name>`) を入れた時に、f4 がダイアログ無しで `tool.run` まで進むか
- 8 MiB を超える append、日本語など複数 byte の文字の append、subagent (`agentId` 付き) への大きな append
- 本物のモデルの context の上限・API の request の大きさの上限に当たる大きさの append の扱い
- auto mode で subagent が報告を返す時に、手元の classifier ("security monitor") への request が出ることがあった (subagent の報告の扱いが代役と合わずに繰り返した回)。何を判定しているかは調べていない

## 実用的な示唆

- M10 の答え: 判定を通して自前で答える形は、tool を `$.tool.register` で登録し、答えを `tool.call` でなく `tool.run` の hook で返す形 (f4)。DR-0039 の Alternatives の表の「permission を通しつつ自前で答える形は見つかっていない」は、2.1.332 では当たらない
- f4 にすると、default の permission mode では呼び出しのたびにダイアログが出る。人に許可を求めずに通すには allow rule が要る (確かめていない)
- M14 の答え: 代役に向けた request では、8 MiB までの本文が append で欠けずに載る。DR-0066 の Q7 の判断材料としては、append の口の上限は退避の大きさを決める制約にならず、決めるのはモデルの context に載せてよい量の方。足した行は会話に残り続け、後の request のたびに載る

## 検証の詳細

- 試験用の plugin の hook: `session.start` (tool の登録)、`tool.check` / `tool.judge` (`next(e)` の結果を記録して返す)、`classic.PreToolUse` / `classic.PermissionRequest` (記録して `next`)、形ごとの `tool.call` / `tool.run`、M14 用の tool `ap` (`tool.call` で n bytes を `$.session.append` してから `next` を呼ばずに答える)
- ダイアログが出たかは、10 秒以内に代役へ次の request が来ず、画面に `Do you want to proceed?` が出ていることで判定し、Enter (Yes) か `3` (No) で答えた
- 代役は Claude Code 2.1.332 の request の形に合わせて次を足した: `messages` に入る `role: "system"` の message を指示の読み取りから外す、起動ごとに tool_use の id を変える (同じ id が会話に 2 回出ると Claude Code が tool_result の組を直して `[Tool use interrupted]` にする)、auto mode の subagent には `SubagentHandback` を呼ばせる (呼ばないと報告を催促する request が繰り返される)
