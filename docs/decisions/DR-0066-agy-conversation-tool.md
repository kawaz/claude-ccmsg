# DR-0066: エージェントが agy (Antigravity の CLI) の会話を tool `agy` で使う

- Status: Proposed
- Date: 2026-11-25

未実装。Decision は起草時の推しで通して書いてある。裁定の要る点は「未決」の Q1〜Q14 と「再考の提案」の R1 で、裁定が推しと違えば該当の節を書き直す。

## Context

Claude Code のセッションから、別の系統のモデルに仕事を頼みたい場面がある (レビューや調査の突き合わせ、利用枠の逃がし先)。agy は Google の Antigravity の CLI で、Gemini と、同じ口から Claude 等のモデルを呼べる。今は Bash から `agy -p` を呼ぶが、auto mode の classifier に引数の違うたびに止められ、全許可やシェルを使わせる依頼は人の許可の後でも止められ続けた ([issue 2026-11-25-agy-tool](../issue/2026-11-25-agy-tool.md))。

kawaz の仕様案 (2026-11-25):

```
agy {
  op:
    | "run"     agyid が無ければ新規、あれば既存の会話への依頼。プロセスが生きていなければ起動する。
                どの場合も tool の利用側からは違いが見えない
    | "status"  生きているか、ターン中か
    | "abort"
  agyid?:   新規の時は付けない
  prompt,
  cwd:      新規の時だけ付ける (無ければプロジェクトのディレクトリ)
  dirs:     新規の時だけ付ける (無ければプロジェクトのディレクトリ)
    [ { path, containerpath?, write: bool }, … ]
}
```

tool の裏では agy を起こし、stream-json (`--input-format stream-json --output-format stream-json`) で ccmsg が入出力する。

### kawaz が決めたこと (2026-11-25)

本文はこれを前提にし、覆さない。

- K1: run は非同期。agyid はすぐ返し、応答は後で知らせとして届ける
- K2: 新規の時に model と effort は必須
- K3: 権限は全許可 (`--dangerously-skip-permissions`)。書ける範囲はコンテナで囲う前提。最初はホスト上で動かし、コンテナで動かす実験を並行して進め、使えそうになったら切り替える
- K4: model を run ごとに替えない (cache が効かなくなる)
- K5: agyid は起動したセッション以外も使ってよい (セッションの引き継ぎで agy の会話も引き継げる)
- K6: 何もしていないプロセスを雑に殺さない (重い依頼は 20 分かけて仕事をすることがあり、出力が止まっていても agy の中で裏の処理を待っているだけのことがある)
- K7: status と run の結果は、詳しさを引数で選べる。最低限 (生きているか、ターン中か、最後の応答、エラー) と、詳細 (起動時の model・effort・cwd・dirs、usage の累計、cache の利用状況、拒否された道具、利用枠の戻り時間)。引き継いだ agyid でも中身が分かる
- K8: 中断は agy の仕様で確かめてから決める (A6 で確かめた)
- K9: tool は 1 つで、`op` で run / status / abort を分ける (仕様案)

### agy の実測 (1.5.13〜1.5.15、macOS、2026-11-21〜25)

出どころは上の issue と、claude-rules-personal の reference の `agy/` (`headless`・`permissions`・`agents`)。ここに無いことは「要る実測」に挙げる。**agy の挙動の判断基準日: 2026-11-25** (設計を agy の別の版に合わせ直したら、この日付と下の項目も一緒に更新する)。

- A1: 会話の ID は agy が発行する。自分で作った uuid を `--conversation` に渡すと `not found` と警告し、別の ID の新しい会話になる
- A2: `--input-format stream-json --output-format stream-json` で起こすと、標準入力の 1 行 (`{"event":"user","message":{"content":"…"}}`) が 1 回の依頼になり、依頼ごとに `result` が 1 つ出る。起動から約 4 秒で `init` が出て、そこに `conversation_id` が入る。`init` は 1 プロセスに 1 回
- A3: ターンの途中で次の依頼を書いても、agy が今のターンを終えてから順に処理した
- A4: 標準入力を閉じると、今のターンを終えてから正常に終わる
- A5: 終わったプロセスの会話は、同じ形に `--conversation <ID>` を足して起こすと同じ ID のまま続き、前の内容を覚えている。再開時に `--model` を替えても同じ会話として続く
- A6: 今のターンだけを止めてプロセスを生かす口は無い (`control_request` はエラーで終わる)。本体のプロセスに SIGINT か SIGTERM を送ると、すぐに `"status":"ERROR"`、`"finished_reason":"interrupted"` の `result` を出してプロセスが終わる。SIGINT の後に書いた依頼は処理されない。止めた会話は再開でき、壊れていない
- A7: `agy` はラッパのシェルスクリプトで、本体 `antigravity` を exec する
- A8: 同じ会話を 2 つのプロセスで同時に開くと、片方の書き込みが失われる
- A9: 「ターン中か」は「依頼を書いてから、その `result` がまだ来ていない」で判定できる (agy の中で裏の処理を待っている間もターン中)。数百 KB の文書を読んで報告を書く依頼は 1 回で 10〜50 分かかった
- A10: `result` は `conversation_id`・`status` (`SUCCESS` / `ERROR`)・`response`・`duration_seconds`・`num_turns`・`usage` (入力・出力・思考・cache から読んだ分) を持ち、失敗時は `error` と `finished_reason`、拒否された道具があれば `denied_actions` を持つ
- A11: cache について出るのは `usage.cache_read_tokens` だけで、書いた分と TTL は出ない。agy 経由の Claude Sonnet で、会話の cache は閉じてから 3 分半後は効き、6 分半後は外れた。プロセスを生かしても延びない。`--model` を替えると効かない。Gemini のモデルは未測定
- A12: 全許可でないと、シェルと `run_workflow` が拒否され、`invoke_subagent` の結果を待たずにターンが終わる。全許可の時に書ける範囲を縛るものは agy の側に無い: `--sandbox` と併せても、作業ディレクトリの外への書き込みとネットワークが通った。`--add-dir` は見せるディレクトリを足すだけ
- A13: 利用枠は Gemini のモデル全体で 1 つ。尽きると `Individual quota reached … Resets in <時間>` と `AGY_ERROR: {…"error_code":429…}` を出して終了コード 3 で終わる。agy 経由の Claude のモデルは別に数えられる
- A14: サインインしていないと `agy models` は `Please sign in …` で失敗し、`-p` は認証の入力待ちのまま 60 秒で失敗する。サインインは人が端末で行う
- A15: モデルの名前は `<系列>-<強さ>` (`gemini-4-carbon-high`、`claude-sonnet-5-5-low`)。`--effort` (low / medium / high / xhigh / max) は `--model` と併せて指定できる
- A16: agy に送った中身は、外のサービス (モデルの提供元) に出る

### ccmsg の今の作り (実装を読んで確かめたこと)

