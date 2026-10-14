# daemon / webui が外から取っている情報と、Claude Mods で素直に取れるかの棚卸し

- Date: 2026-10-14
- 対象: Claude Code 2.1.299。隔離 config home (`$TMPDIR/ccmsg-mods-probe.*/config`) に probe mod を `--plugin-dir` で載せ、`-p` を 22 回 (モデル・環境変数違い) と対話 1 本 (tmux、モデル切替・`/effort`・`/clear`・失敗 turn) を走らせた。型は engine が mod に書き出した `.claude-plugin/types/claude-code/index.d.ts` (16466 行) を読んだ
- 制約: 認証なしで走らせた (`-p` は `Not logged in`、対話はダミー鍵と閉じた localhost の base URL)。turn は API に届かず失敗するが、`session.start` / `turn.start` / `turn.step` / `turn.complete` / `session.measure` / classic の各 event と `$.session.*` は発火・応答する。API の応答が要る値 (`context.tokens`、`turn.complete.usage`、subagent・background task・Task 系 tool の実データ) は観測していない。下の表で「型」と書いたものは d.ts の記述、「実測」は probe の記録
- 起点: webui の ctx 表示が起動直後に 200k を分母にする (opus[1m] で起動しても)。`packages/webui/src/client/session-status-view.ts` の `estimateContextLimit` は「使用量が 200k を超えたら 1M」と推定している

## 判明した事実

