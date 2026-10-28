# DR-0044: webui から走行中のセッションの main loop の turn を中断する (`turn_abort`)

- Status: Accepted (2026-10-28、kawaz 裁定) — ✅ 実装済み (protocol の op `turn_abort` と ErrorCode `no_module` / `no_turn` / `abort_failed`、サイドカーの依頼 `turn.abort`、daemon の `abortTurn`、module の関心 `turn-abort`、webui の `TurnResponding` の ×)。実機の確認は [findings 2026-10-28-turn-abort-verify](../findings/2026-10-28-turn-abort-verify.md)
- Date: 2026-10-28

## Context

端末 (TUI) では Esc で走っている turn を止められる。webui から見ている時 (スマホ等で端末に行けない時) には、長い応答や tool の連鎖を止める手段が無い。あるのは Status タブの終了・再起動 ([DR-0028](./DR-0028-session-kill.md)) だけで、これはプロセスごと止める。turn を止めたいだけの時には過大で、background のプロセスとチームメートも一緒に止まる。

kawaz 提案 (2026-10-28): TL の「応答中…12s」の横に × ボタンを置き、押すとそのセッションの走行中の turn を中断する (TUI の Esc 相当)。

### 読んで分かった前提

- mods の `$.turn.abort({ turnId })` は、main loop の実行中の turn を中断マーカー無しで止める。型定義は「its running tools stopped」と書くが、実機 (2.1.312) では走っていた Bash は止まらずに background の shell に移った (下の §3)。`turnId` は main loop の `turn.start` がその plugin に渡した id で、実行中の turn の id でなければ両方の id を名指して reject する (型定義 `.claude-plugin/types/claude-code/index.d.ts` の `turn.abort`、reference の `claude-mods/dollar-api`)
- 人が Esc で止めた turn の `turn.complete` は `reason: 'aborted'` で来る (reference の `claude-mods/dollar-api` の `process` 節の実測)。`$.turn.abort` で止めた turn も `reason: 'aborted'`、`isAborted: true` で来た (findings)
- `turn.start` / `turn.complete` は subagent・teammate の turn でも起き、main loop のものは `e.agentId` が無い (reference の `claude-mods/events`)
- TL の「応答中」は module の facts の `turn` (main の `turn.start` / `turn.complete`、[DR-0035](./DR-0035-user-input-via-composer-fill.md) §3) から出る (`session-status-view.ts` の `respondingSince`)。module の無いセッションには出ない
- daemon から module への依頼はサイドカーの経路 (DR-0035 §3) で、[DR-0041](./DR-0041-request-model-effort-override.md) §3 の `request.override` が同じ形の前例 (op ごとに args と result のスキーマ、生きている全 run に同時に送る)
- 遅い op は 1 応答の相関 RPC で答え、同じ接続の他の依頼を待たせない ([DR-0029](./DR-0029-async-io-principle.md) 追補)。`session_kill` と `claude_update` ([DR-0043](./DR-0043-sidebar-folds-and-globals.md) §6) もこの形

## Decision

### 1. 経路

webui (user role) → daemon の op `turn_abort { session_id }` → daemon がそのセッションの生きている全 run の module にサイドカーの依頼 `turn.abort` (args `{}`) → module が覚えている main loop の turnId で `$.turn.abort({ turnId })`。

- module の関心 `turn-abort` が、main loop の `turn.start` (`e.agentId` が無いもの) の `turnId` を覚え、main loop の `turn.complete` で忘れる。subagent・teammate の turn の id は覚えない
- 依頼の結果は 3 つ: `aborted` (`$.turn.abort` が resolve した)、`no_turn` (覚えている turn が無い。`$.turn.abort` を呼ばない)、`refused` (`$.turn.abort` が reject した。reject の文言を `message` に持つ)
- run は全部に同時に送る (`request.override` と同じ)。1 つのセッションの 2 つの run (同じ sid の 2 つのプロセス) が両方 turn を走らせていれば両方止まる。押した人の意図は「このセッションの走っている turn を止める」で、run を選ぶ材料を人は持たない
- 新しい経路は作らない。daemon と module の間はサイドカーの依頼の op を 1 つ足すだけ

### 2. op `turn_abort` (user role)

