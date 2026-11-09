# DR-0047: セッションの名前の変更は module の `$.command.run` で `/rename` を走らせる

- Status: Accepted (2026-11-02、kawaz 指示) — ✅ 実装済み (サイドカーの依頼 `session.rename`、daemon の `renameSession`、module の関心 `session-rename`、ErrorCode `rename_failed`、webui の Status タブの TITLE の input)。実機の確認は [findings 2026-11-02-rename-via-mod](../findings/2026-11-02-rename-via-mod.md)
- Date: 2026-11-02

## Context

webui の Status タブの TITLE の input は、op `session_rename { session_id, title }` でセッションの名前を変える。セッションの名前 (Claude Code の state file の `name`、agents の行の `name`) を書けるのは組み込みの `/rename` だけで、外から書く API は無い。

mods の `$.command.run({ command, args })` は、人が `/command args` と打ったのと同じ経路で slash command を走らせる。走るのはセッションが idle になってから (reference の `claude-mods/dollar-api`、組み込みの `/model` `/effort` が走ることは [findings 2026-10-26-mods-command-run-builtin](../findings/2026-10-26-mods-command-run-builtin.md))。daemon から module への依頼はサイドカーの経路 ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §3) で、[DR-0044](./DR-0044-turn-abort.md) の `turn.abort` が同じ形の前例。module は engine のイベント処理だけを持ち、module の無いセッションにその機能は無い ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §1、[DR-0039](./DR-0039-all-mods-and-typed-tools.md) §7)。

## Decision

### 1. 経路

webui (user role) → daemon の op `session_rename { session_id, title }` → daemon がそのセッションの生きている全 run の module にサイドカーの依頼 `session.rename { name }` → module が `$.command.run({ command: "rename", args: name })`。

- 名前は daemon が確かめてから送る: 前後の空白を落とし、空・200 字超・制御文字 (C0 と DEL) を含むものは `invalid_args` で、module に何も送らない。名前は Sessions 一覧の 1 行に出るので、改行等を黙って落とさずに拒む
- run は全部に同時に送る (`turn.abort` と同じ)
- module の無いセッションに、端末への打鍵・CLI 等の別経路は作らない

### 2. module の依頼 `session.rename`

- args: `{ name }` (空でない文字列)
- result は 3 つ:
  - `renamed`: `$.command.run` が resolve した
  - `queued`: main loop が turn を走らせている (main の `turn.start` から `turn.complete` まで、DR-0044 の関心 `turn-abort` が覚えている turn)。`$.command.run` を呼んで待たずに答える。engine は turn の後、セッションが idle になってから `/rename` を走らせる。turn を覚えていなくても、`$.command.run` が `RENAME_WAIT_MS` (2 秒) で resolve しなければ `queued` で答える (module が読み込まれる前から走っている turn、開いているダイアログ等、module に見えない待ち)
  - `refused`: `$.command.run` が reject した (`message` に engine の文言)。`queued` と答えた後の reject は debug log に書くだけ
- subagent・teammate の turn はセッションを busy にしない (`/rename` は main の turn だけを待つ)

### 3. op `session_rename` (user role)

- request: `{ op: "session_rename", session_id, title }` (形は変えない)
- response: `{ ok: true, title, outcome: "renamed" | "queued" }`。`title` は module に渡した (空白を落とした) 名前。どれかの run が `renamed` なら `renamed`、そうでなくどれかが `queued` なら `queued`
- error:
  - `bad_request`: user role でない (session role のエージェントが他のセッションの名前を変える口にしない。DR-0028 の `session_kill` と同じ姿勢)
  - `invalid_args`: 名前が §1 の確認に通らない
  - `session_not_found`: 生きている run が無く、daemon がその sid を走っているセッションに数えていないか、その sid の run が /clear・/resume で別の sid に移っている
  - `no_module`: セッションは走っているが、生きている run (サイドカー) が無い
  - `rename_failed`: どれも `renamed` / `queued` でなく、どれかの module が `refused` と答えた (msg に engine の文言)、または期限までに答えが無かった・op の形で読めなかった (名前が変わるかは分からない、と msg に書く)。この DR より前の plugin の module は `session.rename` を読めずに答えないので、後者になる