- **ctx の分母は `$.session.usage().context.window` がそのまま答える** (実測)。値は engine が今のモデルに使っている window で、status line の `context_window_size` と同じもの (型)
  - 2.1.299 では 5.x 系 (`haiku` / `sonnet` / `opus` の各 alias → `claude-*-5-5`)、`claude-fable-5`、`claude-opus-4-7`、`claude-opus-4-8` は `[1m]` 無しでも 1,000,000。`claude-haiku-4-5-20251001` と `claude-sonnet-4-5` は 200,000 で、`[1m]` を付けると 1,000,000
  - したがって今の推定は、1M が既定のモデルで 200k 以下を使っているセッション (起動直後のほぼ全部) で分母を 5 倍小さく出す。kawaz が見た症状はこれ
  - `/model` で切り替えると window も追従する (sonnet-4-5 → opus-5-5 で 200k → 1M、opus-5-5 → sonnet-4-5 で 1M → 200k を両方向で実測)。切替時に `session.measure` は**発火しない** (型の記述「main-thread の turn ごとと rate limit の変化時」のとおり)。切替は `classic.PreModelSwitch` / `classic.PostModelSwitch` (`from_model` / `to_model` / `requested_model` / `source: "picker"` / `context_tokens`) で分かる
  - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` は `DISABLE_COMPACT` が真の時だけ効く (binary の該当関数 `dS()`)。効いた時は window がその値になる (`DISABLE_COMPACT=1` + `300000` で sonnet-4-5 も opus-5-5 も 300,000 を実測)。`DISABLE_COMPACT` 無しでは 1,000,000 / 300,000 を与えても window は変わらない (process env、`--settings` の env、`ANTHROPIC_BASE_URL` を他所に向けた場合の 3 通りで実測)。kawaz の個人面の settings の env は `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` を持つが `DISABLE_COMPACT` は持たないので、shell の環境から `DISABLE_COMPACT` が来ていない限りこの変数は効いていない (shell の環境は未確認)
- **`$.session.model()` は `/model` の表示どおりで `[1m]` を保つ** (`claude-opus-5-5[1m]`、実測)。transcript の `message.model` は `[1m]` を落とすので、今の webui は起動時の pin を復元できない
- **effort を返す `$.session` のメソッドは無い**。`turn.step` の `e.effort` (effort の設定が無い隔離 config での既定値はモデルごとに違い 5.5 系 `medium`、opus-4-7 `xhigh`、fable-5 / opus-4-8 `high`、effort 非対応の 4.5 系は key 無し。`/model` の picker で上げた後は `"high"` を実測) と、tool 系の classic event の `effort.level` が運ぶ
- **ctx の分子** (`context.tokens` / `percent`) は「live window の最後の応答の input 側 (uncached + cache 書き込み + cache 読み)」で、最初の応答が返るまでと compact 直後は無い (型)。今の transcript の fold と同じ定義。`session.measure` が main-thread の turn ごとに push する。turn の途中 (長い tool の連続) では push されないので、assistant 行ごとに更新される今の fold より粗い。同じ粒度にするなら `turn.step` や `tool.call` の後に `usage()` を読む (未検証)。本調査では認証が無いので値を観測していない (reference の 2.1.284 実測には `tokens` / `window` / `percent` がある)。応答前の見積もりは `$.session.usage({ breakdown: "summary" })` が手元で数える (空の sonnet-4-5 セッションで `totalTokens: 78460`、`rawMaxTokens: 200000`、`autoCompactThreshold: 167000`、`autocompactSource: "auto"`)
- **turn の境目と API error** は event で即時に分かる。`turn.complete.reason` は `answer` / `aborted` / `refusal` / `error` (型)、認証失敗と接続拒否で `error` を実測。直前に `classic.StopFailure` が `error` (enum: `authentication_failed` / `rate_limit` / `overloaded` / `server_error` ...) と `last_assistant_message` を運ぶ (`authentication_failed`、`server_error` を実測)。`turn.start` / `turn.step` / `turn.complete` は subagent の loop でも発火し `agentId` を持つ (型)
- **`/clear` では `session.start` が起きない** (reference の記述を 2.1.299 でも確認)。順序は `command.run (clear)` → `classic.SessionEnd (reason: clear)` → `session.end (reason: clear)` → `classic.SessionStart (source: clear、新しい session_id と transcript_path)`。直後の `$.session.id()` は新 id、`usage().startedAt` は新しい時刻、`model()` は切替後のものを保つ
- **transcript path** は classic の全 event の `e.transcript_path` にある (実測)
- **`$.session.repo()`** は `{ root, remote, internal, name }` (実測)。`root` は worktree でも main working tree の root (型)。branch / worktree 名は無い。cwd の変化は `classic.CwdChanged { old_cwd, new_cwd }` (型)
- **agent** は `$.agent.list()` が `{ id, teammateId?, description, type, status, parentId?, spawnedBy?, name? }` を返す。`status` は `pending | running | waiting | idle | completed | failed | killed`。ただし workflow の agent は含まず、終わった subagent はしばらくして落ちる (型)。probe では agent を起こせず空配列だけを見た
- **background task** は `classic.Stop` / `classic.SubagentStop` の `background_tasks` (`{ id, type: shell | subagent | monitor | workflow ..., status, description, command?, agent_type?, name? }`、in-flight のものだけ) と `session_crons` が運ぶ (型、未観測)。一覧を問い合わせる `$` のメソッドは無い
- **Task 系** (TaskCreate / TaskUpdate) は `tool.call` の入力と `next(e)` の結果、`classic.TaskCreated { task_id, task_subject, ... }` / `classic.TaskCompleted` で取れる (型)。一覧の getter は無い
- **tool の呼び出し**は `tool.call` の `e` に引数が平たく入り (`file_path` 等)、subagent の loop の呼び出しには `agentId` が付く (型)。今の session-status は本体の transcript しか読まないので、subagent の Read / Write は外部ファイルの許可に入っていない。mods で拾うと範囲が広がる
- **`session.append`** は transcript に書かれる行ごとに発火する (`{ message, door: queue | prompt | attachment | command | response, origin, uuid }`、実測)。live の行の流れは取れるが、過去分は取れない
- **人の入力**は `prompt.submit` の `origin.kind` (`composer` / `sdk` / `peer` / `task-notification` ...) で分かる。composer-fill が入れた文も `composer` になる (既知、DR-0035)
- `claude agents --json` の `status` は対話の起動直後 `idle`、失敗 turn の再試行中 `busy`、終了後 `idle` に戻る (実測)

## 情報ごとの取得経路と mods での取り方

「効果」「難易度」は、置き換えた時の利得と、置き換えに要る作業 (module → daemon の push 経路は全行で共通の前提なので、その上に何を足すか) の目安。

| 情報 | 今の取得経路 | 今の問題 | mods での取り方 (確度) | 難易度 / 効果 |
|---|---|---|---|---|
| ctx の分母 (window) | 推定 (`estimateContextLimit`: tokens > 200k なら 1M) | 1M が既定のモデルで 200k 以下の間ずっと誤り。env override (`DISABLE_COMPACT` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS`) を見られない | `$.session.usage().context.window`。`session.measure` の `context.window` (turn ごと)、`classic.PostModelSwitch` の後に `usage()` を読み直す (実測) | 低 / 最大 |
| ctx の分子 (tokens) | transcript の最後の本体 assistant 行の usage 3 項の和 (session-status `foldContextUsage`) | 行が書かれるまで出ない。購読中のセッションだけ fold する | `session.measure` の `context.tokens` / `percent` (型と reference 実測、本調査は未観測)。turn の途中は push されず今の fold より粗い。応答前は `usage({ breakdown: "summary" })` の見積もり (実測) | 低 / 中 |
| model | transcript の `message.model` (fold)、sidebar は gateway の直近 request、検索ヒット | 最初の応答まで出ない。`[1m]` が落ちる。切替は次の応答まで反映されない | `$.session.model()` (`[1m]` 付き、実測)、`classic.PostModelSwitch` (実測)、`turn.step.model` (実測) | 低 / 高 |
| effort | transcript の assistant 行の top-level `effort` | 最初の応答まで出ない。古い CC は書かない | `turn.step.effort` (実測)、classic の `effort.level` (型)。getter は無いので最初の request までは分からない (今と同じ) | 低 / 中 |
| 応答中 / idle | `claude agents --json` の `status` (config dir ごとに 5 秒間隔で CLI を spawn)、Timeline は transcript の行 | 最大 5 秒遅れる。assistant の行は応答の終わりに書かれるので、応答中は TL に何も出ない | `turn.start` / `turn.complete` (turnId、subagent は agentId 付き)、`turn.step` の stream で途中の文字 (実測 / 型) | 中 / 高 |
| 入力待ち (ダイアログ) | `claude agents --json` の `status: waiting` と `waitingFor` | 5 秒遅れ | permission は `tool.check` の結果 `ask` → `classic.PermissionRequest`、AskUserQuestion は `tool.call`、放置は `classic.Notification` (`idle_prompt`、60 秒後)。engine 自身のダイアログ (trust・hot-reload の同意等) には event が無い (reference dialogs) | 高 / 中 |
| API error | transcript の `isApiErrorMessage` 行を全 peer で fold (session-errors、session-status) | 全 peer の transcript を tail し続ける。分類は本文の文字列だけ | `classic.StopFailure` の `error` enum と `last_assistant_message`、`turn.complete.reason: "error"` (実測)。解除は次の `reason: "answer"` | 低 / 中 |
| todo (Task) | transcript の TaskCreate / TaskUpdate の tool_use と結果、`task_reminder` attachment (subagent の Task はこれでしか見えない) | 行の組み合わせの fold が大きい。subagent の分は reminder 待ち | `tool.call` (TaskCreate / TaskUpdate、subagent 分も agentId 付きで、型)、`classic.TaskCreated` / `TaskCompleted` (型)。一覧 getter は無いので module が畳む | 中 / 中 |
| agent tree | transcript の Agent tool_use / 結果 + snapshot ごとに `subagents/` の meta.json と subagent transcript を読む (`readAgentTree`)、workflow は state json と journal | snapshot のたびに file を読む。subagent transcript の走査 | `$.agent.list()` (parentId / status / type / name、型)、`agent.spawn`、`turn.*` の agentId、`classic.SubagentStart` / `SubagentStop` (`agent_transcript_path` 付き、型)。workflow の agent は list に出ない、終わった subagent は落ちる | 高 / 高 |
| background task | transcript の Bash `run_in_background` / Monitor / Workflow の結果と queue-operation の `<task-notification>` | fold が大きい | `classic.Stop` / `SubagentStop` の `background_tasks` (in-flight、turn の終わりにだけ、型)、`prompt.submit` の `origin: task-notification` (完了の通知、型) | 中 / 中 |
| 外部ファイルの許可 (DR-0024) | transcript の tool_use `file_path` / `notebook_path`、`edited_text_file` / `file` attachment、`<persisted-output>` | 本体の transcript だけ (subagent の Read は入らない) | `tool.call` の引数 (subagent 分も、型)、attachment は `session.append` / `prompt.attachment` | 高 / 低 (下の「置き換えないもの」) |
| cwd / repo / ws | SessionStart の command hook が state file に書く (cwd は stdin、repo / ws は `bump-semver vcs get`)、CLI の hello、`claude agents --json` の cwd | 起動時の値だけ。セッション中の `/cd` や worktree 移動は追わない | `$.session.cwd()` / `root()` / `repo()` (実測)、`classic.CwdChanged` (型)。branch / worktree 名は無いので ws は `$.process.run` で bump-semver を呼ぶ | 低 / 低〜中 |
| session の開始・終了・`/clear` | SessionStart command hook (startup / resume / clear / compact)、`claude agents --json` の poll、sidecar の接続が閉じたこと、module の `session.end (clear)` | 終了は poll か socket close 頼み | `session.start` (起動・load ごと、`/clear` では起きない)、`session.end` (`reason`、`kill -9` では起きない)、`classic.SessionStart` (`source: clear`) (実測) | 低 / 中 |
| 人の入力 (sidebar の並び順) | transcript の `origin.kind: human` / ccmsg の u1 / 直接配送の封筒を全 peer で fold (session-user-input) | 全 peer の transcript を tail し続ける | `prompt.submit` の `origin.kind: composer`、`classic.UserPromptSubmit` (実測)。u1 の room 発言は daemon 自身が配っているので transcript を読まなくても daemon が知っている | 中 / 中 |
| transcript path | CLI の hello (SessionStart command hook が書いた state file)、無ければ poll ごとに config dir を走査 (`resolvePendingTranscripts`) | 未入力のセッションは poll ごとに探す | classic の全 event の `transcript_path`、`/clear` で新しい path (実測)。sidecar の hello に載せられる | 低 / 中 |
| harness の pid | `claude agents --json` の行と run の開始時刻の近さで結ぶ (sidecar-runs) | 推定 | `$` に pid を返すものは無い (d.ts に無い) | - / - |

