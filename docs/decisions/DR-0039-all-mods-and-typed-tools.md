# DR-0039: classic hook を全廃して hooks module 1 本に寄せ、エージェントが使う ccmsg の口を typed tool にする

- Status: Proposed
- Date: 2026-10-15

## Context

ccmsg v1 の plugin は、Claude Code に 2 つの経路でつながっている。

- **command hook**: hooks.json の SessionStart (matcher `startup|resume|clear|compact`) が `hooks/session-start.ts` を起こし、state file (transcript_path / cwd / repo / ws / repo_root / branch) を書いて `daemon start` を detached で起こす
- **hooks module** (`composer-fill.bundle.js`): engine event (`session.start` / `session.end` / `session.measure` / `turn.start` / `turn.complete` / `prompt.submit` / `session.send`) と、classic event 5 つ (`classic.SessionStart` / `classic.Stop` / `classic.StopFailure` / `classic.PostModelSwitch` / `classic.UserPromptSubmit`) を hook する ([findings 2026-10-15-mods-reference-opportunities](../findings/2026-10-15-mods-reference-opportunities.md) の「ccmsg が今使っている Mods の機能」)

classic に頼っている所は、組織が管理する機械 (managed settings のある機械、Team / Enterprise の組織) では動かない。そこでは built-in の `sec-default` が user tier の `classic.*` hook を飛ばす (rules リポの reference `claude-mods/overview` の `sec-default` 節。context-notify の DR-0003 は `claude plugin validate` の注記の文面として同じことを記録している)。ccmsg は `/clear` 後のサイドカーの起こし直し、`prompt.send` の受け付けの確認 ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §5)、effort、API error の分類、モデル切替の追従を classic で取っているので、該当する機械ではこれらが全部働かない (同 findings の「食い違い 1」)。command hook と module の 2 本の経路は、読み込まれる条件も違う (module が読まれず command hook だけが走るセッションの集合は未検証、同 findings の B5「全廃の障害と前提」)。

エージェントが ccmsg を使う口も 2 種類ある。

- **CLI**: `ccmsg post <sid>` / `ccmsg reply <mid> --to <sid>` (op `message_send`、[DR-0036](./DR-0036-retire-rooms-for-p2p.md) §1)、`ccmsg peers`、`ccmsg say`。長い本文の truncate の回避と、送るたびのコマンド実行の 1 アクションが要り、引数に型が無い ([DR-0037](./DR-0037-agent-messages-ride-sendmessage.md) の Context)
- **SendMessage の横取り** ([DR-0037](./DR-0037-agent-messages-ride-sendmessage.md)): `to` が `ccmsg:` で始まる SendMessage を module の `session.send` hook が受け、daemon が宛先を解決して peer 注入する。宛先の綴り (`ccmsg:<sid>` / `ccmsg:<sid>.<pid>` / `ccmsg:path:<dir>`) という規約を利用者に覚えさせ、model が読む結果の文面は harness が決め (本来の SendMessage の成功の文面と揃わない)、hook が throw すると harness が宛先を agent 名として探す (DR-0037 §4)。エージェント向けの案内は CLI の help にしか無い (issue `2026-10-13-agent-guidance-for-ccmsg-addresses`)

Claude Code 2.1.299 の実機で、classic を使わずに同じことができる口を確かめた。

- classic.SessionStart の各 source に当たる mods の event と、`$.state` と module の生死 ([findings 2026-10-15-mods-event-matrix-startup-resume-clear-compact](../findings/2026-10-15-mods-event-matrix-startup-resume-clear-compact.md) の「classic.SessionStart の各 source と mods の event」「`$.state` と module の生死」)
- 最初の turn の前に model へ文脈を入れる口ごとの到達 (同 findings の「最初の turn の前の注入: 口ごとの到達」)
- `$.tool.register` で登録した tool が対話・`-p`・subagent の request に載り、model の呼び出しが `tool.call` の handler に届くこと (同 findings の「`$.tool.register` の可視範囲と typed call」の「結論」)
- `agentId` 付きの `$.session.append` が走行中の subagent の次の request にだけ載ること (同 findings の「`agentId` 付きの `$.session.append` で走行中の subagent に文脈を入れる」)

kawaz 2026-10-15 の方針: classic hook は残さず全部 mods に寄せる。エージェントに使わせる口は CLI でなく `$.tool.register` の typed tool にし、宛先は部分指定で解決して config dir 跨ぎは裏で行い、`ccmsg:` 接頭辞のような規約を利用者に課さない。say も typed tool にする。CLI は人が使う口に縮める。module の無いセッション向けのフォールバック経路は作らない。