- C1: tool は hooks module が `session.start` で登録し (`isDeferred: true`、対話のセッションだけ)、handler は `next` を呼ばずに `{ result }` で答える。この形は permission の判定 (`tool.check`・PreToolUse・ダイアログ・auto mode の classifier) を一切通らない ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3、`hooks/tools.ts` の 6 つの tool のすべて)。判定を通らないので、issue の言う「tool 名の完全一致 allow 1 つ」も要らない
- C2: tool は subagent / teammate にも見え、その呼び出しは `agentId` を持つ。`permit` と `comment_reply` は subagent の呼び出しを断り、`send` / `say` / `peers` / `launch` は通す
- C3: module から daemon への依頼は `POST /op` の 1 往復で、host が 30 秒で打ち切る。頼み手のセッションは socket の相手の pid で決まる ([DR-0046](./DR-0046-module-op-over-http.md))
- C4: `launch` は daemon が外のコマンドを起こす前例。待ちを 15 秒で区切り、超えた結果は daemon からの知らせ (`from="ccmsg:daemon"` の封筒、peer 注入) で呼んだ会話に入れる。subagent が呼んだ時は `send` の `agent_id` と同じ経路 (サイドカーの依頼 `agent.send`) でその subagent に届け、届かなければ daemon.log に書いて終わる ([DR-0018](./DR-0018-session-launcher.md) §3.7、`server.ts` の `tellLaunchOutcome`)
- C5: 知らせは預からない。届け先のセッションが走っていない・module が無い時は `not_delivered` で終わり、後で届け直さない ([DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3、`send-message.ts`)
- C6: `launch` の 4096 bytes 以上の出力は `<state dir>/launches/<launch id>/` に退避し、本文の代わりに `output is <N> bytes, file: <path>` を返す。退避は 7 日で消す (DR-0018 §3.6)
- C7: daemon は lock で 1 つに保たれ、新しい版の client が接触すると入れ替わる (newer-wins、[DR-0002](./DR-0002-daemon-supervision.md) §4)。終わる時は走っている起動コマンドの返事を待ち、btw の fork は止める (`shutdownDaemon`)。daemon が起こして、daemon の入れ替わりの後も daemon が読み続ける子は今は無い
- C8: daemon が永続する状態は state dir に置いている (`permit-state.json`、`bookmarks.json`、`sessions/<sid>.comments.jsonl`)
- C9: プロセスに信号を送る前例 (`session_kill`) は、pid が今もその種類のプロセスかを argv[0] で確かめてから送る ([DR-0028](./DR-0028-session-kill.md))
- C10: CLI が起こした daemon は、起こしたセッションの Claude Code の変数 (session id、messaging の token 等) を環境に持ち続け、子に継がせる ([issue 2026-11-20-daemon-env-carries-spawning-session-identity](../issue/2026-11-20-daemon-env-carries-spawning-session-identity.md))

## 目的

Claude Code のセッションのエージェントが、別の系統のモデルとの会話を、チームメートに頼むのと同じ形で使える: 依頼を投げたらすぐ手が空き、応答は終わった時に自分の会話に届き、同じ会話に続きを頼める。会話は依頼したセッションのものではなく、会話のキー (agyid) を知るセッションが続きを頼める。

手順に現れない保証:

- 1 つの会話に同時に書くプロセスは 1 つ (A8)
- 受け付けた依頼の応答は、届け先が居なくなっても、daemon が入れ替わっても、後から読める
- 受け付けられなかった依頼は、原因と次にすることを文で返す

増やしたくないもの:

- **ccmsg の中の依頼の順番待ち**。agy に書けた依頼の順は agy が持つ (A3)。ccmsg は書けない依頼を預からない
- **プロセスの管理**。ここで言う管理は、ccmsg が自分の判断で agy のプロセスを起こす・止めること。依頼が来た時に起こすこと (始まらなかったプロセスの片付けを含む) と、頼まれた時に止めること (abort) は含まない。数の上限・自動の停止・自動の起こし直しを持たない (K6)
- **agy の起こし方の知識**。daemon が知るのは agy の引数と stream-json の形まで。どの環境 (ホスト / コンテナ) で、どの資格情報で起こすかは config のコマンドの側が持つ
- **ccmsg が振る ID**。会話のキーは agy が発行したものを使う
- **model の context に載る文**。tool の説明と input schema は型だけで、使い方は skill に置く (DR-0039 §3 の「mods の tool の作り方」)

## 前提

| 前提 | 満たさない時 |
|---|---|
| セッションに hooks module がある | tool が登録されず、使えない。別の口は作らない (DR-0039 §7) |
| ホストに agy があり、人がサインインしている (A14) | run が §6 の表の文で断られる |
| agy が出力をファイルへ逐次に書き、起こした親が終わった後も走っているターンを書き切る (M1、M2) | Q2 の (a) が取れない。出力を pipe で読み、daemon の入れ替わりで走っているターンを止める形 (Q2 の (b)) になる |
| daemon が起こした pid への SIGINT で、agy が `interrupted` の `result` を出して終わる (A6、M3) | abort を §9 の形で作れない。信号の届け方を実測し直す |
| `result` が依頼を書いた順に出る (M4) | 応答の届け先を取り違える。`result` から依頼を見分ける手掛かりが要る |

## Decision

### 1. 責務の境

| 持ち手 | 持つもの |
|---|---|
| hooks module (tool の handler) | 入力を形で読む<br>呼び手が subagent ならその agent id を添える<br>daemon に `POST /op` で 1 往復頼む<br>返事を model の読む文にする |
| daemon | agy のプロセス (起こす、依頼を書く、出力を読む、信号を送る)<br>会話の記録<br>1 会話 1 プロセスの縛り<br>応答の知らせ |
| agy | 会話の中身の保存と再開<br>書かれた依頼の順 (A3)<br>モデルとの通信と道具の実行 |
| config の `agy.command` | agy をどの環境で起こすか |

- プロセスと会話の記録を daemon が持つのは、会話がセッションより長く生き (K5)、どのセッションからの依頼も通る 1 つの点が daemon だけだから (C7)。module が持つと、セッションの終了で会話のプロセスが終わり、別のセッションからの run と同時オープンの縛り (A8) を掛ける場所が無い
- module は agy のプロセスも状態も持たない。tool の handler は `launch` と同じ形で、`next` を呼ばずに `{ result }` で答える (C1)
- 会話を ccmsg の外で開くこと (人が端末で同じ ID を `agy --conversation` で開く) を止めるのは daemon の責務外

### 2. config と agy の起こし方

daemon config に `agy` の節を足す。節が無い環境では tool は使えない (Q3)。tool の登録は節の有無によらず行い (module は daemon の config を読まない)、呼ばれた時に daemon が `agy_not_configured` で断る (`launch` の `launcher_not_configured` と同じ)。

```ts
agy: {
  command: ["agy"],                        // 省略時の既定
  clean_env: ["CLAUDE*", "ANTHROPIC_*"],   // 省略時の既定
  keep_env: [],
}
```

- **`command`**: agy を起こす argv の先頭 (空でない文字列の配列)。先頭の要素は `launch_command` と同じ規則で、config を読む時に実行できるファイルの絶対パスに固定し、見つからなければ読めない config として daemon は起動時に止まる (DR-0018 §3.1)。daemon はこの後ろに agy の引数を足して shell を介さずに起こす。差し替えるコマンドの契約は 3 つ: 後ろに足された引数を agy に渡す、標準入力と標準出力を agy のものとしてそのまま継ぐ、受けた SIGINT を agy の本体に届ける (exec するか、信号を渡す)。コンテナで起こす版はこの `command` を差し替える (Q5)
- **`clean_env` / `keep_env`**: agy に継がせる環境から落とすキーと残すキーのパターン。意味は `session_launcher` のものと同じ (DR-0018 §3.1)。既定で `CLAUDE*` と `ANTHROPIC_*` を落とすのは、daemon の環境に起こしたセッションの session id や messaging の token が残っていることがあり (C10)、全許可で動く agy のモデルはそれを読めるから。`TMPDIR` は起動コマンドと同じく OS の利用者ごとの一時ディレクトリに置き換える (DR-0002 §2)
- daemon が足す引数:
  - 新しい会話を起こす時: `--input-format stream-json --output-format stream-json --dangerously-skip-permissions --model <model> --effort <effort>`、`dirs` の各 `path` に `--add-dir <path>`
  - プロセスの無い会話を再開する時: 上に `--conversation <agyid>` を足す。model・effort・cwd・dirs は会話の記録の値 (K4)
- プロセスの cwd は入力の `cwd` の realpath

### 3. tool の入力

tool は `agy` 1 つ (model からは `mcp__ccmsg-v1__agy`、K9)。description は `Ask an agy conversation`。model に見せる input schema は分岐の無い 1 つの object で、型だけを持つ (top-level の `oneOf` / `anyOf` を持つ tool は Claude Code が外す、DR-0018 §3.7):

```
op:      "run" | "status" | "abort"                                  (必須)
agyid:   string                                                      # Id a run returned
prompt:  string
model:   string
effort:  "low" | "medium" | "high" | "xhigh" | "max"
cwd:     string
dirs:    { path: string, containerpath?: string, write: boolean }[]
verbose: boolean
```

field の説明を付けるのは `agyid` だけ。field の組み合わせは schema に書かず、handler が読む valibot のスキーマが持つ (`launch` の `LaunchFieldsSchema` と `LaunchInputSchema` と同じ 2 段)。合わない呼び出しは、合う所だけ拾って進めることをせず、「agy の入力が形に合わないので何もしていない: <理由>」で断る。

| 呼び出し | 書く field | 任意の field | 書くと断る field |
|---|---|---|---|
| run (新しい会話) | `prompt`<br>`model`<br>`effort` | `cwd`<br>`dirs`<br>`verbose` | none |
| run (続き) | `agyid`<br>`prompt` | `verbose` | `model`<br>`effort`<br>`cwd`<br>`dirs` |
| status | `agyid` | `verbose` | `prompt`<br>`model`<br>`effort`<br>`cwd`<br>`dirs` |
| abort | `agyid` | none | 他のすべて |

- run が新しい会話か続きかは `agyid` の有無だけで決まる
- 続きの run に `model` 等を書いた呼び出しを断るのは、黙って捨てると呼び手が「効いた」と思い込むから (DR-0018 §3.2 の知らない field と同じ理由)。model は会話の途中で替えない (K4)
- `model` は agy のモデル名をそのまま受ける文字列 (A15)。一覧は agy の側で変わるので ccmsg は持たない。`effort` は agy の `--effort` の 5 つの値
- `cwd` は絶対パスで、存在するディレクトリ。無ければ呼び手のセッションのプロジェクトのディレクトリ (daemon が持つそのセッションの cwd)。daemon がそれを知らない間は「cwd を書く」と断る
- `dirs` の `path` は絶対パスで、存在するディレクトリ。`dirs` が無ければプロジェクトのディレクトリ 1 つ (`cwd` と同じなら足さない)。`[]` は「足さない」
- `dirs` の `write` は必須。ホストで動く版が受けるのは `write: true` で `containerpath` の無い要素だけ (§11、Q4)
- `prompt`・`agyid`・`model` に空文字は受けない
- `verbose` は結果の詳しさ (K7)。無いか `false` なら最低限、`true` なら詳細。run では後で届く知らせの詳しさ、status ではその返事の詳しさ

module は入力を読んだ後、`op` ごとの daemon の op (`agy_run` / `agy_status` / `agy_abort`、session role だけ) に写して頼む。subagent からの呼び出しなら `agent_id` を添える。daemon の側では op ごとに入力の形が決まり、組み合わせの検査は module と同じスキーマを使う。

### 4. 会話のキーと記録

- **agyid は agy が発行した `conversation_id` そのもの** (A1、Q1)。daemon は `init` で読んだ値を、ファイル名に使える形 (英数字と `-`、長さ 1〜128) か確かめてから使う。合わない値は起動の失敗として扱う
- **daemon が知らない agyid は受けない** (Q12)。会話の記録が無い agyid の run / status / abort は「この daemon が発行した agyid ではない」と断る。受けると、起動時の model・effort・cwd・dirs が分からず、ccmsg の外で開かれているかも分からない
- 会話の記録は `<state dir>/agy/<agyid>.json` (ディレクトリ 0700、ファイル 0600。書き換えは一時ファイルから rename)。会話ごとに 1 つで、次を持つ:

| field | 中身 | 無い時 |
|---|---|---|
| `agyid` | 会話のキー | 常にある |
| `created_at`<br>`created_by` | 最初の run の時刻と、頼んだセッションの id | 常にある |
| `model`<br>`effort`<br>`cwd`<br>`dirs` | 最初の run で決まった値。変わらない | 常にある |
| `turns`<br>`usage_total` | 受けた `result` の数と、その `usage` の欄ごとの和 | 0 |
| `last` | 最後の `result`: 受けた時刻、`status`、`finished_reason`、`response` (§7 の退避の文のこともある)、`denied_actions`、`usage`、`duration_seconds` | まだ応答が無い |
| `error` | `result` にならなかった最後の失敗: 時刻、agy が出した文、終了コード、利用枠の戻りの時刻 (読めた時)。次の `SUCCESS` の `result` で消す | 失敗していない |
| `process` | 今のプロセス: pid、argv[0]、出力の置き場のキー (§5)、起こした時刻、出力を読んだ所の byte offset | プロセスが無い |
| `pending` | agy に書いて `result` がまだの依頼の列 (書いた順): 書いた時刻、応答の届け先 (セッションの id と、subagent なら agent id)、`verbose` | 依頼が無い |

- 「ターン中か」は記録に持たず、`pending` が空でないことで言う (A9)。プロセスが「この daemon が依頼を書けるものか」は daemon のメモリ (標準入力を持っているか) で決まり、記録に持たない
- `prompt` の本文は記録に持たない (会話の中身は agy が持つ)
- 記録を永続するのは、daemon が入れ替わった後に、続きの run の起こし方 (model・effort・cwd・dirs)、走っているプロセスの出力の続き、応答の届け先、status の中身が要るから (§10)
- 記録は、最後の動き (`last` か `error` の時刻、無ければ `created_at`) から 30 日で消す (案内の記録の寿命と同じ長さ、`hooks/guidance.ts` の `GUIDED_TTL_MS`)。生きているプロセスを持つ記録は消さない。消えた後の agyid は知らない agyid になる

### 5. プロセスと出力の読み方

- daemon は agy を自分の process group を持つように起こし (起動コマンドと同じ、DR-0018 §3.5)、標準入力は daemon からの pipe、**標準出力と標準エラーはファイル**にする: `<state dir>/agy/out/<起動 id>/stdout.jsonl` と `stderr` (起動 id は `launches/` の `<launch id>` と同じ形)。daemon はこのファイルを続きから 1 行ずつ読み、読んだ所の byte offset を記録に進める
- 読む契機はファイルの変化の通知 (watch) で、時間で読みに行かない。agy が行を逐次にファイルへ書くことが前提 (M1)。自分が起こしたプロセスの終わりは子の終了で知る
- 読む行: `init` (会話の ID)、`result` (ターンの終わり)。行は使う欄だけのスキーマで読む ([DR-0038](./DR-0038-json-is-parsed-by-schema.md))。`step_update` は読んで捨てる。JSON として読めない行と標準エラーは、失敗の材料として末尾の 4096 bytes だけを覚える
- 出力のファイルは、そのプロセスが終わり、最後まで読み終えてから 7 日で消す (`launches/` と同じ寿命と掃除の時)

Design rationale: 子の出力は pipe で読むのが普通で、`launch` もそうしている。ファイルにするのは、daemon が入れ替わって読み手が居ない間も agy がターンを最後まで書き切れ、次の daemon が続きから読めるようにするため (§10、Q2)。代わりに、`step_update` を含む全行がディスクに書かれる。

### 6. run の流れ

同じ agyid への run と abort は、daemon が来た順に 1 つずつ扱う (プロセスを確かめる → 要れば起こす → 依頼を書く、まで。応答の待ちは含まない)。別の agyid は互いを待たない。

| 場合 | daemon がすること | 待ち |
|---|---|---|
| 新しい会話 | 起こす → `init` を待つ → 記録を作る → 依頼を書く | `init` まで (約 4 秒、A2) |
| 続きで、依頼を書けるプロセスがある | 依頼を書く (ターン中でも書く。agy が順に処理する、A3) | 書き込みだけ |
| 続きで、プロセスが無い | `--conversation` で起こす → `init` を待ち、ID が agyid と同じことを確かめる → 依頼を書く | `init` まで |
| 続きで、前の daemon が起こしたプロセスがまだ終わっていない | 何もせずに断る (§10、Q6) | なし |

- どの場合も、受け付けた run の返事は同じ形: `{ agyid, ahead }`。`ahead` は、この依頼より前に書かれて `result` がまだの依頼の数。応答は後で知らせとして届く (§7、K1)
- **`init` の待ちは 15 秒まで** (`launch` の待ちと同じ値。host が fetch を打ち切る 30 秒の内で、実測の約 4 秒の 3 倍強)。過ぎたら process group に SIGTERM、500 ms 後に SIGKILL を送り、起こせなかったものとして返す
- 再開で `init` の ID が agyid と違ったら (agy がその会話を見つけられなかった、A1)、そのプロセスを止めて断る。別の会話に黙って続きを書かない
- 依頼は `init` を受けた後に書く。`init` の前に失敗した run は、会話に何も足していない

受け付けなかった時に tool が返す文:

| 原因 | 文の要点 | 次にすること |
|---|---|---|
| config に `agy` の節が無い | agy は設定されていない | 人が config に節を足して daemon を起こし直す |
| 入力が形に合わない (§3) | 何もしていない: 理由 | 書き直す |
| 知らない agyid | この daemon が発行した agyid ではない。何もしていない | run の返事の agyid を確かめる。新しい会話なら `agyid` を付けずに `model`・`effort` を書く |
| `cwd` / `dirs` が存在するディレクトリでない | どれが無いか | パスを直す |
| ホストで守れない `dirs` (§11) | どの要素か。何もしていない | 書かれてよいなら `write: true` にする。困るなら写しを作って渡す |
| agy を起こせない (ファイルが無い等) | 起こしていない: OS の理由 | 人が `agy.command` を確かめる |
| `init` が 15 秒の内に出ない、または出る前に終わった | 会話は始まっていない。agy が出した文 (退避の文のこともある) | 利用枠 (A13) ならその戻りを待つか、別の系統のモデルで新しい会話を始める。文が無ければサインインを疑い、人が端末で `agy` を 1 回起こす (A14) |
| 再開で別の ID になった | agy がこの会話を見つけられなかった | 新しい会話として run し直す |
| 前の daemon が起こしたプロセスがまだ終わっていない | 今は依頼を足せない。ターン中かどうか | ターン中なら終わりの知らせを待って run し直す (急ぐなら abort)。ターン中でなければ少し後に run し直す |
| daemon が終わりかけている | 受け付けていない | 少し後に run し直す |
| daemon が居ない / plugin より古い | `launch` と同じ文 | `launch` と同じ |
| daemon から返事が無い | 受け付けたか確かめられなかった | 同じ依頼を投げ直さず、status で確かめる (新しい会話なら、受け付けられていれば応答の知らせに agyid が入って届く) |

依頼を書いた後の失敗 (プロセスが `result` を出さずに終わった、利用枠が尽きた) は、その依頼の届け先への知らせで伝える (§7)。

### 7. 応答の届け方

- 応答は依頼ごとに 1 つ、その run を呼んだ会話に知らせとして届ける。経路は `launch` の遅れた結果と同じ (C4): 本体が呼んだ run は `from="ccmsg:daemon"` の封筒で本体の会話に、subagent / teammate が呼んだ run はその agent に (本文の頭に `ccmsg:daemon から:`)。その agent が turn を終えていれば resume されて読み、その turn の終わりに親へ知らせが行く (DR-0018 §3.7 で受け入れた代償と同じ)
- 届け先は依頼ごとに記録の `pending` に持つ。引き継ぎで別のセッションが run すれば、その依頼の応答はそのセッションに届く (K5)。`result` は書いた順に出るものとして `pending` の先頭から当てる (M4)
- 知らせの文は「ccmsg の agy (agyid: <agyid>) が応答した: 」に JSON を続けたもの。最低限は `{ status, finished_reason?, response, error? }`、詳細 (`verbose: true` で頼んだ run) はこれに `usage`・`denied_actions`・`duration_seconds`・`usage_total` を足す
- `result` を出さずにプロセスが終わった時は、`pending` の全部の届け先に「ccmsg の agy (agyid: <agyid>) が応答せずに終わった: 」に `{ error }` (agy が出した文と終了コード、利用枠ならその戻り) を続けて届ける
- **応答が長い時**: `response` が 4096 bytes 以上なら `<state dir>/agy/out/<起動 id>/responses/<連番>.md` に書き、`response` を `output is <N> bytes, file: <path>` にする (C6 と同じ決まり、Q7)。記録の `last.response` も同じ文になる
- **届かなかった時**: 届け先のセッションが走っていない・module が無い・別の id に移った時は daemon.log に書いて終わり、届け直さない (C5)。応答は記録の `last` に残り、どのセッションからも status で読める (K7)
- 前のセッションが投げた依頼の終わりを、引き継いだセッションが待つ時は、自分の run を投げる (agy が前の依頼の後に処理し、その応答が自分に届く)。終わりを時間で見に行く使い方は skill で案内しない
- 知らせを頼んでから、記録の `pending` と読んだ所を進める。この間に daemon が落ちると、次の daemon が同じ応答をもう一度知らせる。取りこぼすより二重を選ぶ
- 知らせには返信しない。続きは `agy` の run で頼む

### 8. status

読むだけで、プロセスに触らず、§6 の順番にも並ばない。返事は JSON:

| 詳しさ | field | 答える問い |
|---|---|---|
| 最低限 | `process`: `"running"` / `"none"` | プロセスが生きているか (`none` なら次の run で起こす約 4 秒がかかる) |
| 最低限 | `pending`: 数 | ターン中か (0 ならターン中でない)。今 run を投げると何件の後になるか |
| 最低限 | `last`: `at`・`status`・`finished_reason`・`response` | 最後の応答は何か (知らせを受け損ねた時、引き継いだ時) |
| 最低限 | `error` | 最後の失敗は何か |
| 詳細 | `model`・`effort`・`cwd`・`dirs`・`created_at` | この会話は何で動いているか |
| 詳細 | `turns`・`usage_total` | どれだけ使ったか |
| 詳細 | `last.usage` (`cache_read_tokens` を含む)・`idle_seconds` (最後の `result` からの経過) | cache が効いていたか、次に効きそうか (A11) |
| 詳細 | `last.denied_actions` | 拒否された道具 |
| 詳細 | `quota_resets_at` | 利用枠はいつ戻るか (最後の失敗が利用枠の時) |

`process` と `pending` は別の問いに答える field で、1 つの状態の語にまとめない。

### 9. abort

- ターン中 (`pending` が空でない) の時だけ働く。daemon は記録の pid が今も記録の argv[0] のプロセスであることを確かめ (C9)、SIGINT を送る (A6)。前の daemon が起こしたプロセスにも送れる
- `interrupted` の `result` かプロセスの終わりを 5 秒まで待つ (A6 の「すぐに」と、`turn_abort` の期限と同じ値、[DR-0044](./DR-0044-turn-abort.md) §2)
- 返事は 3 つ: `aborted` (止まった)、`no_turn` (ターン中でないので何もしていない)、`unconfirmed` (信号は送ったが、5 秒の内に止まったと確かめられなかった)
- 止まった後、プロセスは終わっている (A6)。走っていた依頼の届け先には `interrupted` の応答が、書いてあってまだ始まっていなかった依頼の届け先には「abort で処理されなかった」が知らせで届く (§7)。会話は壊れておらず、次の run で再開して続きを頼める
- **ターン中でないプロセスは止めない** (K6)。abort はターンを止める口で、プロセスを終わらせる口ではない。何もしていないプロセスをいつ終わらせるかは Q8
- agyid を知るどのセッションも abort できる (K5)

### 10. daemon が入れ替わる時

- **終わる時**: 新しい run と abort を断り、走っている agy のプロセスの標準入力を閉じる。信号は送らず、終わりを待たない。ターン中のプロセスは今のターンを終えてから、ターン中でないプロセスはすぐに、正常に終わる (A4)。書いてあってまだ始まっていなかった依頼まで処理されるかは M2 で、処理されなければ下の「応答せずに終わった」になる。記録を書き終えてから lock を放す (許可依頼の状態と同じ順)
- **起きた時**: 記録を読み、`process` を持つ会話ごとに、pid が記録の argv[0] のプロセスとして生きているかを見る
  - 生きていない: 出力を読んだ所から最後まで読み、あった `result` を §7 のとおり知らせ、残った `pending` には「応答せずに終わった」を知らせて、`process` を消す
  - 生きている: 出力の続きを読み続け、`result` を知らせる。pid が生きているかは、セッションの記録の読みと同じ 5 秒ごとに見る ([DR-0034](./DR-0034-peer-socket-injection.md) §5。自分の子でないプロセスの終わりを知らせてくれるものが無い)。終わったら上と同じ
- 前の daemon が起こしたプロセスには依頼を書けない (標準入力は閉じている)。それが走っている間の run は断り (§6)、終わった後の run は再開する。1 会話 1 プロセスの縛りは、入れ替わりの前後でもこの記録の `process` が持つ
- daemon が落ちた時も、標準入力は OS が閉じるので同じ経過になる
- 入れ替わりで失うのは、ターン中でなかったプロセス (次の run で起こし直す約 4 秒) だけで、走っているターンとその応答は失わない

### 11. 安全

- **tool は permission の判定を通らない** (C1)。他の ccmsg の tool と同じ形で、`agy` の呼び出しは auto mode の classifier にも許可のダイアログにも掛からない (Q3)
- **agy は全許可で動き、ホストでは書ける範囲を縛れない** (K3、A12)。合わせると、ホストで動く版の `agy` は、エージェントが classifier の外で任意のコマンドを走らせられる口になる。send・知らせ・subagent への直送が「足されるのは文脈であって権限ではない」(DR-0039 §6 と Consequences) と言え、抜け道を classifier に任せる切り分け ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §4) が成り立つのは、受け手の harness の枠と classifier が後ろに居るからで、agy の後ろには居ない。`launch` も permission を通らないが、起こされたセッションは自分の permission の判定を持つ
- 歯止め:
  - config の `agy` の節 (§2)。節を書いた環境でだけ使える
  - skill の注意 (§13): 人に頼まれていない仕事を頼まない、classifier に止められた操作を agy に頼んで通さない
  - 書ける範囲の囲い。コンテナで動かす版で入る (§12、K3) ので、ホストで動く間に効くのは上の 2 つ
