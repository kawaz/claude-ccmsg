# Claude Mods のリファレンスと v1 の hooks module の突き合わせ (食い違いと活用候補)

- Date: 2026-10-15
- 対象: rules リポの reference `claude-mods/` (`_index` と本文 9 ファイル。記述の基準は Claude Code 2.1.299 の型定義と 2.1.284 / 2.1.299 の実機) と、ccmsg v1 (v0.170.0) の `hooks/composer-fill.ts`・`hooks/session-start.ts`・`hooks/hooks.json`、関連 DR / findings / issue
- 方法: 読み合わせだけ。本書のために実機 probe はしていない。「実測」と書いたものは既存の findings かリファレンスが実測と明記したもので、出典を付ける。それ以外の可否はすべて未検証
- 書き方: リファレンスの記述は「リファレンス `<file>`: …」、ccmsg の実装は `ファイル:行` で示す。食い違いはどちらが正しいかを決めず、両方を並べる

## 判明した事実

### ccmsg が今使っている Mods の機能

| 区分 | 使っているもの | ccmsg の箇所 |
|---|---|---|
| 読み込み | hooks.json の `modules` 1 本 (`./composer-fill.bundle.js`) と command hook (SessionStart) の併用 | `hooks/hooks.json:1-17` |
| engine event | `session.start` / `session.end` / `session.measure` / `turn.start` / `turn.complete` / `prompt.submit` / `session.send` | `hooks/composer-fill.ts:885-1030` |
| classic event | `classic.SessionStart` / `classic.Stop` / `classic.StopFailure` / `classic.PostModelSwitch` / `classic.UserPromptSubmit` | `hooks/composer-fill.ts:910,942,960,981,988` |
| `$` | `session.id` / `surfaces` / `model` / `usage`、`prompt.read` / `fill`、`process.run` / `spawn`、`env.get`、`clock.now` / `after`、`ui.log`、`plugin.root` | `hooks/composer-fill.ts:98-127` (自前の `Engine` 型) |
| 失敗の扱い | observe 系の hook すべてに `.catch(next(e))`、`session.send` だけ `.catch` 無し | `hooks/composer-fill.ts:880-1030` |
| 状態 | module 変数 (`ModuleState`)。`$.state` / `$.store` は使っていない | `hooks/composer-fill.ts:335-386` |

