# DR-0039: classic hook を全廃して hooks module 1 本に寄せ、エージェントが使う ccmsg の口を typed tool にする

- Status: Accepted (2026-10-15) — ✅ 実装済み (段 1〜6: API error を transcript の行に一本化、classic hook の全廃、typed tool `send` / `say` / `peers` と skill、最初の turn の前の案内、webui から走行中の subagent への直送、旧 op `message_send` / `address_send` と CLI の `post` / `reply` / `peers --addresses` の削除)
- Date: 2026-10-15

## Context

エージェントが ccmsg を使う口は 2 種類あり、どちらも入出力に型が無い。

- **CLI**: `ccmsg post <sid>` / `ccmsg reply <mid> --to <sid>` (op `message_send`、[DR-0036](./DR-0036-retire-rooms-for-p2p.md) §1)、`ccmsg peers`、`ccmsg say`。エージェントは本文を引数として書くので、クォートの有無で本文の切れ目がぶれ (DR-0036 §1 は本文をクォートしない書き方に合わせて語を連結する規則を持つ)、長い本文は truncate の回避が要り、送るたびにコマンド実行の 1 アクションが要る。CLI はエージェントがセッションへメッセージを入れる口として誰でも叩ける
- **SendMessage の横取り** ([findings 2026-10-09-sendmessage-hook-for-ccmsg-addresses](../findings/2026-10-09-sendmessage-hook-for-ccmsg-addresses.md)): `to` が `ccmsg:` で始まる SendMessage を module の `session.send` hook が受け、daemon が宛先を解決して peer 注入する。宛先の綴り (`ccmsg:<sid>` / `ccmsg:<sid>.<pid>` / `ccmsg:path:<dir>`) という規約を利用者に覚えさせ、model が読む結果の文面は harness が決め (本来の SendMessage の成功の文面と揃わず、`to` が 1 つなので結果も 1 値)、hook が throw すると harness が宛先を agent 名として探す (同 findings の「判明した事実」)。エージェント向けの案内は CLI の help にしか無い (issue `2026-10-13-agent-guidance-for-ccmsg-addresses`)

plugin と Claude Code のつながりも 2 本ある。

- **command hook**: hooks.json の SessionStart (matcher `startup|resume|clear|compact`) が `hooks/session-start.ts` を起こし、state file (transcript_path / cwd / repo / ws / repo_root / branch) を書いて `daemon start` を detached で起こす
- **hooks module** (`composer-fill.bundle.js`): engine event (`session.start` / `session.end` / `session.measure` / `turn.start` / `turn.complete` / `prompt.submit` / `session.send`) と、classic event 5 つ (`classic.SessionStart` / `classic.Stop` / `classic.StopFailure` / `classic.PostModelSwitch` / `classic.UserPromptSubmit`) を hook する ([findings 2026-10-15-mods-reference-opportunities](../findings/2026-10-15-mods-reference-opportunities.md) の「ccmsg が今使っている Mods の機能」)

2 本の経路は読み込まれる条件が違う (module が読まれず command hook だけが走るセッションの集合は未検証、同 findings の B5「全廃の障害と前提」)。加えて、組織が管理する機械 (managed settings のある機械、Team / Enterprise の組織) では built-in の `sec-default` が user tier の `classic.*` hook を飛ばすと、rules リポの reference `claude-mods/overview` の `sec-default` 節と context-notify の DR-0003 (`claude plugin validate` の注記の文面) が記録している。そこでは ccmsg が classic で取っている `/clear` 後のサイドカーの起こし直し、`prompt.send` の受け付けの確認 ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §5)、effort、API error の分類、モデル切替の追従が働かない (同 findings の「食い違い 1」。ccmsg では未検証で、kawaz の各 config home が該当するかも未確認)。

Claude Code 2.1.299 の実機で、classic を使わずに同じことができる口を確かめた。

