# DR-0039: classic hook を全廃して hooks module 1 本に寄せ、エージェントが使う ccmsg の口を typed tool にする

- Status: Proposed
- Date: 2026-10-15

## Context

エージェントが ccmsg を使う口は 2 種類あり、どちらも入出力に型が無い。

- **CLI**: `ccmsg post <sid>` / `ccmsg reply <mid> --to <sid>` (op `message_send`、[DR-0036](./DR-0036-retire-rooms-for-p2p.md) §1)、`ccmsg peers`、`ccmsg say`。エージェントは本文を引数として書くので、クォートの有無で本文の切れ目がぶれ (DR-0036 §1 は本文をクォートしない書き方に合わせて語を連結する規則を持つ)、長い本文は truncate の回避が要り、送るたびにコマンド実行の 1 アクションが要る ([DR-0037](./DR-0037-agent-messages-ride-sendmessage.md) の Context)。CLI はエージェントがセッションへメッセージを入れる口として誰でも叩ける
- **SendMessage の横取り** ([DR-0037](./DR-0037-agent-messages-ride-sendmessage.md)): `to` が `ccmsg:` で始まる SendMessage を module の `session.send` hook が受け、daemon が宛先を解決して peer 注入する。宛先の綴り (`ccmsg:<sid>` / `ccmsg:<sid>.<pid>` / `ccmsg:path:<dir>`) という規約を利用者に覚えさせ、model が読む結果の文面は harness が決め (本来の SendMessage の成功の文面と揃わず、`to` が 1 つなので結果も 1 値)、hook が throw すると harness が宛先を agent 名として探す (DR-0037 §4)。エージェント向けの案内は CLI の help にしか無い (issue `2026-10-13-agent-guidance-for-ccmsg-addresses`)

plugin と Claude Code のつながりも 2 本ある。

- **command hook**: hooks.json の SessionStart (matcher `startup|resume|clear|compact`) が `hooks/session-start.ts` を起こし、state file (transcript_path / cwd / repo / ws / repo_root / branch) を書いて `daemon start` を detached で起こす
- **hooks module** (`composer-fill.bundle.js`): engine event (`session.start` / `session.end` / `session.measure` / `turn.start` / `turn.complete` / `prompt.submit` / `session.send`) と、classic event 5 つ (`classic.SessionStart` / `classic.Stop` / `classic.StopFailure` / `classic.PostModelSwitch` / `classic.UserPromptSubmit`) を hook する ([findings 2026-10-15-mods-reference-opportunities](../findings/2026-10-15-mods-reference-opportunities.md) の「ccmsg が今使っている Mods の機能」)

2 本の経路は読み込まれる条件が違う (module が読まれず command hook だけが走るセッションの集合は未検証、同 findings の B5「全廃の障害と前提」)。加えて、組織が管理する機械 (managed settings のある機械、Team / Enterprise の組織) では built-in の `sec-default` が user tier の `classic.*` hook を飛ばすと、rules リポの reference `claude-mods/overview` の `sec-default` 節と context-notify の DR-0003 (`claude plugin validate` の注記の文面) が記録している。そこでは ccmsg が classic で取っている `/clear` 後のサイドカーの起こし直し、`prompt.send` の受け付けの確認 ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §5)、effort、API error の分類、モデル切替の追従が働かない (同 findings の「食い違い 1」。ccmsg では未検証で、kawaz の各 config home が該当するかも未確認)。

Claude Code 2.1.299 の実機で、classic を使わずに同じことができる口を確かめた。

- classic.SessionStart の各 source に当たる mods の event と、`$.state` と module の生死 ([findings 2026-10-15-mods-event-matrix-startup-resume-clear-compact](../findings/2026-10-15-mods-event-matrix-startup-resume-clear-compact.md) の「classic.SessionStart の各 source と mods の event」「`$.state` と module の生死」)
- 最初の turn の前に model へ文脈を入れる口ごとの到達 (同 findings の「最初の turn の前の注入: 口ごとの到達」)
- `$.tool.register` で登録した tool が対話・`-p`・subagent の request に載り、model の呼び出しが `tool.call` の handler に届くこと (同 findings の「`$.tool.register` の可視範囲と typed call」の「結論」)
- `agentId` 付きの `$.session.append` が走行中の subagent の次の request にだけ載ること (同 findings の「`agentId` 付きの `$.session.append` で走行中の subagent に文脈を入れる」)

