# DR-0045: hooks module はセッションの会話の行を daemon に流すだけにし、daemon が行を正本として webui への中継・say の副作用・既読を持つ

- Status: Accepted (2026-10-28、kawaz 裁定。launch は 2026-10-29 の裁定で §6 を改める) — ✅ 実装済み (§9 の段階 1〜3)
  - 段階 1: module の push (`hooks/transcript-push.ts`)、op `transcript_push`、daemon の relay (`transcript-relay.ts`)、`transcript_subscribe` の付け替え。実機の観測は [findings](../findings/2026-10-28-transcript-push-live-verify.md)
  - 段階 2: §3 の追いつきと uuid の重複除去、§5 の fold・API error・最後のユーザ入力の付け替え、`transcript.ts` の Watch の削除。実機の観測は [findings](../findings/2026-10-28-dr-0045-stage2-verify.md)
  - 段階 3: §6 の say の発声と permit の音声 (`say-speech.ts`、`row-effects.ts`)、launch の `POST /op` (`launch_tool`)、§7 の未読と既読 (`say-unread.ts`、`say-read.json`、`ev:"say_unread"`、webui の 🔔)、§8 の削除。実機の観測は [findings](../findings/2026-10-28-dr-0045-stage3-verify.md)
- Date: 2026-10-28

## Context

daemon は、セッションの transcript の jsonl を自分で読んで追っている (`transcript.ts` の Watch。fs.watch と poll で追記を検知し、行を listener に配る)。その tail の利用者は次の 4 つ:

- webui の Timeline の live 更新 (`transcript_subscribe` → `ev:"transcript"`、継ぎ目は byte offset)
- Status タブの fold (`session_status_subscribe`、[DR-0020](./DR-0020-session-status-tab.md) §3.1)
- サイドバーの API error の監視 (`session-errors.ts`)
- 最後のユーザ入力の時刻の監視 (`session-user-input.ts`)

エージェントの tool の副作用は、module の handler が CLI を起こして行っている。
- `say`: `ccmsg say` が daemon に記録を送って `/usr/bin/say` を起こす。daemon は記録をメモリに持って webui に配り、webui は時刻で TL に差し込む
- `launch`: `ccmsg sidecar launch` が daemon に起動させ、その返事を tool の結果にする

module は会話の行の追加を `session.append` (`{ message, door, origin, uuid, agentId? }`) で見られる。module → daemon の口は、daemon の Unix socket 上の HTTP の 1 endpoint (`POST /op`、DR-0046) になる。

kawaz 2026-10-28 の裁定:
- module はセッションの会話の行を、何も考えずに daemon へ流す
- daemon はその行を正本として持ち、webui へ中継し、行をパターンマッチして副作用 (say の発声、launch の起動) を自分で実行し、既読も持つ
- transcript の tail は廃止する。ライブは push で受け、閉じたセッションの履歴だけをファイルから読む
- module の役目は engine のイベント処理に限る

## Decision

### 1. 境界

| 持ち手 | 持つもの |
|---|---|
| hooks module | engine のイベント処理だけ。tool への応答 (`tool.call`)、`turn.step` (request の上書き、[DR-0041](./DR-0041-request-model-effort-override.md))、`turn.abort` ([DR-0044](./DR-0044-turn-abort.md))、`permit` のダイアログ ([DR-0040](./DR-0040-permit-request-tool.md))、prompt の差し込み ([DR-0035](./DR-0035-user-input-via-composer-fill.md))、セッションの事実 (`session_facts`)。会話の行は解釈せずに daemon へ流す (§2) |
| daemon | ライブのセッションの会話の行の正本 (§3)。webui への中継 (§4)。行から導く状態 (Status の fold、API error、最後のユーザ入力、say の未読) (§5、§7)。行をきっかけにした副作用 (say の発声) と、`permit_request` を受けた時の音声 (§6) |
| webui | daemon から届く行と、`transcript_read` で読む履歴の描画。🔔 は say の tool_use の行から描く (§7) |

- module の無いセッションは、ライブの更新も副作用も持たない。daemon が tail で拾い直す経路は作らない ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §7 の no_module)。履歴は `transcript_read` でファイルから読める