使っていない口のうち ccmsg の作業に関係するもの: `$.agent.*`、`agent.spawn`、`tool.call` / `tool.check` / `tool.describe`、`classic.PermissionRequest` / `classic.Notification` / `classic.SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `CwdChanged`、`$.session.append`、`$.prompt.submit`、`$.model.fork`、`$.command.run`、`$.ui.status` / `notify` / `toast`、`$.state` / `$.store`、`$.http.fetch` (`socketPath`)、`prompt.context` / `prompt.section`。

### 食い違い・ずれの要点 (詳細は「検証の詳細」)

1. **組織が管理する機械では ccmsg の classic hook が全部飛ばされる、とリファレンスは書く**。ccmsg は `/clear` 後のサイドカー起動、effort、API error の分類、モデル切替、`prompt.send` の受け付け確認を classic event に頼っている。該当する機械では webui からの入力が毎回「未確認」になりうる (受け付けの event が来ないため。未検証)。kawaz の各 config home が該当するかは未確認 (このマシンに macOS の managed settings の置き場は無かった。Team / Enterprise 組織かどうかは見ていない)
2. **import の可否の記述が違う**。ccmsg は「module loader は実行時の import をしない」と書き、リファレンスは「plugin 内の別ファイルは `import` 宣言で読める、bare specifier は拒む」と書く
3. **`$` から socket に繋ぐ口の有無の記述が違う**。DR-0035 §3 は「`$` には socket を直接開く口が無い」、リファレンスは `$.http.fetch` の `socketPath` で Unix socket 越しの HTTP を話せると書く (ただしリファレンス自身が適用範囲を未確認としている)
4. ccmsg の findings (2026-10-14) が「未観測」とした subagent の `tool.call` は、リファレンスでは実測済みになっている。逆に、リファレンスが未確認とした `/clear` での `classic.SessionStart (source: clear)` は ccmsg の findings が実測している
5. 入力の注入で、fill から Enter までの間 (DR-0035 §1 の実測で約 55ms) にダイアログが開くと Enter がダイアログに届く可能性を、リファレンスは推測として書いている。ccmsg はその間のダイアログを検知していない

## 実用的な示唆 / ベストプラクティス

### 活用候補

各候補に、使う口 (リファレンスの該当箇所)、ccmsg の何を置き換える・足すか、期待効果、制約、要る probe を書く。probe はどれも未実施。

#### B1. agent tree の生存判定を event にする (`turn.*` の `agentId`、`agent.spawn`)

- 口: リファレンス `events` の「意味論の注意」(`turn.start` / `turn.step` / `turn.complete` は subagent・teammate の turn でも起き `e.agentId` で区別、`turn.complete` は spawner を含む全 hook が聞く)、`capabilities` の `agent.spawn` 行 (`e` に `subagentType` / `description` / `background` / `isTeammate?` / `workflow?` / `name?`、結果に `agentId?` / `teammateId?`)、`dollar-api` の `agent.list()` (`id` / `type` / `status` / `parentId?` / `spawnedBy?` / `name?`)、`capabilities` の `classic.SubagentStart` / `SubagentStop` (`agent_transcript_path` 付き)
- 置き換えるもの: `readAgentTree` の深さ 1 以上の生存判定は transcript の mtime からの推定で、長い tool 呼び出しの間は「止まった」に見えると Design rationale に書いてある (`packages/daemon/src/session-status.ts:1340-1361`)。turn の開始と終了を agentId ごとに受ければ推定が要らなくなる。spawn の親子は `agent.spawn` の結果と `parentAgentId` で取れる
- 期待効果: 大。agent tree の state が推定でなく事実になる。snapshot ごとの meta.json の読み直しも module のあるセッションでは減らせる
- 制約: 過去分と daemon が居なかった間の分は取れない (findings 2026-10-14 の「置き換えられないもの」)。`$.agent.list()` は workflow の agent を含まず、終わった subagent は落ちる (同 findings、型)。TL の drilldown は subagent transcript を読み続ける。module の無いセッション用に transcript の fold は残るので、経路が 2 本になる
- probe: (1) 本体の module が subagent / teammate / workflow の agent の `turn.start` / `turn.complete` を受けるか (リファレンスの「spawn の内側にいた hook は agent の start を聞かない」が本体の module に当たるか)、(2) workflow の agent が `agent.spawn` を通るか (リファレンス `capabilities` は「workflow の `agent()` と resume は deny だけ効く」と書くので通ると読めるが未確認)。どちらも API の応答が要る。findings 2026-10-14 では認証付きの隔離起動が auto mode classifier に止められたので、kawaz の許可を取ってから行う

#### B2. 入力待ちの即時通知 (`classic.PermissionRequest`、AskUserQuestion の `tool.call`、`classic.Notification`)

- 口: リファレンス `dialogs` の「permission の時系列」(ダイアログ直前に `classic.PermissionRequest`、`e` は `tool_name` / `tool_input` / `permission_suggestions?`)、`capabilities` の `tool.call` (AskUserQuestion の入力は `questions`)、`classic.Notification` (`notification_type`)
- 置き換えるもの: sidebar の waiting は `claude agents --json` の 5 秒 poll (`packages/daemon/src/agents.ts:17-31`) の `status: waiting` / `waitingFor`。module が「何のダイアログで待っているか」を session facts に足して即時に送る。解除は `tool.call` の `next(e)` の resolve
- 期待効果: 中。待ちの検知が最大 5 秒から即時になり、待っている tool と引数を webui に出せる
- 制約: engine 自身のダイアログ (trust・hot-reload の同意など) には event が無い (リファレンス `dialogs`)。poll はセッションの発見と module の無いセッションのために残る。組織が管理する機械では user tier の `classic.*` は飛ばされる (リファレンス `overview` の `sec-default`)。`$.ui.notify` を使う場合、`classic.Notification` を聞いて通知し直すと無限に反響する (リファレンス `events`)
- probe: auto mode で `classic.PermissionRequest` が起きるか (リファレンス `dialogs` の未確認)。tool の結果待ちと「ダイアログ待ち」を `tool.call` の during で区別できるか

#### B3. エージェント向けの `ccmsg:` 宛先の案内 (issue agent-guidance-for-ccmsg-addresses)

issue の推し (b) SessionStart hook の `additionalContext` と、Mods で取れる口を並べる。

| 口 | 載る場所と寿命 | 組織が管理する機械 | 実装の重さ |
|---|---|---|---|
| command hook (`session-start.ts`) の `additionalContext` | SessionStart の出力。matcher が `startup|resume|clear|compact` なので compact の後も入り直す (`hooks/hooks.json:5`) | command hook は `sec-default` の対象外 (`allowManagedHooksOnly` で止まる) | 小。今は出力無しの hook に JSON を出させる |
| module の `classic.SessionStart` の結果 `additionalContext` | 同上 (リファレンス `capabilities` で「model に届く」) | user tier の `classic.*` は飛ばされる | 小 |
| `tool.describe` で SendMessage の説明に 1〜2 文を足す | tool の説明そのもの。model が SendMessage を使う時に読む場所。session 内 cache、変えると prompt cache が書き直る (リファレンス `capabilities`) | 対象 tool の provider が組織の tier の時だけ飛ばされる。SendMessage は core なので効くと読める | 小 |
| `$.session.append` (`type: 'user'`) | 会話に 1 行。model にはユーザの発言として見える (リファレンス `practices`)。`/clear` で消え、compaction で要約されうる | door `note` は効く (リファレンス `capabilities` 末尾) | 中。`/clear` と compact の後に足し直す契機が要る |
| `prompt.context` の独自 block | 最初の user message の context block。会話ごと 1 回、compaction と `/clear` で再計算 | user tier は飛ばされる | 小 |

- 判断の軸: 「案内が SendMessage を書く瞬間に見えるか」なら `tool.describe` が最も近い。「compact / `/clear` を跨いで確実に残るか」なら command hook の `additionalContext` (今の matcher のまま) が確実。両者は載る場所が違う別の口で、どちらか 1 つで足りる
- 制約: DR-0035 §4 はサイドカーの socket path と依頼の形式を agent が読む面に書かないと定める。案内は `ccmsg peers` → `addresses` → `SendMessage({ to })` の導線に留める
- probe: SendMessage が deferred tool (ToolSearch の後ろ) かどうかと、その時 `tool.describe` の書き換えが model に届く時機。`tool.describe` の結果がセッションの最初の turn に間に合うか

#### B4. `prompt.send` の受け付け確認を `prompt.submit` に寄せる (issue mods-consolidation の受け入れ条件 2)

- 口: リファレンス `events` (`prompt.submit` の `next(e)` は turn の開始か queue に入った時点で resolve)、`capabilities` の `prompt.submit` (`origin.kind`、`text`)
- 現状: 受け付けは `classic.UserPromptSubmit` で取り (`hooks/composer-fill.ts:988-1004`)、書きかけの復元は既に `prompt.submit` の after で `origin.kind === 'composer'` と文の一致を見て行っている (`hooks/composer-fill.ts:1005-1022`)。つまり同じ文の一致判定が両方の event に既にある
- 期待効果: 中。B5 の `sec-default` 下で受け付けが取れなくなる問題を避けられる。受け付けと復元が 1 つの event にまとまる
- 制約: DR-0035 §5 の裁定 (成功は `classic.UserPromptSubmit` の時点) の変更が要る
- probe: busy 中の Enter で `prompt.submit` の hook が Enter の時点で呼ばれるか (DR-0035 §5 は `classic.UserPromptSubmit` について 2.1.291 で実測済み。`prompt.submit` は未確認)。`e.text` が末尾空白を落とした後の文か

#### B5. classic event に頼る箇所の代替 (組織が管理する機械への備え)

- 口: リファレンス `overview` の `sec-default` の表 (user tier の `classic.*` hook は飛ばされる)、`events` (`/clear` は `session.end` の `reason` か `command.run` の `{ command: ['clear', 'resume'] }` を after で拾う)
- 代替の対応: `classic.SessionStart (clear)` → `command.run` の after か `session.end (clear)` の次の event で `$.session.id()` を読み直す、`classic.UserPromptSubmit` → B4、`classic.PostModelSwitch` → `turn.step` の `model` か次の `session.measure` で `$.session.model()` を読み直す、`classic.Stop` の effort → `turn.step` の `effort`、`classic.StopFailure` の分類 → 分類は代替が無く `turn.complete.reason: 'error'` だけになる
- 期待効果: kawaz の環境が該当しないなら効果は無い。該当するなら大 (入力・`/clear`・API error が全部壊れる)
- 制約: `turn.step` は stream の event で、hook を置くと応答の断片がすべて module を通る (DR-0035 §3 が effort で避けた理由)
- probe: まず kawaz の config home ごとに `sec-default` が座っているか (`--debug` の `plugin.register` の行で judge が誰か) を見る。座っていなければ本候補は保留でよい

#### B6. サイドカーから harness の pid を知る

- 口: リファレンス `overview` の「2026-10-14 時点の未確認」(`$.process.run` の子の親 pid が worker か engine 本体か)
- 置き換えるもの: daemon は run と harness の pid を `claude agents --json` の行の開始時刻の近さで結んでいる (`packages/daemon/src/sidecar-runs.ts:9-14`、DR-0035 §3)。`$.process.spawn` の子 (サイドカー) の親が harness 本体なら、サイドカーは `ps` 無しで親 pid を名乗れる
- 期待効果: 中。推定の対応付けが事実になり、同じ sid の run が複数ある時の取り違えが無くなる。並行している ps 依存の除去作業とも関係する
- 制約: 親が worker プロセスなら使えない (その場合の親の親は名乗れても同じ推定が残る)
- probe: 隔離環境でサイドカー相当の子に親 pid を出させ、`claude agents --json` の pid と比べる。API の応答は要らない

#### B7. 応答中の細かい状態と途中経過 (`tool.call`、`turn.step`)

- 口: リファレンス `capabilities` の `tool.call` (before / after、`agentId`、after で `$.session.usage()`)、`turn.step` (stream、最後に `answer` / `toolUses` / `usage`)
- 足すもの: TL の「応答中」の行に「Bash を実行中: <description>」のような今の tool を出す。ctx の分子を turn の途中でも更新する (findings 2026-10-14 は「`turn.step` や `tool.call` の後に `usage()` を読む (未検証)」と書いた)。`turn.step` の stream で応答の途中の文字を TL に流すのは別の設計判断
- 期待効果: 中 (tool 表示)、大 (途中の文字。ただし重い)
- 制約: tool 呼び出しごとに `ccmsg sidecar facts` の process を起こすと、1 回あたり bun の起動が乗る (`hooks/composer-fill.ts:269-272` の実測で往復約 0.3 秒)。送信は 1 本ずつに畳まれる (`hooks/composer-fill.ts:614-639`) ので詰まりはしないが、B10 の送信経路と合わせて考える
- probe: `tool.call` の after で読む `usage().context.tokens` が assistant 行ごとの transcript の fold と同じ値か (API の応答が要る)

#### B8. todo と background を module で畳む

- 口: リファレンス `capabilities` の `tool.call` (TaskCreate / TaskUpdate / TaskStop、Bash の `run_in_background`、Monitor の引数と結果。subagent の分は `agentId` 付き、実測)、`classic.TaskCreated` / `TaskCompleted`、`classic.Stop` / `SubagentStop` の `background_tasks` (turn の終わりに in-flight のものだけ)、`prompt.submit` の `origin.kind: 'task-notification'`
- 置き換えるもの: session-status の fold が transcript の tool_use / 結果 / `task_reminder` attachment / `<task-notification>` を組み合わせている部分 (`packages/daemon/src/session-status.ts:79-123` の PREFILTER)。subagent の Task は `task_reminder` 待ちになっている
- 期待効果: 中。subagent の Task が reminder 待ちでなく即時に出る
- 制約: 一覧の getter が無いので module が状態を畳み、daemon の再接続時に全体を送り直す。module の reload で module 変数が消えるので、畳んだ状態は `$.state` に置く (B9)。module の無いセッションのために fold は残る
- probe: API の応答が要る (B1 と同じ許可の問題)

#### B9. module の状態を `$.state` に置く

- 口: リファレンス `dollar-api` の `state` (session の値を host が持ち reload を跨ぐ、`get` は `{ value, version }`、`set` は `ifVersion`)、`practices` の「状態の置き場」(`$.state` は `/clear`・resume・終了で消える、`$.store` は config home 単位で永続・全体 4 MiB)、`overview` (module 変数は reload で消える)
- 置き換えるもの: `ModuleState` (`hooks/composer-fill.ts:335-386`) の run id、事実、書きかけ (`restoring`)。reload が入ると run id が引き直されて daemon からは別の run に見え、事実は次の event まで空になり、fill と Enter の間の書きかけは失われる (リファレンス `prompt-injection` の「注意」が同じことを書く)
- 期待効果: 小〜中。installed の plugin が session の途中で reload される頻度次第
- 制約: `$.state` の `plugin` / `key` は文字列リテラル必須で validate が列挙する (リファレンス `dollar-api` の「制限」)。`/clear` で消えるので、`/clear` を跨いで同じ run を保つ run id は `$.state` だけでは足りない (`$.store` に sid 無しの key で置くと別セッションと衝突するので key の設計が要る)。state ライブラリが実行時に import できるかはリファレンス自身が未確認
- probe: installed の plugin が session の途中で reload される契機 (plugin の更新、`/plugin` の操作) と、その時 `session.start` が再度走るか

#### B10. daemon への送信を `$.http.fetch` にする

- 口: リファレンス `dollar-api` の `http.fetch` (`socketPath` で Unix socket 越しの HTTP、http / https だけ、WebSocket 無し、body 4 MiB)
- 置き換えるもの: 事実の送信と返事を `$.process.run([bin/ccmsg, "sidecar", "facts" | "reply", ...])` で行っている (`hooks/composer-fill.ts:489-503,618-639`)。daemon の HTTP は `/ws` (WebSocket) と添付・webhook・fs-serve だけで、op を受ける素の HTTP endpoint は無い (`packages/daemon/src/http.ts:259-294`)。UDS は行の protocol で HTTP ではない
- 期待効果: 小〜中。1 送信ごとの bun の起動が無くなる。B7 のように送る回数を増やす時に効く
- 制約: daemon に HTTP の op endpoint と、session role をどう名乗るか (今は CLI が hello する) の設計が要る。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` と組織の web-fetch policy の下での扱い (リファレンスは「built-in の request と `auth` 付きの request を拒む」と書く)。`socketPath` が任意の UDS に繋がるかはリファレンス自身が未確認
- probe: `socketPath` で daemon の state dir の下の UDS に HTTP を話せるか、loopback の HTTP に `$.http.fetch` が届くか