kawaz 2026-10-15 の方針: エージェントに使わせる口は CLI でなく `$.tool.register` の typed tool にし、宛先は部分指定で解決して config dir 跨ぎは裏で行い、`ccmsg:` 接頭辞のような規約を利用者に課さない。say も typed tool にする。CLI はエージェントがメッセージを入れる口を持たない。classic hook は残さず全部 mods に寄せる。module の無いセッション向けのフォールバック経路は作らない。

## Decision

### 1. classic hook を全廃し、plugin の経路を hooks module 1 本にする

- hooks.json は `{ "modules": [...] }` だけにする。command hook の SessionStart (`hooks/session-start.ts`) と、module 内の `classic.*` の hook はすべて削る
- 今 classic で行っていることは、§2 の対応表の mods の event で行う
- 組織が管理する機械で飛ばされる user tier の hook (`classic.*` の他に `prompt.context` / `prompt.attachment` / `session.compact` 等、reference `claude-mods/overview` の `sec-default` 節の表) を、ccmsg の機能が成り立つための前提に使わない。`session.compact` だけは §5 の案内の足し直しに使い、飛ばされた時に失うものを Consequences に書く

### 2. classic の各口の置き換え

| 今の口 | 用途 | mods での拾い方 | 前提の確度と、成り立たない時 |
|---|---|---|---|
| command hook SessionStart `startup` / `resume` (`--resume` / `--continue`) | state file の書き出しと `daemon start` | `session.start` の after から `$.process.run` で `bin/ccmsg` を呼び、state file を書いて daemon を起こす。cwd は `$.session.cwd()`、repo の root と remote は `$.session.repo()`、ws / branch は今と同じく bump-semver を `$.process.run` で呼ぶ | `session.start` は startup・resume・continue のどれでも起きる (event-matrix 実測、対話と `-p`)。hot reload でも起きるので冪等にする (同実測)。最初の `session.start` は await されるので、起動を待たせない形にする。`daemon start` を `$.process.run` で呼んで detached の daemon を待たずに返るかは未検証 (「Accepted の前提」) |
| 同 `clear`、module の `classic.SessionStart (clear)` | 新しい sid でサイドカーを起こし直し、事実を読み直し、turn を idle にし、新しい sid の state file を書く | `session.end` (`reason: 'clear'`) で旧 id の世代を進め、`command.run` を `{ command: 'clear' }` で hook して `await next(e)` の後に `$.session.id()` を読み直し、新しい sid の state file を `$.process.run` で書く | `command.run` の `next(e)` が resolve するのは新しい session の `classic.SessionStart (clear)` の dispatch の後 (event-matrix 実測 2/2)。その時点で `$.session.id()` が新しい id を返すことは未観測 (「Accepted の前提」) |
| セッション内の `/resume` | 同上 | `session.end` (`reason: 'resume'`) と `command.run` (`resume`) の after。新しい sid の state file を同じく書く | 未観測 (「Accepted の前提」) |
| 同 `compact`、module の `classic.SessionStart (compact)` | state file の書き直しと model / window の読み直し | 事実の読み直しはしない (§5 の印を置く `session.compact` の hook だけを持つ) | session id は変わらない (event-matrix 実測)。compaction で変わるのは使用量だけで次の `session.measure` で取り直せる、というのは B5 の表の読みで、compaction の後の使用量の再取得は未観測 |
| `classic.Stop` の `effort.level` | 本体の turn の effort | `turn.step` を `async function*` と `yield* next(e)` で hook し、`e.agentId === undefined` の request の `e.effort` を取る (context-notify の `turn.step` の hook と同じ形、B17) | 実測 (mods-vs-transcript findings、context-notify DR-0003)。request の時点で分かるので今より早い。effort 非対応のモデルでは key が無い |
| `classic.PostModelSwitch` | 切替直後の model と window の読み直し | 次の request の `turn.step` の `e.model` と、その時の `$.session.usage().context.window` | engine event の一覧にモデル切替は無い。`/model` が `config.set` (key `model`) か `command.run` (`model`) を通るかは未検証 (B5 の表、「Accepted の前提」)。通るならその after で読み直す。通らなければ、切替から次の prompt までの間、webui の model / window は古いまま (Consequences) |
| `classic.UserPromptSubmit` | `prompt.send` の受け付け (DR-0035 §5 の成功の時点) | `prompt.submit` の hook で `origin.kind === 'composer'` と fill した文の一致を見て、`next(e)` が resolve し結果が `{ drop }` でない時点を受け付けとする。書きかけの復元は今も同じ event でしている | idle では `prompt.submit` が `classic.UserPromptSubmit` より先に起きる (event-matrix の event 列)。busy 中の Enter で `next(e)` がいつ resolve するかは未観測 (「Accepted の前提」) |
| `classic.StopFailure` の `error` / `last_assistant_message` | API error の分類と表示文 | 分類は残す (kawaz 2026-10-15)。`turn.complete` の `reason: 'error'` で立て、分類と表示文は `$.session.append` の hook (保存される行ごとに保存の前に起きる。harness が書く API error の行が通るか。どの door で通るかは未観測で、findings 2026-10-14 が観測した door は `queue` / `prompt` / `attachment` / `command` / `response`) から取る | engine event の欄には分類が無い (B5 の表)。`session.append` で取れるかは未観測 (「Accepted の前提」)。取れなければ、分類と表示文は今の transcript の API error の行の読みで取り続ける (要る事実のために既にある経路を残すもので、§7 の言うフォールバックではない) |