- request: `{ op: "turn_abort", session_id }`
- response: `{ ok: true }`。どれかの run の module が `aborted` と答えた
- error:
  - `bad_request`: user role でない。session role のエージェントが自分や他のセッションの turn を止める口にしない (DR-0028 の `session_kill` と同じ姿勢)
  - `invalid_args`: `session_id` が無いか空
  - `session_not_found`: その sid の生きている run が無く、daemon がその sid を走っているセッションに数えていないか、その sid の run が /clear・/resume で別の sid に移っている
  - `no_module`: セッションは走っているが、その sid の生きている run (サイドカー) が無い。module の無いセッションに、CLI・端末への Esc の送鍵・signal 等の別経路は作らない ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §7)
  - `abort_failed`: どれも `aborted` でなく、どれかの module が `refused` と答えた (msg に module の文言)、または答えが期限までに無かった・op の形で読めなかった (msg でそう言い、止まったかは分からないと書く)。古い plugin の module は `turn.abort` の行を読めずに答えないので、後者になる
  - `no_turn`: 答えた module がどれも `no_turn` だった (押した時には turn が終わっていた)
- 期限は `TURN_ABORT_DEADLINE_MS` = 5 秒 (書き込みと `ccmsg sidecar reply` 1 回で約 0.3 秒、`request.override` と同じ値)
- 返事は module の答えを待つので遅い op で、1 応答の相関 RPC で答える。同じ接続の他の依頼を待たせない (DR-0029 追補、`session_kill` と同じ理由)
- daemon.log に 1 行: `turn_abort: session_id=<sid> result=<aborted|error code> tries=[<id> <socket> <run の結果>, ...]`

### 3. 中断の痕跡

- `$.turn.abort` は中断マーカーを残さない。transcript に人の中断の行は出ず、model は次の request で中断されたことを知らない (続きを頼むなら人が prompt で伝える)。応答の途中で止めた時は、そこまでの文が `stop_reason` の無い assistant 行として transcript に残る
- tool の実行中に止めると、走っていた Bash は止まらずに background の shell に移り、その tool_result は「Command running in background with ID: …」になる (TUI に「1 shell still running」)。TUI の Esc はその Bash を kill し、`[Request interrupted by user for tool use]` を残す。× は turn を止めるが、走っていた Bash を止めるのは Esc と違う (findings の比較)。移った shell はセッションの他の background の shell と同じく、人か model が止める
- `turn.complete` は `reason: 'aborted'` で来て、module の facts の `turn` は idle になる。webui の応答中の表示はこれで消える
- 中断したことの記録は daemon も webui も持たない。webui は押したタブだけで「中断しました」を短く出し、保存しない (他のタブ・読み込み直しでは出ない)

### 4. webui

- × は TL の末尾の「応答中…12s」の行の中、表示のすぐ横に置く。出るのはその行が出ている間 (module が main の turn を走らせていると言っている間) だけ。accessible name は「応答を中断」
- 押したらその × を disabled にする。確認ダイアログは出さない (Esc と同じく、会話は続き、次の prompt で続けられる操作なので)
- 返事の後:
  - `ok`: 応答中の行の位置に「中断しました」を 4 秒出す。応答中の行は module の `turn.complete` で facts が idle になった時に、× ごと消える
  - error: code ごとの短い文を応答中の行の位置に出す (`no_turn` は「中断する応答がありませんでした (既に終わっていた)」、`no_module` は「このセッションには hooks module が無いので中断できません」、`session_not_found` は「セッションが見つかりません」、`abort_failed` と他の code は msg を添える)。次に × を押すか、別のセッションに移るまで出しておく
- 押したセッションの view を離れると、出していた結果も消える (保存しない)
- module の無いセッションには応答中の行が出ないので × も出ない。`no_module` の文が出るのは、facts の responding が残ったまま run が消えた時などに限られる

### 5. 対象外

- subagent・teammate の turn。`$.turn.abort` は main loop の turn を止める口で、subagent の turn の id は受け付けない。main の turn を止めた時に、その turn の中で走っている前景の Agent と、background で起きた subagent・teammate がどうなるかは未確認 (Bash は §3 のとおり background に移った)
- 中断の後に自動で何かを送ること (「中断しました」の prompt 等)。中断の後にどうするかは人が決める

## Alternatives Considered