## 実用的な示唆 / ベストプラクティス

### ctx の分母の正しい取り方

module が `$.session.usage()` を読み、`context.window` を daemon に push し、daemon は snapshot の `context` に `window` として載せる。webui は `estimateContextLimit` をやめてその値で割る。読む時機は 3 つで足りる。

1. `session.start` の後 (起動直後に分母が出る)
2. `session.measure` (main-thread の turn ごと。`e.context` に `window` と、応答後は `tokens` / `percent` が入っているので `usage()` を呼び直す必要も無い)
3. `classic.PostModelSwitch` の後 (`session.measure` は切替で起きないので、ここで `usage()` を読み直す)

`/clear` 後は `classic.SessionStart (source: clear)` の後に読み直す (新しい session id に紐付けるため)。

module が無いセッション (古い plugin、`-p`、他の config home で flag が無いもの) には分母が来ない。その時の表示は「推定」と明示したまま今の推定に落とすか、`[1m]` 付きの起動 model 名 (sidebar の候補の一つ) から引くかを決める。推定値の表は engine のモデルごとの既定に追従できないので、mods の値を正、推定を fallback とする。

### mods に置き換える優先順 (効果 ÷ 難易度)

前提として、module → daemon の push 経路 (sidecar の上り方向の op) を 1 本作る。今の sidecar は daemon → module の要求と、`sidecar send` (SendMessage の転送) だけを持つ。