- `turn.*` / `turn.step` は subagent の loop でも起きるので、本体の事実は `agentId` の無いものに絞る
- transcript path を返す `$` は無い。daemon が sid から解決する今の経路 (`resolvePendingTranscripts`) を使う (Consequences)

### 3. エージェントが使う ccmsg の口は typed tool にする

module が `session.start` で `$.tool.register` により tool を登録し、`tool.call` の handler で答える。登録した tool は対話・`-p`・subagent の request の `tools` に載り、handler では呼び手の session id (`$.session.id()`、subagent からの呼び出しでも本体の id)、cwd (`$.session.cwd()`)、subagent なら `e.agentId` が取れる (event-matrix の `$.tool.register` の「結論」)。

- **セッション間の送信**: 入力は `{ session_id?, cwd?, name?, pid?, text }` のような宛先の部分指定と本文。daemon が部分指定を生きているセッションに解決し、config dir が違うセッションにも peer 注入 ([DR-0034](./DR-0034-peer-socket-injection.md)) で届ける。config dir を跨ぐことを利用者に意識させず、宛先の綴りの規約 (`ccmsg:` 接頭辞) を持たない
  - 部分指定が複数のセッションに当たったら、当たった全部に届ける (kawaz 2026-10-15。DR-0037 §4 の path 宛と同じ)
  - 送り主自身は宛先から除く。送り主だけに当たった時は送らず、理由 (`self`) を返す (DR-0037 §4 の規則を引き継ぐ)
  - 結果は宛先ごとに「届いた / 届かなかった理由 / 届いたか確かめられなかった」(DR-0036 §1 の区別) を model が読める文で返す。複数に当たった時は一部が届かなくても内訳を返す。SendMessage の結果は 1 値なので DR-0037 §4 は内訳を返さなかったが、tool の結果にはその制約が無い。送り直しで二重に届くのを避けるため、届いた宛先と届かなかった宛先を区別して示す