- **`dirs` は囲いではない**。ホストでは `--add-dir` で見せるディレクトリを足すだけで、agy は `dirs` に無い所にも書ける (A12)。skill にそう書く
- **`write: false` と `containerpath`**: ホストで動く版は、`write: false` か `containerpath` を持つ要素のある run を断る (§6 の表、Q4)。受け取って何もしなければ、呼び手は守られていると思い込む。`write` を必須のままにするのは、呼び手に「このディレクトリは書かれうる」と書かせるため
- **送った中身は外に出る** (A16)。`prompt` と、agy が `cwd`・`dirs` から読んだものは、モデルの提供元に送られる。ccmsg の tool は config dir を跨いで使えるので、業務の情報を扱うセッションからも呼べる。どの `cwd`・`dirs` を agy に見せてよいかの判定は daemon では行わず、要る環境は `agy.command` の側で行う (起動コマンドが cwd の信頼を判定するのと同じ分け方、DR-0018 §3.8)
- **agy に継がせる環境** は §2 の `clean_env` で絞る
- **subagent / teammate** の呼び出しは受ける (`launch` と同じ、Q13)。btw の fork ([DR-0060](./DR-0060-btw-mode.md)) からの run は断る: fork は答えを返すと終わり、応答の届け先が残らない
- **`-p` / SDK のセッション** には tool を登録しない (今の tool と同じ、C1)
- 誰が何を頼んだかは daemon.log に 1 行ずつ残す (`agy_run` / `agy_abort`: 頼んだセッション、agyid、`prompt` の長さ、起こしたか、結果)。`prompt` の本文は書かない