## Decision

### 1. classic hook を全廃し、plugin の経路を hooks module 1 本にする

- hooks.json は `{ "modules": [...] }` だけにする。command hook の SessionStart (`hooks/session-start.ts`) と、module 内の `classic.*` の hook はすべて削る
- 今 classic で行っていることは、§2 の対応表の mods の event で行う
- 組織が管理する機械で飛ばされる user tier の hook (`classic.*` の他に `prompt.context` / `prompt.attachment` / `session.compact` 等、reference `claude-mods/overview` の `sec-default` 節の表) を、ccmsg の機能が成り立つための前提に使わない。`session.compact` だけは §5 の案内の足し直しに使い、飛ばされた時に失うものを Consequences に書く

### 2. classic の各口の置き換え

| 今の口 | 用途 | mods での拾い方 | 前提の確度と、成り立たない時 |
|---|---|---|---|
| command hook SessionStart `startup` / `resume` (`--resume` / `--continue`) | state file の書き出しと `daemon start` | `session.start` の after から `$.process.run` で `bin/ccmsg` を呼ぶ。cwd は `$.session.cwd()`、repo の root と remote は `$.session.repo()`、ws / branch は今と同じく bump-semver を `$.process.run` で呼ぶ | `session.start` は startup・resume・continue のどれでも起きる (event-matrix 実測、対話と `-p`)。hot reload でも起きるので冪等にする (同実測)。最初の `session.start` は await されるので、起動を待たせない形にする。`daemon start` を `$.process.run` で呼んだ時に detached の daemon を待たずに返るかは未検証 (B5「全廃の障害と前提」) |
| 同 `clear`、module の `classic.SessionStart (clear)` | 新しい sid でサイドカーを起こし直し、事実を読み直し、turn を idle にする | `session.end` (`reason: 'clear'`) で旧 id の世代を進め、`command.run` を `{ command: 'clear' }` で hook して `await next(e)` の後に `$.session.id()` を読み直す | `command.run` の `next(e)` が resolve するのは新しい session の `classic.SessionStart (clear)` の dispatch の後 (event-matrix 実測 2/2)。その時点で `$.session.id()` が新しい id を返すことは**未観測** (同 findings の「未観測」)。読めなかった時の拾い直しの契機は probe の結果で決める |
| セッション内の `/resume` | 同上 | `session.end` (`reason: 'resume'`) と `command.run` (`resume`) の after | **未観測** (event-matrix の「未観測」、B5 の表) |
| 同 `compact`、module の `classic.SessionStart (compact)` | state file の書き直しと model / window の読み直し | 何もしない。compaction で変わるのは使用量だけで、次の `session.measure` で取れる | B5 の表 |
| `classic.Stop` の `effort.level` | 本体の turn の effort | `turn.step` を `async function*` と `yield* next(e)` で hook し、`e.agentId === undefined` の request の `e.effort` を取る (context-notify の `turn.step` の hook と同じ形、B17) | 実測 (mods-vs-transcript findings、context-notify DR-0003)。request の時点で分かるので今より早い。effort 非対応のモデルでは key が無い |
| `classic.PostModelSwitch` | 切替直後の model と window の読み直し | 次の request の `turn.step` の `e.model` と、その時の `$.session.usage().context.window` | 即時の event は無い。切替から次の prompt までの間、webui の model / window は古いまま (Consequences) |
| `classic.UserPromptSubmit` | `prompt.send` の受け付け (DR-0035 §5 の成功の時点) | `prompt.submit` の hook で `origin.kind === 'composer'` と fill した文の一致を見る。書きかけの復元は今も同じ event でしている | idle では `prompt.submit` が `classic.UserPromptSubmit` より先に起きる (event-matrix の event 列)。**busy 中の Enter で Enter の時点に起きるかは未観測** (B4)。queue された prompt が model に届く時点まで起きないなら、busy 中の入力は daemon の期限 (12 秒) を過ぎて `unconfirmed` になる。その時は成功の時点の定め方を見直す |
| `classic.StopFailure` の `error` / `last_assistant_message` | API error の分類と表示文 | `turn.complete` の `reason: 'error'` で立てる (今も StopFailure が無い時に分類 `unknown` で立てている経路) | **分類と表示文の代わりが無い** (B5 の表)。代わりの取り方は [QUESTIONS](../QUESTIONS.md) の M39-Q2 |

- 本体と subagent は `e.agentId` の有無で分ける (`turn.*` / `turn.step` は subagent の loop でも起きるので、本体の事実は `agentId` の無いものに絞る)
- transcript path を返す `$` は無い。daemon が sid から解決する今の経路 (`resolvePendingTranscripts`) を使う

