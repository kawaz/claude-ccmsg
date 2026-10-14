# Claude Mods のリファレンスと v1 の hooks module の突き合わせ (食い違い、classic の全廃、活用候補)

- Date: 2026-10-15
- 対象: rules リポの reference `claude-mods/` (`_index` と本文 9 ファイル。記述の基準は Claude Code 2.1.299 の型定義と 2.1.284 / 2.1.299 の実機)、ccmsg v1 (v0.170.0) の `hooks/composer-fill.ts`・`hooks/session-start.ts`・`hooks/hooks.json` と関連 DR / findings / issue、参照実装として kawaz/claude-context-notify (v0.7.0、`hooks/register.ts`・`hooks/notify.ts`・`tests/`・`justfile`・DR-0003。以下 context-notify)
- 方針 (kawaz): classic hook は残さず、全部 Mods に寄せる。context-notify は完全に Mods 化済みで、リファレンスはそのセッションで再調査してまとめたもの
- 方法: 読み合わせだけ。本書のために実機 probe はしていない。「実測」と書いたものは既存の findings、context-notify の DR-0003、リファレンスのどれかが実測と明記したもので、出典を付ける。それ以外の可否はすべて未検証
- 書き方: リファレンスの記述は「リファレンス `<file>`: …」、ccmsg と context-notify の実装は `ファイル:行` で示す (context-notify のものは `context-notify:` を前に付ける)。食い違いはどちらが正しいかを決めず、両方を並べる

## 判明した事実

### ccmsg が今使っている Mods の機能

| 区分 | 使っているもの | ccmsg の箇所 |
|---|---|---|
| 読み込み | hooks.json の `modules` 1 本 (`./composer-fill.bundle.js`) と command hook (SessionStart、matcher `startup|resume|clear|compact` → `hooks/session-start.ts`) の併用 | `hooks/hooks.json:1-17` |
| engine event | `session.start` / `session.end` / `session.measure` / `turn.start` / `turn.complete` / `prompt.submit` / `session.send` | `hooks/composer-fill.ts:885-1030` |
| classic event | `classic.SessionStart` / `classic.Stop` / `classic.StopFailure` / `classic.PostModelSwitch` / `classic.UserPromptSubmit` | `hooks/composer-fill.ts:910,942,960,981,988` |
| `$` | `session.id` / `surfaces` / `model` / `usage`、`prompt.read` / `fill`、`process.run` / `spawn`、`env.get`、`clock.now` / `after`、`ui.log`、`plugin.root` | `hooks/composer-fill.ts:98-127` (自前の `Engine` 型) |
| 失敗の扱い | observe 系の hook すべてに `.catch(next(e))`、`session.send` だけ `.catch` 無し | `hooks/composer-fill.ts:880-1030` |
| 状態 | module 変数 (`ModuleState`)。`$.state` / `$.store` は使っていない | `hooks/composer-fill.ts:335-386` |

使っていない口のうち ccmsg の作業に関係するもの: `turn.step`、`$.agent.*`、`agent.spawn`、`tool.call` / `tool.check` / `tool.describe`、`command.run`、`$.session.append`、`$.prompt.submit`、`$.model.fork`、`$.command.run`、`$.tool.register`、`$.ui.status` / `notify` / `toast`、`$.state` / `$.store`、`$.http.fetch` (`socketPath`)、`prompt.context` / `prompt.section`。

### classic を全廃した時 (要点、詳細は B5)

- **代わりが取れるもの**: 起動時の state file と daemon の起動 (`session.start` から `$.process.run`)、`/clear` と `/resume` の追従 (`session.end` の `reason` と `command.run` の after)、effort (`turn.step` の `e.effort`)、`prompt.send` の受け付け (`prompt.submit`)、compact の後 (追従の必要が無い)
- **取れなくなる・遅れるもの**: API error の分類 (`classic.StopFailure` の `error`) と表示文はリファレンスの engine event に対応する欄が無い。モデル切替は即時の event が無く、次の request の `turn.step` まで遅れる。transcript path を返す `$` が無い。これから足す候補では、permission ダイアログの直前 (`classic.PermissionRequest`)、`idle_prompt` の通知、cwd の変化、turn 終わりの background 一覧が classic にしか無い
- **障害**: 上の API error の分類の代わりが要る (probe 次第)。「module が読まれず command hook だけが走る」セッションの集合は未検証で、そこでは state file と daemon の起動が消える (daemon は CLI の初回使用でも立つので致命ではない、`hooks/session-start.ts:337`)
- **全廃で得るもの**: 組織が管理する機械 (`sec-default` が座る) では user tier の `classic.*` hook が飛ばされる (リファレンス `overview`、context-notify DR-0003 は `claude plugin validate` の注記として同じことを記録)。今の ccmsg はそこで入力の受け付け・`/clear`・effort・API error が全部働かなくなる

### 食い違い・ずれの要点 (詳細は「検証の詳細」)

1. **組織が管理する機械では ccmsg の classic hook が全部飛ばされる**。ccmsg は `/clear` 後のサイドカー起動、effort、API error の分類、モデル切替、`prompt.send` の受け付け確認を classic event に頼っている。該当する機械では webui からの入力が毎回「未確認」になりうる (受け付けの event が来ないため、コードからの読みで未検証)。kawaz の各 config home が該当するかは未確認 (このマシンには macOS の system 側の managed settings の置き場 (ClaudeCode のディレクトリ) が無かった。Team / Enterprise 組織かどうかは見ていない)
2. **import の可否の記述が違う**。ccmsg は「module loader は実行時の import をしない」と書き、リファレンスは「plugin 内の別ファイルは `import` 宣言で読める、bare specifier は拒む」と書く。context-notify は hooks.json が `./register.ts` を直接名指し、それが `./notify` を相対 import する形で動いている (`context-notify:hooks/hooks.json`、`context-notify:hooks/register.ts:6-22`)
3. **`$` から socket に繋ぐ口の有無の記述が違う**。DR-0035 §3 は「`$` には socket を直接開く口が無い」、リファレンスは `$.http.fetch` の `socketPath` で Unix socket 越しの HTTP を話せると書く (ただしリファレンス自身が適用範囲を未確認としている)
4. **同じ事実を別の経路で取っている**。ctx の使用量は ccmsg が `session.measure` (main の turn ごと) と transcript の fold、context-notify が `turn.step` の後の `$.session.usage()` (request ごと、transcript を待つ遅れが無いと実測) で取る。effort は ccmsg が `classic.Stop` で、`turn.step` の `e.effort` は使っていない。ccmsg が `turn.step` を避けた理由 (応答の断片がすべて module を通る、DR-0035 §3) に対し、context-notify は `yield* next(e)` の形で `turn.step` を hook して本番で使っている
5. ccmsg の findings (2026-10-14) が「未観測」とした subagent の `tool.call` は、リファレンスと context-notify DR-0003 で実測済み。逆に、リファレンスが未確認とした `/clear` での `classic.SessionStart (source: clear)` は ccmsg の findings が実測している
6. 入力の注入で、fill から Enter までの間 (DR-0035 §1 の実測で約 55ms) にダイアログが開くと Enter がダイアログに届く可能性を、リファレンスは推測として書いている。ccmsg はその間のダイアログを検知していない

## 実用的な示唆 / ベストプラクティス

### 活用候補

各候補に、使う口 (リファレンスの該当箇所)、ccmsg の何を置き換える・足すか、期待効果、制約、要る probe を書く。probe はどれも未実施。classic を全廃する方針に合わせ、各候補は Mods の engine event だけで組む形で書く。