### 12. 段階

| 範囲 | ホストで動く最初の版 | コンテナで動かす版 |
|---|---|---|
| tool `agy` の run / status / abort、非同期の応答、会話の記録、daemon の入れ替わりをまたぐ読み | 入れる | そのまま |
| `dirs` | `write: true` の `path` を `--add-dir` で足す | `write: false` と `containerpath` を受け、読み取り専用と見せるパスに使う |
| 書ける範囲の囲い | 無い (§11) | `agy.command` がコンテナで起こし、`dirs` だけを見せる |
| ログインの資格情報の渡し方 | ホストの agy のサインインを使う | コンテナの実験で決める |
| skill の節 | 入れる | 囲いの記述を直す |

- 最初の版だけで目的 (チームメートのように使う) は果たせる: 依頼・非同期の応答・続き・引き継ぎ・中断が揃う
- コンテナの版に要る実測 (Linux 版の agy がコンテナで動くか、資格情報) は M12
- 最初の版に入れないもの: `--agent` と `--json-schema` (Q9)、プロセスの数とメモリの上限 (Q8)、webui の画面 (agy の会話は webui に出ない。人が見られるのは daemon.log の行)

### 13. skill と案内

- skill (`skills/ccmsg/SKILL.md`) の tool の表に `mcp__ccmsg-v1__agy` (別の系統のモデルの会話に頼む) を足し、description にも使い所を 1 句足す
- 足す節「agy の会話に頼む」の骨子:
  - 使い所: 別の系統のモデルの意見が要る時、長い調査や読み込みを任せる時。Bash から `agy` を呼ばない
  - 定型 4 つ: 新しい会話 (`op: "run"`・`prompt`・`model`・`effort`、要れば `cwd`・`dirs`)、続き (`op: "run"`・`agyid`・`prompt`)、status、abort
  - field の決まり: §3 の表。`model` は agy のモデル名で、一覧は人が `agy models` で見る
  - 結果の読み方: run の返事は `{ agyid, ahead }` で、応答は後で `from="ccmsg:daemon"` の知らせとして届く。待つ間に同じ依頼を投げ直さない。知らせには返信せず、続きは run で頼む。長い応答は `output is <N> bytes, file: <path>` になり、その file を Read する。断られた時は文に書いてある次のことをする
  - 引き継ぎ: agyid を引き継ぎの文書に書けば、次のセッションが同じ会話に続きを頼める。前のセッションの依頼の終わりを待つ時は自分の run を投げる
  - cache: 最後の応答から 5 分前後を過ぎると会話の cache は外れる (A11)。経過は status の詳細の `idle_seconds`
  - 注意: `agy` は permission の確認を通らず、agy は全許可で動く。`dirs` に無い所にも書ける。送った中身は外のサービスに出るので、個人の情報や業務の情報を含むディレクトリは、持ち主の明示の指示がある時だけ渡す。人に頼まれていない仕事を頼まない。classifier に止められた操作を agy に頼んで通さない (止められたら `permit`)