### 3. エージェントが使う ccmsg の口は typed tool にする

module が `session.start` で `$.tool.register` により tool を登録し、`tool.call` の handler で答える。登録した tool は対話・`-p`・subagent の request の `tools` に載り、handler では呼び手の session id (`$.session.id()`、subagent からの呼び出しでも本体の id)、cwd (`$.session.cwd()`)、subagent なら `e.agentId` が取れる (event-matrix の `$.tool.register` の「結論」)。

- **セッション間の送信**: 入力は `{ session_id?, cwd?, name?, pid?, text }` のような宛先の部分指定と本文。daemon が部分指定を生きているセッションに解決し、config dir が違うセッションにも peer 注入 ([DR-0034](./DR-0034-peer-socket-injection.md)) で届ける。config dir を跨ぐことを利用者に意識させず、宛先の綴りの規約 (`ccmsg:` 接頭辞) を持たない。結果は「届いた / 届かなかった理由 / 届いたか確かめられなかった」を model が読める文で返す (DR-0036 §1 の区別をそのまま使う)
- **人への知らせ**: say を tool にする。今の `ccmsg say` と同じく、人に音声で知らせ、daemon に記録して webui に 📣 を出す (DR-0036 §3)
- **宛先の候補**: 相手を探す口 (今の `ccmsg peers` の役割) も、エージェントが使う口なので tool にする
- tool の名前・引数の名前・宛先の部分指定が複数のセッションに当たった時の扱いは [QUESTIONS](../QUESTIONS.md) の M39-Q4
- **入力は handler の入口で valibot のスキーマに通す**。engine は input schema で入力を検査せず、`text` の欠落や型違いがそのまま handler に届く (event-matrix 実測)。input schema (JSON Schema) と valibot のスキーマは同じ形を表すので、どちらかからもう一方を導き、別々に書かない ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §1)
- handler は `next` を呼ばずに `{ result }` で答える。この形は permission の判定 (`tool.check`・PreToolUse・ダイアログ・auto mode の classifier) を一切通らない (event-matrix 実測)。これを受け入れるかは [QUESTIONS](../QUESTIONS.md) の M39-Q1
- ccmsg は `session.send` (SendMessage) と PushNotification を hook しない。SendMessage は harness の本来の用途 (同じ config home の中の宛先、本体と subagent の間) のまま使われる
- 受け手に届く封筒の送り主の示し方と、受け手が返信に使う口 (受け手の model は届いた封筒の `from` を SendMessage の `to` に書いて返信する、DR-0037 §4 の実測) は [QUESTIONS](../QUESTIONS.md) の M39-Q5
- `isDeferred` と `/clear` の後の登録の扱いは [QUESTIONS](../QUESTIONS.md) の M39-Q3
- `-p` / SDK のセッションと codex は、DR-0037 §5 の判断 (kawaz 2026-10-09: `-p` で別セッションとやりとりするユースケースはほとんど無い) を引き継いで対象外にする。tool を登録しないか、登録して理由を返すかは実装時に決める

### 4. CLI は人が使う口に縮める

- エージェント向けのメッセージの口を CLI から削る: `ccmsg post` / `ccmsg reply` (op `message_send`)、SendMessage の横取りが使う `ccmsg sidecar send` (op `address_send`)、`ccmsg peers` の `addresses` (宛先の綴り)
- CLI に残すのは人が使うもの (`daemon` / `status` / `stop` / `origins` 等) と、module が `$.process.run` で起こすもの (`sidecar` 系)。サブコマンドごとの振り分けは実装時に行い、判断の軸は「エージェントが呼ぶ口か」とする
- webui からの人の入力 (op `session_input`、user role、DR-0035 §1) は人の口なので変えない

### 5. 最初の turn の前に、エージェント向けの案内を会話に入れる

- `prompt.submit` の before で、`$.state` に「この session で案内を入れた」印が無ければ `$.session.append` (`type: 'user'`) で案内を足して印を置く。`session.compact` の after で `$.state` に「compact 済み」を置き、次の `prompt.submit` の before で足し直す (event-matrix の「最初の turn の前に文脈を入れる場所」の推奨 E + I)
- この組み合わせは、対話と `-p`、startup / resume / continue / `/clear` / compact のすべてで次の request に載った (同 findings の実測)。`/clear` と resume では `$.state` が空になるので、何もしなくても足し直される。hot reload では `$.state` が残るので二重にならない
- `$.state` の印は `prompt.submit` 以降に読む。`/clear` の直後の hook の入口では前の session の値が見えることがある (同 findings の「`$.state` と module の生死」)
- `session.start` で無条件に足す形は取らない。`session.start` は hot reload でも走り、`/clear` と compact では起きない (同 findings)
- `$.state` の key は plugin の `types/index.d.ts` の `PluginState` に宣言する (無いと `claude plugin validate` が落ちて module が読み込まれない、同 findings の「実験の作り方」)
- 案内の文面は実装時に決める。tool の使い方そのものは各 tool の説明に置く