- classic.SessionStart の各 source に当たる mods の event と、`$.state` と module の生死 ([findings 2026-10-15-mods-event-matrix-startup-resume-clear-compact](../findings/2026-10-15-mods-event-matrix-startup-resume-clear-compact.md) の「classic.SessionStart の各 source と mods の event」「`$.state` と module の生死」)
- 最初の turn の前に model へ文脈を入れる口ごとの到達 (同 findings の「最初の turn の前の注入: 口ごとの到達」)
- `$.tool.register` で登録した tool が対話・`-p`・subagent の request に載り、model の呼び出しが `tool.call` の handler に届くこと (同 findings の「`$.tool.register` の可視範囲と typed call」の「結論」)
- `agentId` 付きの `$.session.append` が走行中の subagent の次の request にだけ載ること (同 findings の「`agentId` 付きの `$.session.append` で走行中の subagent に文脈を入れる」)
- 本 DR の前提 (`/clear`・`/resume`・`/model` の拾い方、busy 中の入力、`daemon start`、tool の登録の寿命と結果の形、API error の行、handler の待ち、自動 compact の後の案内) (同 findings の「DR-0039 の前提の probe」。結果は「前提の確認」の節)

kawaz 2026-10-15 の方針: エージェントに使わせる口は CLI でなく `$.tool.register` の typed tool にし、宛先は部分指定で解決して config dir 跨ぎは裏で行い、`ccmsg:` 接頭辞のような規約を利用者に課さない。say も typed tool にする。CLI はエージェントがメッセージを入れる口を持たない。classic hook は残さず全部 mods に寄せる。module の無いセッション向けのフォールバック経路は作らない。

## Decision

### 1. classic hook を全廃し、plugin の経路を hooks module 1 本にする

- hooks.json は `{ "modules": [...] }` だけにする。command hook の SessionStart (`hooks/session-start.ts`) と、module 内の `classic.*` の hook はすべて削る
- 今 classic で行っていることは、§2 の対応表の mods の event で行う
- 組織が管理する機械で飛ばされる user tier の hook (`classic.*` の他に `prompt.context` / `prompt.attachment` / `session.compact` 等、reference `claude-mods/overview` の `sec-default` 節の表) を、ccmsg の機能が成り立つための前提に使わない。`session.compact` だけは §5 の案内の足し直しに使い、飛ばされた時に失うものを Consequences に書く

### 2. classic の各口の置き換え

