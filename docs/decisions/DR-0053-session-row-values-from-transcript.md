# DR-0053: SESSIONS の行の値は、daemon がセッションを知った時に transcript を通読して埋め、live の値と同じ field に流す

- Status: Accepted (2026-11-16、kawaz 指示) — ✅ 実装済み (`packages/daemon/src/transcript-facts.ts` の `readTranscriptFacts`、daemon の `queueTranscriptFacts` / `takeTranscriptFacts`、活動の op の一覧 `ACTIVITY_OPS`、`last_activity_at` の push を待たせる `PEERS_ACTIVITY_PUSH_MS`、`PeerInfo.model` / `.effort`、webui の `resolveModelEffort` の peers の候補)
- Date: 2026-11-16

## Context

サイドバー SESSIONS の 1 行は、経過時間 (`last_activity_at`)、model/effort、並び順に使う最終プロンプト時刻 (`last_user_input_at`)、名前、say (🔔) と許可依頼 (🔐) の未読の数を出す。kawaz の指摘 (2026-11-16):

> 一度でもリストしないと、モデル表示されないようだが？ 各セッションのアイドル時間?もおそらくdaemonの再起動タイミングにリセットされてしまっている。

> daemon再起動した時（または最初にclaude agents --jsonした時）に知らないセッションが登場したらその時点で、以下の情報はもう読み込み接続中のwebuiにpush配信する

対象に挙げられたのは、idle 時間 (最後の timestamp 付きの行から)、最終時点の model/effort、最終プロンプト時刻 (Claude Code 本体からの通知は除く)、最後の rename の名前、say と permit の既読 (webui で押した時に daemon が sid ごとに永続化したもの)。続けて出た裁定:

- 人のプロンプトと本体の通知を見分ける判定は、新しく作らず既にあるものを使う
- 読み込みは愚直でよい。セッションは 20 本ちょっと。1 本ずつ await して、読めたものから push する (並行にしない。末尾読みの最適化も要らない)

調べた事実は [findings 2026-11-16-session-row-facts-sources](../findings/2026-11-16-session-row-facts-sources.md)。要点:

- `last_activity_at` は daemon のメモリにだけあり、session role の request が終わるたびに受けた時刻で上書きされる。daemon を作り直すと無くなり、サイドカーが名乗り直した時刻で埋まるので、経過時間は「再起動からの時間」になる。module の無いセッションは何かの request が来るまで出ない。この field だけの変化は `ev:"peers"` を push しない
- 行の model/effort は、開いている間の session_status の購読 → gateway の prompt cache の窓 → ブックマークの凍結値、の順で取る。開いていない行、開いて別へ移った行には出ない。daemon は module の facts (`SessionFacts.model` / `.effort`) を持っているが、全 webui へ配る event に載せていない
- `last_user_input_at` は module の run が名乗っている間の fold の値だけで、module の無いセッションには無い
- 名前は agents の行 (`sessions/<pid>.json` の `name`) から来て、再起動の直後も、開いていないセッションにも出る
- say / permit の既読の id は daemon が sid ごとに state dir のファイルに書き、再起動をまたいで読む

## 目的

SESSIONS の行に出る情報 (経過時間、model/effort、並び順に使う最終プロンプト時刻、名前、未読の数) は、「webui でそのセッションを開いたか」「daemon がいつ起動したか」「そのセッションに module が入っているか」に左右されず、そのセッションの transcript と daemon の永続状態が言っている値になる。webui を開いた直後も、daemon を再起動した直後も、どのセッションも開かなくても、行は正しい値を出す。

増やしたくないもの: 同じ値の供給元が場面ごとに別々に増えること。ここで足す供給元は「transcript から読んだ値」の 1 つで、既にある live の値 (module の facts、transcript の push とその fold) と同じ field (`PeerInfo` の `last_activity_at` / `last_user_input_at` / `model` / `effort`) に流し込む。webui は場面を問わずその field を読む。

## Decision

### 1. 読む契機

daemon がある sid を初めて知り、その transcript の場所が分かった時に 1 回、その transcript を先頭から末尾まで読む。