#### B11. cache keepalive と復帰の起こしを subscribe でなく module で行う

- 口: リファレンス `dollar-api` の `prompt.submit` (session が idle になってから自前の turn、`origin` は `{ kind: 'plugin', name }`) と `model.fork` (main thread の最後の request の後ろに prompt を足した tool 無しの completion、「prefix が cache から出る」、最初の応答前と `/clear` 後は `nothing-to-fork`)
- 置き換えるもの: keepalive の marker (`packages/daemon/src/cache-keepalive.ts:1-21`) と network 復帰の起こし (`packages/daemon/src/session-wake.ts:1-14`) は、セッションが開いている `subscribe` stream (Monitor) に頼る。subscribe が無いセッションには届かない
- 期待効果: 中。keepalive を `$.model.fork` で送れれば、会話に turn を残さずに cache を温められる。起こしは `$.prompt.submit` で Monitor 無しに届く
- 制約: `$.model.fork` は「tool 無し」とリファレンスにあり、tool 定義を含む prefix の cache を本当に温めるかは要確認 (リファレンスの「prefix が cache から出る」と「tool 無し」の関係を確かめる)。gateway は marker が request に載ることで keepalive を確認するので、fork の request に marker を載せれば足りるかは gateway 側の仕様次第。サイドカーは composer のあるセッションにしか無い (DR-0035 §3)
- probe: `$.model.fork` の request の cache read / write の usage。`$.prompt.submit` が API error で止まったセッションで再試行の turn になるか