### 2. 口: 行の push

- module は `session.append` の hook で、受けた `e` から `message` / `uuid` / `agentId` / `door` / `origin` をそのまま daemon に送る。中身は読まない (say や launch の tool_use かを module は判断しない)
- content が空の行は送らない。jsonl に行が書かれないため (送ると daemon が書かれない行を待つ)。content が空でも書かれる行 (`hook_non_blocking_error`) は、後に続く行の読みで jsonl から来る
- 経路は DR-0046 の `POST /op` に op を 1 つ足す (名前と body は mod-http-op と合わせて決める。仮に `transcript_push { rows: [...] }`)。session role で、行は名乗った session の会話として受ける
- 送る順は発生の順。module は送りを 1 本の直列に並べ、前の送りの返事を待ってから次を送る (行の順を daemon 側で並べ直さない)。返事を待つ間に溜まった行は 1 回の要求にまとめる
- 送りが届かない (`no_daemon` / `outdated` / `unanswered`) 時は、その行を捨てて debug log に 1 行書く。module は再送しない。抜けた行は、daemon が次の初期登録の追いつき (§3) で拾う
- subagent / teammate の行 (`agentId` 付き) も送る。daemon は `agentId` で main の行と分けて扱う

**観測 (段階 0、[findings](../findings/2026-10-28-session-append-vs-jsonl.md)、Claude Code 2.1.312、`claude -p`)**:
- uuid を持つ jsonl の行は、全種が append で来る。user、assistant、attachment の各種、`system` の compact_boundary、subagent の行 (`agentId` 付き) のすべて
- uuid を持たない行は来ない。`queue-operation`、`api-request*`、`atis-latch`、`tools-used`、`last-prompt`、`cost-state`、`mode`
- jsonl に行の無い append がある:
  - `door: "queue"` の user
  - content が空の `hook_success` の attachment (`door: "hook-context"`)。何も言わずに終わった hook が走るたびに 1 件 ([findings](../findings/2026-10-28-session-append-vs-jsonl.md) の §6)
  - compaction の後には、残した行が同じ uuid でもう一度来る
- `e.message` は jsonl の行ではない。API の message の形 (`{ type, role?, name?, content }`) で、次が含まれない:
  - timestamp
  - `parentUuid` / `isMeta` / `promptSource` / `origin`
  - assistant の `usage` / `model`
  - tool_result の `toolUseResult`
  - attachment の構造 (`e` は描画された文だけ)
- assistant と tool_result の `content` は jsonl と同じ
- append の順は、jsonl の行の順と同じ (main と各 subagent のそれぞれで)
- append の時点 (`next(e)` の後も) では jsonl にまだ行が無い。書き込みは 20〜200 ms 後

**決め方** (kawaz 2026-10-28): 用途ごとに源を分ける。会話の行の正本は、セッションの transcript の jsonl。(a)〜(c) は次のとおり:
- (a) daemon が `e.message` を行の形に直す: attachment の構造・usage・timestamp が `e` に無いので、直せない
- (b) push の `e.message` を正本にする: 副作用 (§6) はこれで足りる。必要なのは tool_use の `id` / `name` / `input` で、jsonl と同じものが来る
- (c) push を合図に jsonl の続きを読む: 中継 (§4) と fold (§5) は jsonl の行が要るので、これを採る

副作用を (b)、中継と fold と say の未読 (§7) を (c) にする。用途ごとに要るものが違い、互いに独立している。未読は追いつきの読みでも作るので、push と追いつきを 1 つの経路で扱える (c) の fold にし、say の時刻は行の timestamp から取る。(c) の読み方:
- daemon はセッションごとに jsonl の読み終わりの位置を持つ。push が来たら、そこから続きを読む
- 行は append より後に書かれる (実測で 20〜200 ms 後)。そこで、push で受けた uuid の行が jsonl に現れるまで、そのファイルだけを短い間隔で読み直す。上限 (例 5 秒) を過ぎたら 1 回最終読みをして諦める。待ちは push ごとの局所的な再試行で、待つ uuid が無ければ何も読まない。常時の Watch も FSEvents も使わない
- 読んだ行を uuid で重ねて §4・§5 に流す。`door: "queue"` の append と、uuid の重なる二度目の append は読みの対象にしない
- 上限で諦めた行は、次の push の読みで拾われる (読み終わりの位置から続きを読むので)