- 起動後の最初の agents の poll で見つかる全セッション、後から現れたセッション、hello で登録されたセッションのどれも同じ。daemon がセッションを知る経路 (`syncSessionsFromAgents` と hello) はどちらも `registerSession` に入るので、そこで読みを待ち行列に積む
- transcript の場所が後から分かるセッション (まだ何も打たれておらず `<sid>.jsonl` が無かった) は、分かった時に積む: agents の poll の round ごとの再探索 (`resolvePendingTranscripts`) と、transcript を名乗る hello (`registerSession`) の 2 か所
- 同じ sid を二重に読まない。読みを積んだこと・読み終えたことは daemon の登録簿のそのセッションの項 (`SessionEntry.fromTranscript`) に持つ。セッションが終わって忘れられ (`forgetSession`)、また現れた時は新しい項なので、また読む
- 宣言された場所にファイルがまだ無い時 (起動した直後で最初のプロンプトがまだのセッション。Claude Code は最初のプロンプトでファイルを作る) は、その読みを「読んだ」にせず、項を積む前の状態に戻す。積み直す契機は既にある event に載せ、タイマーは足さない: agents の poll の round (`resolvePendingTranscripts`)、そのセッションの次の hello (`registerSession`。module は依頼のたびに hello する)、そのセッションの `transcript_push` (会話に行が入ったので、ファイルはもうある)。どれも、読みが積まれている間と読み終えた後は何も積まない。ファイルが無いことはログに書かない (ふつうの状態なので)
- 読みが着地する時に、積んだ時のファイルと項の今の `transcript_path` を照合する。読み待ち・読み途中に同じ項の場所が別のファイルに変わっていたら (同じ sid が別の transcript を名乗った)、古いファイルから読んだ値は今のセッションの値ではないので反映せず、今の場所で積み直す。読みが着地した後に場所が変わった時 (`relayRetarget`) は読み直さない (読んだ値は live の値が引き継ぐ)

### 2. 読み方

- 待ち行列に積み、1 本ずつ await して全体を読む。並行にしない。順番は積んだ順 (登録の順)。待ち行列は既存の `createSerial`
- 1 本読めるたびに、そのセッションの値を反映して `ev:"peers"` を全 webui に push する (§5 の待ちを経ずにすぐ)
- ファイルはあるが読めなかったセッション (権限が無い、ファイルでない) は値を付けずに次へ進み、daemon.log に 1 行残す (`transcript facts <sid>: <file> not read: <理由>`)。これは 1 回で「読んだ」に確定し、読み直さない (同じ理由で失敗するので)。ファイルが無い時は §1 のとおり確定しない
- 行はすべて行そのものの parse で見る。部分文字列で assistant 行を前もって選り分けない (JSON の綴り方の違い、たとえば文字の escape で取りこぼすため)。20 本ほどを 1 回読むだけなので、全行を parse する費用は問題にならない
- 読めない行 (JSON でない、`timestamp` が文字列でない) は飛ばして、読める行から値を取る。1 本の中にそういう行があれば daemon.log に 1 行 (`transcript facts <sid>: <N> lines of <file> did not read; the rest were read`)。改行がまだ書かれていない最後の行は書き込みの途中なので読まない
- 読みの途中で daemon が止まる時、積まれて待っている読みは何も読まずに終わり、走っている 1 本は読み終わるのを待つ (ファイルを開いたまま残さない)

### 3. 1 回の通読で取る値と、`last_activity_at` が言う「活動」

1 回の通読で次の 3 つを取る (`readTranscriptFacts`)。

- 最後の活動時刻: `timestamp` を持つ行のうち最大の timestamp。transcript の最後の行は timestamp を持たない metadata 行 (`custom-title`、`agent-name`、`last-prompt`、`cost-state` 等、Claude Code が末尾近くに繰り返し書く) であることが多いので、「最後の行」ではなく「timestamp を持つ行」から取る。最大を取るのは、resume や fork で古い turn が後ろに差し込まれても戻らないため
- 最終時点の model と effort: sidechain でも `<synthetic>` でもない最後の `type: "assistant"` 行の `message.model` と行直下の `effort` の組。行の読み方は Session Search の resume の model/effort と同じ関数 (`launchContextFromRow`) を使う。effort を書かない版の行なら effort は無し (前の行の effort と組み合わせない)
- 最終プロンプト時刻: live の fold と同じ判定 (`session-user-input.ts` の `classifyUserInputRow`) で「人の入力」とされた行の timestamp の最大値。判定は足さず変えず、fold と通読が同じ関数 (`userInputAtOfLine`) を通る。task-notification や peer の中継、tool_result は人の入力ではない

`last_activity_at` は「そのセッションが最後に何かをした時刻」で、その供給元は 2 つ:

- 通読で取った最後の活動時刻 (transcript の行の timestamp)
- その後にセッションが仕事をした request。daemon の request の終わりの 1 か所で、session role の接続の request のうち次の op だけがそのセッションの `last_activity_at` を今の時刻にする (`ACTIVITY_OPS`)。今の値より新しい時だけ採り、後ろに戻さない (通読の値が daemon の時計より先のことがある: 別の機械の時計、戻された時計):
  - `transcript_push` (module が会話に入った行を送る。会話に行が増えた)
  - `send_message`、`notify`、`peer_list`、`launch_tool`、`permit_request` (セッションのエージェントが ccmsg の tool で頼んだこと)