1. **ctx の分母と model (`[1m]` 付き)**: 誤表示の直接の原因で、`usage()` / `model()` を読んで送るだけ
2. **API error**: `classic.StopFailure` の enum で分類が付き、session-errors が全 peer の transcript を tail する必要が module のあるセッションでは無くなる
3. **ctx の分子と effort**: 分母と同じ `session.measure` / `turn.step` で一緒に送れる
4. **応答中 / idle**: `turn.start` / `turn.complete` で即時になる。issue mods-consolidation-and-turn-events の 2 の本体。`turn.step` の stream で TL に途中経過を出すかは別の設計判断
5. **transcript path と `/clear` の追従**: sidecar の hello に `transcript_path` を載せ、`classic.SessionStart (clear)` で更新する。`resolvePendingTranscripts` の poll ごとの走査が module のあるセッションでは要らなくなる
6. **人の入力**: `prompt.submit (composer)` で即時に送れる。ただし u1 の room 発言は daemon 側で付ける
7. **agent tree / todo / background**: 効果は大きいが、`$.agent.list()` が終わった subagent と workflow を含まず、Task と background に一覧 getter が無いので、module 側で状態を畳み、daemon の再接続時に丸ごと送り直す設計が要る。subagent の tool 呼び出しが見える範囲の変化 (本体の transcript だけ → subagent 込み) の扱いも決める