### 6. webui から走行中の subagent へ文脈を直送する

- webui から走行中の subagent に書いた文は、daemon がサイドカー経由で module に渡し、module が `$.session.append({ message: { type: 'user', ... }, agentId })` で足す。子の次の request で、直前の tool_result と同じ user message の後ろの text block として載り、本体の request には載らない (event-matrix の agentId 付き append の実測 5/5)
- 宛先の `agentId` は `turn.*` の `e.agentId` と同じ値で、module が事実として daemon に送る (同実測: `turn.*`・`$.agent.list()` の `id`・`tool.call` の `agentId`・`Agent` tool の結果の `agentId` はすべて一致)
- 終わった子と存在しない id への append は `refused: no running loop is <agentId>` で拒まれる (同実測)。module はこれを「届かなかった (subagent が走っていない)」として daemon に返し、webui に出す。文言では終わった子と存在しない id を区別できないので、区別して示さない
- **これは会話への文脈の追加であって、user prompt ではない**。人の入力として扱われず (transcript では meta の user 行)、classifier や permission の判断を変える権限の付与には使えない
- 本体への人の入力は今までどおり composer への fill + Enter (DR-0035 §1) で、この経路は subagent 宛てに限る

### 7. module の無いセッションは no_module の 1 状態とし、フォールバック経路を作らない

- module が読まれていないセッション (未 trust の workspace、safe mode、`--bare`、`disableAllHooks` / `allowManagedHooksOnly` / policy、`allowManagedModsOnly`、module を持たない古い plugin) は、daemon から見て no_module の 1 状態で、ccmsg の機能を持たない
- そのセッションのために、CLI での送信、PushNotification の利用、`ps` での探索、classic hook の併用といった別経路を作らない
- 送り手から見て宛先が no_module なら、送信の tool は届かない理由として返す。人の入力の `input_readiness` の `no_module` (DR-0035 §5) と同じ語彙を使う

### 8. やらないこと

- 同一セッションの中の SendMessage (本体と subagent / teammate の間) には触らない。typed tool はセッション間の送信と say (と宛先の候補) に限る。同一セッションの中の連絡まで tool に寄せると、harness の SendMessage と経路が 2 本になる
- §7 のフォールバック経路を作らない。経路が 2 本あると、どちらで届いたか・どちらが壊れているかの切り分けが常に要り、no_module という状態の意味もぼやける
- §6 の `agentId` 付き append を、permission の許可や classifier の判断材料の代わりに使わない

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| classic を併用する (command hook の SessionStart と module の `classic.*` を残す) | 組織が管理する機械では user tier の `classic.*` が飛ばされ、そこで `/clear`・入力の受け付け・effort・API error が全部働かない (Context)。読み込みの条件が違う 2 本の経路を持ち続けることになる |
| エージェント向けの口を CLI のまま残す (`ccmsg post` / `reply` / `peers` / `say`) | 長い本文の truncate の回避と 1 アクションが残り、引数に型が無い (DR-0037 の Context)。typed tool なら入力の形を schema で示せ、本文は tool の入力として全文が渡る |
| SendMessage の横取り (DR-0037) を続ける | `ccmsg:` の綴りの規約を利用者に課す。model が読む結果の文面は harness が決めて ccmsg の結果を正確に表せず、hook の throw が harness の宛先探しに落ちる (DR-0037 §4)。harness の本来の宛先 (本体と subagent) と同じ tool に ccmsg の宛先が混ざる |
| module の無いセッション向けに CLI / PushNotification / `ps` / classic のフォールバックを持つ | §8 のとおり。kawaz 2026-10-15 の方針 |
| 案内を `session.start` の after で append する (event-matrix の口 A) | `/clear` と compact で届かず、hot reload で重複する |
| 案内を `classic.SessionStart` の `additionalContext` で入れる (口 C) | 全場面で届くが classic で、本 DR の目的と逆 |
| 案内を `prompt.context` の独自 block で入れる (口 D) | resume で作り直されず古いまま。組織が管理する機械では飛ばされる |
| 案内を `turn.start` の before で append する (口 F) | その turn の request に間に合わず、後から prefix を変えて prompt cache を切る |
| tool の handler で `next(e)` を呼んで permission を通す | `next(e)` は permission の判定の後に core まで降り、`no tool.call hook answered` のエラー結果が返る。permission を通しつつ自前で答える形は見つかっていない (event-matrix 実測、M39-Q1) |

