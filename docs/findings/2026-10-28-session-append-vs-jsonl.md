# `session.append` が運ぶものと transcript の jsonl の行の突き合わせ (DR-0045 §2 の段階 0)

- Date: 2026-10-28
- 対象: Claude Code 2.1.312
- 動機: [DR-0045](../decisions/DR-0045-say-speaks-in-tool-shown-from-transcript.md) §2 は、module が `session.append` の `e` を daemon に流し、daemon がそれを会話の行の正本にする設計。次の 4 つが未検証だった。
  - jsonl の全種の行が `session.append` を通るか
  - `e.message` は jsonl の行と同じ形か
  - 書き込みと append はどちらが先か
  - compaction の前後で何が来るか
- 方法:
  - 隔離した `CLAUDE_CONFIG_DIR` と空の作業ディレクトリで、`claude -p` を `--plugin-dir` の観測 mod と一緒に走らせた
  - model の応答は Messages API の代役 (reference `claude-mods/lab-setup`) が返した。prompt の印で次を返す:
    - `TOOLRUN`: Bash の tool_use
    - `AGENTRUN`: Agent の tool_use (subagent の request には文)
    - compaction の request: 要約
  - 観測 mod の記録:
    - `session.append` の hook で `e` を丸ごと記録した
    - `next(e)` の前と後に、jsonl (main の `<sid>.jsonl` と `<sid>/subagents/*.jsonl`) にその `uuid` の行があるかを調べた
    - hook の後 20 ms / 200 ms / 1 s / 3 s にも調べ直した。`-p` は応答の後すぐ終わるので、後ろ 2 つはほぼ記録されない
  - 走らせたもの:
    - run 1 / 2: Bash を 1 回使う turn
    - run 3: background の subagent を 1 つ起こす turn (完了の知らせで続く turn を含む)
    - run 4: run 1 のセッションを `--resume` して `/compact`
  - 突き合わせ: jsonl の行 (uuid を持つもの) と append の `e.uuid` を、run ごとに比べた。run 1 の append の記録は手で見た分だけで、表の集計は run 2〜4

## 判明した事実

### 1. どの行が来るか

| jsonl の行の種類 | append で来たか |
|---|---|
| `user` (人の prompt、tool_result、compaction の要約、`/compact` の command の 3 行) | 全部来た |
| `assistant` (text、tool_use) | 全部来た |
| `attachment` の各種 (environment、model、deferred_tools_delta、agent_listing_delta、skill_listing、total_tokens_reminder、session_context、date、remote_session_change、prompt_snapshot) | 全部来た |
| `system` / `compact_boundary` | 来た (`door: "compaction"`) |
| subagent の jsonl の行 (user、assistant、attachment の各種) | 全部来た。`e.agentId` が付く |
| uuid を持たない行 (`queue-operation`、`api-request`、`api-request-blob`、`api-request-shape`、`atis-latch`、`tools-used`、`last-prompt`、`cost-state`、`mode`) | 1 つも来ない |

jsonl に行の無い append もあった:

- `door: "queue"` の user (prompt が queue に入った時。jsonl ではこれに当たるのは uuid の無い `queue-operation`): 各 run の prompt ごとに 1 つ
- compaction の後、残した assistant の行が、前と同じ `uuid` で append にもう一度来た (run 4 の `a885be6a`、run 1 で書かれた行)。jsonl には二度目は書かれていない

### 2. 形

`e` は `{ message, door, origin, uuid, agentId? }`。`e.message` は jsonl の行ではなく、API の message に近い形 (`{ type, role?, name?, content }`)。