対話のセッションでも、同じ結果だった (findings の §5)。composer の prompt、stream の最中に打った prompt、peer のメッセージ (stream の最中と idle の時) を見た。tool の実行中に打った prompt が `queued_command` の attachment になる場面は未観測

### 3. 正本と追いつき

- daemon は、module の初期登録 (サイドカーの `sidecar_hello` で run が名乗った時) に、そのセッションの jsonl を頭から 1 回読んで追いつく。以後はそのセッションの行の正本を push とする
- 重複は行の `uuid` で除く。追いつきの読みと push は重なりうる (読み始めた後に書かれた行が両方から来る)。compaction の後には同じ uuid の append がもう一度来る (§2)。uuid を持たない行は push で来ない。中継と fold が要る分 (今の fold は `queue-operation` 等を読まない) は、§2 の (c) の読みで jsonl から得る
- daemon は会話の全文をメモリに持たない。push の `e.message` は §6・§7 に通し、§2 の (c) で読んだ jsonl の行は §5 の fold に通して §4 の中継に流す。持つのは各 fold の状態と、重複を除くための uuid の集合 (ライブのセッションの分) だけ
- 閉じたセッション (module の run が去った) の uuid の集合と fold は捨てる。履歴は `transcript_read` がファイルから読む
- 実装 (`transcript-relay.ts`):
  - live: module の run が名乗っているセッション (`sidecar_hello` で名乗り、その接続が閉じるか harness が去るまで)。live になった時に一度だけ追いつく。同じ run の名乗り直しでは追いつき直さない (読み終わりの位置から続きを読むので、行は抜けない)
  - 追いつき: ファイルの頭からその時の末尾まで、chunk ごとに event loop を明け渡して読み ([DR-0029](./DR-0029-async-io-principle.md))、fold だけに流す。追いつきの間に来た push は待つ uuid に積むだけで、続きの読みは追いつきの後
  - 重複除去: relay はファイルから読んだ行の uuid の集合を持つ。push の uuid のうち読み済みのものは待たない。ファイルの側は byte offset で続きを読むので、同じ行を二度読まない
  - fold は追いつきの間、別に作った状態に畳み、追いつきが終わった時に差し替える (読みかけの途中を見せない)
  - transcript を名乗る前 (最初の prompt の前) に live になったセッションは、ファイル無しで fold を始め、最初の push でそのファイルの頭から追いつき直す
  - ファイルが縮んだ・別のファイルになった時と、hello が別の transcript を名乗った時は、タブには空の event で新しい size を伝え、fold はそのファイルの頭から追いつき直す。hello の cwd / repo_root が変わった時も、fold を追いつき直す (DR-0024 の外部ファイルの判定の根が変わるため)

### 4. webui への中継

- `transcript_subscribe` の源を、tail の Watch から §2 の (c) の読み (push を合図にした jsonl の続きの読み) に置き換える。daemon はその読みの行を、そのセッションの Timeline を購読しているタブへ送る。push の `e.message` は中継しない
- `ev:"transcript"` の形 (`{ ev, sid, lines, start, end, size }`、行は jsonl の 1 行の文字列) と webui は変えない。継ぎ目は byte offset のまま (統括 2026-10-28)
  - 読みの源がファイルなので、送る行の byte 範囲は正確に分かる
  - `transcript_read` (DR-0009 §3) の `after` / `before` も byte offset なので、webui の継ぎ目の判定 (`end` が続かなければ `after` で読み足す) がそのまま使える
  - uuid の継ぎ目にすると、uuid の無い行 (`queue-operation` 等) が挟まった時に継ぎ目を誤判定しうる

### 5. tail の廃止と利用者の付け替え