- **人への知らせ**: say を tool にし、これをエージェントが人に知らせる口の正とする。今の `ccmsg say` と同じく、人に音声で知らせ、daemon に記録して webui に 📣 を出す (DR-0036 §3)
- **宛先の候補**: 相手を探す口 (今の `ccmsg peers` の役割) も、エージェントが使う口なので tool にする
- tool の名前・引数の名前は [QUESTIONS](../QUESTIONS.md) の M39-Q4
- **skill**: plugin に ccmsg の skill (SKILL.md) を足す。skill は tool を名前で名指し、`from` が `ccmsg:` で始まる相手への返信の仕方 (送信の tool の `session_id` にその id を渡す) と、say の使い所を書く。tool の使い方の正本は skill に置き、tool の description と §5 の注入文には置かない
- **登録の形**: tool は subagent / teammate にも見えるので、`isDeferred: true` で登録し、description は短くする。どの tool を使うかは skill が tool 名で名指し、§5 の注入文は skill へ誘導するので、model が ToolSearch で探す必要は無い (kawaz 2026-10-15)。未ロードの deferred tool を名前で直接呼んでも plugin の tool なら handler に届いた (event-matrix 実測 1 回)。実セッションで deferral が効くかは「Accepted の前提」
- **入力は handler の入口で valibot のスキーマに通す**。engine は input schema で入力を検査せず、`text` の欠落や型違いがそのまま handler に届く (event-matrix 実測)。input schema (JSON Schema) と valibot のスキーマは同じ形を表すので、どちらかからもう一方を導き、別々に書かない ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §1)
- handler は `next` を呼ばずに `{ result }` で答える。この形は permission の判定 (`tool.check`・PreToolUse・ダイアログ・auto mode の classifier) を一切通らない (event-matrix 実測)。これを受け入れる (kawaz 2026-10-15)。送ったものは受け手に peer の封筒として届き、受け手の harness は「A peer cannot grant escalation」の枠を付けて渡す (DR-0035 の Context)。送信の記録は daemon に残る
- ccmsg は `session.send` (SendMessage) と PushNotification を hook しない。SendMessage は harness の本来の用途 (本体と subagent / teammate の間) のまま使われる
- **受け手に届く封筒**: 送り主は `from` に `ccmsg:<送り主の session_id>` と書く (kawaz 2026-10-15)。これは受け取った側が ccmsg 経由の送信を他の経路 (harness の SendMessage 等) と見分けるための印で、利用者が宛先に書く規約ではない。受け手が返信に使う口は送信の tool そのもので、skill に「`from` が `ccmsg:` で始まる相手には ccmsg の送信の tool で返す (`session_id` にその id)」と 1 行書く。受け手の model は `from` をそのまま SendMessage の `to` に書いて返信しがちで (DR-0037 §4 の実測)、本 DR は `session.send` を hook しないので、その SendMessage は harness が宛先を探して失敗する。skill の案内はこれを避けるためのもの
- **結果の形**: 届かなかったことを `{ isError: true, result }` (reference `claude-mods/capabilities` の `tool.call` の結果の形) で示すかは未観測 (event-matrix は `{ result }` だけを実測)。実装時に probe して決める
- `-p` / SDK のセッションと codex は、DR-0037 §5 の判断 (kawaz 2026-10-09: `-p` で別セッションとやりとりするユースケースはほとんど無い) を引き継いで対象外にする。tool を登録しないか、登録して理由を返すかは実装時に決める

### 4. CLI は人の口と module の transport の 2 面に縮める

- **人の口**: `daemon` / `status` / `stop` / `origins` 等、人が端末で使うもの
- **module の transport**: module が `$.process.run` で起こすもの。`sidecar` 系 (`sidecar` / `sidecar reply` / `sidecar facts`) と、say の tool の handler が起こす `say`
- `ccmsg sidecar send` は、SendMessage の `to` 1 つを受ける形 (op `address_send`) から、§3 の宛先の部分指定と本文を受け、宛先ごとの結果を返す新しい op に置き換える。宛先の候補の tool も `sidecar` 系を transport にする
- エージェントがメッセージを入れる口を CLI から削る: `ccmsg post` / `ccmsg reply` (op `message_send`)、`ccmsg peers` の `addresses` (宛先の綴り)
- `subscribe` / `notify` は本 DR では残す
- サブコマンドごとの最終の振り分けは実装時に行い、判断の軸は「エージェントが呼ぶ口か」とする
- webui からの人の入力 (op `session_input`、user role、DR-0035 §1) は人の口なので変えない

### 5. 最初の turn の前に、エージェント向けの案内を会話に入れる

- `prompt.submit` の before で、`$.state` に「この session で案内を入れた」印が無ければ `$.session.append` (`type: 'user'`) で案内を足して印を置く (event-matrix の推奨 E)。`session.compact` の after で `$.state` に「compact 済み」を置き、次の `prompt.submit` の before で足し直す (同 I)
- E は対話と `-p`、startup / resume / continue / `/clear` で次の request に載った (同 findings の実測)。`/clear` と resume では `$.state` が空になるので、何もしなくても足し直される。hot reload では `$.state` が残るので二重にならない
- I は対話の手動 compact 1 回で確認した。自動 compact の後は未観測 (「Accepted の前提」)
- `$.state` の印は `prompt.submit` 以降に読む。`/clear` の直後の hook の入口では前の session の値が見えることがある (同 findings の「`$.state` と module の生死」)
- `$.state` の key は plugin の `types/index.d.ts` の `PluginState` に宣言する (無いと `claude plugin validate` が落ちて module が読み込まれない、同 findings の「実験の作り方」)
- `-p` (`session.start` の `isInteractive: false`) のセッションには案内を入れない。§3 で `-p` を送受信の対象外にしているため (E 自体は `-p` でも届く、event-matrix 実測)
- 注入する案内は skill (§3) への誘導に留め、tool の使い方そのものは書かない。文面は実装時に決める。DR-0035 §4 のとおり、サイドカーの socket path と依頼の形式は案内にも skill にも書かない