- 案: 端末に Esc を送る (hyoui の `input`、tmux の `send-keys`)
  - 不採用理由: hyoui の外で起動したセッションには端末が無い。ダイアログが開いていると Esc はダイアログを閉じる別の操作になり、送った後に何が起きたかを daemon が確かめられない。module の無いセッションのための別経路になる (DR-0039 §7)
- 案: Status タブの終了・再起動 (DR-0028) で代える
  - 不採用理由: プロセスごと止めるので background のプロセスとチームメートも止まり、再起動では cron / schedule も貼り直しになる。turn を止めたいだけには過大で、押すまでに Status タブへ移る必要もある
- 案: 何もしない (止めたい時は端末で Esc)
  - 不採用理由: webui から見ている時 (スマホ等) に端末へ行けない。kawaz の提案の動機そのもの
- 案: daemon が facts の `turn` を見て、idle なら module に聞かずに `no_turn` を返す
  - 不採用理由: facts は module の写しで、送信の遅れの分だけ古い。止められる turn があるかは module だけが知っているので、module に聞く
- 案: 受け付けたことだけを先に返し、止まったかは後から push する
  - 不採用理由: 遅い op は 1 応答の相関 RPC で答え、同じ接続の他の依頼は並行の dispatch が待たせない (DR-0029 追補で 2 段の応答を撤去した理由と同じ)。止まったかは module が `$.turn.abort` の resolve で知り、5 秒の期限の中で答えられる
- 案: 中断を daemon が記録して全タブに push する、または transcript に印を足す
  - 不採用理由: kawaz の指定は「保存しない」。`$.turn.abort` が中断マーカーを残さない以上、記録は ccmsg が独自に作る事実になり、transcript と食い違う
- 案: 押した時に確認ダイアログを出す
  - 不採用理由: Esc と同じく取り返しの付く操作で、会話は続く。終了 (DR-0028) のように不可逆ではない

## Consequences

- protocol は op `turn_abort` が 1 つ、ErrorCode が 3 つ (`no_module`、`no_turn`、`abort_failed`)、サイドカーの依頼の op が 1 つ (`turn.abort`) 増える。module の `describe` の `ops` に `turn.abort` が並ぶ
- この DR より前の plugin で起動したセッションの module は `turn.abort` を知らず、× を押すと 5 秒待って `abort_failed` (答えが無い) になる。plugin を上げて起動し直したセッションから効く
- 人が webui から止めたことは会話にも transcript にも残らない。後から transcript を読む人やエージェントには、turn が途中で終わったことしか分からない
- tool の実行中に × で止めると、その Bash は background で走り続ける (§3)。Esc と同じく kill されることを期待して押すと、止まったつもりの処理が残る
- 「持たない」ことを壊す変更を止める試験の観点:
  - user role 以外の `turn_abort` は `bad_request` で、module に何も送らない
  - module は subagent・teammate の `turn.start` の id で main の turnId を上書きせず、subagent の `turn.complete` で忘れない
  - 覚えている turn が無い時、module は `$.turn.abort` を呼ばずに `no_turn` を返す
  - module は main の `turn.complete` の後に覚えた id を使わない (終わった turn を止めにいかない)
  - 生きている run が無い時、daemon は走っているセッションに `no_module`、そうでないセッションに `session_not_found` を返し、別の経路を試さない
  - 2 つの run のうち 1 つが `aborted` なら `ok`
  - module の答えが無い時は `no_turn` でなく `abort_failed`
  - × は応答中の行がある時だけ出て、押すと `turn_abort` が 1 回だけ飛び、返事まで disabled
  - 「中断しました」は押したタブだけに出て、store に入らない

## 関連

- [DR-0028](./DR-0028-session-kill.md) — セッションの終了・再起動 (プロセスごと止める操作)
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) §3 — サイドカーの依頼と facts の `turn`
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §7 — module の無いセッションは no_module の 1 状態
- [DR-0041](./DR-0041-request-model-effort-override.md) §3 — daemon から module への依頼の前例 (`request.override`)
- [DR-0029](./DR-0029-async-io-principle.md) 追補 — 遅い op も 1 応答の相関 RPC
- [DR-0043](./DR-0043-sidebar-folds-and-globals.md) §6 — error code の付け方の前例 (`claude_update`)