### 置き換えられないもの (理由)

- **過去・停止したセッションの情報** (session-search、session-dump、fork-origin、virtual-sessions、agent-transcripts、Timeline の過去行): mods は動いているプロセスの中でしか動かない。`$.session.messages()` は新しい 4096 件までで、形も transcript の行と違う
- **daemon が居なかった間の分**: mods の event は live だけで、daemon の再起動や sidecar の切断の間に起きたことは届かない。累積する状態 (外部ファイルの許可、todo、agent tree の履歴) は transcript を正として fold し直せる今の形が残る。module 側で `$.state` に畳んで再接続時に全量を送る形なら代われるが、その間に module 自体が reload されると module 変数は消える (`$.state` は残る)
- **外部ファイルの許可 (DR-0024)**: 上の理由に加え、読み取りの許可は「harness が記録した呼び出し」から決めるのが DR の前提で、live の event だけにすると許可の取りこぼしと、subagent 分で範囲が広がることの両方が設計変更になる。置き換えない
- **module が無いセッション**: `-p` / SDK (module は sidecar を持たない)、古い plugin、flag の無い config home。transcript と `claude agents --json` の経路は fallback として残る
- **engine 自身のダイアログによる入力待ち**: event も component も無い。`claude agents --json` の `waitingFor` が残る
- **harness の pid**: `$` に無い

### issue mods-consolidation-and-turn-events への材料

- 「module 内の `classic.SessionStart` を `session.start` に寄せる」は `/clear` で成り立たない。`/clear` では `session.start` が起きず `classic.SessionStart (source: clear)` だけが起きる (実測)。寄せるなら `session.end (clear)` を受けて次の event で `$.session.id()` を読み直す形になる

## 検証の詳細

### モデルごとの window (`-p`、認証なし、`session.start` 直後の `$.session.usage()`)

| `--model` | `$.session.model()` | `context.window` | `turn.step.effort` |
|---|---|---|---|
| `haiku` | `claude-haiku-5-5` | 1,000,000 | medium |
| `sonnet` | `claude-sonnet-5-5` | 1,000,000 | medium |
| `opus` | `claude-opus-5-5` | 1,000,000 | medium |
| `opus[1m]` | `claude-opus-5-5[1m]` | 1,000,000 | medium |
| `sonnet[1m]` | `claude-sonnet-5-5[1m]` | 1,000,000 | medium |
| `claude-haiku-4-5-20251001` | 同左 | 200,000 | 無し |
| `claude-sonnet-4-5` | 同左 | 200,000 | 無し |
| `claude-sonnet-4-5[1m]` | 同左 | 1,000,000 | 無し |
| `claude-opus-4-7` | 同左 | 1,000,000 | xhigh |
| `claude-opus-4-7[1m]` | 同左 | 1,000,000 | xhigh |
| `claude-fable-5` | 同左 | 1,000,000 | high |
| `claude-opus-4-8` | 同左 | 1,000,000 | high |