#### B12. rename を `$.command.run` にする

- 口: リファレンス `dollar-api` の `command.run` (session が idle になってから走る)
- 置き換えるもの: rename は hyoui で `/rename <title>` と Enter を端末に打っている (`packages/daemon/src/session-rename.ts:75-85`)。hyoui の外のセッションでは使えず、人の打鍵と混ざりうる
- 期待効果: 小〜中。端末の無いセッションでも rename でき、打鍵の競合が無くなる
- 制約: idle まで待つ。サイドカーのあるセッション (composer のあるもの) に限られる
- probe: built-in の `rename` が `$.command.run` で走るか

#### B13. webui からダイアログに答える (`dialogs`)

- 口: リファレンス `dialogs` の「待つ形」(AskUserQuestion は `tool.call` の during で外部から `{ result }` を返すとダイアログが閉じる、実測。permission は during では `{ deny }` だけ、許可は `tool.check` / `classic.PermissionRequest` で出る前に決める、実測)
- 足すもの: AskUserQuestion の質問を webui に出し、webui の答えで閉じる (端末の人が先に答えればそちらが勝つ)。permission は webui から拒否だけを返す
- 期待効果: 中〜大 (人が端末の前に居ない時)
- 制約: **サイドカーには認証が無い** (DR-0035 §4 は「同じ uid のプロセスが規約 path を組み立てて書くことは防がず、classifier に任せる」と定める)。人の入力は composer に入るだけだが、permission の許可や AskUserQuestion の答えをサイドカー経由で受けると、同じ uid の agent が自分の permission を自分で通す口になる。許可側はこの認証の設計が先に要る。拒否と AskUserQuestion の答えも同じ口を通るので、扱いを DR で決めてから行う。permission の許可を出る前に外へ訊く形は、待つ間ダイアログが出ないので端末の人が答えられない (race できない)。組織が管理する機械では deny rule が mod の allow に勝つ
- probe: AskUserQuestion の during で daemon 経由の答えを返す一巡