#### B1. agent tree の生存判定を event にする (`turn.*` の `agentId`、`agent.spawn`)

- 口: リファレンス `events` の「意味論の注意」(`turn.start` / `turn.step` / `turn.complete` は subagent・teammate の turn でも起き `e.agentId` で区別、`turn.complete` は spawner を含む全 hook が聞く)、`capabilities` の `agent.spawn` 行 (`e` に `subagentType` / `description` / `background` / `isTeammate?` / `workflow?` / `name?`、結果に `agentId?` / `teammateId?`)、`dollar-api` の `agent.list()` (`id` / `type` / `status` / `parentId?` / `spawnedBy?` / `name?`)
- 置き換えるもの: `readAgentTree` の深さ 1 以上の生存判定は transcript の mtime からの推定で、長い tool 呼び出しの間は「止まった」に見えると Design rationale に書いてある (`packages/daemon/src/session-status.ts:1340-1361`)。turn の開始と終了を agentId ごとに受ければ推定が要らなくなる。spawn の親子は `agent.spawn` の結果と `parentAgentId` で取れる。`classic.SubagentStart` / `SubagentStop` は使わない (全廃の方針。`agent_transcript_path` は daemon が meta.json から引く今の形のまま)
- 期待効果: 大。agent tree の state が推定でなく事実になる。snapshot ごとの meta.json の読み直しも module のあるセッションでは減らせる
- 制約: 過去分と daemon が居なかった間の分は取れない (findings 2026-10-14 の「置き換えられないもの」)。`$.agent.list()` は workflow の agent を含まず、終わった subagent は落ちる (同 findings、型)。TL の drilldown は subagent transcript を読み続ける。module の無いセッション用に transcript の fold は残るので、経路が 2 本になる
- probe: (1) 本体の module が subagent / teammate / workflow の agent の `turn.start` / `turn.complete` を受けるか (リファレンスの「spawn の内側にいた hook は agent の start を聞かない」が本体の module に当たるか。context-notify DR-0003 は subagent の `turn.step` と `tool.call` に `agentId` が付くことを実測している)、(2) workflow の agent が `agent.spawn` を通るか (リファレンス `capabilities` は「workflow の `agent()` と resume は deny だけ効く」と書くので通ると読めるが未確認)。どちらも API の応答が要る。findings 2026-10-14 では認証付きの隔離起動が auto mode classifier に止められたので、kawaz の許可を取ってから行う

#### B2. 入力待ちの即時通知 (`tool.check`、AskUserQuestion の `tool.call`)

- 口: リファレンス `dialogs` の「permission の時系列」(`tool.check` は mode が ask を決着させる前、`{ decision: 'ask' }` の後にダイアログか classifier か host が決着させる)、`capabilities` の `tool.call` (AskUserQuestion の入力は `questions`、`ui.render` の `AskUserQuestion` component)
- 置き換えるもの: sidebar の waiting は `claude agents --json` の 5 秒 poll (`packages/daemon/src/agents.ts:17-31`) の `status: waiting` / `waitingFor`。module が「何で待っているか」を session facts に足して即時に送る。解除は `tool.call` の `next(e)` の resolve
- 期待効果: 中。待ちの検知が最大 5 秒から即時になり、待っている tool と引数を webui に出せる
- 制約: classic を使わないので、ダイアログ直前の確かな event (`classic.PermissionRequest`) は使えない。`tool.check` の `ask` は auto mode では classifier が決着させるので、ダイアログが出ると言い切れない (`tool.check` の答えから決着者を見分けられるかはリファレンスに記述が無い)。permission ダイアログには `ui.render` の component が無い (リファレンス `capabilities` の `ui.render` 備考)。`tool.check` は hook した plugin がある時だけ engine が上げる event で、hook すると全 tool 呼び出しで上がるようになる (リファレンス `events`)。`idle_prompt` の通知 (`classic.Notification`) は代わりが無い。engine 自身のダイアログ (trust・hot-reload の同意など) には event が無い。poll はセッションの発見と module の無いセッションのために残る
- probe: `tool.check` の after で、ダイアログになる `ask` と classifier に回る `ask` を区別できるか (permission mode を `e` か `$.settings.read` で知れるか)

#### B3. エージェント向けの `ccmsg:` 宛先の案内 (issue agent-guidance-for-ccmsg-addresses)

issue の推し (b) SessionStart hook の `additionalContext` は classic (command hook か `classic.SessionStart`) なので、全廃の方針では使えない。Mods の口を並べる。

| 口 | 載る場所と寿命 | 組織が管理する機械 | 実装の重さ |
|---|---|---|---|
| `tool.describe` で SendMessage の説明に 1〜2 文を足す | tool の説明そのもの。model が SendMessage を使う時に読む場所。session 内 cache、変えると prompt cache が書き直る (リファレンス `capabilities`) | 対象 tool の provider が組織の tier の時だけ飛ばされる。SendMessage は core なので効くと読める | 小 |
| `$.session.append` (`type: 'user'`) | 会話に 1 行。context-notify DR-0003 の実測: transcript に `isMeta: true` の user 行として残り画面には出ない、次の request で model が読む、継続 turn は起きない。`/clear` で消え、compaction で要約されうる | door `note` は効く (リファレンス `capabilities` 末尾) | 中。`/clear` と compact の後に足し直す契機が要る (`command.run (clear)` の after、`session.compact` は `sec-default` の対象) |
| `prompt.context` の独自 block | 最初の user message の context block。会話ごと 1 回、compaction と `/clear` で再計算 | user tier は飛ばされる | 小 |
| `$.tool.register` で `mcp__<plugin>__peers` を足す | 宛先を探す道具そのものを model に渡す。context-notify は `isDeferred: false` の check tool を `session.start` で登録し、`tool.call` の `{ result }` で答えている (`context-notify:hooks/register.ts:177-216`) | `tool.register` の拒否は組織の MCP の制限がある時 (リファレンス `overview`) | 中 |

- 判断の軸: 「案内が SendMessage を書く瞬間に見えるか」なら `tool.describe` が最も近い。「compact / `/clear` を跨いで確実に残るか」なら `prompt.context` が engine に再計算される (ただし組織の機械では飛ばされる)
- 制約: DR-0035 §4 はサイドカーの socket path と依頼の形式を agent が読む面に書かないと定める。案内は `ccmsg peers` → `addresses` → `SendMessage({ to })` の導線に留める
- probe: SendMessage が deferred tool (ToolSearch の後ろ) かどうかと、その時 `tool.describe` の書き換えが model に届く時機。`tool.describe` の結果がセッションの最初の turn に間に合うか

#### B4. `prompt.send` の受け付け確認を `prompt.submit` に寄せる (issue mods-consolidation の受け入れ条件 2)