- **最初の turn の前の案内 (DR-0039 §5) には足さない** (Q11)

### 14. 検証の計画

本物の agy は利用枠を使うので、試験は agy の stream-json を真似る偽物を `agy.command` に置いて行う。

| 確かめること | 偽物で | 本物でだけ |
|---|---|---|
| 入力の組み合わせの検査と断りの文 (§3、§6) | できる | none |
| 新しい会話: `init` を待って agyid を返し、依頼を書き、`result` を知らせる | できる | `init` までの時間 |
| 続き: 書けるプロセスがある / 無い / ターン中 | できる | none |
| `init` が出ない、出る前に終わる (終了コード 3 と `AGY_ERROR`)、再開で別の ID | できる (偽物がそう振る舞う) | 本物がその時に何をどこに出すか (M5) |
| 応答の届け先: 本体 / subagent / 居なくなったセッション | できる | none |
| 長い応答の退避 | できる | none |
| abort: SIGINT → `interrupted` → 次の run で再開、ターン中でない時は何もしない | できる (偽物が SIGINT で `interrupted` を出して終わる) | 起こした pid への信号で止まるか (M3)、始まっていない依頼の扱い (M4) |
| daemon の入れ替わり: 標準入力が閉じた後もターンを終え、次の daemon が続きを読んで知らせる | できる (試験の中で daemon を止めて起こし直す) | 本物が親の終了後も書き切るか (M2)、ファイルに逐次に書くか (M1) |
| 同じ agyid への同時の run が 1 つのプロセスに順に書かれる | できる | none |
| `write: false` / `containerpath` をホストで断る | できる | none |
| 記録と出力の寿命の掃除 | できる | none |