次は活動ではない:

- `hello`: 接続であって仕事ではない。module は `POST /op` の依頼のたびに hello し (DR-0046)、CLI も実行のたびに hello する
- `sidecar_hello`: サイドカーが run を名乗る。daemon が起動するたびに名乗り直すので、これを活動と数えると経過時間が「再起動からの時間」になる
- `sidecar_reply`: daemon が module に聞いたことへの答え (daemon が起こしたもの)
- `session_facts`: module が知っていることの写し。webui で人が通しの上書き (DR-0041) を変えた時にも送られる。turn の始まり・終わりは会話の行として `transcript_push` で数えられる
- 読むだけの request (`ping`、`peers`、`read` 等)

一覧は「数えるもの」で書き、op が増えても一覧に入れない限り誰の経過時間も動かさない。

### 4. 値の置き場と、既にある live の値との関係

| 値 | field | daemon の中での優先 |
|---|---|---|
| 最後の活動時刻 | `last_activity_at` | 通読の値は、その時点で daemon が持つ値より新しい時だけ採る。読みを待つ間にセッションが仕事をしていれば、そちらが新しい |
| 最終プロンプト時刻 | `last_user_input_at` | module の run が名乗っている間の fold の値があればそれ。無いセッション (module 無し、名乗る前、名乗った run が去った後) は通読の値 |
| model / effort | `model` / `effort` (`PeerInfo` に足す) | module の facts が model を言っていれば facts の `model` / `effort` の組。無ければ通読の組。2 つの供給元から 1 つずつ取って組み合わせない |
| 名前 | `name` | 変えない (下) |
| 未読の数 | `ev:"say_unread"` / `ev:"permit_state"` | 変えない (下) |

- `PeerInfo` に足す field 名は `SessionFacts` と webui の `ModelEffortSource` の語彙に合わせ、`model` と `effort` にする。値は生の綴り (facts は `$.session.model()` の名前、`[1m]` 付きもある。通読は `claude-fable-5-2` の形)。短い名前に写すのは webui (`formatSessionModelEffort`)
- module の facts が変わった時も `ev:"peers"` を push しうる (比較キーに `model` / `effort` が入るので、変わった時だけ)
- webui の `resolveModelEffort` (`sessionRowModelEffort`) は、Status タブの MODEL / EFFORT・TL 下の状態行と同じ決め方 (`requestValueInForce`、[DR-0041](./DR-0041-request-model-effort-override.md) §5) で、field ごとに単発の上書き、通しの上書き、セッション自身の値の順に取る。上書きは全セッション分が全タブに届く (`ev:"request_overrides"` / `ev:"request_override"`) ので、開いていない行でも変えた時点で変わる。セッション自身の値は、開いている間の session_status の購読の値 (Status と同じく `engine` を元の値とする) → peers の行の `model` / `effort` → gateway の直近の request の model → ブックマークの凍結値、の順で、model を持つ最初の候補の組を使う。開いていない行にも、開いた後に別のセッションへ移った行にも出る。行の見た目 (family の短い名前、印なし) は変えない
- 名前は既に満たしている: 行のタイトルは agents の行の `name` (CC の `sessions/<pid>.json`) で、agents の poll は daemon の起動時すぐに 1 round 走り、transcript を読まずに名前を取る。開いていないセッションにも、再起動の直後にも出る (findings 4 節、再現で観測)。最後の rename の値は CC がその file に書いた値なので、transcript の `custom-title` を読む必要が無い
- say / permit の既読は既に満たしている部分がある: 既読の id は `say-read.json` / `permit-state.json` に sid ごとにあり、再起動の後に読み戻される。module のあるセッションは、サイドカーが名乗り直すと fold が transcript を先頭から読み、未読の数は再起動の前と同じになる (テストで固定)。module が無く誰も開いていないセッションの未読は、再起動の前も後も数えられない (未読はその session の status の一回読みか fold が見つけた呼び出しから決まる)。これは §1 の通読では埋めない (§7)

### 5. `last_activity_at` だけの変化の push

`ev:"peers"` は全セッションの一覧の全体で、全 webui に送る。働いているセッションは turn の間、会話に行が入るたびに (1 秒に何度も) `last_activity_at` を動かすので、その変化のたびに一覧を送ると push が多すぎる。そのため daemon は `last_activity_at` を他の field と分けて比べる:

- 他の field (名前、場所、readiness、`last_user_input_at`、`model` / `effort` 等) の変化はすぐ push する。その push はその時の全行を運ぶので、待っている `last_activity_at` の変化もそこで届く
- `last_activity_at` だけの変化は、最初の変化から `PEERS_ACTIVITY_PUSH_MS` (5 秒) 後に 1 回 push し、その間の変化を全部まとめる。タブが持つ値は daemon の値から最大 5 秒遅れ、push は何セッション働いていても 5 秒に 1 回まで。5 秒は SESSIONS の行が経過時間を描き直す間隔 (10 秒) の半分で、描かれる時間の遅れは描き直し 1 回分を超えない
- 通読が終わった時 (§2) は待たずにすぐ push する
- 待ちのタイマーは活動の event でしか張らない (活動が無ければ何も起きない)。定期の polling ではない。daemon の停止で外す
- `peers` の応答は今の値をそのまま返す

### 6. protocol

`PeerInfo` に `model` / `effort` を足すのは webui 向けの変更で、hooks の bundle (`hooks/register.bundle.js`) は変わらない (`just check-hooks-bundle` が通る)。DR-0002 §4 により `PROTOCOL_VERSION` は上げない。新しい op や event は足さず、既存の event の形も変えない。

### 7. 責務の外

- Session Search が rename の後のセッションで古い名前を返しうる件 (findings 4 節) は、行の名前が agents の行から来るので行の表示に関係しない。直さない
- transcript の `api-request` 行 (`params.model` / `params.output_config.effort`) は読まない。assistant 行の組で最終時点の model/effort が取れる
- webui の行の見た目は変えない。最終プロンプト時刻は行に描かず、今どおり並び順に使う
- module が無く開いていないセッションの say / permit の未読を通読で数えることはしない (§4)。数えるなら、通読の 1 回の読みに既存の一回読み (`sayScan` / `permitScan`、DR-0045 §7 の「live でないセッションの一回読み」) の行を流す形になる。その時は一回読みの分がメモリだけにあり、live になった時に fold へ引き継ぐ決まりもそのまま使える

### 8. 実装で決めたこと

- 契機を掛けた場所: `registerSession` の最後、`resolvePendingTranscripts` (agents の poll の round ごと。場所がまだ分からない項の再探索と、場所はあるがファイルがまだ無かった項の積み直し)、`transcript_push` の受け口。poll と hello の両方が `registerSession` を通るので、契機を経路ごとに足さずに済む。transcript を名乗る hello が後から来たセッションも同じ所で拾える。積み直しはどれも既にある event で、`queueTranscriptFacts` が積まれている間と読み終えた後は何もしないので、何度呼ばれても読みは増えない
- 読んだ値の置き場: 登録簿の項 (`SessionEntry.fromTranscript`、積んだ / 読んだ値)。セッションが忘れられると値も消え、また現れたら読み直す。live の値は今どおりの置き場 (`lastActivityAt`、fold の store、facts の store) で、peers の行を作る時に §4 の優先で 1 つにする
- push の方法 (§5): `last_activity_at` が比較キーから外してあったのは、活動の上書きが hello を含む全 request で起き、hello の request 自体が比較の間に `last_activity_at` を動かして「内容の変わらない hello の再送で push しない」が崩れるため、そして request のたびに全件の push になるため (`peersCompareKey` のコメント、issue 2026-07-12-peers-live-update-protocol)。前者は hello を活動から外したことで消え、後者は `last_activity_at` を別の比較キー (`peersActivityKey`) にして §5 の待ちでまとめることで保つ。タイマーを足す形にしたのは、既にある push の契機 (他の field の変化) だけでは、turn の間に他の field が動かないセッションの経過時間がずっと古いままになるため。タイマーは daemon の `afterActivityWindow` (窓が終わったら 1 回だけ呼ぶ関数) を通して張り、テストは窓の終わりを自分で決める (実時間に頼らずに push の回数を固定する)
- 活動の定義 (§3): request の終わりの 1 か所はそのままにし、数える op の一覧 (`ACTIVITY_OPS`) で絞る
- model/effort の通読は `launchContextFromRow` (session-search.ts) を、最終プロンプト時刻は `userInputAtOfLine` (session-user-input.ts、fold の 1 行の判定を切り出したもの) を使う。読み方の判定をこの DR で新しく作らない
- transcript の時刻の比べ方: 瞬間で比べる (`Date.parse`)。読めない時刻は新しい側にならない。`last_user_input_at` の最大は fold と同じく文字列で比べる (fold と通読が同じ行を最新にするため)

## Alternatives Considered