- 口: リファレンス `events` (`prompt.submit` の `next(e)` は turn の開始か queue に入った時点で resolve)、`capabilities` の `prompt.submit` (`origin.kind`、`text`)
- 現状: 受け付けは `classic.UserPromptSubmit` で取り (`hooks/composer-fill.ts:988-1004`)、書きかけの復元は既に `prompt.submit` の after で `origin.kind === 'composer'` と文の一致を見て行っている (`hooks/composer-fill.ts:1005-1022`)。同じ文の一致判定が両方の event に既にある
- context-notify DR-0003 は `UserPromptSubmit` を使わない理由に「外部注入や別セッションからのメッセージが起点のターンでは発火しない経路がある」と書き、`prompt.submit` は「ユーザ入力に限らずターンを始める入力 (task-notification、別セッションからのメッセージ等) で発火する」と実測している。ccmsg の composer 経路では `classic.UserPromptSubmit` が起きることを ccmsg が実測済み (DR-0035 §5) なので、ccmsg の用途ではどちらでも成り立つ。`prompt.submit` に寄せる時は `origin.kind === 'composer'` で絞ることが要る (今の復元と同じ)
- 期待効果: 中。classic の全廃に要る。受け付けと復元が 1 つの event にまとまる
- 制約: DR-0035 §5 の裁定 (成功は `classic.UserPromptSubmit` の時点) の変更が要る
- probe: busy 中の Enter で `prompt.submit` の hook が Enter の時点で呼ばれるか (DR-0035 §5 は `classic.UserPromptSubmit` について 2.1.291 で実測済み。`prompt.submit` は未確認)。`e.text` が末尾空白を落とした後の文か

#### B5. classic を全廃する (方針、event 単位の対応表)

ccmsg に残る classic は、command hook の SessionStart (`hooks/hooks.json:3-14` → `hooks/session-start.ts`) と、module 内の `classic.*` 5 つ。加えて、B2 / B8 で使いたくなる classic を並べる。

| classic の口 | ccmsg での用途 | Mods での代わり | 取れなくなる・差が出るもの | 根拠 |
|---|---|---|---|---|
| command hook SessionStart `startup` (`session-start.ts`) | state file (transcript_path / cwd / repo / ws / repo_root / branch) を書き、`daemon start` を detached で起こす (`hooks/session-start.ts:302-341`) | `session.start` (プロセスごと・読み込みごとに 1 回、最初の 1 回は await) から `$.process.run([bin/ccmsg, ...])`。cwd は `$.session.cwd()`、repo の root と remote は `$.session.repo()`、ws / branch は今と同じく bump-semver を `$.process.run` | transcript path を返す `$` は無い (リファレンス `dollar-api` の session の method に無い)。classic の全 event の `e.transcript_path` が今の出所 (findings 2026-10-14)。daemon が sid から解決する今の fallback (`resolvePendingTranscripts`) に寄せる | リファレンス `events`、`dollar-api` |
| 同 `resume` | `claude --resume` の起動と `/resume` で state file を書き直す | 起動時の resume は新しいプロセスなので `session.start` が起きる。セッション内の `/resume` は `session.start` が起きず、`session.end` (`reason: 'resume'`) と `command.run` (`{ command: ['clear', 'resume'] }`) の after で拾う | 未検証: `command.run` の after の時点で `$.session.id()` が新しい id を返すか | リファレンス `events` の「意味論の注意」(built-in `diff` の形) |
| 同 `clear`、module の `classic.SessionStart (clear)` | 新しい sid でサイドカーを起こし直し、事実を読み直し、turn を idle にする (`hooks/composer-fill.ts:910-921`) | `session.end (clear)` で旧 id の世代を進め (今もしている、`hooks/composer-fill.ts:895-909`)、`command.run (clear)` の after で `$.session.id()` を読み直してサイドカーと事実を更新 | 同上の未検証。findings 2026-10-14 は `/clear` の順序を `command.run (clear)` → `classic.SessionEnd` → `session.end (clear)` → `classic.SessionStart (clear)` と実測したが、`command.run` の after が resolve する時点は見ていない | findings 2026-10-14、リファレンス `events` |
| 同 `compact`、module の `classic.SessionStart (compact)` | state file の書き直しと model / window の読み直し | 不要と読める。compaction で変わるのは使用量だけで、次の `session.measure` か `turn.step` で取れる。turn の途中でありうる点 (DR-0035 §3) も、engine event では turn の状態を触らないので問題にならない。compaction 自体を知るなら `session.compact` があるが、`sec-default` の対象 | 無し | リファレンス `capabilities` の `session.compact`、`overview` の `sec-default` |
| `classic.Stop` の `effort.level` | 本体の turn の effort (`hooks/composer-fill.ts:960-966`) | `turn.step` の `e.effort` (main は `agentId` 無し)。context-notify の `turn.step` の形 (B17) で hook する | 差は無く、request の時点で分かるので今より早い。effort 非対応のモデルでは key が無い (findings 2026-10-14 実測) | findings 2026-10-14、context-notify DR-0003 |
| `classic.StopFailure` の `error` / `last_assistant_message` | API error の分類と表示文 (`hooks/composer-fill.ts:939-959`) | `turn.complete` の `reason: 'error'` で立てる (今も StopFailure が無い時はこれで分類 `unknown` を立てている、`hooks/composer-fill.ts:711-726`) | **分類と表示文が取れない**。リファレンスの `turn.complete` / `turn.step` の欄に分類は無い。未検証の候補: `turn.step` の `next(e)` が API error でどう終わるか (reject の message、`stopReason`)、harness が書く API error の行 (`isApiErrorMessage`) が `session.append` (door `response`) を通るか | リファレンス `capabilities` |
| `classic.PostModelSwitch` | 切替直後に model と window を読み直す (`hooks/composer-fill.ts:981-987`) | 即時の代わりは無い (リファレンスの engine event 一覧にモデル切替は無い)。次の request の `turn.step` の `e.model` と、その時の `$.session.usage().context.window` で追従する | 切替から次の prompt までの間、webui の model / window が古い。未検証の候補: `/model` が `config.set` (key `model`) か `command.run` (`model`) を通るか | リファレンス `events`、findings 2026-10-14 (`turn.step.model` は `[1m]` 付きで実測) |
| `classic.UserPromptSubmit` | `prompt.send` の受け付け (`hooks/composer-fill.ts:988-1004`) | `prompt.submit` (B4) | busy 時に Enter の時点で発火するかが未検証 | B4 |
| `classic.PermissionRequest` (B2 で使いたくなるもの) | (未使用) | `tool.check` の `ask` | ダイアログ直前の確かな契機が無くなる (B2 の制約) | リファレンス `dialogs` |
| `classic.Notification` (`idle_prompt` / permission) | (未使用) | 無し | 応答完了 60 秒後の idle 通知 | リファレンス `events` |
| `classic.Stop` の `background_tasks` (B8) | (未使用) | `tool.call` (Bash の `run_in_background`、Monitor、Agent の background) の結果と `prompt.submit` (`origin.kind: 'task-notification'`) で module が畳む | turn の終わりの in-flight 一覧という形は無い。一覧の getter も無い | リファレンス `capabilities`、findings 2026-10-14 |
| `classic.TaskCreated` / `TaskCompleted` (B8) | (未使用) | `tool.call` (TaskCreate / TaskUpdate) | 無しと読める (未検証) | リファレンス `capabilities` |
| `classic.CwdChanged` | (未使用) | 無し。`$.session.cwd()` を `turn.complete` 等で読み直す | 変化の瞬間 | リファレンス `events` |
| `classic.SessionEnd` | (未使用) | `session.end` (`kill -9` では起きない、chain 全体で 1.5 秒の予算) | 無し | リファレンス `events` |

`-p` と subagent での差:

- `-p`: module は読まれ (未 trust の cwd でも)、`session.start` は `surface: null` / `isInteractive: false`、`prompt.submit` の `origin` は `sdk` (リファレンス `events`)。`turn.step` は `-p` でも起きる (findings 2026-10-14 の `-p` の表で `turn.step.effort` を実測)。サイドカーは起こさない (DR-0035 §3) ので、事実の送信と state file の書き出しは CLI を `$.process.run` で直接呼ぶ形が要る
- subagent: `turn.*` / `tool.call` / `turn.step` は subagent でも同じ module に届き `agentId` が付く (リファレンス、context-notify DR-0003 の実測)。classic の `Stop` は main だけ (subagent は `SubagentStop`) だったので、Mods では `e.agentId === undefined` で main に絞る (context-notify の `turn.step` と同じ、`context-notify:hooks/register.ts:197-201`)