| 今の口 | 用途 | mods での拾い方 | 根拠 |
|---|---|---|---|
| command hook SessionStart `startup` / `resume` (`--resume` / `--continue`) | state file の書き出しと `daemon start` | `session.start` の after から `$.process.run` で `bin/ccmsg` を呼び、state file を書いて daemon を起こす。cwd は `$.session.cwd()`、repo の root と remote は `$.session.repo()`、ws / branch は今と同じく bump-semver を `$.process.run` で呼ぶ | `session.start` は startup・resume・continue のどれでも起きる (event-matrix 実測、対話と `-p`)。hot reload でも起きるので冪等にする (同実測)。最初の `session.start` は await されるので、起動を待たせない形にする。CLI と同じ形 (stdio ignore、`detached`) で子を起こすスクリプトに対し、`$.process.run` は 25〜26 ms で返り子は生き残った (probe 2/2)。実物の `ccmsg daemon start` の所要は実装時に確認する |
| 同 `clear`、module の `classic.SessionStart (clear)` | 新しい sid でサイドカーを起こし直し、事実を読み直し、turn を idle にし、新しい sid の state file を書く | `session.end` (`reason: 'clear'`) で旧 id の世代を進め、`command.run` を `{ command: 'clear' }` で hook して `await next(e)` の後に `$.session.id()` を読み直し、新しい sid の state file を `$.process.run` で書く | `command.run` の `next(e)` が resolve するのは新しい session の `classic.SessionStart (clear)` の dispatch の後 (event-matrix 実測 2/2)。その後で読んだ `$.session.id()` は新しい id だった (probe 2/2) |
| セッション内の `/resume` | 同上 | `command.run` を `{ command: 'resume' }` で hook し、after で `$.session.id()` を読み直して同じことをする。`session.end` (`reason: 'resume'`) で旧 id の世代を進める | `command.run (resume)` → `session.end (resume、旧 id)` → `classic.SessionStart (resume)` の後に after が resolve し、`$.session.id()` は再開した id。`session.start` は起きない (probe 2/2) |
| 同 `compact`、module の `classic.SessionStart (compact)` | state file の書き直しと model / window の読み直し | 事実の読み直しはしない (§5 の印を置く `session.compact` の hook だけを持つ) | session id は変わらない (event-matrix 実測)。compaction で変わるのは使用量だけで次の `session.measure` で取り直せる、というのは B5 の表の読みで、compaction の後の使用量の再取得は未観測 |
| `classic.Stop` の `effort.level` | 本体の turn の effort | `turn.step` を `async function*` と `yield* next(e)` で hook し、`e.agentId === undefined` の request の `e.effort` を取る (context-notify の `turn.step` の hook と同じ形、B17) | 実測 (mods-vs-transcript findings、context-notify DR-0003)。request の時点で分かるので今より早い。effort 非対応のモデルでは key が無い |
| `classic.PostModelSwitch` | 切替直後の model と window の読み直し | `command.run` を `{ command: 'model' }` で hook し、after で `$.session.model()` と `$.session.usage().context.window` を読み直す。request ごとの値は `turn.step` の `e.model` でも取れる | `/model` は picker (既定として保存・この session だけ) でも引数付きでも `command.run (model)` を通り、after は `classic.PostModelSwitch` の後に resolve した (probe 4/4、うち切替あり 2)。`config.set` (key `model`) は既定として保存する時しか起きないので使わない |
| `classic.UserPromptSubmit` | `prompt.send` の受け付け (DR-0035 §5 の成功の時点) | `prompt.submit` の hook で `origin.kind === 'composer'` と fill した文の一致を見て、`next(e)` が resolve し結果が `{ drop }` でない時点を受け付けとする。書きかけの復元は今も同じ event でしている | idle では `prompt.submit` が `classic.UserPromptSubmit` より先に起きる (event-matrix の event 列)。busy 中 (tool の実行中) の Enter でも `prompt.submit` は Enter の時点で起き、`next(e)` は 9〜15 ms で resolve した。queue された prompt は別の turn にならず、実行中の turn の次の request に入った (probe 2/2)。model が応答を stream している最中の Enter は実装時に確認する |
| `classic.StopFailure` の `error` / `last_assistant_message` | API error の分類と表示文 | daemon が transcript の API error の行 (`isApiErrorMessage`) から、表示文と分類を読む。module のあるセッションも同じ経路にし、module は API error を事実として送らない。分類は行の `error` 欄 (`authentication_failed` / `invalid_request` / `unknown` 等) を読む (分類は残す、kawaz 2026-10-15) | mods では表示文しか取れない。API error の行は `$.session.append` の door `response` (`origin: { kind: 'model', model: '<synthetic>' }`) で通り表示文を持つが、分類は `e` に無く、`turn.complete` は `reason: 'error'` だけを持つ。順序は `session.append (response)` → `classic.StopFailure` → `turn.complete` → `session.append (notice)` (probe、529 / 500 / 400 / 429)。daemon の今の transcript の読み (`classifyApiErrorRow`) が導くのも表示文だけで、表示文から分類を導く処理は無い (分類は今 `classic.StopFailure` からだけ来ている)。transcript の行は `error` 欄を持つ (実 transcript で確認) ので、分類を残すにはこの欄を読む。module の表示文と transcript の分類を突き合わせて 1 つの事実にすると経路が 2 本になるので、行 1 つから両方を読む。要る事実のために既にある経路を使うもので、§7 の言うフォールバックではない。行の `error` 欄の語彙が `classic.StopFailure` の分類と同じかと、retry が有効な時の行と event の並びは実装時に確認する |

- `turn.*` / `turn.step` は subagent の loop でも起きるので、本体の事実は `agentId` の無いものに絞る
- transcript path を返す `$` は無い。daemon が sid から解決する今の経路 (`resolvePendingTranscripts`) を使う (Consequences)

### 3. エージェントが使う ccmsg の口は typed tool にする

module が `session.start` で `$.tool.register` により tool を登録し、`tool.call` の handler で答える。登録した tool は対話・`-p`・subagent の request の `tools` に載り、handler では呼び手の session id (`$.session.id()`、subagent からの呼び出しでも本体の id)、cwd (`$.session.cwd()`)、subagent なら `e.agentId` が取れる (event-matrix の `$.tool.register` の「結論」)。