- 案: 末尾だけ読む (`readSessionLaunchContext` のように末尾の 64 KiB / 256 KiB の窓)
  - 不採用理由: kawaz の裁定 (末尾読みの最適化は要らない)。最終プロンプト時刻の人の prompt は会話の途中にあり、末尾の窓に入るとは限らない (findings「取れない・取りにくいもの」)。窓を広げる・遡る工夫は 3 つの値ごとに違う境界を持ち込む。`readTranscriptFacts` で実物の transcript を全体読みして 2.8 MB / 3.4 MB / 0.38 MB で 12〜21 / 13〜17 / 2 ms、手元で一番大きい 218 MB で 0.65 s (2026-11-16、手元で計測。全行を parse する形で、assistant 行を部分文字列で選り分けた形と差は無かった)
- 案: 並行に読む
  - 不採用理由: kawaz の裁定 (1 本ずつ await、並行にしない)。セッションは 20 本程度で直列でも数百 ms に収まり、並行にすると起動直後に全 transcript を同時に開いて読む負荷の山を作る。読めたものから push するので、直列でも最初の行はすぐ埋まる
- 案: webui がセッションを開いた時に読む (session_status の購読や一回読みに載せる)
  - 不採用理由: 目的に反する。「開いたか」に左右されない値にするのが目的で、開いた時に読む形は今の「開いている間だけ出る」と同じ種類の場面依存を残す。開かれていない行の値が無いままになる
- 案: `last_activity_at` を比較キーに戻し、変化のたびにすぐ push する
  - 不採用理由: 働いているセッションは 1 秒に何度も値を動かし、そのたびに全セッションの一覧を全タブへ送ることになる (§5)
- 案: webui が経過時間のために `peers` を定期的に聞き直す、または daemon が定期的に push する
  - 不採用理由: 定期の polling を足すことになる。活動の event を合図にしたまとめの push で、遅れは 5 秒に収まる
- 案: 活動から外す op を列挙する (除外の一覧)
  - 不採用理由: op が増えるたびに、一覧に入れ忘れた op が経過時間を動かす。数える側の一覧なら、入れ忘れは「動かない」側に倒れ、`transcript_push` が会話の行を拾うので実害が小さい

## Consequences

- module の無いセッションの `last_activity_at` は、daemon がそのセッションを知った時の通読の値から動かない (module の無いセッションは `transcript_push` を送らず、その会話の行は daemon に届かない)。§3 の op の request (CLI の `ccmsg notify` 等) が来た時だけ動く。module の無いセッションは no_module の 1 状態で、別の経路を作らない (DR-0039 §7)
- `last_user_input_at` は、名乗っていた run が去って fold が閉じると、通読の値 (daemon がそのセッションを知った時のもの) に戻る。fold の値より古いことがある
- daemon の起動の直後に、受け持つ全セッションの transcript を 1 本ずつ全部読む。実物で 1 MB あたり 3〜7 ms (上の計測)、20 本で数百 ms。200 MB 級の transcript があればその 1 本で 1 秒弱かかり、その後ろに積まれたセッションの値はその分遅れて届く。読みは `scanTranscriptLines` で 4 MiB ごとに event loop に戻る (DR-0029)
- module のあるセッションの model/effort は、facts の `model` が来た時点で facts の組に変わる。facts の effort は最初の request (turn.step) まで無いので、その間は model だけになることがある
- `last_activity_at` の push は最大 5 秒遅れる。`peers` の応答 (webui の ↻、接続時) は今の値

## 関連

- [findings 2026-11-16-session-row-facts-sources](../findings/2026-11-16-session-row-facts-sources.md) — 各値の供給元、daemon の再起動での振る舞い、transcript の field
- [DR-0020](./DR-0020-session-status-tab.md) — session status (§2.1 (a): 全セッションの購読は高すぎるので、行に要る値は全体へ配る field で持つ)
- [DR-0021](./DR-0021-session-search.md) — Session Search (resume の model/effort の読み方 `readSessionLaunchContext`)
- [DR-0034](./DR-0034-peer-socket-injection.md) §5 — セッションの登録は harness の登録簿から導出する
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — module の無いセッションは no_module の 1 状態
- [DR-0040](./DR-0040-permit-request-tool.md) §4 — 許可依頼の既読 (`permit-state.json`)
- [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §5 / §7 — transcript の push と fold、say の既読 (`say-read.json`)、live でないセッションの一回読み
- [DR-0046](./DR-0046-module-op-over-http.md) — module の依頼は依頼ごとに hello する
- [DR-0047](./DR-0047-session-rename-via-command-run.md) — 名前は agents の行の `name` が追従する
- [DR-0002](./DR-0002-daemon-supervision.md) §4 — protocol の版