### 6. webui から走行中の subagent へ文脈を直送する

- webui から走行中の subagent に書いた文は、daemon がサイドカー経由で module に渡し、module が `$.session.append({ message: { type: 'user', ... }, agentId })` で足す。子の次の request で、直前の tool_result と同じ user message の後ろの text block として載り、本体の request には載らない (event-matrix の agentId 付き append の実測 5/5)。観測は background の `Agent` の子が tool を実行している間に、timer を契機に足した場合だけで、foreground の `Agent`、stream の途中、`-p` の子・teammate・workflow の agent、peer socket やサイドカーの依頼を契機にした append は未観測
- module は `agentId` 付きの `turn.start` / `turn.complete` を畳んで、走行中の subagent の `agentId` の一覧をセッションの事実 (DR-0035 §3) の subagent の節として daemon に送る。webui は直送の宛先をこの一覧から選ぶ (transcript の `Agent` の結果からは子が今走っているかが分からないため)。これは findings 2026-10-15-mods-reference-opportunities の B1 (agent tree の生存判定を event にする) の一部を先に入れることになる。`turn.*` の `agentId` は直送の宛先と同じ値 (同実測: `turn.*`・`$.agent.list()` の `id`・`tool.call` の `agentId`・`Agent` tool の結果の `agentId` はすべて一致)
- 終わった子と存在しない id への append は `refused: no running loop is <agentId>` で拒まれる (同実測)。module はこれを「届かなかった (subagent が走っていない)」として daemon に返し、webui に出す。文言では終わった子と存在しない id を区別できないので、区別して示さない
- これは会話への文脈の追加であって user prompt ではない (transcript では `isMeta` の user 行)。permission や classifier の判断を変える権限の付与には使わない (§8)。classifier がこの行をどう読むかは未検証
- 本体への人の入力は今までどおり composer への fill + Enter (DR-0035 §1) で、この経路は subagent 宛てに限る

### 7. module の無いセッションは no_module の 1 状態とし、フォールバック経路を作らない

- no_module の判定は DR-0035 §5 の `input_readiness` と同じ材料で行う: その sid を名乗ってサイドカーが生きている run が無ければ no_module。未 trust の workspace、safe mode、`--bare`、`disableAllHooks` / `allowManagedHooksOnly` / policy、`allowManagedModsOnly` で module が読まれないセッション、module を持たない古い plugin のセッション、サイドカーを起こさない `-p` / SDK のセッションがこれに当たる
- no_module のセッションは ccmsg の機能 (送信・say・人の入力・受信) を持たない。そのために CLI での送信、PushNotification の利用、`ps` での探索、classic hook の併用といった別経路を作らない
- 送信の tool が宛先ごとに見る状態は `ready` (生きている run がある)、`no_module`、`session_changed` (その sid を名乗った run が今は別の sid で名乗っている、/clear・/resume)、`ended` (終了した)。語彙は DR-0035 §5 の `input_readiness` に揃える (端末の有無 `no_terminal` は peer 注入に関わらないので見ない)。`ready` 以外の宛先には送らず、その状態を理由として返す

### 8. やらないこと

- 同一セッションの中の SendMessage (本体と subagent / teammate の間) には触らない。typed tool はセッション間の送信と say (と宛先の候補) に限る。同一セッションの中の連絡まで tool に寄せると、harness の SendMessage と経路が 2 本になる
- 同じ config home のセッション同士でも、セッション間の送信は送信の tool で行い、harness の SendMessage の名前での直接送信は案内しない (DR-0037 §1 の kawaz 2026-10-13 の裁定を引き継ぐ)
- §7 のフォールバック経路を作らない。経路が 2 本あると、どちらで届いたか・どちらが壊れているかの切り分けが常に要り、no_module という状態の意味もぼやける
- §6 の `agentId` 付き append を、permission の許可や classifier の判断材料の代わりに使わない

## Accepted の前提 (probe)

次を実機で確かめてから Accepted にする。`isDeferred` の行は実セッションの debug log で、それ以外は代役の API と隔離 config home で行える (event-matrix の「実験の作り方」)。