`turn.step.model` は `$.session.model()` と同じ綴り (`[1m]` 付き) で、`effort` はモデルごとの既定値。effort 非対応のモデルでは key 自体が無い。`session.measure` は turn の失敗後に `{ context: { window }, rateLimits: [], cost: { usd: 0 }, changed: ["context", "cost"] }` (tokens 無し)。

### window の上書き

| 条件 | model | `context.window` |
|---|---|---|
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` (process env) | `claude-sonnet-4-5` | 200,000 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS=300000` (process env) | `claude-haiku-5-5` | 1,000,000 |
| 同 300000 を `--settings` の env で | `claude-sonnet-4-5` | 200,000 |
| `ANTHROPIC_BASE_URL=http://127.0.0.1:9` + 同 1000000 | `claude-sonnet-4-5` | 200,000 |
| `ANTHROPIC_BASE_URL=http://127.0.0.1:9` + 同 1000000 | `claude-opus-5-5` | 1,000,000 |
| `DISABLE_COMPACT=1` + 同 300000 | `claude-sonnet-4-5` | 300,000 |
| `DISABLE_COMPACT=1` + 同 300000 | `claude-opus-5-5` | 300,000 |

binary の該当部分: `function dS(){if(Ne(process.env.DISABLE_COMPACT)){let e=a.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(e!==void 0&&e>0)return e}return}`。window の決め方の分類は d.ts の `ContextWindowSource` (`env` / `settings` / `clientdata` / `experiment` / `model-default` / `unknown-model` / `auto`)。

考察: 本番の個人面は gateway の model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`) を使っており、gateway が返す model 情報で window が変わる可能性は認証が要るので確かめていない。どちらにしても `usage().context.window` は engine が実際に使う値なので、推定より正しい。

### 対話での切替と `/clear` (sonnet-4-5 で起動)

| 操作 | 観測 |
|---|---|
| 起動直後 | `model: claude-sonnet-4-5`、`window: 200000`。`claude agents --json` は `status: idle` |
| `/model` の picker で Opus (このセッションだけ) | `classic.PreModelSwitch` → `classic.PostModelSwitch`。次の snapshot で `model: claude-opus-5-5`、`window: 1000000`。`session.measure` は出ない |
| `/model claude-sonnet-4-5[1m]` (引数付き) | 検証の通信が失敗して `Network error`、切り替わらない |
| picker で effort を High に | 次の turn の `turn.step.effort: "high"` |
| prompt を送る (接続拒否) | `turn.start` → `turn.step` → 10 回の再試行 (約 181 秒) → `classic.StopFailure (error: server_error)` → `turn.complete (reason: error)` → `session.measure`。再試行中の `claude agents --json` は `status: busy` |
| `/clear` | `classic.SessionEnd (clear)` → `session.end (clear)` → `classic.SessionStart (source: clear、新 id)`。`session.start` は無い。`$.session.id()` は新 id、`turns: 0`、`messages` は 0 件、`usage().startedAt` は更新、model は opus-5-5 のまま |
| picker で Sonnet 4.5 | `PostModelSwitch { from_model: claude-opus-5-5, to_model: claude-sonnet-4-5, context_tokens: 0, source: picker }`、以後 `window: 200000` |
| `$.session.usage({ breakdown: "summary" })` (sonnet-4-5、応答 0 件) | `totalTokens: 78460`、`maxTokens` / `rawMaxTokens: 200000`、`autoCompactThreshold: 167000`、`autocompactSource: auto`、`apiUsage: null`、`context.tokens` は無し |
| `$.config.list()` | `model` の行はあるが effort の行は無い |

### 観測できなかったもの

- `session.measure` の `context.tokens` / `percent` と `turn.complete.usage` の実値 (API の応答が要る)
- `$.agent.list()` の中身、`agent.spawn`、`classic.SubagentStart` / `SubagentStop`、`background_tasks`、`classic.TaskCreated` (model に tool を呼ばせる必要がある)
- `tool.call` が subagent の loop の呼び出しで本体の module に届くこと (型の記述だけ)

いずれも認証付きの隔離起動が要る。今回は、実 settings の認証の設定を隔離 config に渡す操作と、usage を持つ transcript を手で組んで `--resume` する操作が auto mode の classifier に止められたので行っていない。