- **セッション間の送信**: 入力は `{ session_id?, cwd?, name?, pid?, text }` のような宛先の部分指定と本文。daemon が部分指定を生きているセッションに解決し、config dir が違うセッションにも peer 注入 ([DR-0034](./DR-0034-peer-socket-injection.md)) で届ける。config dir を跨ぐことを利用者に意識させず、宛先の綴りの規約 (`ccmsg:` 接頭辞) を持たない
  - daemon の op は `send_message` (宛先の候補は `peer_list`) で、module は `ccmsg sidecar send-message` / `peer-list` を transport にする。wire の op の名は本家の SendMessage / user prompt / user message と対照させ、composer を通る本物の prompt (`user_prompt`、DR-0035 §1) と文脈を足すだけの message (`user_message`、§6) の違いを名前で表す (kawaz 2026-10-18)
  - 面 (config dir) で絞らない。一覧 (`peers`) と送信 (`send`) は同じ解決元で、daemon が検出した config dir と hello で名乗られた config dir の全部のセッションを対象にする (kawaz 2026-10-18)
  - 部分指定が複数のセッションに当たったら、当たった全部に届ける (kawaz 2026-10-15)
  - 送り主自身は宛先から除く。送り主だけに当たった時は送らず、理由 (`self`) を返す
  - 結果は宛先ごとに「届いた / 届かなかった理由 / 届いたか確かめられなかった」(DR-0036 §1 の区別) を model が読める文で返す。複数に当たった時は一部が届かなくても内訳を返す。SendMessage の結果は 1 値で内訳を返せなかったが、tool の結果にはその制約が無い。送り直しで二重に届くのを避けるため、届いた宛先と届かなかった宛先を区別して示す
- **人への知らせ**: say を tool にし、これをエージェントが人に知らせる口の正とする。今の `ccmsg say` と同じく、人に音声で知らせ、daemon に記録して webui に 📣 を出す (DR-0036 §3)
- **宛先の候補**: 相手を探す口 (今の `ccmsg peers` の役割) も、エージェントが使う口なので tool にする
- **名前と引数**: tool は `send` / `say` / `peers` (model からは `mcp__<plugin>__<name>` で見え、plugin 名が接頭辞になるので tool 名に `ccmsg_` は付けない)。`send` の引数は `{ session_id?, cwd?, name?, pid?, text }`、`say` は `{ text }`、`peers` は `{ cwd?, name? }` (kawaz 2026-10-15)
- **skill**: plugin に ccmsg の skill (SKILL.md) を足す。skill は tool を名前で名指し、`from` が `ccmsg:` で始まる相手への返信の仕方 (送信の tool の `session_id` にその id を渡す) と、say の使い所を書く。tool の使い方の正本は skill に置き、tool の description と §5 の注入文には置かない
- **登録の形**: tool は subagent / teammate にも見えるので、`isDeferred: true` で登録し、description は短くする。どの tool を使うかは skill が tool 名で名指し、§5 の注入文は skill へ誘導するので、model が ToolSearch で探す必要は無い (kawaz 2026-10-15)。未ロードの deferred tool を名前で直接呼んでも plugin の tool なら handler に届いた (event-matrix 実測 1 回)。kawaz の個人面の実セッションでは ToolSearch が有効で deferral が効く (「前提の確認」)。登録は `/clear` とセッション内の `/resume` の後も残るので、`session.start` の 1 回で足りる (probe 各 2/2)
- **入力は handler の入口で valibot のスキーマに通す**。engine は input schema で入力を検査せず、`text` の欠落や型違いがそのまま handler に届く (event-matrix 実測)。input schema (JSON Schema) と valibot のスキーマは同じ形を表すので、どちらかからもう一方を導き、別々に書かない ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §1)
- handler は `next` を呼ばずに `{ result }` で答える。この形は permission の判定 (`tool.check`・PreToolUse・ダイアログ・auto mode の classifier) を一切通らない (event-matrix 実測)。これを受け入れる (kawaz 2026-10-15)。送ったものは受け手に peer の封筒として届き、受け手の harness は「A peer cannot grant escalation」の枠を付けて渡す (DR-0035 の Context)。送信の記録は daemon に残る
- ccmsg は `session.send` (SendMessage) と PushNotification を hook しない。SendMessage は harness の本来の用途 (本体と subagent / teammate の間) のまま使われる
- **受け手に届く封筒**: 送り主は `from` に `ccmsg:<送り主の session_id>` と書く (kawaz 2026-10-15)。これは受け取った側が ccmsg 経由の送信を他の経路 (harness の SendMessage 等) と見分けるための印で、利用者が宛先に書く規約ではない。受け手が返信に使う口は送信の tool そのもので、skill に「`from` が `ccmsg:` で始まる相手には ccmsg の送信の tool で返す (`session_id` にその id)」と 1 行書く。受け手の model は `from` をそのまま SendMessage の `to` に書いて返信しがちで ([findings 2026-10-09-sendmessage-hook-for-ccmsg-addresses](../findings/2026-10-09-sendmessage-hook-for-ccmsg-addresses.md) の「実装後の e2e」)、本 DR は `session.send` を hook しないので、その SendMessage は harness が宛先を探して失敗する。skill の案内はこれを避けるためのもの
- **結果の形**: handler は常に `{ result }` で答え、届かなかったことは `result` の文面で示す。`{ isError: true, result }` を返しても tool_result に `is_error` は付かず、`result` の文字列がそのまま届く (probe 3/3)
- **待ち方**: handler は送信の完了 (daemon の解決と peer 注入) を `$.process.run` で待ち、`timeoutMs` を明示して超えたら「届いたか確かめられなかった」で返す。`$.process.run` の待ちは hook の予算 (10 秒) に数えられない (15 秒・40 秒とも待ち切った) が、`$.clock.sleep` 等の待ちは数えられ、10 秒を超えると hook が飛ばされて core に落ち、許可ダイアログが出て `no tool.call hook answered` のエラーになる (probe)。handler の中で時計の待ちを使わない。待ちの間に人が Esc を押すと `$.process.run` は `aborted` で reject して子を kill し、turn は `aborted` で終わる (probe 2/2)。その送信が届いたかは model に返らず、daemon の送信の記録が正になる
- `-p` / SDK のセッションと codex は、kawaz 2026-10-09 の判断 (`-p` で別セッションとやりとりするユースケースはほとんど無い) に従い対象外にする。tool を登録しないか、登録して理由を返すかは実装時に決める