全廃の障害と前提:

- 読み込みの条件が違う: module は未 trust の workspace、safe mode、`--bare` (managed 以外)、`disableAllHooks` / `allowManagedHooksOnly` / policy、`allowManagedModsOnly` で読まれない (リファレンス `overview`)。command hook がこのうちどれで走るかは未検証で、「module が読まれず command hook だけが走る」集合があれば、そこでは state file と daemon の起動が消える。daemon は CLI の初回使用でも立つ (`hooks/session-start.ts:337`)
- `daemon start` を `$.process.run` で呼ぶ: リファレンス `dollar-api` は「背景に残って書き続ける子がいると timeout まで返らない」と書く。CLI は daemon を stdin / stdout / stderr とも ignore、`detached: true` で起こす (`packages/cli/src/client.ts:245-266`) ので、pipe を握る子は残らないと読める (未検証)
- state file の書き出し先 (`resolvePaths().stateDir`) は CLI が環境変数から解く。module から `$.fs.write` で書くなら `$.env.get` で読む変数名をリテラルで列挙する必要がある (リファレンス `dollar-api` の「制限」)。CLI のサブコマンドを足して `$.process.run` で呼ぶ方が経路が 1 本で済む
- API error の分類の代わりが probe で見つからなければ、分類は transcript の fold (今の module の無いセッション用の経路) の本文に戻るか、分類を諦める
- probe の順: `command.run (clear)` / `(resume)` の after の `$.session.id()`、`turn.step` の API error の終わり方、`$.process.run` の `daemon start`、busy 時の `prompt.submit` (B4)

#### B6. サイドカーから harness の pid を知る

- 口: リファレンス `overview` の「2026-10-14 時点の未確認」(`$.process.run` の子の親 pid が worker か engine 本体か)
- 置き換えるもの: daemon は run と harness の pid を `claude agents --json` の行の開始時刻の近さで結んでいる (`packages/daemon/src/sidecar-runs.ts:9-14`、DR-0035 §3)。`$.process.spawn` の子 (サイドカー) の親が harness 本体なら、サイドカーは `ps` 無しで親 pid を名乗れる
- 期待効果: 中。推定の対応付けが事実になり、同じ sid の run が複数ある時の取り違えが無くなる。並行している ps 依存の除去作業とも関係する
- 制約: 親が worker プロセスなら使えない
- probe: 隔離環境でサイドカー相当の子に親 pid を出させ、`claude agents --json` の pid と比べる。API の応答は要らない

#### B7. 応答中の細かい状態と途中経過 (`tool.call`、`turn.step`)

- 口: リファレンス `capabilities` の `tool.call` (before / after、`agentId`)、`turn.step` (stream、最後に `answer` / `toolUses` / `usage`)
- 足すもの: TL の「応答中」の行に「Bash を実行中: <description>」のような今の tool を出す。ctx の分子は B17 のとおり `turn.step` の後の `$.session.usage()` で request ごとに取れる (context-notify DR-0003 の実測)。`turn.step` の stream で応答の途中の文字を TL に流すのは別の設計判断
- 期待効果: 中 (tool 表示)、大 (途中の文字。ただし重い)
- 制約: 送るたびに `ccmsg sidecar facts` の process を起こすと 1 回あたり bun の起動が乗る (`hooks/composer-fill.ts:269-272` の実測で往復約 0.3 秒)。送信は 1 本ずつに畳まれる (`hooks/composer-fill.ts:614-639`) ので詰まりはしないが、B10 の送信経路と合わせて考える
- probe: 不要 (tool 表示)。途中の文字は chunk の形を確かめる

#### B8. todo と background を module で畳む

- 口: リファレンス `capabilities` の `tool.call` (TaskCreate / TaskUpdate / TaskStop、Bash の `run_in_background`、Monitor の引数と結果。subagent の分は `agentId` 付き、実測)、`prompt.submit` の `origin.kind: 'task-notification'`
- 置き換えるもの: session-status の fold が transcript の tool_use / 結果 / `task_reminder` attachment / `<task-notification>` を組み合わせている部分 (`packages/daemon/src/session-status.ts:79-123` の PREFILTER)。subagent の Task は `task_reminder` 待ちになっている
- 期待効果: 中。subagent の Task が reminder 待ちでなく即時に出る
- 制約: 一覧の getter が無いので module が状態を畳み、daemon の再接続時に全体を送り直す。classic を使わないので `classic.Stop` の `background_tasks` (in-flight 一覧) で答え合わせする手は無い (B5)。module の reload で module 変数が消えるので、畳んだ状態は `$.state` に置く (B9)。module の無いセッションのために fold は残る
- probe: API の応答が要る (B1 と同じ許可の問題)

#### B9. module の状態を reload に耐えさせる (`$.state` / `$.store`)

- 口: リファレンス `dollar-api` の `state` (session の値を host が持ち reload を跨ぐ)、`practices` の「状態の置き場」(`$.state` は `/clear`・resume・終了で消える、`$.store` は config home 単位で永続・全体 4 MiB)、`overview` (module 変数は reload で消える)
- 置き換えるもの: `ModuleState` (`hooks/composer-fill.ts:335-386`) の run id、事実、書きかけ (`restoring`)。reload が入ると run id が引き直されて daemon からは別の run に見え、事実は次の event まで空になり、fill と Enter の間の書きかけは失われる (リファレンス `prompt-injection` の「注意」が同じことを書く)
- reload の契機: context-notify の release 手順は、更新後に「各環境のセッションで `/reload-plugins` すると restart 無しで反映される」と案内している (`context-notify:justfile` の `on-success-release`)。DR-0035 §3 の「動いているセッションには前の版の module が残りうる」は、`/reload-plugins` で新しい module に入れ替わる経路もあることになる (その時 `session.start` が再度走るかはリファレンス `events` の「後の回 (enable・worker の再起動・hot-reload) はその plugin の hook だけが走る」から読めるが、`/reload-plugins` については未確認)
- context-notify の置き方: 消えてほしくない値は `$.store` に `session:<sid>` の key で持ち、`updatedAt` を 1 日以上経った時だけ書き直し、`session.start` で 30 日触られていない key を掃除する (`context-notify:hooks/notify.ts:29-41`、`context-notify:hooks/register.ts:161-169`)。`$.state` は `/clear` と resume で消えるので使わない (同 DR-0003 §3)
- ccmsg への当てはめ: 事実は daemon が `session.facts` で問い直せるので、reload で消えても次の event か問い合わせで戻る。reload を跨いで残したいのは run id と書きかけ。run id は `/clear` を跨いで同じでなければならない (DR-0035 §3) ので、`/clear` で消える `$.state` には置けない。`$.store` に置くなら key に何を使うか (sid は `/clear` で変わる) の設計が要る
- 期待効果: 小〜中
- 制約: `$.state` / `$.store` の参照のリテラル規則 (リファレンス `dollar-api` の「制限」)。`$.store` から読み戻す値は外から来るデータとして parse する (context-notify の `readLatch`、`context-notify:hooks/register.ts:83-101`)
- probe: `/reload-plugins` で module がどう読み直されるか (`session.start` の再実行、サイドカーの kill と再 spawn)