「持たない」を壊す変更を止める試験の観点:

- daemon は、依頼も abort も無いのに agy のプロセスを起こさず、止めない (終わる時に標準入力を閉じるだけ)
- daemon は、書けなかった依頼を覚えておいて後で書かない
- 同じ agyid に、同時に 2 つのプロセスを起こさない (入れ替わりの前後を含む)
- 続きの run は、記録の model・effort・cwd・dirs で起こし、入力のものを使わない
- 知らない agyid では何も起こさない
- tool の input schema は top-level に `oneOf` / `anyOf` を持たない

## 未決

各問いは、原意図、選択肢ごとの意味の違い、起草時の推しの順に書く。

### Q1. agyid を agy の会話の ID にするか、ccmsg が別の ID を振るか

- 原意図: 初回に受け取った ID で続きを頼める (仕様案)。agyid はすぐ返す (K1)
- 選択肢:
  - (a) agy の `conversation_id` をそのまま使う: 対応表が要らず、agy のログや端末の `--conversation` と同じ値で追える。新しい会話の返事は `init` まで約 4 秒待つ。`init` の前の失敗 (利用枠、サインイン) は run の返事で分かる
  - (b) ccmsg が ID を振る: 返事は待たずに返せる。`init` の前の失敗は後の知らせでしか分からず、agyid を受け取っても会話が始まっていないことがある。ccmsg の ID と agy の ID の対応を記録に持つ。再開で agy が別の ID の会話にした時 (A1) に agyid を変えずに済む
- 推し: (a)。issue の実測の読み (「応答を待たずに agyid を返せる」) と合い、ccmsg が振る ID を増やさない。約 4 秒の待ちは tool の往復として短く、agyid を受け取った時点で会話が始まっていることが言える

### Q2. daemon の入れ替わりで、走っているターンを守るか

- 原意図: 重い依頼は 20 分かかる (K6)。daemon は plugin の版が上がるたびに、新しい版の client の接触で入れ替わる (C7)。その契機は agy を使っているセッションの外にある
- 選択肢:
  - (a) 守る (§5、§10): 出力をファイルに向け、終わる時は標準入力を閉じるだけにする。走っているターンは最後まで走り、次の daemon が応答を知らせる。代わりに、出力の全行がディスクに書かれ、前の daemon のプロセスが走っている間は依頼を足せない (Q6)。M1・M2 の実測が要る
  - (b) 止める: 出力は pipe で読み、終わる時に走っているターンを SIGINT で止めて「daemon の入れ替わりで止まった」と知らせる。作りは単純で、出力のファイルも pid の見張りも要らない。入れ替わりのたびに、走っていた依頼はやり直しになる
  - (c) 中継のプロセスを会話ごとに置く: 入れ替わりの後も依頼を足せる。常駐のプロセスが会話ごとに 1 つ増える
- 推し: (a)。release は 1 日に 7〜41 回あり (2026-11-21〜25 の Release の commit の数)、新しい版が入るたびに入れ替わりうるので、(b) は 20 分の仕事を何度も捨てる。(c) が (a) より足すのは「入れ替わりの直後にも依頼を足せる」ことだけで、プロセスを増やす分に見合わない

### Q3. tool `agy` を permission の判定に通すか

- 原意図 (issue): classifier に引数の違うたびに止められないようにする。issue は「tool 名の完全一致 allow 1 つで済む」と書くが、今の tool の作りは判定を通らないので allow も要らない (C1)
- 選択肢:
  - (a) 他の tool と同じく通さない: 何も足さずに作れる。エージェントは、classifier に止められた操作を agy に頼めば通せる (§11)
  - (b) 通す: エージェントの呼び出しを classifier が見る。プロジェクトごとに人が allow を 1 つ足せば、以後は classifier を通らずに使える (allow を足すのが人の明示の判断になる)。今の engine で「判定を通しつつ自前で答える」形は見つかっていない (DR-0039 の Alternatives) ので、M10 の実測が要る。できなければこの選択肢は取れない
  - (c) (a) の上で、config の `agy` の節がある環境でだけ使えるようにする (§2): plugin を入れただけの環境には口が出ない。使えるようにするのは人の 1 度の判断
- 推し: (c)。目的そのものが「classifier に止められずに agy を使う」ことで、書ける範囲の歯止めはコンテナの囲いで掛ける方針 (K3)。ホストで動く間は囲いが無いので、口を開けるのを人の config に寄せる。(b) は (c) と別の軸 (判定を通すか / 口をどこで開けるか) で、M10 が通れば (c) の上に足せる

### Q4. ホストで守れない `dirs` の値 (`write: false`、`containerpath`) をどう受けるか

- 原意図 (仕様案): 見せるディレクトリごとに、書けるかと、コンテナの中のパスを決める。どちらもコンテナで動かす時だけ効く (issue)
- 選択肢:
  - (a) 形は仕様案のまま受け、ホストでは守れない値のある run を断る (§3、§11): schema は版をまたいで変わらない。呼び手は毎回 `write: true` と書く
  - (b) 最初の版の schema から `write` と `containerpath` を外し、コンテナの版で足す: 効かない field が見えない。版が変わる時に schema が変わり、走っているセッションの古い module と食い違う (protocol の minor、DR-0002 §4)
  - (c) 受けて、依頼の本文に「このディレクトリには書かない」と足す: 守られないことがある (reference の `agy/permissions`)。呼び手は守られたかを知れない
  - (d) 受けて無視する: 呼び手に嘘をつく
- 推し: (a)。仕様案の形を保ち、守れないことは断って言う。(c) と (d) は「守られている」という誤解を作る

### Q5. agy の起こし方をどこが持つか