### 4. CLI は人の口と module の transport の 2 面に縮める

- **人の口**: `daemon` / `status` / `stop` / `origins` 等、人が端末で使うもの
- **module の transport**: module が `$.process.run` で起こすもの。`sidecar` 系 (`sidecar` / `sidecar reply` / `sidecar facts`) と、say の tool の handler が起こす `say`
- `ccmsg sidecar send` は、SendMessage の `to` 1 つを受ける形 (op `address_send`) から、§3 の宛先の部分指定と本文を受け、宛先ごとの結果を返す新しい op (`send_message`、transport は `ccmsg sidecar send-message`) に置き換える。宛先の候補の tool も `sidecar` 系を transport にする
- エージェントがメッセージを入れる口を CLI から削る: `ccmsg post` / `ccmsg reply` (op `message_send`)、`ccmsg peers` の `addresses` (宛先の綴り)
- `subscribe` / `notify` は本 DR では残す
- サブコマンドごとの最終の振り分けは実装時に行い、判断の軸は「エージェントが呼ぶ口か」とする
- webui からの人の入力 (op `user_prompt`、user role、DR-0035 §1) は人の口なので変えない

### 5. 最初の turn の前に、エージェント向けの案内を会話に入れる

- `prompt.submit` の before で、`$.state` に「この session で案内を入れた」印が無ければ `$.session.append` (`type: 'user'`) で案内を足して印を置く (event-matrix の推奨 E)。`session.compact` の after で `$.state` に「compact 済み」を置き、次の `prompt.submit` の before で足し直す (同 I)
- E は対話と `-p`、startup / resume / continue / `/clear` で次の request に載った (同 findings の実測)。`/clear` と resume では `$.state` が空になるので、何もしなくても足し直される。hot reload では `$.state` が残るので二重にならない
- I は手動 compact (1 回) と自動 compact (probe 2/2) の後に足し直された。自動 compact はその turn の `turn.start` の後に起きるので、compaction 直後の request には案内が無く、次の turn の request から載る (1 turn 遅れる)
- `$.state` の印は `prompt.submit` 以降に読む。`/clear` の直後の hook の入口では前の session の値が見えることがある (同 findings の「`$.state` と module の生死」)
- `$.state` の key は plugin の `types/index.d.ts` の `PluginState` に宣言する (無いと `claude plugin validate` が落ちて module が読み込まれない、同 findings の「実験の作り方」)
- `-p` (`session.start` の `isInteractive: false`) のセッションには案内を入れない。§3 で `-p` を送受信の対象外にしているため (E 自体は `-p` でも届く、event-matrix 実測)
- 注入する案内は skill (§3) への誘導に留め、tool の使い方そのものは書かない。文面は実装時に決める。DR-0035 §4 のとおり、サイドカーの socket path と依頼の形式は案内にも skill にも書かない