#### B10. daemon への送信を `$.http.fetch` にする

- 口: リファレンス `dollar-api` の `http.fetch` (`socketPath` で Unix socket 越しの HTTP、http / https だけ、WebSocket 無し、body 4 MiB)
- 置き換えるもの: 事実の送信と返事を `$.process.run([bin/ccmsg, "sidecar", "facts" | "reply", ...])` で行っている (`hooks/composer-fill.ts:489-503,618-639`)。daemon の HTTP は `/ws` (WebSocket) と添付・webhook・fs-serve だけで、op を受ける素の HTTP endpoint は無い (`packages/daemon/src/http.ts:259-294`)。UDS は行の protocol で HTTP ではない
- 期待効果: 小〜中。1 送信ごとの bun の起動が無くなる。B7 / B17 のように送る回数を増やす時に効く
- 制約: daemon に HTTP の op endpoint と、session role をどう名乗るか (今は CLI が hello する) の設計が要る。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` と組織の web-fetch policy の下での扱い (リファレンスは「built-in の request と `auth` 付きの request を拒む」と書く)。`socketPath` が任意の UDS に繋がるかはリファレンス自身が未確認。context-notify は外部コマンドも外部通信も持たない設計 (DR-0003 §1) で、この点の参照実装にはならない
- probe: `socketPath` で daemon の state dir の下の UDS に HTTP を話せるか、loopback の HTTP に `$.http.fetch` が届くか

#### B11. cache keepalive と復帰の起こしを subscribe でなく module で行う

- 口: リファレンス `dollar-api` の `prompt.submit` (session が idle になってから自前の turn、`origin` は `{ kind: 'plugin', name }`) と `model.fork` (main thread の最後の request の後ろに prompt を足した tool 無しの completion、「prefix が cache から出る」、最初の応答前と `/clear` 後は `nothing-to-fork`)
- 置き換えるもの: keepalive の marker (`packages/daemon/src/cache-keepalive.ts:1-21`) と network 復帰の起こし (`packages/daemon/src/session-wake.ts:1-14`) は、セッションが開いている `subscribe` stream (Monitor) に頼る。subscribe が無いセッションには届かない
- 期待効果: 中。keepalive を `$.model.fork` で送れれば、会話に turn を残さずに cache を温められる。起こしは `$.prompt.submit` で Monitor 無しに届く
- 制約: `$.model.fork` は「tool 無し」とリファレンスにあり、tool 定義を含む prefix の cache を本当に温めるかは要確認。gateway は marker が request に載ることで keepalive を確認するので、fork の request に marker を載せれば足りるかは gateway 側の仕様次第。サイドカーは composer のあるセッションにしか無い (DR-0035 §3)
- probe: `$.model.fork` の request の cache read / write の usage。`$.prompt.submit` が API error で止まったセッションで再試行の turn になるか

#### B12. rename を `$.command.run` にする

- 口: リファレンス `dollar-api` の `command.run` (session が idle になってから走る)
- 置き換えるもの: rename は hyoui で `/rename <title>` と Enter を端末に打っている (`packages/daemon/src/session-rename.ts:75-85`)。hyoui の外のセッションでは使えず、人の打鍵と混ざりうる
- 期待効果: 小〜中。端末の無いセッションでも rename でき、打鍵の競合が無くなる
- 制約: idle まで待つ。サイドカーのあるセッション (composer のあるもの) に限られる
- probe: built-in の `rename` が `$.command.run` で走るか

#### B13. webui からダイアログに答える (`dialogs`)

- 口: リファレンス `dialogs` の「待つ形」(AskUserQuestion は `tool.call` の during で外部から `{ result }` を返すとダイアログが閉じる、実測。permission は during では `{ deny }` だけ、許可は `tool.check` で出る前に決める、実測)
- 足すもの: AskUserQuestion の質問を webui に出し、webui の答えで閉じる (端末の人が先に答えればそちらが勝つ)。permission は webui から拒否だけを返す
- 期待効果: 中〜大 (人が端末の前に居ない時)
- 制約: **サイドカーには認証が無い** (DR-0035 §4 は「同じ uid のプロセスが規約 path を組み立てて書くことは防がず、classifier に任せる」と定める)。人の入力は composer に入るだけだが、permission の許可や AskUserQuestion の答えをサイドカー経由で受けると、同じ uid の agent が自分の permission を自分で通す口になる。許可側はこの認証の設計が先に要る。拒否と AskUserQuestion の答えも同じ口を通るので、扱いを DR で決めてから行う。permission の許可を出る前に外へ訊く形は、待つ間ダイアログが出ないので端末の人が答えられない (race できない)。組織が管理する機械では deny rule が mod の allow に勝つ
- probe: AskUserQuestion の during で daemon 経由の答えを返す一巡

#### B14. 注入の Enter がダイアログに当たる窓を塞ぐ

- 口: リファレンス `prompt-injection` の「注意」(`refusal: 'dialog'` のまま Enter を送ると、Enter はダイアログに届いて選択中の項目を確定させる、推測・未検証)、`dialogs` の時系列 (`tool.check` がダイアログの前に起きる)
- 現状: fill の拒否は Enter の前に見ている (`hooks/composer-fill.ts:427-428`) が、fill が通った後から Enter までの間 (`hooks/composer-fill.ts:433-447`、DR-0035 §1 の実測で約 55ms) にダイアログが開くことは見ていない。busy のセッションに入力した時は tool の permission がいつでも出うる
- 足すもの: module が `tool.check` の `ask` と AskUserQuestion の `tool.call` を受けた時に「ダイアログが出うる」を立て、`tool.call` の resolve で下ろし、Enter の直前にそれを見る (classic を使わないので `classic.PermissionRequest` ではなくこの形)。または Enter の直前に同じ文で fill し直して `refusal: 'dialog'` を見る
- 期待効果: 当たれば影響が大きい (permission の既定の選択を確定しうる)。起きる頻度は低い
- 制約: 窓は縮むが 0 にはならない。`tool.check` を hook すると全 tool 呼び出しで上がるようになる (B2)
- probe: まず「ダイアログ表示中の Enter が既定の選択を確定するか」を隔離環境で確かめる (リファレンスの推測の裏取り)

#### B15. TUI に ccmsg の状態を 1 行出す (`$.ui.status`)

- 口: リファレンス `dollar-api` の `ui.status` (plugin ごと 1 行を prompt の下に固定)、`ui.toast`
- 足すもの: daemon に繋がっていない (webui からの入力が届かない) こと、このセッションの `ccmsg:` 宛先、webui から入力が入った直後の告知など
- 期待効果: 小。端末の人が ccmsg の状態を知れる
- 制約: `-p` では描かれない。say は CLI が macOS の `say` を叩き、daemon は記録だけを持つ (`packages/daemon/src/server.ts:2377-2390`) ので、`$.audio.speak` / `$.ui.notify` に置き換える利点は見当たらない (CLI の say は module の無いセッションでも動く)

#### B16. テストを `claude plugin test` に寄せるか

- context-notify の形: hook の振る舞いは `tests/register.test.ts` で engine に hook を起こさせ、`$` の下 (`fs.*` / `session.usage` / `session.id` / `turn.step` / `session.append` と `mock.store` / `mock.clock` / `mock.env`) をテストが答える (`context-notify:tests/register.test.ts:1-117`、DR-0003 §8)。`$` に触れない判定は別ファイル (`hooks/notify.ts`) に置いて直接呼ぶ。型は engine が書き出した `claude-code` の型を `import type` し、`tsconfig.json` は書き出された tsconfig を extends する (`context-notify:hooks/register.ts:5`、`context-notify:tsconfig.json`)
- ccmsg の形: `bun test` で、自前の `Engine` 型 (`hooks/composer-fill.ts:94-127`) を満たす stand-in の engine を使う (`hooks/composer-fill.test.ts:1-5`)。自前の型にしているのは、型が engine の書き出す場所にしか無いため (`hooks/composer-fill.ts:94-97`)
- 差: `claude plugin test` は engine 自身の chain (`.catch` の replay、validate と同じ静的な読み、失敗した hook の扱い) を通すので、stand-in では確かめられない「engine がその書き方を受け付けるか」を見られる。代わりに `claude` が要り、context-notify の `lint-ts` は型の書き出しが無いと失敗する (`context-notify:justfile` の `lint-ts`、DR-0003 Consequences)。ccmsg は GitHub CI で bundle を検査している (`justfile:146-149`) ので、`claude` を CI に置けるかが判断の軸になる。自前の `Engine` 型は engine の型とずれても気づけない
- bundle: context-notify は依存を持たず、外から来るデータを手書きの parse で読む (DR-0003 §7、vendoring の負担が釣り合わないため)。ccmsg は protocol のスキーマ (valibot) を daemon と共有しているので、bundle の理由は context-notify の判断と前提が違い、残る
- probe: bundle (`composer-fill.bundle.js`) を対象に `claude plugin test` の test file が書けるか

#### B17. ctx の使用量と effort を `turn.step` で取る (context-notify と同じ経路に揃える)

- 口: context-notify の `turn.step` の hook (`context-notify:hooks/register.ts:195-204`): `async function*` で `const r = yield* next(e)`、`e.agentId === undefined && r.usage !== null` の時だけ `$.session.usage()` を読み、`.catch(async function* ($, e, next) { return yield* next(e) })` で失敗を素通しにする。context-notify DR-0003 の実測: 「`turn.step` の `next(e)` が返った時点で、`$.session.usage()` の `context.tokens / window / percent` はその応答の値になっている。transcript の書き込みを待つ遅れが無い」
- 置き換えるもの: ccmsg は使用量を `session.measure` (main の turn ごと) で取り、tool の続く turn の途中は transcript の fold の方が新しいので両方の新しい方を使う (DR-0035 §3)。`turn.step` で取れば request ごとに更新でき、module のあるセッションでは使用量のための transcript の fold が要らなくなる。同じ hook で `e.effort` と `e.model` も取れ、`classic.Stop` (effort) を外せる (B5)
- DR-0035 §3 が `turn.step` を避けた理由「hook を置くと応答の断片がすべて module を通る」について: context-notify は `yield* next(e)` で断片を素通しにして本番で使っている。断片が module を通ること自体のコストを測った記録は ccmsg にも context-notify にも無い (未検証)
- 期待効果: 中。ctx の分子が turn の途中でも即時になり、effort が request の時点で分かる
- 制約: 送信は B7 / B10 と同じく process の起動が乗る。module の中で 1 本ずつに畳む (今の `sendFacts`)。並行した request (subagent と main) は context-notify も `oneAtATime` で直列にしている (`context-notify:hooks/register.ts:150-159`)
- probe: 応答の断片が多い request で `turn.step` の hook を置いた時の遅れ

### 優先順位

効果・実装の軽さ・probe の要否からの目安。「probe」は着手前に要る実機確認の重さ (API の応答が要るものは kawaz の許可が要る)。

| 順 | 候補 | 効果 | 実装の軽さ | probe |
|---|---|---|---|---|
| 1 | B5 classic の全廃 (B4 / B17 を含む) | 大 (組織の機械での全滅を避ける、方針) | 中 | 中 (`command.run (clear)` の after、API error の終わり方、`daemon start`、busy 時の `prompt.submit`) |
| 2 | B14 Enter がダイアログに当たる窓 | 当たれば大、頻度は低 | 軽 | 中 (隔離環境で Enter の挙動) |
| 3 | B3 `ccmsg:` 宛先の案内 | 中〜大 (open issue の解消) | 軽 | 軽 (`tool.describe` 案なら deferred かの確認) |
| 4 | B6 サイドカーの親 pid | 中 | 軽 | 軽 (API 不要) |
| 5 | B1 agent tree の生存判定 | 大 | 重 | 重 (API が要る) |
| 6 | B2 入力待ちの即時通知 | 中 | 中 | 中 (`tool.check` の ask の決着者) |
| 7 | B12 rename を `$.command.run` に | 小〜中 | 軽 | 軽 |
| 8 | B9 reload に耐える状態 | 小〜中 | 中 | 中 (`/reload-plugins`) |
| 9 | B11 keepalive / 起こし | 中 | 中 | 重 (fork の cache の挙動、gateway) |
| 10 | B7 応答中の tool 表示 | 中 | 中 | 軽 |
| 11 | B16 `claude plugin test` | 中 (engine の受け付けを試験できる) | 中 | 軽 (bundle を対象にできるか) |
| 12 | B8 todo / background | 中 | 重 | 重 (API が要る) |
| 13 | B10 `$.http.fetch` | 小〜中 | 中 (daemon 側の endpoint) | 中 |
| 14 | B13 ダイアログに webui から答える | 中〜大 | 重 (認証の設計が先) | 中 |
| 15 | B15 `$.ui.status` | 小 | 軽 | 不要 |

## 検証の詳細

### ccmsg の実装とリファレンスの記述の照合

| ccmsg の前提 | ccmsg の箇所 | リファレンスの記述 | 判定 |
|---|---|---|---|
| hook の失敗は飛ばされ下が走る。`.catch` の `next` は replay-safe | `hooks/composer-fill.ts:157-163,880-884` | `overview` の「失敗と `.catch`」 | 一致 |
| `session.send` が throw すると harness が宛先を agent 名として探す | `hooks/composer-fill.ts:37-44,1023-1025`、DR-0037 | `overview`: 失敗した hook は飛ばされ下と core が走る | 一致 |
| harness の SendMessage は同じ config home のセッションにしか届かない | `hooks/composer-fill.ts:37-40` | `dollar-api` の `$.session.send` (実測) | 一致 |
| `/clear` では `session.start` が起きず `classic.SessionStart (source: clear)` で新しい id が分かる | `hooks/composer-fill.ts:910-921`、findings 2026-10-14 (2.1.299 実測) | `events` は `session.start` が起きないことを実測とし、`capabilities` は `classic.SessionStart (clear)` が mod に届くかを未確認とする | ccmsg が先に実測 (フィードバック候補 1) |
| `session.measure` は main の turn ごと、モデル切替では起きない | `hooks/composer-fill.ts:922-938` | `capabilities` の `session.measure` | 一致 |
| `turn.*` の main と subagent は `agentId` の有無で分ける | `hooks/composer-fill.ts:967-980` | `events`、`practices` | 一致 |
| effort を返す `$` は無い、`classic.Stop` の `effort.level` で取る | DR-0035 §3 | `dollar-api` に effort の getter は無い。`capabilities` は classic の共通欄に `effort?`、`turn.step` の `e` に `effort?` | getter が無い点は一致。`turn.step` の経路は ccmsg が使っていない (B17) |
| `turn.step` を hook すると応答の断片がすべて module を通るので使わない | DR-0035 §3 | `practices`: 「この 1 往復が `turn.step` で、全部拾える」。context-notify は `turn.step` を hook して本番で使っている | 判断の違い (B17) |
| `-p` は `surface: null` / `isInteractive: false` | `hooks/composer-fill.ts:888-889` | `events` の「対話と `-p` の差」 | 一致 |
| `$.process.spawn` の子は unload で kill、`input` は 1 回書いて閉じるので常駐の子に後から書けない | `hooks/composer-fill.ts:814-817`、DR-0035 §3 | `dollar-api` の「制限」 | 一致 |
| `$.process.run` は既定 30 秒で throw | `hooks/composer-fill.ts:273-279` | `dollar-api`: 既定 30 秒、最大 10 分 | 一致 |
| fill の拒否 (`dialog` / `no_composer`) を見てから Enter | `hooks/composer-fill.ts:427-428` | `prompt-injection` | 一致 |
| 注入の手順 (退避 → fill → 外部の Enter → `prompt.submit` の後に復元) | `hooks/composer-fill.ts:417-477,1005-1022` | `prompt-injection` の「手順」 | 一致。ccmsg は受け付けを `classic.UserPromptSubmit` で別に取る (B4) |
| module は実行時の import をしない | `hooks/composer-fill.ts:50-54`、`hooks/bundle.ts:1-3`、DR-0038 §4 | 食い違い 2 | 食い違い |
| `$` に socket を開く口は無い | DR-0035 §3 | 食い違い 3 | 食い違い |
| `$.process.run` の `env` は session の環境の上に重なる | `hooks/composer-fill.ts:586-587` | `dollar-api` は `env` を受けるとだけ書く | リファレンスに記述無し (フィードバック候補 4) |
| classic event の hook が効く前提 | `hooks/composer-fill.ts:910,942,960,981,988` | 食い違い 1 | 環境次第 (B5 で解消する) |

### 参照実装 context-notify との対照

| 観点 | context-notify | ccmsg | 流用の形 |
|---|---|---|---|
| hooks.json | `{ "modules": ["./register.ts"] }` だけ。classic も command hook も無い | `modules` と command hook の SessionStart の併用 | B5 |
| 構成 | `register.ts` (配線と `$` を通した入出力) と `notify.ts` (`$` に触れない判定) の 2 ファイル (DR-0003 §1) | `composer-fill.ts` 1 ファイルに配線と処理。純粋な部分 (`samePrompt` / `lineSplitter` 等) は export してテストしている | 配線と判定を分けると、B1 / B8 の畳み込みを `$` 抜きで試験できる |
| 使用量の経路 | `turn.step` の後の `$.session.usage({ breakdown: 'summary' })` (request ごと) | `session.measure` の `e.context` (main の turn ごと) と transcript の fold | B17 |
| main と subagent | `e.agentId === undefined` で main に絞る | 同じ (`turn.*`)、classic は `agent_id` | 一致 |
| 会話への注入 | `$.session.append` (`type: 'user'`)、拒否 (`{ deny }`) なら状態を進めない | 無し | B3 |
| model が呼ぶ tool | `session.start` で `$.tool.register` (`isDeferred: false`)、`tool.call` の matcher `{ tool: 'mcp__context-notify__check' }` で `{ result }` | 無し | B3 の peers tool |
| skill への埋め込み | `skill.prompt` の matcher `{ skill: '<plugin>:<name>' }` で展開文の末尾に報告を足す (組織の機械では飛ばされると DR-0003 Consequences が明記) | 無し | v1 に skill を置く場合 |
| 状態 | `$.store` に `session:<sid>`、`updatedAt` と 30 日の掃除。`$.state` は `/clear` と resume で消えるので使わない | module 変数だけ | B9 |
| 並行 | 計測を `oneAtATime` で直列 | 事実の送信を `factsSend` で直列、`prompt.send` を `queue` で直列 | 同じ考え方 |
| 失敗の扱い | 全 hook に `.catch`。stream の `turn.step` は `async function*` の `.catch` で `yield* next(e)` | observe 系に `.catch(next(e))`、`session.send` は意図して `.catch` 無し | stream の `.catch` の書き方を B17 で使う |
| 外から来るデータ | 手書きの parse 2 か所 (`readList` / `readLatch`)、ライブラリは使わない | valibot のスキーマ (protocol と共有) を bundle | 前提が違うので ccmsg は bundle のまま (B16) |
| import | 相対 import (`./notify`) をそのまま読ませる | bundle で 1 ファイルに畳む | 食い違い 2 |
| 型 | `import type { EngineInterface, Register } from 'claude-code'`、tsconfig は engine の書き出しを extends | 自前の `Engine` 型 | B16 |
| テスト | `claude plugin test` (engine の chain と `mock.*`) | `bun test` と stand-in の engine | B16 |
| 外部プロセス | 起こさない (DR-0003 §1) | `$.process.run` / `spawn` で CLI とサイドカー | ccmsg の役割上残る |
| 組織の機械 | `classic.*` を避けた (DR-0003 Alternatives: 「managed settings のある機械では、利用者が入れた plugin の `classic.*` hook が走らない」)。履歴も `classic.PostToolUse` / `classic.Stop` → `tool.call` → `turn.step` と移している (context-notify の commit 履歴) | `classic.*` 5 つに依存 | B5 |
| 配布後の反映 | 全 config home の installed plugin を update し、`/reload-plugins` を案内 | DR-0035 §3 は「前の版の module が残りうる」 | B9 |

同じ事実を別の経路で取っているもの:

- **ctx の使用量**: ccmsg は `session.measure` と transcript の fold の新しい方 (DR-0035 §3)、context-notify は `turn.step` の後の `$.session.usage()` (DR-0003 §2)。context-notify の経路は transcript を待たず request ごとなので、ccmsg が transcript の fold を併用している理由 (turn の途中は transcript の方が新しい) を無くせる (B17)
- **window**: 両方 `$.session.usage().context.window`。context-notify DR-0003 は `/clear` 後と `-p` でも正しい window を返すと実測しており、ccmsg の findings 2026-10-14 の実測と一致する
- **effort**: ccmsg は `classic.Stop`。`turn.step` を hook すれば同じ hook の `e.effort` で取れる
- **auto compact の有効 / 無効**: context-notify は `$.session.usage({ breakdown: 'summary' })` の `context.breakdown.isAutoCompactEnabled` で engine の判定を読む。ccmsg は扱っていないが、webui で compact の閾値を示すなら同じ口が使える (findings 2026-10-14 も `autoCompactThreshold` を実測している)

### 食い違い 1: 組織が管理する機械での `classic.*`

- リファレンス `overview` の `sec-default` 節: 「managed settings か managed-mcp.json のある機械、または Team / Enterprise の組織で、prepend tier の先頭に座る」「user tier の hook が飛ばされる: `classic.*`、…」。同節は「validate と `/plugin` は『組織が管理する環境で飛ばされる mod の hook』を名指す注記を出す (CHANGELOG)。対象はこの表と対応すると読めるが、注記の実物は未確認」と書く
- context-notify DR-0003 Context: 「`claude plugin validate` の注記: managed settings のある機械では、利用者が自分で入れた plugin の `classic.*` / `skill.prompt` hook は走らない (組織が managed settings に載せた plugin だけが走らせる)。`turn.step` / `tool.call` / `session.start` と `$.session.append` はこの注記の対象に入らない」。注記の実物を記録している
- ccmsg: `classic.SessionStart` で `/clear` 後のサイドカーを起こし直し (`hooks/composer-fill.ts:910-921`)、`classic.UserPromptSubmit` で `prompt.send` の受け付けを決め (`hooks/composer-fill.ts:988-1004`、DR-0035 §5)、`classic.Stop` / `StopFailure` / `PostModelSwitch` で事実を取る
- 帰結 (コードからの読み、未検証): 受け付けの event が来ないと `handlePromptSend` は `ACCEPT_WAIT_MS` 待って composer を見る。Enter で文が入っていれば composer は空なので `unconfirmed` を返す (`hooks/composer-fill.ts:450-462`)。`/clear` の後はサイドカーが古い sid のまま残る
- kawaz の環境: このマシンには macOS の system 側の managed settings の置き場が無かった。組織のアカウントかどうかは見ていない

### 食い違い 2: import

- ccmsg `hooks/composer-fill.ts:50`: "Claude Code's module loader allows no imports that run"。`hooks/bundle.ts:1-3`: "in one file with no imports of its own (the module loader runs none)"。DR-0038 §4: 「Claude Code の module loader に読まれ、実行時の import ができない」
- リファレンス `overview`: 「どれも ES module で `require` は無い。plugin 内の別ファイルは `import` 宣言で読む。`import()` を含む module は読み込まれない」。`practices`: 「module は相対 import と `"claude-code"` しか読めない (bare specifier は validate が拒む)。npm パッケージは plugin 内に置いて相対 import する (dist を直接置いて動くことは実測済み)」
- context-notify: hooks.json が `./register.ts` を名指し、`register.ts` は `./notify` を相対 import している (`context-notify:hooks/register.ts:6-22`)。DR-0003 Context: 「hooks module が import できるのは自分のファイル (相対パス) と `claude-code` だけ。パッケージ名の import は `claude plugin validate` が拒む」
- bundle の必要は 3 者の記述どれでも変わらない (ccmsg は valibot と workspace package を bare specifier で import している)。違うのは「相対 import も読めないか」で、ccmsg のコメントの根拠になった観測の版と条件は本書では辿っていない

### 食い違い 3: socket

- DR-0035 §3: 「`$` には socket を直接開く口が無いので、往復 1 回の CLI を挟む」「`$` に socket を開く口が無い」
- リファレンス `dollar-api` の「制限」: 「`socketPath` で Unix socket 越しの HTTP を話せる (絶対パス、約 100 byte まで…)」。同じファイルの未確認: 「`http.fetch` の `socketPath` の説明 "one per session, in a private directory" の意味 (任意の UDS に繋げるのか)」
- 生の socket が無いことは両者で一致する。ccmsg の daemon の UDS は行の protocol なので、`socketPath` があっても今の daemon にはそのまま話せない (B10)

### 食い違い 4: 同じ事実の別経路

「参照実装 context-notify との対照」の「同じ事実を別の経路で取っているもの」と B17。

### 食い違い 5: 未観測と実測のずれ

- findings 2026-10-14 の「観測できなかったもの」: 「`tool.call` が subagent の loop の呼び出しで本体の module に届くこと (型の記述だけ)」。リファレンス `capabilities` の `tool.call` の備考: 「実測: `e.agentId` で subagent の呼び出しを見分ける」。context-notify DR-0003: 「subagent の tool 呼び出しでも同じ module の `tool.call` が走り、`e.agentId` が付く (Bash も `SubagentHandback` も)」
- findings 2026-10-14: `$.agent.list()` は「workflow の agent は含まず、終わった subagent はしばらくして落ちる (型)」。リファレンス `dollar-api` の `agent.list()` の行にはこの制限が書かれていない

### 食い違い 6: fill から Enter までの間のダイアログ

- リファレンス `prompt-injection` の「注意」: 「`refusal: 'dialog'` のまま Enter を送ると、Enter はダイアログに届いて選択中の項目を確定させる (ダイアログがキーを持っていることからの推測、未検証)」
- ccmsg は fill の時点の拒否だけを見る (`hooks/composer-fill.ts:427-428`)。fill の後から Enter までにダイアログが開いた場合の扱いは DR-0035 にも findings 2026-10-06 にも無い (B14)

## リファレンスへのフィードバック候補

リファレンス自体は編集していない。採否は裏取りしてから決める。

1. `capabilities` の「2026-10-14 時点の未確認」の「`classic.SessionStart` (`source: clear`) が `/clear` で mod に届くか」: ccmsg の findings 2026-10-14 が 2.1.299 で実測している (`command.run (clear)` → `classic.SessionEnd (clear)` → `session.end (clear)` → `classic.SessionStart (source: clear、新しい session_id と transcript_path)`、直後の `$.session.id()` は新 id)
2. `capabilities` の `session.send` の行は instead の答えを `{ isDelivered: false, reason }` だけ挙げる。ccmsg の findings 2026-10-09 は `next` 無しの `{ isDelivered: true }` も通り、model が `{"success":true,"message":"Delivered by a plugin hook; nothing else was sent."}` を読むこと、`false` の時は `Not sent: a plugin hook refused it (<reason>).` になることを実測している
3. `dollar-api` の `agent.list()` に、workflow の agent を含まないこと・終わった subagent が落ちることを書く (ccmsg の findings 2026-10-14 が型定義から読んだ記述)
4. `dollar-api` の `process.run` の `env` が session の環境を置き換えるのか上に重なるのか (ccmsg のコメントは重なると書く。実測かどうかは本書では辿っていない)
5. `prompt-injection` / `capabilities` に、busy 中の注入の時系列を足す: DR-0035 §5 は 2.1.291 で「`classic.UserPromptSubmit` は turn 実行中でも Enter の数 ms 後に起き、transcript の `queued_command` 行と `session.append` は model に届いた時点で現れる」と実測している。`session.append` の door `prompt` が queue された prompt では Enter の時点でなく model に渡る時点で起きる、という読みはリファレンスに無い
6. `overview` の import の記述と、ccmsg の「module loader は import を実行しない」という記述の食い違い (食い違い 2)。context-notify が相対 import で動いていることを実例として添えられる
7. `prompt-injection` の手順には、受け付けの確認 (文が session に入った証拠) の取り方が無い。ccmsg は fill した文との一致で `classic.UserPromptSubmit` を見ており、harness が末尾の空白を落としてから event を上げることを 2.1.293 で実測している (`hooks/composer-fill.ts:313-320`)。classic を使わない形 (`prompt.submit` の `origin.kind === 'composer'` と文の一致) で書くなら B4 の probe が要る
8. `prompt-injection` の「注意」にある「fill から Enter の間の打鍵の混入」と並べて、「fill から Enter の間にダイアログが開いた時に Enter がダイアログを確定させる」窓がある、という注意を足すかどうか (今はリファレンスの推測。B14 の probe で確かめる)
9. `overview` の `sec-default` 節は validate の注記の実物を未確認としているが、context-notify DR-0003 Context がその文面 (「managed settings のある機械では、利用者が自分で入れた plugin の `classic.*` / `skill.prompt` hook は走らない」「`turn.step` / `tool.call` / `session.start` と `$.session.append` は対象に入らない」) を記録している
10. `/reload-plugins` で module がどう読み直されるか (`session.start` の再実行、`$.process.spawn` の子の kill、module 変数の消失) の記述がリファレンスに無い。context-notify の release 手順が案内している操作なので、hot-reload の節に並べる価値がある
11. `practices` の「リクエストの単位」は `turn.step` で全部拾えると書くが、stream の event を hook する時の書き方 (`async function*` と `yield* next(e)`、stream の `.catch`) の例が無い。context-notify の `turn.step` の hook が実例になる