#### B14. 注入の Enter がダイアログに当たる窓を塞ぐ

- 口: リファレンス `prompt-injection` の「注意」(`refusal: 'dialog'` のまま Enter を送ると、Enter はダイアログに届いて選択中の項目を確定させる、推測・未検証)、`dialogs` の時系列 (`tool.check` / `classic.PermissionRequest` がダイアログの前に起きる)
- 現状: fill の拒否は Enter の前に見ている (`hooks/composer-fill.ts:427-428`) が、fill が通った後から Enter までの間 (`hooks/composer-fill.ts:433-447`、DR-0035 §1 の実測で約 55ms) にダイアログが開くことは見ていない。busy のセッションに入力した時は tool の permission がいつでも出うる
- 足すもの: module が `classic.PermissionRequest` か `tool.check` の ask と、AskUserQuestion の `tool.call` を受けた時に「ダイアログ中」を立て、Enter の直前にそれを見る。または Enter の直前に同じ文で fill し直して `refusal: 'dialog'` を見る
- 期待効果: 当たれば影響が大きい (permission の既定の選択を確定しうる)。起きる頻度は低い
- 制約: 窓は縮むが 0 にはならない
- probe: まず「ダイアログ表示中の Enter が既定の選択を確定するか」を隔離環境で確かめる (リファレンスの推測の裏取り)