### 6. webui から走行中の subagent へ文脈を直送する

- webui から走行中の subagent に書いた文は、op `user_message` (user role) で daemon に届き、daemon がサイドカー経由で module に渡し、module が `$.session.append({ message: { type: 'user', ... }, agentId })` で足す。子の次の request で、直前の tool_result と同じ user message の後ろの text block として載り、本体の request には載らない (event-matrix の agentId 付き append の実測 5/5)。観測は background の `Agent` の子が tool を実行している間に、timer を契機に足した場合だけで、foreground の `Agent`、stream の途中、`-p` の子・teammate・workflow の agent、peer socket やサイドカーの依頼を契機にした append は未観測
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
- 同じ config home のセッション同士でも、セッション間の送信は送信の tool で行い、harness の SendMessage の名前での直接送信は案内しない (kawaz 2026-10-13 の裁定)
- §7 のフォールバック経路を作らない。経路が 2 本あると、どちらで届いたか・どちらが壊れているかの切り分けが常に要り、no_module という状態の意味もぼやける
- §6 の `agentId` 付き append を、permission の許可や classifier の判断材料の代わりに使わない

## 前提の確認

Proposed の時点で前提として挙げた項目を、findings 2026-10-15-mods-event-matrix-startup-resume-clear-compact の「DR-0039 の前提の probe」(代役の API と隔離 config home、2.1.299) と実セッションの debug log で確かめた。

| 確かめたこと | 結果 | 本 DR への帰結 |
|---|---|---|
| `command.run (clear)` の after で `$.session.id()` が新しい id | 成り立つ (2/2) | §2 の clear の行 |
| セッション内の `/resume` で新しい id が読める | 成り立つ。`command.run (resume)` の after、`session.start` は起きない (2/2) | §2 の `/resume` の行 |
| busy 中の Enter で `prompt.submit` が Enter の時点で起きる | 成り立つ (tool の実行中、2/2)。queue された prompt は同じ turn の次の request に入る | §2 の受け付けの行 |
| `$.process.run` で detached の子を起こして待たずに返る | 成り立つ (代役のスクリプト、2/2) | §2 の startup の行 |
| `/clear` と `/resume` の後に tool の登録が残る | 成り立つ (各 2/2) | §3 の登録の形。登録し直さない |
| `/model` が `command.run (model)` を通る | 成り立つ (4/4)。after は `classic.PostModelSwitch` の後 | §2 のモデル切替の行 |
| `{ isError: true }` が model に error として届く | 成り立たない (3/3) | §3 の結果の形。文面で示す |
| API error の行が `session.append` を通り、分類と表示文が読める | 表示文は読める (door `response`)、分類は読めない | §2 の API error の行。transcript の行から読む |
| handler が待てる上限 | `$.process.run` の待ちは予算に数えられない。時計の待ちは 10 秒で飛ばされる。Esc で `aborted` | §3 の待ち方 |
| 自動 compact の後に案内が足し直される | 成り立つが 1 turn 遅れる (2/2) | §5 |
| kawaz の個人面の実セッションで `isDeferred` が効く | 効く。debug log の `[ToolSearch:optimistic]` は `mode=tst-auto, result=true` が約 177 万行で、`disabled` は 826 行 (統括が確認) | §3 の登録の形 |

実装時に確認したこと (代役の API と隔離 config home、どれも本 DR の判断を変えなかった):