- 期限は `SESSION_RENAME_DEADLINE_MS` = 5 秒 (書き込み、module の 2 秒の待ち、`POST /op` の返事 ([DR-0046](./DR-0046-module-op-over-http.md)))。遅い op なので 1 応答の相関 RPC で答え、同じ接続の他の依頼を待たせない ([DR-0029](./DR-0029-async-io-principle.md) 追補)
- daemon.log に 1 行: `session_rename: session_id=<sid> result=<renamed|queued|error code> tries=[<id> <socket> <run の結果>, ...]`

### 4. webui

- 名前を変える場所はセッションの Status タブの TITLE。値は最初から `<input>` で、Enter で前後の空白を除いた値を `session_rename` に送り、Escape で表示中の名前に戻す。空または今の名前と同じ値は送らない
- module がそのセッションについて話していない (agents の行に `turn` が無い) セッションでは input を readOnly にする。`no_module` にしかならないので、失敗しかしない編集を置かない
- 返事の後、input の下に 6 秒だけ注記を出す: `renamed` は「名前を変更: <title>」、`queued` は「応答の後に名前を変更: <title>」。error は入力した値を残したまま msg を出す
- input に出す名前は agents の行の `name` で、Claude Code が state file に書いた時に追従する。編集中 (入力してから Enter / Escape まで) は追従で上書きしない。webui は名前を先回りして書き換えない (送った後の input は agents の行の名前に戻り、それが変わった時に追従する)

## Alternatives Considered

- 案: 端末に `/rename <title>` を打鍵する (hyoui の `input`)
  - 不採用理由: hyoui の外で起動したセッションには端末が無い。応答中・ダイアログが開いている時は打鍵が prompt の入力欄やダイアログに入り、何が起きたかを daemon が確かめられない。module の無いセッションのための別経路になる (DR-0039 §7)
- 案: module が `$.command.run` の resolve を待ってから答える (応答中でも)
  - 不採用理由: 応答中は turn が終わるまで resolve しないので、daemon の期限を超えて `rename_failed` になる。名前は turn の後に変わるのに、人には失敗に見える
- 案: daemon が facts の `turn` を見て、応答中なら module に聞かずに `queued` を返す
  - 不採用理由: `/rename` を頼むのは module なので、どのみち module に送る。facts は module の写しで送信の遅れの分だけ古い
- 案: 名前が変わったことを確かめてから返事をする (state file の `name` を待つ)
  - 不採用理由: `queued` の時は turn が終わるまで待つことになる。変わった名前は agents の行が運ぶので、webui はそれを見れば足りる

## Consequences

- protocol はサイドカーの依頼の op が 1 つ (`session.rename`)、ErrorCode が 1 つ (`rename_failed`) 増え、`terminal_unavailable` が無くなる。op `session_rename` の response は `{ ok, title, outcome }` になる。module の `describe` の `ops` に `session.rename` が並ぶ
- この DR より前の plugin で起動したセッションは、TITLE で Enter を押すと 5 秒待って `rename_failed` (答えが無い) になる。plugin を上げて起動し直したセッションから効く
- `/rename` は人が打った時と同じく transcript と TUI に `/rename <name>` と「Session renamed to: …」の行を残す
- 「持たない」ことを壊す変更を止める試験の観点:
  - user role 以外の `session_rename` は `bad_request` で、module に何も送らない
  - 制御文字・空の名前は `invalid_args` で、module に何も送らない
  - 生きている run が無い時、走っているセッションに `no_module`、そうでないセッションに `session_not_found` を返し、別の経路を試さない
  - main の turn を走らせている module は `$.command.run` を待たずに `queued` と答え、subagent の turn では待つ
  - `$.command.run` が `RENAME_WAIT_MS` で resolve しなければ `queued`
  - module の答えが無い時は `rename_failed`
  - TITLE の input は module の話しているセッションでだけ書き換えられる (それ以外は readOnly)

## 関連

- [DR-0044](./DR-0044-turn-abort.md) — daemon から module への依頼の前例 (`turn.abort`)、main の turn を覚える関心
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) §3 — サイドカーの依頼と facts の `turn`
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §7 — module の無いセッションは no_module の 1 状態
- [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §1 — module は engine のイベント処理だけ
- [DR-0029](./DR-0029-async-io-principle.md) 追補 — 遅い op も 1 応答の相関 RPC