- 原意図: 最初はホスト、コンテナの実験を並行して、使えそうになったら切り替える (K3)
- 選択肢:
  - (a) daemon が agy の引数を組み、先頭のコマンドだけ config で差し替えられる (§2): 契約は「agy と同じ引数と入出力と SIGINT」の 3 つ。コンテナへの切り替えは config の差し替えで済む。`dirs` の `containerpath` / `write` をコンテナにどう渡すかは、この形では決まらない (コンテナの版で決める)
  - (b) daemon が `agy` を固定で起こす: config も契約も無い。コンテナの版では daemon がコンテナの起こし方を持つ
  - (c) 起動コマンドと同じ形 (`launch_command`) にし、入力を JSON で渡して起こし方を丸ごと任せる: cwd の信頼の判定や環境ごとの都合を全部そちらに置ける。標準入力は依頼の流れに使うので、JSON を渡す別の道 (引数か環境変数) と、新しい契約の文書が要る
- 推し: (a)。実験の間はコンテナの起こし方が定まらず、差し替えられる所が 1 つあれば daemon を作り直さずに試せる。(c) の契約は、コンテナの渡し方が見えてから決める方が外れない

### Q6. 前の daemon が起こしたプロセスがまだ終わっていない間の run

- 原意図 (仕様案): どの場合も tool の利用側からは違いが見えない。順番待ちは agy が持つ (A3)
- 選択肢:
  - (a) 断る (§6): ccmsg は依頼を預からない。呼び手は終わりの知らせの後に run し直す。「違いが見えない」がこの場合だけ崩れる
  - (b) daemon が依頼を記録に預かり、前のプロセスが終わったら再開して書く: 利用側からは違いが見えない。ccmsg が永続の順番待ちを持ち、預かった依頼が daemon の入れ替わりや失敗をまたぐ時の扱いが要る
- 推し: (a)。起きるのは「入れ替わりの時にターン中で、その応答の前に次の依頼を投げた」時だけで、応答を待ってから次を頼む使い方では起きない。順番待ちを持たないことを優先する

### Q7. 応答をファイルに退避する大きさ

- 原意図: 知らせは会話に入るので、長い応答はそのまま context を使う。`launch` は 4096 bytes 以上をファイルにしている (C6)
- 選択肢:
  - (a) `launch` と同じ 4096 bytes: 決まりと部品と skill の読み方が 1 つで済む。日本語で 1,300 字ほどを超える応答は毎回 Read が 1 回要る
  - (b) もっと大きくする (例: 16 KiB): 多くの応答が知らせだけで読める。読まない応答も context を使い、peer 注入で届く大きさの実績が無い (M14)
  - (c) 退避しない: 応答が何であれ会話に入る
- 推し: (a)。応答をファイルで渡せば、呼び手は要る所だけ読める。大きくするのは M14 の後でできる

### Q8. 何もしていないプロセスをいつ終わらせるか (issue の未決)

- 原意図: 雑に殺さない (K6)。一方、会話ごとにプロセスが 1 つ残り、数とメモリが増える
- 選択肢:
  - (a) ccmsg は終わらせない: プロセスが終わるのは、abort、daemon の入れ替わり (標準入力が閉じる)、agy 自身の終了だけ。数は会話の数だけ増える
  - (b) 数の上限を持ち、超える新しい会話の run を断る: プロセスは殺さない。上限の値の根拠 (1 プロセスのメモリ) が要る
  - (c) 最後の応答から一定の時間が過ぎたプロセスの標準入力を閉じる: cache が外れた後 (A11) にプロセスを残す利得は起こし直しの約 4 秒だけ。`result` の後に裏の処理が残らないこと (M8) が前提で、時間の値が要る
- 推し: (a) で始め、daemon.log に生きているプロセスの数を残して、困った時に (b) を足す。(c) は M8 が無いと K6 に触れる

### Q9. 新しい会話の任意の項目に `--agent` と `--json-schema` を入れるか (issue の未決)

- 原意図: `--agent` は agy の agent 定義でシステムプロンプトと道具を決め、`--json-schema` は応答の形を決める
- 選択肢:
  - (a) 最初の版には入れない: 入力は §3 のまま
  - (b) `agent` を入れる: 定義の `tools` を書かないと全許可でもシェルを使えない等、定義の書き方の案内が skill に要る (reference の `agy/agents`)
  - (c) `json_schema` を入れる: stream-json の `result` に `structured_output` が入るか (M11) と、知らせにどう載せるかが要る
- 推し: (a)。どちらも無くても目的は果たせ、入れるなら使いたい場面が出てから 1 つずつ足せる

### Q10. tool を 1 つにして `op` で分けるか、動作ごとに分けるか

- 原意図 (K9): tool は 1 つ
- 今の tool との違い: 今の 6 つは 1 つの tool が 1 つの動作で、`op` で動作を分ける tool は無い。`launch` は起動の種類を `type` で分ける案を採らなかった (DR-0018 §6) が、理由は claude のオプション名と別の語彙になることで、動作の違う `op` には当たらない
- 選択肢:
  - (a) 1 つ (§3): 登録と skill の節が 1 つ。field の組み合わせの検査が handler に要る (§3 の表)
  - (b) 3 つ (`agy_run` / `agy_status` / `agy_abort`): 各 schema が小さくなり、書くと断る field の表が要らない。tool の一覧に名前が 3 つ載る
- 推し: (a)。3 つの動作は同じ会話への操作で、1 節で説明できる。(b) の利点は schema の小ささだけで、deferred の tool では context の差も名前 2 行分

### Q11. 最初の turn の前の案内に agy を足すか

- 原意図: エージェントが agy を使えることを知る。案内は skill への誘導に留める (DR-0039 §5)
- 選択肢:
  - (a) 足さない。skill の description に使い所を足す (§13): 全セッションの会話に入る文が増えない。agy を使うのは skill の一覧から辿った時
  - (b) 案内に 1 句足す: どのセッションも最初から知る。`agy` の節の無い環境のセッションにも載る
- 推し: (a)。agy を使うのは人が頼んだ時が主で、その時に skill の description から辿れる

### Q12. daemon が知らない agyid を受けるか

- 原意図: 初回に受け取った ID で続きを頼む (仕様案)
- 選択肢:
  - (a) 断る (§4): tool で開ける会話は、この daemon が始めたものだけ。記録が消えた会話 (30 日、state dir を消した時) は tool から続けられない
  - (b) `model`・`effort` を添えた run なら、記録を作って再開する: 人が端末で始めた会話や、記録の消えた会話を続けられる。続きの run に `model` 等を書けない決まり (§3) に例外ができ、ccmsg の外で開かれている会話を開きうる
- 推し: (a)。1 会話 1 プロセスの縛りを、この daemon の記録の中で閉じる

### Q13. subagent / teammate からの呼び出し

- 原意図: チームメートのように使う (目的)。今の tool は、人の許可や人のコメントが本体に届くもの (`permit`、`comment_reply`) だけ subagent を断る (C2)
- 選択肢:
  - (a) 受ける (§11): worker が別の系統のモデルの意見を取れる。応答はその agent に届き、終わっていれば resume されて親に知らせが行く
  - (b) 断る: 応答の届け先は本体だけになる。worker は委譲元に頼んでもらう
- 推し: (a)。`launch` と同じ扱いで、届ける経路は既にある

### Q14. 軽い確認 (推しのまま進めてよいか)

- `verbose` (boolean) の名前と型。詳しさは 2 段だけなので boolean にした
- `cwd` を省いた時は呼び手のプロジェクトのディレクトリ、`dirs` を省いた時も同じ 1 つ、`[]` は「足さない」(§3)
- `init` の待ちの 15 秒、abort の待ちの 5 秒 (§6、§9)
- 記録の寿命 30 日、出力のファイルの寿命 7 日 (§4、§5)
- agy に継がせる環境から `CLAUDE*` と `ANTHROPIC_*` を既定で落とす (§2)