#### B15. classic hook (`session-start.ts`) を module に寄せる (issue mods-consolidation の受け入れ条件 1)

- 口: リファレンス `dollar-api` の `process.run` (終了後にまとめて返る、背景に残って書き続ける子がいると timeout まで返らない、git は repo hooks 無効)、`session.repo()`、classic event の `transcript_path`
- 置き換えるもの: state file の書き出し (transcript_path / cwd / repo / ws) と `daemon start` (`hooks/session-start.ts:302-341`)
- 期待効果: 小〜中。SessionStart ごとの bun の起動が 1 本減り、起動の経路が module に揃う
- 制約: module が読まれない条件 (workspace 未 trust、safe mode、`--bare`、`allowManagedModsOnly` 等。リファレンス `overview`) では state file も daemon の起動も無くなる。command hook はその一部の条件でも走る。`daemon start` の子が stdout を握ったまま残ると `$.process.run` が timeout まで返らない。branch / worktree 名は `$.session.repo()` に無く (findings 2026-10-14)、bump-semver の呼び出しは残る。リファレンス `overview` の未確認「`modules` を含む hooks.json を Mods 非対応の古い build が丸ごと捨てるか」が本当なら、今の構成でも古い build では command hook ごと消える (kawaz の環境は常に最新なので影響は無いと見込むが未確認)
- probe: `$.process.run([bin/ccmsg, "daemon", "start"])` が daemon を残したまま返るか

#### B16. TUI に ccmsg の状態を 1 行出す (`$.ui.status`)

- 口: リファレンス `dollar-api` の `ui.status` (plugin ごと 1 行を prompt の下に固定)、`ui.toast`
- 足すもの: daemon に繋がっていない (webui からの入力が届かない) こと、このセッションの `ccmsg:` 宛先、webui から入力が入った直後の告知など
- 期待効果: 小。端末の人が ccmsg の状態を知れる
- 制約: `-p` では描かれない。say は CLI が macOS の `say` を叩き、daemon は記録だけを持つ (`packages/daemon/src/server.ts:2377-2390`) ので、`$.audio.speak` / `$.ui.notify` に置き換える利点は見当たらない (CLI の say は module の無いセッションでも動く)

### 優先順位

効果・実装の軽さ・probe の要否からの目安。「probe」は着手前に要る実機確認の重さ (API の応答が要るものは kawaz の許可が要る)。