| 行の種類 | `e.message.content` と jsonl の行の比較 | jsonl の行にだけあるもの |
|---|---|---|
| assistant | `content` は同じ (tool_use の `id` / `name` / `input` を含む) | `timestamp`、`parentUuid`、`isSidechain`、`message.id` / `model` / `usage` / `stop_reason`、`requestRef`、`effort`、`cwd`、`sessionId` 等 |
| user (tool_result) | `content` は同じ | `toolUseResult` (stdout 等の構造)、`sourceToolAssistantUUID`、`permissionDecision`、`timestamp` 等 |
| user (prompt) | jsonl では文字列、`e` では 1 つの text block の配列 | `promptSource`、`turnOrigin`、`turnPosition`、`permissionMode`、`origin` (peer の封筒)、`isMeta`、`isCompactSummary`、`timestamp` 等 |
| attachment | `e` は描画された文 (`<system-reminder>…`) の text block だけ。`name` が attachment の種類 | `attachment` の構造そのもの (例: task_reminder の項目、prompt_snapshot の中身)、`rendered`、`timestamp` 等 |
| system (compact_boundary) | `e` は `Conversation compacted` の text だけ | `subtype`、`compactMetadata`、`logicalParentUuid`、`timestamp` 等 |

`door` の値と行の対応: `prompt` (人の prompt)、`queue`、`attachment`、`response` (assistant)、`tool-result`、`compaction`、`command`。`origin` は `{ kind: "engine" | "unclassified" | "model" | "tool", model?, tool? }`。

### 3. 順と書き込みの時機

- append の順は、jsonl の行の順と同じ。main と各 subagent を別々に比べて、run 2〜4 の全部で一致した
- append の時点では、jsonl にその行はまだ無い。`next(e)` の直後にも無かった (全件)
- 書き込まれるのは append の後
  - 20 ms 後に見つかったのは 5 / 46 件
  - 200 ms 後には、jsonl に行のある append は全部見つかった (22 / 22 件。見つからなかった 2 件は、jsonl に行の無い `queue` の append)
- `--resume` の起動で、それまでの履歴は append で来ない (run 4 の最初の append は `/compact` の `queue`)

### 4. compaction

`/compact` で来た append の順:
1. `queue` (`/compact`)
2. `session.compact` の hook
3. `compaction` の `system` (compact_boundary)
4. `compaction` の `user` (要約、jsonl では `isCompactSummary: true`)
5. 残した assistant の行 (前と同じ uuid、§1)
6. `command` の user 3 行 (caveat、`<command-name>`、stdout)
7. 続く attachment の各種

## DR-0045 への含み

`e.message` で足りる用途と、足りない用途に分かれる。

| 用途 | `e.message` で足りるか |
|---|---|
| say / launch の tool_use の検出と副作用 (§6) | 足りる (`content` の tool_use の `id` / `name` / `input` が jsonl と同じ) |
| say の未読 (§7) | 足りる (tool_use の id。時刻は daemon が受けた時刻で足りる) |
| webui への中継 (§4) | 足りない。webui は jsonl の行 (timestamp、`promptSource`、`isMeta`、`toolUseResult`、`attachment` の構造、peer の封筒の `origin`) で描く |
| Status の fold (§5) | 足りない (`message.usage` / `model`、task_reminder の attachment の構造、timestamp) |
| API error と最後のユーザ入力 (§5) | 足りない (assistant の行の error の欄、timestamp、`promptSource` / `origin`) |

- uuid の重複除去は要る。compaction の後に同じ uuid の行がもう一度来る
- `queue` の append は jsonl に行が無いので、行の正本からは外す

## 試験の環境に由来すること

- 全部 `claude -p` での観測。対話のセッションでは見ていない。対話では、人の composer の prompt の `door` / `origin`、queue された prompt の `queued_command` の attachment、PushNotification 等が変わりうる
- model は代役で、thinking の block、API error の行、画像を含む行は出していない
- 書き込みの遅れは、行の少ない短い turn での値

## 未検証

- 対話のセッションでの同じ突き合わせ (特に人の入力、queue された prompt、peer の封筒の行)
- thinking を含む assistant、API error の行 (`isApiErrorMessage`)、`/clear` と `/resume` の後の append
- 長い turn で書き込みの遅れがどこまで伸びるか