- `transcript.ts` の Watch (fs.watch と poll、`subscribeTranscriptLines`) を削る。行の源は §3 の「追いつきの 1 回の読み + push を合図にした読み (§2 の (c))」になる
- tail・fs.watch・ポーリングの口は残さない (kawaz 2026-10-28)。残すと、module の無いセッションへの暗黙のフォールバックになる。module の無いセッションの行は `transcript_read` で読めるだけ
- 付け替え:
  - Status の fold (`session-status.ts`): live のセッションの fold は §3 の追いつきで作り、以後は push の行を `foldLine` に通す。購読の有無にかかわらず保ち、購読は push の宛先を決めるだけ。live でないセッションの `session_status` と、最初の追いつきが終わる前の `session_status` は、ファイルの 1 回の走査で答える。live でないセッションの購読には push が無い (live になって追いつくと push する)
  - API error (`session-errors.ts`) と最後のユーザ入力 (`session-user-input.ts`): live の全セッションの行を、それぞれの候補の検査と fold に通す。webui のタブの有無では gate しない。live でないセッションは値を持たない (サイドバーのエラーの節に出ず、並びの時刻も無い)
  - say の未読 (§7) も同じ push の行から作る

### 6. 副作用

daemon は push で受けた `e.message` だけで副作用を起こす (§2 の (b))。追いつきの読みの行では起こさない (古い行で発声をやり直さない): relay がファイルから読み済みの uuid の行は副作用の対象にしない (compaction で同じ uuid のまま来る二度目の append も、これで除く)。同じ tool_use の id の副作用は 1 度だけ (live のセッションごとに id の集合をメモリに持ち、行が書かれる前の二重の push を除く)。

**say** (`mcp__ccmsg-v1__say` の tool_use、input `{ text }`):

- daemon が読み上げ辞書を当てて、`[<say>, "--", <置き換えた本文>]` を起こす
  - `<say>` は daemon の環境の `CCMSG_SAY_BIN` か `/usr/bin/say`
  - `--` は、`-` で始まる本文を say のオプションとして読ませないため (実測: `say -o <file> "-v テスト"` は本文を読まずに exit 0、`--` を付けると発声する)
- 発声は daemon の中で直列にする。同時に複数の say が来ても声が重ならない。1 回の発声は 120 秒で打ち切って次へ進む (終わらない発声のバイナリが後の発声を止めない)
- 辞書の規則 (archive の DR-0042 から引き取る):
  - 一致:
    - 大文字小文字を無視する
    - 語の両側を `(?<![A-Za-z0-9])word(?![A-Za-z0-9])` で区切る。下線・空白・記号・日本語・文字列の端は区切りになる
    - 同じ位置に複数の語が当たる時は長い方
    - 語の中の正規表現の記号は文字どおりに扱う
    - 辞書に無い語はそのまま
  - ファイル: `<config dir>/say-dictionary.tsv`。1 行に `word<TAB>読み`、`#` で始まる行はコメント、空白だけの行は無視。規則に合わない行はその行だけ飛ばす。同じ語は後の行が勝つ。行の形はスキーマで読む ([DR-0038](./DR-0038-json-is-parsed-by-schema.md))
  - 同梱の辞書の後にファイルの行を重ねる (同じ語はファイルが勝つ)。初期値は `1Password` / `daemon` / `sidecar` / `plugin` / `OTP` / `URL` / `API` / `CI` / `PR` / `jj` / `Kyell` の読み
  - 置き場: 同梱の辞書 (TS の定数 `BUILTIN_SAY_DICTIONARY`。daemon は bundle されるので、隣のファイルを読む形にしない)・行の読み・重ね合わせ・置き換えは protocol の純関数 (`packages/protocol/src/say-dictionary.ts`)。daemon は発声のたびにファイルを読む (編集は次の発声から効く)。飛ばした行と読めないファイルは daemon.log に 1 行ずつ書く
  - TL の 🔔 は、書かれた原文のまま描く
- tool の結果は module が即座に返す: 「読み上げを依頼した (daemon が読み上げる)」。発声の成否は module には返らない
- subagent / teammate の say も発声する