| 順 | 候補 | 効果 | 実装の軽さ | probe |
|---|---|---|---|---|
| 1 | B5 の前段: `sec-default` が座っているかの確認 | 該当なら大 | 確認だけ | 軽 (`--debug` を見る) |
| 2 | B14 Enter がダイアログに当たる窓 | 当たれば大、頻度は低 | 軽 | 中 (隔離環境で Enter の挙動) |
| 3 | B3 `ccmsg:` 宛先の案内 | 中〜大 (open issue の解消) | 軽 | 軽 (`tool.describe` 案なら deferred かの確認) |
| 4 | B6 サイドカーの親 pid | 中 | 軽 | 軽 (API 不要) |
| 5 | B4 受け付けを `prompt.submit` に | 中 | 軽 | 中 (busy 時の発火時機)、DR-0035 §5 の変更 |
| 6 | B1 agent tree の生存判定 | 大 | 重 | 重 (API が要る) |
| 7 | B2 入力待ちの即時通知 | 中 | 中 | 中 |
| 8 | B12 rename を `$.command.run` に | 小〜中 | 軽 | 軽 |
| 9 | B11 keepalive / 起こし | 中 | 中 | 重 (fork の cache の挙動、gateway) |
| 10 | B7 応答中の tool 表示 | 中 | 中 | 中 |
| 11 | B8 todo / background | 中 | 重 | 重 (API が要る) |
| 12 | B15 session-start.ts の統合 | 小〜中 | 中 | 中 |
| 13 | B9 `$.state` | 小〜中 | 中 | 中 |
| 14 | B10 `$.http.fetch` | 小〜中 | 中 (daemon 側の endpoint) | 中 |
| 15 | B13 ダイアログに webui から答える | 中〜大 | 重 (認証の設計が先) | 中 |
| 16 | B16 `$.ui.status` | 小 | 軽 | 不要 |

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
| effort を返す `$` は無い、`classic.Stop` の `effort.level` で取る | DR-0035 §3 (58-59 行) | `dollar-api` に effort の getter は無い。`capabilities` は classic の共通欄に `effort?` | 一致 |
| `-p` は `surface: null` / `isInteractive: false` | `hooks/composer-fill.ts:888-889` | `events` の「対話と `-p` の差」 | 一致 |
| `$.process.spawn` の子は unload で kill、`input` は 1 回書いて閉じるので常駐の子に後から書けない | `hooks/composer-fill.ts:814-817`、DR-0035 §3 (60 行) | `dollar-api` の「制限」 | 一致 |
| `$.process.run` は既定 30 秒で throw | `hooks/composer-fill.ts:273-279` | `dollar-api`: 既定 30 秒、最大 10 分 | 一致 |
| fill の拒否 (`dialog` / `no_composer`) を見てから Enter | `hooks/composer-fill.ts:427-428` | `prompt-injection` | 一致 |
| 注入の手順 (退避 → fill → 外部の Enter → `prompt.submit` の後に復元) | `hooks/composer-fill.ts:417-477,1005-1022` | `prompt-injection` の「手順」 | 一致。ccmsg は受け付けを `classic.UserPromptSubmit` で別に取る (B4) |
| module は実行時の import をしない | `hooks/composer-fill.ts:50-54`、`hooks/bundle.ts:1-3`、DR-0038 §4 | 食い違い 2 | 食い違い |
| `$` に socket を開く口は無い | DR-0035 §3 (50, 60 行) | 食い違い 3 | 食い違い |
| `$.process.run` の `env` は session の環境の上に重なる | `hooks/composer-fill.ts:586-587` | `dollar-api` は `env` を受けるとだけ書く | リファレンスに記述無し (フィードバック候補 4) |
| classic event の hook が効く前提 | `hooks/composer-fill.ts:910,942,960,981,988` | 食い違い 1 | 環境次第 |

### 食い違い 1: 組織が管理する機械での `classic.*`

- リファレンス `overview` の `sec-default` 節: 「managed settings か managed-mcp.json のある機械、または Team / Enterprise の組織で、prepend tier の先頭に座る」「user tier の hook が飛ばされる: `classic.*`、…」。`capabilities` 末尾: 「そこでも効くのは `tool.call` / `prompt.submit` / `prompt.mention` の `context` と、`$.session.append` (door `note`) / `$.prompt.submit`」
- ccmsg: `classic.SessionStart` で `/clear` 後のサイドカーを起こし直し (`hooks/composer-fill.ts:910-921`)、`classic.UserPromptSubmit` で `prompt.send` の受け付けを決め (`hooks/composer-fill.ts:988-1004`、DR-0035 §5)、`classic.Stop` / `StopFailure` / `PostModelSwitch` で事実を取る
- 帰結 (コードからの読み、未検証): 受け付けの event が来ないと `handlePromptSend` は `ACCEPT_WAIT_MS` 待って composer を見る。Enter で文が入っていれば composer は空なので `unconfirmed` を返す (`hooks/composer-fill.ts:450-462`)。`/clear` の後はサイドカーが古い sid のまま残る
- kawaz の環境: このマシンには macOS の system 側の managed settings の置き場 (ClaudeCode のディレクトリ) が無かった。組織のアカウントかどうかは見ていない

### 食い違い 2: import

- ccmsg `hooks/composer-fill.ts:50`: "Claude Code's module loader allows no imports that run"。`hooks/bundle.ts:1-3`: "in one file with no imports of its own (the module loader runs none)"。DR-0038 §4: 「Claude Code の module loader に読まれ、実行時の import ができない」
- リファレンス `overview`: 「どれも ES module で `require` は無い。plugin 内の別ファイルは `import` 宣言で読む。`import()` を含む module は読み込まれない」。`practices`: 「module は相対 import と `"claude-code"` しか読めない (bare specifier は validate が拒む)。npm パッケージは plugin 内に置いて相対 import する (dist を直接置いて動くことは実測済み)」
- bundle の必要は両方の記述で変わらない (ccmsg は valibot と workspace package を bare specifier で import している)。違うのは「相対 import も読めないか」で、ccmsg のコメントの根拠になった観測の版と条件は本書では辿っていない