## Consequences

- 本 DR が Accepted になり実装された時点で、[DR-0037](./DR-0037-agent-messages-ride-sendmessage.md) は Superseded になる。[DR-0035](./DR-0035-user-input-via-composer-fill.md) の §3 (事実を取る classic の event、「daemon はセッションの起動 (SessionStart) で立つ」) と §5 (成功の時点を `classic.UserPromptSubmit` とする定め) は §2 の対応表に置き換わる。[DR-0036](./DR-0036-retire-rooms-for-p2p.md) §1 の CLI の直送と §3 の「人へ知らせるのは PushNotification で足りる」は、§3 の送信と say の tool に置き換わる
- 組織が管理する機械では次のものが効かない (reference `claude-mods/overview` の `sec-default` 節の記述で、ccmsg では未検証): `session.compact` の hook が飛ばされるので compact の後の案内の足し直し (§5) が起きない。managed の `allowedMcpServers` がある間は user tier の `$.tool.register` が拒まれるので、§3 の tool が登録されず、§7 によりそのセッションは ccmsg の送信と say を持たない
- モデルを切り替えてから次の prompt までの間、webui の model と window は切替前の値のまま
- §5 の案内は resume のたびに 1 つずつ会話に積み重なる (event-matrix 実測)。`$.session.messages()` で既に入っているかを見てから足す手はある (未検証)
- tool 1 つにつき request の `tools` に約 0.5 KB が載る (event-matrix の「context のコスト」で、説明 54 字・property 5 つの entry が 487 byte)。hot reload で説明を変えても本体の request は session 開始時の説明のまま (同実測)
- daemon が立つ契機は module の `session.start` と人の CLI になる。module の無いセッションは daemon を起こさない
- state file は、CLI が session として hello する時に repo / ws / transcript_path 等の名乗りのために読む。エージェント向けの CLI が無くなった後もこの名乗りを state file 経由で渡すか、サイドカーの名乗りやセッションの事実に載せ替えるかを実装時に決める
- protocol から消えるもの: `hook-input.ts` (SessionStart の stdin)、`ccmsg-address.ts` の `ccmsg:` の文法、op `message_send` / `address_send`。足すもの: tool の入力のスキーマ、webui から subagent への直送の依頼 (サイドカーの op)
- DR-0035 §4 のとおりサイドカーには認証が無いので、§6 の直送の依頼も同じ uid のプロセスが規約 path に書けば通る。足されるのは文脈であって権限ではない (§6) ので、DR-0035 §4 の切り分け (抜け道は classifier に任せる) をそのまま適用する
- DR-0027 §6.3 の PushNotification の 📣 表示 (transcript の tool_use の読み取り) は本 DR では変えない
- 使用量を `turn.step` の後の `$.session.usage()` で request ごとに取り、transcript の fold を外す形 (B17) は、§2 で `turn.step` を hook するので同じ hook に足せる。本 DR の範囲外
- issue `2026-10-14-mods-consolidation-and-turn-events` の 1 (classic を mods に寄せる) と issue `2026-10-13-agent-guidance-for-ccmsg-addresses` (エージェント向けの案内の置き場) は、本 DR の実装で片付く

## 関連

- [findings 2026-10-15-mods-event-matrix-startup-resume-clear-compact](../findings/2026-10-15-mods-event-matrix-startup-resume-clear-compact.md) — event の対応、注入の口、`$.tool.register` の制約、agentId 付き append の実測
- [findings 2026-10-15-mods-reference-opportunities](../findings/2026-10-15-mods-reference-opportunities.md) — classic 全廃の対応表 (B5)、宛先の案内 (B3)、`turn.step` で effort (B17)、組織が管理する機械 (食い違い 1)
- [findings 2026-10-14-mods-vs-transcript-information-sources](../findings/2026-10-14-mods-vs-transcript-information-sources.md) — module で取れる事実の棚卸し
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — hooks module、サイドカー、セッションの事実、人の入力
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) — セッション間の直送と say
- [DR-0037](./DR-0037-agent-messages-ride-sendmessage.md) — 本 DR が置き換える SendMessage の横取り
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — tool の入力をスキーマで読む
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入 (受け手への配送はこのまま)
- kawaz/claude-context-notify の DR-0003 — classic を使わない hooks module の参照実装 (`turn.step` の hook、`$.tool.register`、`$.session.append`)
