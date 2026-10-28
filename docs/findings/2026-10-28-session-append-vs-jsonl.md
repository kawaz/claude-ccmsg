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
- content が空の `hook_success` の attachment (`door: "hook-context"`)。§6 (追記) で観測した

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

### 5. 対話のセッション (追記)

方法: `--plugin-dir` の観測 mod で、tmux の中の対話のセッション (`--permission-mode default`、代役の model) を起動した。次の 4 つの turn を観測した:
- composer に打った prompt
- 25 行を 200 ms ずつ stream する応答の最中に、composer で打った 2 つ目の prompt
- 同じ stream の最中に、セッションの peer の socket へ直接書いたメッセージ (reference `claude-mods/scripts/uds-send.py`)
- idle の時の同じ peer のメッセージ

| 場面 | append (`door` / `origin`) | jsonl の行 |
|---|---|---|
| composer の prompt | `prompt` / `{kind:"composer"}` | user (`promptSource: "typed"`、`origin: {kind:"human"}`) |
| stream の最中に打った prompt | `prompt` / `{kind:"composer"}`。いまの turn が終わった後に来た | user (`promptSource: "queued"`、`origin: {kind:"human"}`)。`queued_command` の attachment にはならず、次の turn の prompt になった |
| stream の最中の peer のメッセージ | 先に `queue` / `{kind:"engine"}` (jsonl に行は無い)。turn が終わった後に `prompt` / `{kind:"peer"}` | user (`promptSource: "system"`、`isMeta: true`、`origin: {kind:"peer", name, body, verifiedPeerPid, …}`) |
| idle の時の peer のメッセージ | `prompt` / `{kind:"peer"}`、その後に `queue` | 同上 |
| 各 turn の終わり | `notice` / `{kind:"engine"}` の system (`name: "turn_duration"`、content は空) | system (`isMeta: false`) |

- uuid を持つ jsonl の行は、全部 append で来た。順も同じだった (28 行)
- jsonl に行の無い append は、peer の 2 件の `queue` だけ
- 書き込みの時機: 20 ms 後に見つかったのは 5 / 28 件。200 ms 後には 28 / 28 件。`-p` と同じ傾向
- `e.message` に `promptSource` と `origin` の構造 (peer の名前・本文・pid) は無い。人の入力と peer の区別は `e.origin.kind` (`composer` / `peer`) でできる
- stream の最中に打った prompt が `queued_command` の attachment になる場面 (tool の実行中に打った時) は、この観測では出なかった

### 6. hook の出力の attachment (追記)

動機: DR-0045 の段階 2 の daemon で、tool を使う turn のたびに `transcript relay: gave up waiting ... rows=N after 5000ms` が出た (push で受けた uuid の行が、5 秒待っても jsonl に現れない)。

方法:
- 一時的に workspace を切り出し、daemon の `transcript_push` の受け口で、受けた各行の `uuid` / `door` / `agent_id` と、`message` の `type` / `role` / `name` / `content` の先頭を daemon.log に書くようにした (確認の後に workspace ごと捨てた)
- その workspace の daemon と、`--plugin-dir` でその module を読む対話のセッション (tmux、代役の model、`--allowedTools Bash`) を起動した
- 次の 3 つの turn を進め、push で受けた uuid を jsonl の uuid と突き合わせた
  - 文だけの turn
  - TaskCreate の turn
  - Bash の turn (`echo`)
- hook は、試験用の config home に入った plugin の hook が走った (下の「試験の環境に由来すること」)

| 場面 | jsonl に行の無い append | jsonl の側 |
|---|---|---|
| 起動 (SessionStart の hook 5 つ) | `door: "hook-context"`、`message: { type: "attachment", role: "user", name: "hook_success", content: [] }` が 3 件 | content のある `hook_success` (content は `<system-reminder>` の text) と、`hook_non_blocking_error` (append の content は `[]`) は、同じ uuid で書かれていた |
| 文だけの turn | 無し (`queue` を除く) | — |
| TaskCreate の turn (PreToolUse の hook 1 つ) | 上と同じ形の `hook_success` が 1 件。tool_result の append の直前に来た | 無し |
| Bash の turn (PreToolUse の hook 5 つ、PostToolUse の hook 1 つ) | 同じ形の `hook_success` が 6 件。tool_result の append の直前と直後にまとめて来た (5 件が前、1 件が後) | 無し |

- jsonl に書かれる hook の行は、起動時の 2 行 (content のある `hook_success`、`hook_non_blocking_error`) だけだった。tool の turn の hook の行は、別の uuid でも書かれていない (jsonl に `hook_*` の attachment がこの 2 行のほか無い)
- jsonl に行の無い append を見分けられる形: `door: "hook-context"`、`message.name: "hook_success"`、`message.content` が空の配列。`door: "hook-context"` だけでは足りない (content のある `hook_success` と `hook_non_blocking_error` は jsonl に行がある)
- daemon が待って諦めた行の数は、この append の数と一致した (TaskCreate の turn で 1、Bash の turn で 6)
- 起動の時の 3 件は、module の run が名乗る前に送られたので、daemon は待たなかった

扱い (統括 2026-10-28): module は `message.content` が空の配列の append を送らない (`hooks/transcript-push.ts`)。door や name で名指ししない一般則にした。
- 送らない理由: 何も言わずに終わった hook の `hook_success` は jsonl に行が書かれず、送ると daemon が書かれない行を上限まで待つ
- 例外も同じ扱いで足りる: content が空でも jsonl に書かれる行がある (起動時の `hook_non_blocking_error`)。daemon はこの行の push を受けないが、後に続く行の push で、byte offset の続きとして読む

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
- content が空の `hook_success` の append (§6) も jsonl に行が無い。push を合図に jsonl を読む側がこの uuid を待つと、hook の走る tool の turn のたびに上限まで待つ

## 試験の環境に由来すること

- §1〜§4 は `claude -p`、§5 は対話のセッションでの観測
- model は代役で、thinking の block、API error の行、画像を含む行は出していない
- 書き込みの遅れは、行の少ない短い turn での値
- §6 の hook は、試験用の config home の settings (普段の設定から認証の値を抜いたもの) が読む marketplace から入った plugin のもの (SessionStart、PreToolUse、PostToolUse)。§6 の tool の turn の hook と、起動の時の `hook_success` になった hook は、どれも終了の status 0 で終わっていた。content が空なのが hook の出力が空だったためかは、hook の stdout を直接見ていないので確かめていない

## 未検証

- tool の実行中に打った prompt (`queued_command` の attachment になる場面)。ccmsg の daemon が書く peer の封筒そのもの (この観測は reference の送信の script の frame)
- thinking を含む assistant、API error の行 (`isApiErrorMessage`)、`/clear` と `/resume` の後の append
- 長い turn で書き込みの遅れがどこまで伸びるか
- tool の turn で出力を返す hook (`additionalContext` 等) の `hook_success` が jsonl に書かれるか。§6 の tool の turn の hook はどれも出力が無かった
- hook が終了の status 0 以外 (blocking の error 等) で終わった時の append と jsonl