### 食い違い 3: socket

- DR-0035 §3: 「`$` には socket を直接開く口が無いので、往復 1 回の CLI を挟む」「`$` に socket を開く口が無い」
- リファレンス `dollar-api` の「制限」: 「`socketPath` で Unix socket 越しの HTTP を話せる (絶対パス、約 100 byte まで…)」。同じファイルの未確認: 「`http.fetch` の `socketPath` の説明 "one per session, in a private directory" の意味 (任意の UDS に繋げるのか)」
- 生の socket が無いことは両者で一致する。ccmsg の daemon の UDS は行の protocol なので、`socketPath` があっても今の daemon にはそのまま話せない (B10)

### 食い違い 4: 未観測と実測のずれ

- findings 2026-10-14 の「観測できなかったもの」: 「`tool.call` が subagent の loop の呼び出しで本体の module に届くこと (型の記述だけ)」。リファレンス `capabilities` の `tool.call` の備考: 「実測: `e.agentId` で subagent の呼び出しを見分ける」。B1 / B8 の前提の一部はリファレンス側で実測済み
- findings 2026-10-14: `$.agent.list()` は「workflow の agent は含まず、終わった subagent はしばらくして落ちる (型)」。リファレンス `dollar-api` の `agent.list()` の行にはこの制限が書かれていない

### 食い違い 5: fill から Enter までの間のダイアログ

- リファレンス `prompt-injection` の「注意」: 「`refusal: 'dialog'` のまま Enter を送ると、Enter はダイアログに届いて選択中の項目を確定させる (ダイアログがキーを持っていることからの推測、未検証)」
- ccmsg は fill の時点の拒否だけを見る (`hooks/composer-fill.ts:427-428`)。fill の後から Enter までにダイアログが開いた場合の扱いは DR-0035 にも findings 2026-10-06 にも無い (B14)

## リファレンスへのフィードバック候補

リファレンス自体は編集していない。採否は裏取りしてから決める。

1. `capabilities` の「2026-10-14 時点の未確認」の「`classic.SessionStart` (`source: clear`) が `/clear` で mod に届くか」: ccmsg の findings 2026-10-14 が 2.1.299 で実測している (`command.run (clear)` → `classic.SessionEnd (clear)` → `session.end (clear)` → `classic.SessionStart (source: clear、新しい session_id と transcript_path)`、直後の `$.session.id()` は新 id)
2. `capabilities` の `session.send` の行は instead の答えを `{ isDelivered: false, reason }` だけ挙げる。ccmsg の findings 2026-10-09 は `next` 無しの `{ isDelivered: true }` も通り、model が `{"success":true,"message":"Delivered by a plugin hook; nothing else was sent."}` を読むこと、`false` の時は `Not sent: a plugin hook refused it (<reason>).` になることを実測している
3. `dollar-api` の `agent.list()` に、workflow の agent を含まないこと・終わった subagent が落ちることを書く (ccmsg の findings 2026-10-14 が型定義から読んだ記述)
4. `dollar-api` の `process.run` の `env` が session の環境を置き換えるのか上に重なるのか (ccmsg のコメントは重なると書く。実測かどうかは本書では辿っていない)
5. `prompt-injection` / `capabilities` に、busy 中の注入の時系列を足す: DR-0035 §5 は 2.1.291 で「`classic.UserPromptSubmit` は turn 実行中でも Enter の数 ms 後に起き、transcript の `queued_command` 行と `session.append` は model に届いた時点で現れる」と実測している。`session.append` の door `prompt` が queue された prompt では Enter の時点でなく model に渡る時点で起きる、という読みはリファレンスに無い
6. `overview` の import の記述と、ccmsg の「module loader は import を実行しない」という記述の食い違い (食い違い 2)。どの版・条件で相対 import が読めるかを実機で確かめて明記する
7. `prompt-injection` の手順には、受け付けの確認 (文が session に入った証拠) の取り方が無い。ccmsg は fill した文との一致で `classic.UserPromptSubmit` を見ており、harness が末尾の空白を落としてから event を上げることを 2.1.293 で実測している (`hooks/composer-fill.ts:313-320`)
8. `prompt-injection` の「注意」にある「fill から Enter の間の打鍵の混入」と並べて、「fill から Enter の間にダイアログが開いた時に Enter がダイアログを確定させる」窓がある、という注意を足すかどうか (今はリファレンスの推測。B14 の probe で確かめる)