### 再考の提案

#### R1. 新規の時の `effort` を必須にするか (K2)

本文は K2 のとおり `model` と `effort` を必須にしている。agy のモデル名は強さを含み (`gemini-4-carbon-high`、A15)、`--effort` はそれと別に指定できる。2 つが食い違う呼び出し (`model: "gemini-4-carbon-high"`、`effort: "low"`) でどちらが効くかは実測に無い (M6)。必須のままだと、呼び手は毎回 2 か所に強さを書き、食い違いを作れる。M6 の結果が「モデル名の強さが効き、`--effort` は無視される」か「食い違いはエラー」なら、`effort` を任意にする (か、無くす) ことを提案する。「`--effort` が勝つ」なら今のままで良い。

## 要る実測

本物の agy を呼んで確かめること。設計のどこに効くかを添える。

- M1: 標準出力をファイルに向けて起こした時、stream-json の行が逐次に書かれるか (`init` が約 4 秒で読めるか)。§5、Q2
- M2: 自分の process group で起こした agy が、起こした親が終わって標準入力が閉じた後も、走っているターンを終えて `result` を書き、正常に終わるか。その時、書いてあってまだ始まっていなかった依頼も処理されるか。§10、Q2
- M3: 起こした pid (ラッパを起こした pid) への SIGINT で `interrupted` の `result` が出るか。`agy.command` を別のコマンドにした時に信号が本体に届く条件。§9、§2
- M4: `result` が依頼を書いた順に出るか、`result` に依頼を見分ける欄があるか。SIGINT の時、書いてあってまだ始まっていない依頼に `result` が出るか。§7、§9
- M5: stream-json で起こした時の、サインインしていない場合と利用枠が尽きている場合の出方 (標準出力か標準エラーか、JSON の行か、`init` の前か後か、終わるまでの時間)。§6
- M6: モデル名の強さと `--effort` が食い違う時にどちらが効くか。agy が知らないモデル名を渡した時の出方。§3、R1
- M7: `conversation_id` の形。再開した時の `init` の `conversation_id` が渡した ID と同じこと。§4、§6
- M8: `result` の後に、agy の中の裏の処理 (background の subagent 等) が残ることがあるか。Q8
- M9: ターン中に agy が標準入力を読み進めるか (pipe のバッファを超える大きさの依頼を、ターン中に書き切れるか)。§6
- M10: tool の handler が、permission の判定を通した上で自前で答える形が engine にあるか (`$.tool.check` 等)。Q3
- M11: stream-json の `result` に `--json-schema` の `structured_output` が入るか。Q9
- M12: Linux 版の agy がコンテナで動くか、ログインの資格情報をどう渡すか (issue の未決)。§12
- M13: Gemini のモデルの cache の寿命 (issue の未決)。§13 の skill の文
- M14: peer 注入で届けられる本文の大きさ。Q7
- M15: 長い依頼 1 回で標準出力に書かれる量 (`step_update` を含む)。§5 の出力のファイルの大きさ

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| hooks module が agy のプロセスを持つ | セッションの終了で会話のプロセスが終わる。別のセッションからの run と、同時オープンの縛りを掛ける場所が無い (§1) |
| 依頼のたびに `agy -p --conversation <ID>` を起こし、常駐させない | 起こすたびに約 4 秒かかり、ターン中に来た依頼を ccmsg が預かることになる (順番待ちを増やす)。仕様案は stream-json での入出力 |
| `agy acp` (Agent Client Protocol) で話す | 操作する側を自前で書く必要がある (reference の `agy/agents`)。stream-json で目的は果たせる |
| daemon が終わる時に、走っているターンの終わりを待つ (起動コマンドと同じ) | ターンは 10〜50 分かかることがあり (A9)、その間 daemon の入れ替わりが止まる |
| 届かなかった応答を預かり、届け先が戻ったら届け直す | 知らせは預からない (C5)。応答は記録に残り、status で読める (§7) |
| 続きの run で `model` を替えられるようにする | K4。agy は受ける (A5) が cache が効かなくなる (A11) |
| abort でターン中でないプロセスも止める | K6。プロセスを終わらせる口は Q8 で決める |
| Bash の決まったコマンドにし、変わる部分をファイルで渡す (reference の `agy/from-claude-code` の台) | 完全一致の allow をプロジェクトごとに足す必要があり、非同期の応答と会話の続きを持てない |

## Consequences

- protocol: tool の入力のスキーマ、op `agy_run` / `agy_status` / `agy_abort` とその返事、断りの code (`agy_not_configured` 等)、知らせの文。module が取り込む契約が変わるので `PROTOCOL_VERSION` の minor が上がる (DR-0002 §4)
- daemon: agy の会話を扱う関心が 1 つ増える。state dir に `agy/` (会話の記録と出力)、config に `agy` の節。終わる時と起きた時の手順に §10 が足される
- daemon が初めて、自分より長く生きる子を持ち、次の daemon がその出力を読み継ぐ (C7 が変わる)。自分の子でないプロセスの終わりを、5 秒ごとの pid の確認で知る
- module: tool の登録が 7 つになり、handler が 1 つ増える
- skill: 節が 1 つ増え、description が長くなる
- ホストで動く間、`agy` は classifier の外で任意のコマンドを走らせられる口になる (§11)。agy は daemon と同じ uid のプロセスなので、ccmsg の socket や Claude Code の peer の token にも届く。「同じ uid の抜け道は classifier に任せる」という切り分け (DR-0035 §4、DR-0046 §5) は、classifier の外で動く agy には効かない
- 業務の情報を扱うセッションからも呼べ、渡した中身は外のサービスに出る (§11)
- agy の stream-json の形・信号の振る舞い・`init` の中身に依存する。agy の版が上がって形が変わると、daemon は行を読めなくなる。読めない行は失敗の材料として残る (§5) ので、黙って待ち続けることにはならないが、応答は届かない
- 人は agy の会話を webui で見られない。走っている会話は daemon.log の行と status でしか分からない
- 会話ごとにプロセスが 1 つ残りうる (Q8)。出力のファイルは `step_update` の全行を持つ (M15)
- 知らせは、daemon が落ちた直後に同じ応答を 2 度届けることがある (§7)

## 関連

- [issue 2026-11-25-agy-tool](../issue/2026-11-25-agy-tool.md) — 仕様案、議論で決まったこと、agy の実測
- claude-rules-personal の reference の `agy/` (`headless`・`permissions`・`agents`・`from-claude-code`) — agy の実測の詳細と再現手順
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — typed tool の登録の形、「mods の tool の作り方」、知らせの注入 (§9)
- [DR-0018](./DR-0018-session-launcher.md) — tool `launch` (daemon が外のコマンドを起こし、遅れた結果を知らせで戻す前例)、出力の退避
- [DR-0046](./DR-0046-module-op-over-http.md) — module から daemon への `POST /op`
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 — 預からない
- [DR-0044](./DR-0044-turn-abort.md) — セッションの turn の中断 (結果の語彙)
- [DR-0028](./DR-0028-session-kill.md) — 信号を送る前に pid を確かめる
- [DR-0002](./DR-0002-daemon-supervision.md) — daemon の入れ替わり、protocol の版、子に継がせる `TMPDIR`
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — 入力と agy の出力をスキーマで読む
- [issue 2026-11-20-daemon-env-carries-spawning-session-identity](../issue/2026-11-20-daemon-env-carries-spawning-session-identity.md) — daemon の環境に残るセッションの変数