- model が応答を stream している最中 (request の応答待ち) の busy の Enter: `prompt.submit` は Enter の時点で起きて受け付けになった (webui の入力で 163 ms)。queue された prompt は実行中の turn の次の request ではなく、その turn の終わった後の別の turn (`promptSource: "queued"`) に入った。tool の実行中の Enter (「前提の確認」) とは入る turn が違う
- 実物の daemon の起動: `ccmsg sidecar begin` (state file の書き込みと daemon の起動) の所要は daemon が無い時 0.38 s、いる時 0.28 s。module は待たずに走らせるので、最初の `session.start` は待たされない
- retry が有効な時の API error: 途中の試行では transcript に行を書かず、retry が尽きた時に最後の error の行を 1 本だけ書いた。retry が成功した時は error の行を書かなかった
- transcript の API error の行の `error` 欄の語彙: 実 transcript で `server_error` / `invalid_request` / `rate_limit` / `unknown` / `authentication_failed` / `model_not_found` / `billing_error` と欄の無い行で、どれも `classic.StopFailure` の分類 (engine の型定義の 13 語) に含まれた。`kind` は open な文字列のまま読む

未観測:

- teammate のループへの `agentId` 付きの `$.session.append` (§6 の一覧には teammate も入れている)
- §6 の直送の、foreground の `Agent` の子・応答の stream の途中・`-p` の子への到達
- `prompt.submit` の `text` の末尾空白の扱い (受け付けの照合は `classic.UserPromptSubmit` で測った許容を流用している)

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| classic を併用する (command hook の SessionStart と module の `classic.*` を残す) | 読み込みの条件が違う 2 本の経路を持ち続けることになる。組織が管理する機械では user tier の `classic.*` が飛ばされる (Context) |
| エージェント向けの口を CLI のまま残す (`ccmsg post` / `reply` / `peers` / `say`) | 本文の切れ目のぶれ、長い本文の truncate の回避、1 アクションが残り、引数に型が無い (Context)。typed tool なら入力の形を schema で示せ、本文は tool の入力として全文が渡る |
| SendMessage の横取りを続ける | `ccmsg:` の綴りの規約を利用者に課す。model が読む結果の文面は harness が決めて ccmsg の結果を正確に表せず、hook の throw が harness の宛先探しに落ちる ([findings 2026-10-09-sendmessage-hook-for-ccmsg-addresses](../findings/2026-10-09-sendmessage-hook-for-ccmsg-addresses.md))。harness の本来の宛先 (本体と subagent) と同じ tool に ccmsg の宛先が混ざる |
| 宛先の解決を送り主と同じ面 (config dir) のセッションに絞る | 面を跨いで届けることが本来の用途で、到達範囲は SendMessage の横取りの時と同じ (同じ config dir の集合を読む)。絞ると面を跨ぐ相手に送る口が無くなる |
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