**launch** (`mcp__ccmsg-v1__launch`): 行からは起こさない。module が daemon の `POST /op` の `launch_tool` を 1 往復で呼び、daemon は起動コマンドを上限付きで待って、間に合えば結果を同期で返し、間に合わなければ「起動中」を返して結果を notify で会話に戻す (kawaz 2026-10-29、[DR-0018](./DR-0018-session-launcher.md) §3.7)。行から起こす形は、tool の結果に `session_id` が入らず、同じ turn の中で起動先へ続けて送れないので採らない

**permit の音声**:
- daemon が `permit_request` を記録した時に、上の say と同じ発声の関数で鳴らす。文は固定文「許可を求めています」か、依頼が持つ読み上げ用の文 (DR-0040 で足す `voice`)
- CLI (`ccmsg sidecar permit`) は発声しない
- テストの daemon は鳴らさない: テストの preload が `CCMSG_SAY_BIN` を無音のバイナリにする (テストが自分のバイナリを渡す時を除く)

### 7. say の表示と既読

- TL は main thread の assistant 行の tool_use `{name:"mcp__ccmsg-v1__say", input:{text}}` を、PushNotification と同じ境界行の 🔔 バブルとして描く。時刻と位置はその行のもの。照合は `packages/protocol/src/ccmsg-direct-transcript.ts` に置く
- バブルの見た目と既読ボタンの規則は [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6.3 のまま (未読が複数ある時の最新の未読のボタンだけ「N 件すべて既読」、押した時に TL に出ている未読だけを既読にする)
- 既読のキーは tool_use の id。未読は、ライブのセッションの main thread の say の tool_use (§3 の追いつきと push で見たもの) から既読の集合を引いたもの
- daemon は user role の購読者に未読を `ev:"say_unread"` `{ says: [{ session_id, tool_use_id, ts }] }` で送る。購読の時に全件 (空でも)、変わるたびに全件送る。session には送らない
- op `say_read { ids }` (user role だけ) は tool_use の id で既読にする。未読でない id が混ざれば、どれも既読にせずに `invalid_args` で断る。全部が既読済みなら成功を返して何も変えない
- Sessions 一覧の 🔔 と件数は、未読をセッションごとに数えたもの
- daemon の終了の途中では `ev:"say_unread"` を送らない。終了で fold を閉じると未読が空になり、タブは次の daemon が未読を送るまで全部の say を 🔕 として見せてしまう
- 永続化: 既読の id の集合と、集合を作った時刻 `since` を `<state dir>/say-read.json` に持つ
  - `since` より前の say は既読とみなす (初回やファイルが壊れた時に、古い say で 🔔 が溢れないように)
  - 書き込みは `say_read` のたびに一時ファイルへ書いて rename し、応答はその後に返す
- 永続化は [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 の「v1 だけの永続状態を増やさない」の例外。say を transcript の行から描く以上、既読をメモリだけに持つと、再起動のたびに過去の say が全部未読に戻る
- subagent の say はその agent の TL に 🔕 で出て、未読には入らない

### 8. 削るもの

- CLI の `ccmsg say` (dispatch、help、README / README-ja / skill の記述)
- protocol の op `say`、`SayRecord`、`ev:"says"`。daemon の `say-log.ts`
- webui の say の時刻の差し込み (`useSayBubbles` と say-merge の say の分。許可依頼の時刻の差し込みは残す)
- CLI の `sidecar permit` の発声と、CLI の読み上げ辞書 (`packages/cli/src/say-dictionary*`)
- module の say / launch の CLI 経由の transport。`ccmsg sidecar launch` も削る (呼び手は module だけ。webui は op `session_launch` を直に使う)
- `transcript.ts` の Watch (§5)
- 旧版の plugin の module は自分の root の `bin/ccmsg say` を起こすので、旧版の CLI のまま発声する。旧版の CLI が送る op `say` は新しい daemon に断られるが、旧版の CLI は記録の失敗を握って発声に進む (実測)。旧版のセッションは行を push しないので、TL のライブ更新と 🔔 の未読は無い (再起動で新しい版になれば付く)
- PATH に置いた `say` の shim (`exec ccmsg say "$@"`) は、PATH の `ccmsg` が `say` を持たない版を指した時点で発声できなくなる。shim の copy は消す

### 9. 段階

| 段階 | 入れるもの | 前提 |
|---|---|---|
| 0 | §2 の観測 (済み: `claude -p` と対話のセッション) | — |
| 1 (済み) | push の op と module の転送、daemon の受け口、§4 の中継 (`transcript_subscribe` の源を push 起点の読みに置き換える。`ev:"transcript"` の形と webui は不変) | DR-0046 の `POST /op` |
| 2 (済み) | §3 の追いつきと uuid の重複除去、§5 の利用者の付け替えと `transcript.ts` の Watch の削除 | 段階 1 |
| 3 (済み) | §6 の副作用 (say の発声、permit の音声)、launch の `POST /op`、§7 の既読、§8 の削除 | 段階 1 (未読は段階 2 の後でもよい) |

## Alternatives Considered

- 案 A: daemon が transcript の tail に listener を足して say の tool_use を数える (module は発声する)
  - 不採用理由: kawaz 2026-10-28 の裁定。tail を残すことになり、副作用が module と daemon に分かれる
- 案 B: module が発声し、hook が say の呼び出しの id を daemon に知らせる (`say_mark`)
  - 不採用理由: kawaz 2026-10-28 の裁定。副作用の起点が tool ごとに module に散り、daemon が行を正本として持つ形にならない。この案の実装で観測した事実は [findings](../findings/2026-10-28-say-redesign-verify.md)
- module が行をパターンマッチして、副作用だけを daemon に頼む
  - 不採用理由: 何を副作用とみなすかが module に入り、新しい副作用のたびに module と daemon の両方を変える。行を流すだけなら、module は行の中身を知らずに済む
- tail を残し、push と並べる
  - 不採用理由: 行の源が 2 本になり、どちらの行が効いているか分からない状態を作る (フォールバックを持たない、DR-0039 §7)

## Consequences

- module → daemon の要求は、行の数だけ増える (1 turn に数行〜数十行)。DR-0046 の口の往復は 1 ms 前後 (実測) で、直列の送りは返事を待つ間の行をまとめる
- daemon の副作用は daemon の環境で起きる (`CCMSG_SAY_BIN`、`<config dir>` は daemon の側の値)
- Timeline の live の反応: 今の tail は fs.watch (FSEvents) で即時に拾い、2 秒の backup の poll で取りこぼしを拾う (最悪 2 秒)。新しい形は push の後に jsonl に行が現れるのを待って読むので、書き込みの遅れ (実測 ≈ 200 ms) の分だけ遅れ、常時のポーリングは無い
- daemon が止まっている間の行は、副作用を起こさない (発声されない)。再起動後の追いつきは fold と未読を作るが、副作用はやり直さない
- 発声の成否は tool の結果に入らない
- 触る範囲: hooks (`session.append` の転送、say / launch の handler)、protocol (push の op、`launch_tool`、`ev:"say_unread"`、`say_read`、辞書)、daemon (push の受け口、追いつき、fold の付け替え、Watch の削除、副作用、`launch_tool`、既読のファイル)、webui (say のバブル、Sessions 一覧の数)、CLI (`ccmsg say`・`sidecar launch`・permit の発声の削除)
- 既読の集合 (`say-read.json` の `read`) は刈り込まず、tool_use の id の数だけ増える (1 つ数十 byte)

## 関連

- [DR-0046](./DR-0046-module-op-over-http.md) — module → daemon の `POST /op` (push の経路)
- [DR-0009](./DR-0009-session-transcript-access.md) — `transcript_read` (履歴の読み) と live の継ぎ目
- [DR-0020](./DR-0020-session-status-tab.md) §3.1 — Status の fold の源
- [DR-0018](./DR-0018-session-launcher.md) §3.7 — tool `launch`
- [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6.3 — 🔔 バブルの見た目と既読ボタンの規則
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 — 人への経路、v1 だけの永続状態
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 / §7 / §9 — typed tool、no_module、notify の封筒
- [DR-0040](./DR-0040-permit-request-tool.md) §6 — 許可依頼の音声
