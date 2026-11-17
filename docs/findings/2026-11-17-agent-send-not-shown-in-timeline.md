# webui の入力欄から subagent に送った文が TL のどこにも出ない件の調べ

- Date: 2026-11-17
- 対象: Claude Code 2.1.325 (観測した行の `version`)、ccmsg v0.274.0 (webui・daemon・hooks module)
- 動機: kawaz 2026-11-17 の報告。worker (subagent) の TL を開いた状態で FAB (＋) の入力欄から送ると宛先はその agent になるが、送ったユーザのメッセージが agent の TL にも親のセッションの TL にも出ない
- 方法:
  - コードの経路を読んだ (入力欄 → op → サイドカーの依頼 → module → engine)
  - 実データ: 個人面の実 transcript (subagent の `subagents/agent-<id>.jsonl` と親のセッションの jsonl) と実 daemon の `daemon.log` を読んだ (読むだけ。会話の本文は写していない)
  - 再現: webui の Timeline を happy-dom でマウントし、実 transcript と同じ形の行 (本文だけ作り物) を初回の読み込みに返した (`packages/webui/test/timeline-agent-person-message.dom.test.ts`)。隔離 daemon と実ブラウザは使っていない

## 判明した事実

### 1. 送信の経路と、agent に届いたか

| 段 | 場所 | 何をするか |
|---|---|---|
| 入力欄 | `SessionInputComposer.tsx` の `handleAgentSubmit` | 宛先は agent の TL の間はその agent (`timelineAgentId`、人が選び直していなければ)。op `user_message { session_id, agent_id, text }` を送る。結果が `appended` なら入力欄を空にして閉じ、それ以外は理由を出す |
| daemon | `server.ts` の `case "user_message"` → `user-message.ts` | セッションの生きている run の module に、サイドカーの依頼 `agent.append { agentId, text }` を順に渡す。結果を `agent-input -> <sid> <agent id>: <outcome>` で `daemon.log` に書く |
| module | `hooks/subagents.ts` の `appendToAgent` | `$.session.append({ message: { type: "user", content: [{ type: "text", text: "ユーザから (ccmsg 経由):\n" + text }] }, agentId })` |
| agent | engine | 次の request で、直前の tool_result と同じ user message の text block として読む (DR-0039 §6) |

- 報告の時刻の 2 回の送信は、実 daemon の `daemon.log` に `agent-input -> 7c8b0b3a… a0f97ceb…: appended` として残っていた (08:19:58.808Z と 08:20:48.957Z)。どちらも subagent の transcript に行があり、その後に subagent の request (`api-request-blob`) と応答の行が続いていた。**メッセージは agent に届いている**。届かなかったのは表示だけ

### 2. transcript に残る行

subagent の transcript (`subagents/agent-a0f97ceb….jsonl`) に、送信 1 回につき 1 行:

| field | 値 |
|---|---|
| `type` | `"user"` |
| `isMeta` | `true` |
| `isSidechain` | `true` |
| `agentId` | subagent の id |
| `parentUuid` | null でない (直前の行) |
| `promptId` | 文字列 |
| `origin` | `{ kind: "plugin", name: "ccmsg-v1" }` (`name` は install された plugin の名前) |
| `promptSource` | 無し |
| `message.content` | text block 1 つの配列。text は `ユーザから (ccmsg 経由):` の行、改行、本文 |

- 行の位置は、subagent が実行中の tool の `tool_use` の行と、その `tool_result` の行の間 (2 回とも)。`timestamp` は daemon の `appended` の log の 3〜12 ms 前
- 親のセッションの transcript (`7c8b0b3a….jsonl`) に印の文字列は 0 件。**親のセッションには行が残らない**
- 同じ形 (`isMeta`、`origin.kind: "plugin"`、text block 1 つ) の行は、ccmsg 自身の案内 (`このセッションでは ccmsg が使える` で始まる)、他の plugin の注入、`ccmsg:<sid> から:` で始まる行 (11-08・11-09 の 4 行。どの版の module のどの経路が書いたかは確かめていない。今の `agent.send` は `$.session.send` を使い、[2026-11-10-session-append-vs-send](2026-11-10-session-append-vs-send.md) ではその行の origin は `coordinator`) にもあった。個人面の subagent の transcript で origin が plugin の行は 5 ファイル 11 行で、印で始まるのは上の 2 行だけ

### 3. TL の扱い (原因)

- webui の `classifyUserMessage` (`transcript-model.ts`) は、この行を `unknown-array` に分類していた: `promptSource` が `"system"` でなく、content は配列で、tool_result を含まず、長さ 1 の text block が中断の印にも skill の前置きにも当たらないため。`unknown-array` はユーザの発言の kind (`isUserSpeechKind`) ではないので、`classifyBoundaryLine` は null を返し、行は fold group (tool や thinking を畳む群) に入り、その中で `SystemMessageFold` (`▶ 時刻 unknown-array`) として描かれる
- 行は tool_use と tool_result の間にあるので、その tool を畳んだ fold group の中に沈む。fold group は既定で閉じているので、送った文は吹き出しとして出ず、開かない限り見えない
- セッション本体に送った prompt の行は `origin: { kind: "human" }`、`promptSource: "typed"`、content は文字列で、`user-prompt` に分類されて fold の外の右寄せの吹き出し (`UserPromptBubble`、`.tl-bubble-right`) になる。扱いが分かれるのは `classifyUserMessage` の分類だけで、描画の部品はどちらも同じ (分類が `user-prompt` なら同じ吹き出しを通る)
- daemon の `classifyUserInputRow` (`session-user-input.ts`) は `isSidechain` の行を最初に外す。daemon がこの fold に流すのはセッション本体の jsonl の行だけで、subagent の行はそもそも来ない。この件では関わらない