| 確かめること | 成り立たない時 |
|---|---|
| `command.run (clear)` の `next(e)` の後で `$.session.id()` が新しい id を返す | `session.end (clear)` の後の最初の `prompt.submit` で読み直す |
| セッション内の `/resume` で `session.end (resume)` と `command.run (resume)` の after が起き、新しい id が読める | `/resume` の追従の拾い方を別に決める |
| busy 中の Enter で、`prompt.submit` の `next(e)` が Enter の時点で resolve する (DR-0035 §5 は `classic.UserPromptSubmit` について Enter の数 ms 後を実測している) | queue された prompt が model に渡る時点まで resolve しないなら、busy 中の入力は daemon の期限 (12 秒) を過ぎて `unconfirmed` になる。成功の時点の定め方を見直す |
| `$.process.run` で `daemon start` を呼び、detached の daemon を待たずに返る (CLI は daemon の stdio を ignore して起こす、B5) | 起こし方を変える (`$.process.spawn` 等) |
| `/clear` とセッション内の `/resume` の後に `$.tool.register` の登録が残る (起動時の resume は新しい process で `session.start` が起き登録し直すが、`/clear` では `session.start` が起きない)。hot reload の後に登録し直した tool は呼べた (event-matrix 実測 2 回) ので、登録し直しが通ることには部分的な証拠がある | `command.run (clear)` の after で登録し直す |
| `/model` での切替が `config.set` (key `model`) か `command.run` (`model`) を通る | 切替の後の読み直しは次の request の `turn.step` まで遅れる (§2) |
| tool の handler が `{ isError: true, result }` を返した時に model に error として届く | 届かなかったことは `{ result }` の文面だけで示す |
| API error の時に、harness が書く API error の行が `$.session.append` の hook を通り、分類と表示文が読める (どの door で通るか)。`turn.complete (reason: 'error')` との順序 | 分類と表示文は transcript の行の読みで取り続ける (§2) |
| `tool.call` の handler が送信の完了 (daemon の解決と peer 注入) を待てる上限。`$.process.run` の既定の期限は 30 秒で、DR-0037 §4 は `session.send` の hook で 10 秒の await を実測している | handler の待ちを上限の内に収め、超えたら「届いたか確かめられなかった」で返す |
| 自動 compact の後に、§5 の I で案内が足し直される | 足し直しの契機を別に決める |
| 実セッション (kawaz の個人面の settings。gateway の `ANTHROPIC_BASE_URL` を持つ) で `isDeferred: true` が効く。debug log の `[ToolSearch:optimistic]` の行で分かる。代役の URL では `ENABLE_TOOL_SEARCH` を設定しない限り無効だった (event-matrix 実測) | deferred が効かない環境では tool が全文で `tools` に載る。description を短くしておく (§3) ことでその量を抑える |

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| classic を併用する (command hook の SessionStart と module の `classic.*` を残す) | 読み込みの条件が違う 2 本の経路を持ち続けることになる。組織が管理する機械では user tier の `classic.*` が飛ばされる (Context) |
| エージェント向けの口を CLI のまま残す (`ccmsg post` / `reply` / `peers` / `say`) | 本文の切れ目のぶれ、長い本文の truncate の回避、1 アクションが残り、引数に型が無い (Context)。typed tool なら入力の形を schema で示せ、本文は tool の入力として全文が渡る |
| SendMessage の横取り (DR-0037) を続ける | `ccmsg:` の綴りの規約を利用者に課す。model が読む結果の文面は harness が決めて ccmsg の結果を正確に表せず、hook の throw が harness の宛先探しに落ちる (DR-0037 §4)。harness の本来の宛先 (本体と subagent) と同じ tool に ccmsg の宛先が混ざる |
| ccmsg の口を MCP server で出す | module の無いセッションでも動く口になり、§7 と逆になる。セッションごとに別プロセスが常駐する |
| module の無いセッション向けに CLI / PushNotification / `ps` / classic のフォールバックを持つ | §8 のとおり。kawaz 2026-10-15 の方針 |
| tool の handler で `next(e)` を呼んで permission を通す | `next(e)` は permission の判定の後に core まで降り、`no tool.call hook answered` のエラー結果が返る。permission を通しつつ自前で答える形は見つかっていない (event-matrix 実測) |
| tool の handler から `$.tool.check` を呼んで permission の判定だけを受ける | 未検証。送信の tool は permission を通さないことを受け入れた (§3) ので、要らない |
| 案内を `session.start` の after で append する (event-matrix の口 A) | `/clear` と compact で届かず、hot reload で重複する |
| 案内を `classic.SessionStart` の `additionalContext` で入れる (口 C) | 全場面で届くが classic で、本 DR の目的と逆 |
| 案内を `prompt.context` の独自 block で入れる (口 D) | resume で作り直されず古いまま。組織が管理する機械では飛ばされる |
| 案内を `turn.start` の before で append する (口 F) | その turn の request に間に合わず、後から prefix を変えて prompt cache を切る |
| `tool.describe` で SendMessage の説明に案内を足す (B3 の第 1 案) | セッション間の送信は SendMessage でなく送信の tool で行う (§3) ので、SendMessage の説明は案内の置き場にならない。返信の案内は skill と §5 に置く |
| tool の handler から daemon へ `$.http.fetch` (`socketPath`) で直接話す (B10) | daemon に HTTP の op の endpoint と session role の名乗り方の設計が要り、`socketPath` が任意の UDS に繋がるかはリファレンス自身が未確認。transport は今の CLI (`sidecar` 系) のままにする (Consequences にコスト) |