- 置き換わる判断: SendMessage の横取りによるセッション間の送信は、§3 の送信の tool に置き換わる。[DR-0035](./DR-0035-user-input-via-composer-fill.md) の §3 (事実を取る classic の event、「daemon はセッションの起動 (SessionStart) で立つ」) と §5 (成功の時点を `classic.UserPromptSubmit` とする定め) は §2 の対応表に置き換わる。[DR-0036](./DR-0036-retire-rooms-for-p2p.md) §1 の CLI の直送と、v2 の契約に揃えた返信行 (`Reply with: ccmsg reply <mid> --to <sid> <text>`) は §3 の送信の tool に置き換わり、返信行の形の v2 との整合は崩れる (封筒の `from` の `ccmsg:<sid>` は残り、返信は skill の案内で送信の tool に導く、§3)。DR-0036 §3 の「人へ知らせるのは PushNotification で足りる」は say の tool に置き換わる。[DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6 の送信の認識 (`ccmsg-direct-transcript.ts` が agent の `ccmsg post` / `reply` の Bash 呼び出しを認識する部分) には、送信と say の tool の tool_use の形を足す
- 移行の順序: 「tool と新しい op を足す → 旧 op (`message_send` / `address_send`) を deprecate する → 次のリリースで旧 op を削る」。動いているセッションには前の版の module が残りうる (DR-0035 §3) ので、daemon が旧 op を先に削ると、旧 module の SendMessage の横取りがその場で壊れる。旧 module のセッションは再起動 (か `/reload-plugins`) で新しい module になる
- 組織が管理する機械では次のものが効かない (reference `claude-mods/overview` の `sec-default` 節の記述で、ccmsg では未検証): `session.compact` の hook が飛ばされるので compact の後の案内の足し直し (§5) が起きない。managed の `allowedMcpServers` がある間は user tier の `$.tool.register` が拒まれるので、§3 の tool が登録されず、そのセッションは送信と say を持たない (§7 により別経路は無い)
- transcript path の出所が無くなる: 今は SessionStart の command hook が stdin の `transcript_path` を state file に書き、CLI の hello で daemon に届く。module には transcript path を返す `$` が無いので、module のあるセッションも daemon の `resolvePendingTranscripts` (未入力のセッションについて poll ごとに config dir を走査する) で探すことになり、走査の対象が全セッションに広がる。走査のコストは測っていない
- §5 の案内は resume のたびに 1 つずつ会話に積み重なる (event-matrix 実測)。compaction で summary に置き換わるので、積み重なるのは compact までの間に限られる (`preservedSegment` の付く compaction で末尾の行が残った例は 1 回ある、同実測)。`$.session.messages()` で既に入っているかを見てから足す手はある (未検証)
- tool 1 つの entry は約 0.5 KB (event-matrix の「context のコスト」で、説明 54 字・property 5 つの entry が 487 byte)。deferred が効く間は、読み込まれるまで一覧の名前 1 行だけになる。hot reload で説明を変えても本体の request は session 開始時の説明のまま (同実測)
- daemon が立つ契機は module の `session.start` と人の CLI になる。module の無いセッションは daemon を起こさない
- state file は、CLI が session として hello する時に repo / ws / transcript_path 等の名乗りのために読む。エージェント向けの CLI が無くなった後もこの名乗りを state file 経由で渡すか、サイドカーの名乗りやセッションの事実に載せ替えるかを実装時に決める
- protocol から消えるもの: `hook-input.ts` (SessionStart の stdin)、`ccmsg-address.ts` の宛先の文法のうち `ccmsg:<sid>.<pid>` と `ccmsg:path:<dir>` (`ccmsg:<sid>` は封筒の `from` の綴りとして残る)、op `message_send` / `address_send` (移行の順序のとおり次のリリースで)。足すもの: tool の入力のスキーマ、部分指定の宛先と本文を受ける送信の op、webui から subagent への直送の依頼 (サイドカーの op)、セッションの事実の subagent の節 (走行中の `agentId` の一覧、§6)
- 案内の追従: CLI の help (「人に知らせるには PushNotification を使う」「SendMessage で `peers` の address に送る」)、rules 側でエージェントに PushNotification を案内している記述を、say の tool と送信の tool に合わせる。PushNotification の 📣 表示 (DR-0027 §6.3、transcript の tool_use の読み取り) は残すが、エージェントには案内しない
- 外部の案内: rules リポで `ccmsg` の CLI をエージェントに案内している記述は、plugin の skill と §5 の案内に合わせて追従させる。正本は plugin 側 (skill と §5) に置き、issue `2026-10-13-agent-guidance-for-ccmsg-addresses` の候補 (a) skill と (b) 起動時の案内 (classic でなく §5 の形) を取り、(c) rules 側は正本にしない。v1 の plugin は今 skill を持たないので、§3 の skill が初めての skill になる。v2 の plugin の `ccmsg:ccmsg` skill は v2 の口の案内で、本 DR では触らない
- `turn.step` を hook する (§2) ことで、DR-0035 §3 の「`turn.step` を hook すると応答の断片がすべて module を通るので使わない」は撤回になる。断片が module を通るコストは測っていない (B17。context-notify は同じ形で本番で使っている)
- module は API error を事実として送らなくなり、daemon は module のあるセッションも transcript の API error の行を tail する (§2)。今は module のあるセッションを tail から外している (`session-errors.ts`) ので、tail の対象が全セッションに戻る
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
- [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6 — TL の送信・PushNotification の表示
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — tool の入力をスキーマで読む
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入 (受け手への配送はこのまま)
- kawaz/claude-context-notify の DR-0003 — classic を使わない hooks module の参照実装 (`turn.step` の hook、`$.tool.register`、`$.session.append`)