### 4. 送った直後の表示

- セッション本体に送った時も、楽観的な表示 (送った文を transcript の行の前に TL に出す仕組み) は無い。送った文が TL に出るのは、module の `transcript_push` を合図に daemon が jsonl の続きを読み (DR-0045)、`ev:"transcript"` で TL に届いた時
- agent の TL は live の push を購読しない (DR-0025 §4 / §8。`useLiveTailSubscription.ts` は agent の TL では購読しない)。daemon は `transcript_push` で agent の行 (`agent_id` 付き) も受けるが、relay の待ちに入れるのは `agent_id` の無い行だけ (`server.ts`)。agent の TL が新しい行を読むのは、TL を開いた時・別のセッションから戻った時・再接続した時の追いつきと「更新」だけ
- `$.session.append` が返った時点では jsonl にまだ行が無く、200 ms 以内に書かれる ([2026-10-28-session-append-vs-jsonl](2026-10-28-session-append-vs-jsonl.md) §3、append 全般の観測)。`appended` が返った直後に webui が agent の transcript を読み直しても、行を取り逃しうる

### 5. 「どこにも表示されない」の原因

2 つが重なっていた:

1. **分類**: agent の TL を読み直しても、送った文は `unknown-array` の system の行として閉じた fold group の中に沈み、ユーザの発言の吹き出しにならない (3)
2. **live の push の不在**: agent の TL は送った後に伸びないので、送った直後には行そのものが TL に来ない (4)。この後、agent の TL も開いている間その agent の transcript を購読し、agent の行の push を合図に daemon が読んで届けるようにした (DR-0025 §4 / §6)

親のセッションの TL には、行が transcript に無いので何も出ない (2)。

## 実用的な示唆

- 1 は webui の分類で直した: `classifyUserMessage` が、isMeta で origin が plugin の、text block 1 つの行のうち、text が印の行と改行で始まるものを `user-prompt` にし、`parseTranscriptLine` はその行の text segment を印の後の本文だけにする。人の文と分かるのは本文の頭の印だけなので、印の文字列を protocol の `AGENT_APPEND_MARK` に置き、webui はそれを読む。module の `agentMessage` が付ける印がこれと同じであることは hooks のテストで固定した (module の source は literal のまま。import に替えるには bundle の作り直しが要る)
- 2 は webui だけでは確実に直せない。直後に見せるには、daemon が agent の行の push を受けて jsonl への書き込みを待ってから agent の TL に届ける経路 (DR-0025 §8 の変更) が要る。webui が `appended` の後に追いつきを足すだけだと、書き込みより先に読んで取り逃しうる
- 届かなかった時は、今も入力欄が理由を出して文を残す (`agent-input.ts` の `not_delivered` / `unconfirmed` / `failed`)。この件では変えていない

## 検証の詳細

### 実データで確かめたこと

| 確かめたこと | 結果 |
|---|---|
| 報告の時刻の送信が daemon に届き module が足したか | `daemon.log` に `appended` が 2 件 (08:19:58.808Z、08:20:48.957Z) |
| subagent の transcript に行があるか | 2 件。`timestamp` は 08:19:58.796Z、08:20:48.954Z |
| 行の形 | 上の 2 の表 (2/2 同じ) |
| 親のセッションの transcript に行があるか | 印の文字列は 0 件 |
| 送った後に agent が読んだか | 2 件とも、行の後に subagent の request と応答の行が続いた |
| 同じ形の行で印の無いもの | 個人面の subagent の transcript で origin が plugin の行 11 行のうち 9 行 (ccmsg の `ccmsg:<sid> から:` が 4 行、他の plugin が 5 行) |

### 分類の確認

実 transcript と同じ形の行を `parseTranscriptLine` に通した結果 (直す前): `userMessageKind: "unknown-array"`、segment は印の行を含む text 1 つ、`classifyBoundaryLine` は null。

### DOM テスト (`timeline-agent-person-message.dom.test.ts`)

agent の TL を開き、spawn prompt → Bash の tool_use → 人の文の行 → tool_result → 応答、の並びを返した。

| テスト | 直す前 | 直した後 |
|---|---|---|
| 人の文が右寄せの吹き出しに本文だけで出る | 落ちる (吹き出しが無い) | 通る |
| 吹き出しがセッション本体の prompt と同じ class・同じ本文の出し方 | 落ちる (吹き出しが無い) | 通る |
| 印で始まらない plugin の行 (`ccmsg:<sid> から:`) は吹き出しにならない | 通る | 通る |

### 未確認

- 実ブラウザと隔離 daemon での見え方 (DOM テストだけで確かめた)
- in-process の teammate に append した時の行の形 (観測したのは subagent の 2 行だけ。teammate の TL でも同じ分類になる見込みだが、行は見ていない)
- `appended` の返事と、agent の jsonl への行の書き込みの前後 (agent に向けた append での実測は無い。上の 200 ms は main と subagent の行全般の観測)