## Consequences

- 置き換わる判断: 本 DR が Accepted になり実装された時点で、[DR-0037](./DR-0037-agent-messages-ride-sendmessage.md) は Superseded になる。[DR-0035](./DR-0035-user-input-via-composer-fill.md) の §3 (事実を取る classic の event、「daemon はセッションの起動 (SessionStart) で立つ」) と §5 (成功の時点を `classic.UserPromptSubmit` とする定め) は §2 の対応表に置き換わる。[DR-0036](./DR-0036-retire-rooms-for-p2p.md) §1 の CLI の直送と、v2 の契約に揃えた返信行 (`Reply with: ccmsg reply <mid> --to <sid> <text>`) は §3 の送信の tool に置き換わり、返信行の形の v2 との整合は崩れる (封筒の `from` の `ccmsg:<sid>` は残り、返信は skill の案内で送信の tool に導く、§3)。DR-0036 §3 の「人へ知らせるのは PushNotification で足りる」は say の tool に置き換わる。[DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6 の送信の認識 (`ccmsg-direct-transcript.ts` が agent の `ccmsg post` / `reply` の Bash 呼び出しを認識する部分) には、送信と say の tool の tool_use の形を足す
- 移行の順序: 「tool と新しい op を足す → 旧 op (`message_send` / `address_send`) を deprecate する → 次のリリースで旧 op を削る」。動いているセッションには前の版の module が残りうる (DR-0035 §3) ので、daemon が旧 op を先に削ると、旧 module の SendMessage の横取りがその場で壊れる。旧 module のセッションは再起動 (か `/reload-plugins`) で新しい module になる
- 組織が管理する機械では次のものが効かない (reference `claude-mods/overview` の `sec-default` 節の記述で、ccmsg では未検証): `session.compact` の hook が飛ばされるので compact の後の案内の足し直し (§5) が起きない。managed の `allowedMcpServers` がある間は user tier の `$.tool.register` が拒まれるので、§3 の tool が登録されず、そのセッションは送信と say を持たない (§7 により別経路は無い)
- transcript path の出所が無くなる: 今は SessionStart の command hook が stdin の `transcript_path` を state file に書き、CLI の hello で daemon に届く。module には transcript path を返す `$` が無いので、module のあるセッションも daemon の `resolvePendingTranscripts` (未入力のセッションについて poll ごとに config dir を走査する) で探すことになり、走査の対象が全セッションに広がる。走査のコストは測っていない
- モデルを切り替えてから次の prompt までの間、webui の model と window は切替前の値のまま
- §5 の案内は resume のたびに 1 つずつ会話に積み重なる (event-matrix 実測)。compaction で summary に置き換わるので、積み重なるのは compact までの間に限られる (`preservedSegment` の付く compaction で末尾の行が残った例は 1 回ある、同実測)。`$.session.messages()` で既に入っているかを見てから足す手はある (未検証)
- tool 1 つの entry は約 0.5 KB (event-matrix の「context のコスト」で、説明 54 字・property 5 つの entry が 487 byte)。deferred が効く間は、読み込まれるまで一覧の名前 1 行だけになる。hot reload で説明を変えても本体の request は session 開始時の説明のまま (同実測)
- daemon が立つ契機は module の `session.start` と人の CLI になる。module の無いセッションは daemon を起こさない
- state file は、CLI が session として hello する時に repo / ws / transcript_path 等の名乗りのために読む。エージェント向けの CLI が無くなった後もこの名乗りを state file 経由で渡すか、サイドカーの名乗りやセッションの事実に載せ替えるかを実装時に決める
- protocol から消えるもの: `hook-input.ts` (SessionStart の stdin)、`ccmsg-address.ts` の宛先の文法のうち `ccmsg:<sid>.<pid>` と `ccmsg:path:<dir>` (`ccmsg:<sid>` は封筒の `from` の綴りとして残る)、op `message_send` / `address_send` (移行の順序のとおり次のリリースで)。足すもの: tool の入力のスキーマ、部分指定の宛先と本文を受ける送信の op、webui から subagent への直送の依頼 (サイドカーの op)、セッションの事実の subagent の節 (走行中の `agentId` の一覧、§6)
- 案内の追従: CLI の help (「人に知らせるには PushNotification を使う」「SendMessage で `peers` の address に送る」)、rules 側でエージェントに PushNotification を案内している記述を、say の tool と送信の tool に合わせる。PushNotification の 📣 表示 (DR-0027 §6.3、transcript の tool_use の読み取り) は残すが、エージェントには案内しない
- 外部の案内: rules リポで `ccmsg` の CLI をエージェントに案内している記述は、plugin の skill と §5 の案内に合わせて追従させる。正本は plugin 側 (skill と §5) に置き、issue `2026-10-13-agent-guidance-for-ccmsg-addresses` の候補 (a) skill と (b) 起動時の案内 (classic でなく §5 の形) を取り、(c) rules 側は正本にしない。v1 の plugin は今 skill を持たないので、§3 の skill が初めての skill になる。v2 の plugin の `ccmsg:ccmsg` skill は v2 の口の案内で、本 DR では触らない
- `turn.step` を hook する (§2) ことで、DR-0035 §3 の「`turn.step` を hook すると応答の断片がすべて module を通るので使わない」は撤回になる。断片が module を通るコストは測っていない (B17。context-notify は同じ形で本番で使っている)
- tool の呼び出し 1 回ごとに CLI の process が 1 つ乗る (handler が `$.process.run` で `sidecar` 系を起こす。bun の起動を含む往復は約 0.3 秒、B7)
- `$.state` を使うので、plugin の `types/index.d.ts` の `PluginState` の宣言が `claude plugin validate` の必須になる。validate は push の依存 (`just ci` の `validate`) で担保し、GitHub CI では runner に `claude` が無いので検査されない
- hooks.json を `modules` だけにすると、Mods に対応しない古い Claude Code の build が `modules` を含む hooks.json を丸ごと捨てるかは未確認 (reference `claude-mods/overview` の未確認)。本 DR の前提の実測は 2.1.299 で行った。plugin が要る Claude Code の最低版をどこに示すかは実装時に決める
- DR-0035 §4 のとおりサイドカーには認証が無いので、§6 の直送の依頼も同じ uid のプロセスが規約 path に書けば通る。足されるのは文脈であって権限ではない (§6) ので、DR-0035 §4 の切り分け (抜け道は classifier に任せる) をそのまま適用する
- 使用量を `turn.step` の後の `$.session.usage()` で request ごとに取り、transcript の fold を外す形 (B17) は、§2 で `turn.step` を hook するので同じ hook に足せる。本 DR の範囲外
- issue `2026-10-14-mods-consolidation-and-turn-events` の 1 (classic を mods に寄せる) と issue `2026-10-13-agent-guidance-for-ccmsg-addresses` (エージェント向けの案内の置き場) は、本 DR の実装で片付く

## 関連

- [findings 2026-10-15-mods-event-matrix-startup-resume-clear-compact](../findings/2026-10-15-mods-event-matrix-startup-resume-clear-compact.md) — event の対応、注入の口、`$.tool.register` の制約、agentId 付き append の実測
- [findings 2026-10-15-mods-reference-opportunities](../findings/2026-10-15-mods-reference-opportunities.md) — classic 全廃の対応表 (B5)、宛先の案内 (B3)、`turn.step` で effort (B17)、組織が管理する機械 (食い違い 1)
- [findings 2026-10-14-mods-vs-transcript-information-sources](../findings/2026-10-14-mods-vs-transcript-information-sources.md) — module で取れる事実の棚卸し
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — hooks module、サイドカー、セッションの事実、人の入力、`input_readiness`
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) — セッション間の直送と say
- [DR-0037](./DR-0037-agent-messages-ride-sendmessage.md) — 本 DR が置き換える SendMessage の横取り
- [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6 — TL の送信・PushNotification の表示
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — tool の入力をスキーマで読む
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入 (受け手への配送はこのまま)
- kawaz/claude-context-notify の DR-0003 — classic を使わない hooks module の参照実装 (`turn.step` の hook、`$.tool.register`、`$.session.append`)
