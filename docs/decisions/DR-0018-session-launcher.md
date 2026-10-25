# DR-0018: Session Launcher (エージェントの tool `launch` と webui のフォームから、config で固定した 1 つの起動コマンドでセッションを起動する)

Status: Accepted (2026-07-16、§3 は 2026-10-25 の kawaz 裁定) — ✅ 実装済み (§4 の段 1〜5: protocol の起動の入力と op、daemon の config と起動の手順と出力の退避、tool `launch` と `ccmsg sidecar launch` と skill の節、webui のフォームと prefill と結果パネル、runbook の `session-launcher-setup` と `fork-rescue`)
Date: 2026-07-15
Sponsor: kawaz

## 1. 背景

別の Claude セッションを起動したい場面は 2 つある。

- **人が webui から**: model / effort / cwd / プロンプトを毎回端末でタイプせずに、サイドバーの「新規」や、過去セッションの検索結果の「resume」、Timeline の「ここから fork」から起動したい
- **エージェントが**: worker を立てる、作業を別セッションへ引き継ぐ。今はエージェントが起動用のスクリプトを Bash で叩いており、(a) 引数の渡し方がぶれて prompt が捨てられる事故が起き、(b) Bash で別セッションを起動すること自体が auto mode の classifier に止められる

どの claude を、どの端末 (detached の端末 proxy 等) で、どの trust 判定の下で起動するかは kawaz の環境の都合で、ccmsg が知るべきことではない。

## 2. スコープ

### 2.1 目的

起動の依頼を、型の決まった入力 (claude のオプションをそのまま field にしたもの) で人とエージェントの両方から受け、config で固定した 1 つの起動コマンドに渡し、そのコマンドの結果をそのまま返す。

**増やしたくないもの**: daemon と webui が持つ「起動の仕方の知識」。claude の引数の組み立て、端末への載せ方、cwd の信頼判定、model ごとの effort の既定、セッション名の装飾、trust ダイアログの通し方は起動コマンドが持つ。daemon が持つのは「入力を検査し、新しいセッションの id を決め、コマンドに JSON で渡し、終わりを待って結果を返す」だけ。入力の field 名も claude のオプション名に揃え、ccmsg 独自の語彙 (起動の種類の名前等) を間に挟まない。

### 2.2 やること

- claude のオプションを field にした起動の入力 (§3.2) と、それを受ける op `session_launch` (§3.4)
- エージェント向けの MCP tool `launch` (§3.7、[DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 の typed tool の 1 つ)
- webui の新規セッションフォーム (§3.9) と、cwd を選ぶディレクトリツリー (`dir_tree`、§3.4)

### 2.3 やらないこと

- **プロセス管理をしない** (kawaz: 「プロセス管理したがりがちなのを抑制するため『深追いしない』と言った」)。起動後の pid の追跡、stdin への送信、終了の監視、進捗、自動再起動はしない。起動コマンドを実行して結果を返したら終わり
- **セッションへの到達を確かめない**。起動したセッションが hello で daemon に名乗れば peers に載る (既存の経路、[DR-0009](./DR-0009-session-transcript-access.md))。確かめるのは呼び手で、エージェントは `peers` を使う
- **起動コマンドの終了コードを解釈しない**。成否の判断は呼び手に返す
- config の UI 編集 (手編集で足りる)

## 3. 設計

### 3.1 config

既存の daemon config (`<configDir>/config.{ts,js,json}`) の `session_launcher` キー (LN-Q1)。

```ts
session_launcher: {
  launch_command: ["launch-claude"],   // 省略すると組み込みの起動コマンド
  root_dirs: ["~/src/github.com/kawaz/", "~/src/github.com/<organization>/"],
  dir_tree_depth: 2,
  launch_timeout_seconds: 10,
  launch_max_concurrency: 4,
  clean_env: ["CLAUDE*", "ANTHROPIC_*"],
  keep_env: ["CLAUDE_CONFIG_DIR"],
}
```

起動そのものの設定は `launch_` で始まる名前に揃える (`launch_command` / `launch_timeout_seconds` / `launch_max_concurrency`)。`root_dirs` / `dir_tree_depth` は webui の cwd ツリーの、`clean_env` / `keep_env` は起動コマンドの環境の設定。

- **`launch_command`** (省略可): 起動コマンドの argv (空でない文字列の配列)。省略すると plugin に同梱の**組み込みの起動コマンド** (`packages/daemon/src/default-launch-command.ts`) を、daemon を動かしている bun (`process.execPath`) で `[<bun>, <組み込みスクリプト>]` として実行する。組み込みは stdin の JSON の field を同じ名前の claude のオプションに写し、`hyoui run --detached -- claude <オプション>` を加工せずに実行して hyoui の終了コードで終わる (契約と中身は [launch-command](../design/launch-command.md) の「組み込みの起動コマンド」)。面の切替・cwd の信頼判定・trust ダイアログの吸収等が要る環境は自前のコマンドを書く。shell を介さずに実行する。先頭の要素は絶対パス、`~/` で始まるパス、または daemon の `PATH` で探す名前で、config を読む時に実行できるファイルの絶対パスに固定する (`~/` を展開し、名前は `PATH` で探す)。見つからない・実行できない時、`~` 単体の時は読めない config として daemon を起動時に止める。起動のたびに探し直さないので、起動の後で `PATH` やファイルが変わっても、起動したものと違うものを実行しない。起動コマンドが受ける入力と返すものの契約は [launch-command](../design/launch-command.md)
- **`root_dirs`** (必須、空でない): webui の cwd ツリーの根。絶対パスか `~/…`。起動の cwd をこの配下に限ることはしない (cwd の信頼判定は起動コマンドの責務、§3.8)
- **`dir_tree_depth`** (既定 2、1 以上の整数): cwd ツリーの初期ロードの深さ (LN-Q3)
- **`launch_timeout_seconds`** (既定 10、1〜50 の整数): 起動コマンドを待つ時間。超えたら SIGTERM、その 500 ms 後に SIGKILL (§3.5)。上限は tool の待ち (§3.7 の 65 秒) に、kill の猶予と出力の待ちと daemon の起動を待つ分が収まるように置く
- **`launch_max_concurrency`** (既定 4、1〜16 の整数): 同時に走らせる起動コマンドの数の上限。超えた依頼は起動コマンドを走らせずに `launch_busy` で断る。依頼者ごとの頻度の制限はしない (上限は daemon が抱えるプロセスの数に置く)
- **`clean_env` / `keep_env`** (既定 `[]`): 起動コマンドに渡す環境から落とすキーと、落とさずに残すキーのパターン。daemon はあるセッションの中の shell から起動されることがあり、そのセッション由来の変数 (`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_CHILD_SESSION` 等) を持っている。それが新しいセッションへ流れて動作を変えるのを防ぐ。パターンは `*` がキー名の中の任意の文字列 (改行を含む) で、それ以外はリテラル (大文字小文字を区別、キー名全体との一致)。両方に当たるキーは残す (`keep_env` が勝つ)。広い `CLAUDE*` で落としつつ、面の分離に要る `CLAUDE_CONFIG_DIR` を残すのがこの優先の用途。daemon が足す変数 (`CCMSG_LAUNCH_REQUESTED_BY`、§3.5) は clean / keep の判定の後に重ねるので、`CCMSG_*` を落とすパターンでも必ず届く
- config は 1 つのスキーマで読み ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §6)、読めなければ daemon は起動時に止まる。エラーは読めない所ごとに `config: <file>: <場所>: <理由>` の 1 行で daemon.log に書かれ、CLI が spawn した daemon ならその行が CLI のエラーとして出る。壊れた所だけ捨てて起動したり、不正な値を既定値に読み替えたりはしない。既定値は値が無い時だけスキーマが与える。`session_launcher` に上の 7 つ以外のキーがあっても読めない。`session_launcher` の節が無ければ起動は設定されていない (`launcher_not_configured`、§3.4)。節があれば `launch_command` が無くても起動できる
- config の変更は daemon の再起動で反映する (LN-Q4)

### 3.2 起動の入力 (op と webui で共通、tool はその部分)

`packages/protocol` (`launch.ts`) に置き、tool の handler、daemon の op、webui のフォームが同じスキーマで読む。field は claude のオプション名の snake_case で、引数の無いオプションは boolean。

```ts
export const LaunchFieldsSchema = v.strictObject({
  cwd: LaunchCwdSchema,                          // 絶対パス
  model: v.optional(LaunchModelSchema),          // fable | opus | sonnet | haiku
  effort: v.optional(LaunchEffortSchema),        // low | medium | high | xhigh | max
  continue: v.optional(v.boolean()),
  resume: v.optional(SessionUuidSchema),         // 小文字の uuid (hello の sid と同じ形)
  resume_session_at: v.optional(SessionUuidSchema),
  fork_session: v.optional(v.boolean()),
  name: v.optional(NonEmptySchema),
  prompt: v.optional(NonEmptySchema),
});

export const LaunchInputSchema = v.pipe(
  LaunchFieldsSchema,
  // 組み合わせの検査 (下の表)。v.forward(v.partialCheck(...), [<直す field>]) で書く
);

export const LaunchToolFieldsSchema = v.omit(LaunchFieldsSchema, ["resume_session_at"]);
```

| field | claude のオプション | 意味 |
|---|---|---|
| `cwd` | (起動の cwd) | セッションを起動するディレクトリ (絶対パス、必須)。`continue` はここで「最も新しい」を探す |
| `model` / `effort` | `--model` / `--effort` | 新規 (`continue` も `resume` も無い) では必須。それ以外で無ければ起動コマンドが決める |
| `continue` | `--continue` | cwd で最も新しいセッションの続き |
| `resume` | `--resume` | 指定したセッションの続き (id は変わらない) |
| `resume_session_at` | `--resume-session-at` | fork 地点の transcript の record の uuid。その record までを写す。無ければ先端まで。`fork_session` と一緒にだけ指定できる |
| `fork_session` | `--fork-session` | `continue` / `resume` の元の履歴を写した新しいセッションにする |
| `name` | `--name` | セッション名。無ければ起動コマンドが決める |
| `prompt` | (位置引数) | 最初の prompt。無ければ起動コマンドが決める |

組み合わせの検査は、claude 自身が拒む・黙って無視する組み合わせ ([findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md)) をスキーマで弾く。理由は直す側の field に付ける。

| 組み合わせ | 理由を付ける field |
|---|---|
| `continue` と `resume` の同時指定 | `resume` |
| `fork_session` に `continue` も `resume` も無い | `fork_session` |
| `resume_session_at` に `fork_session` が無い (fork しない resume に fork 地点は意味が無く、claude の扱いも未観測) | `resume_session_at` |
| 新規 (`continue` も `resume` も無い) で `model` が無い | `model` |
| 新規で `effort` が無い | `effort` |

- 検査は読む field が読めた時点で走る (`partialCheck`)。他の field が読めなくても組み合わせの理由も出るので、webui のフォームは理由を一度に全部出せる。新規の `model` / `effort` の理由の文 (`LAUNCH_CHOOSE_MESSAGE`、「選んでください …」) はスキーマが持ち、webui は別の文を持たない
- `continue` / `fork_session` の `false` は付けないのと同じ。`name` と `prompt` に空文字は受けない (「指定しない」の言い方を field の不在 1 つにする)
- `strictObject` で、知らない field は読めない入力になる。黙って捨てると、呼び手は渡した値が効いたと思い込む
- **tool の入力** (`LaunchToolFieldsSchema`) は op の入力から `resume_session_at` を外したもの (§3.7)。fork 地点は transcript の record の uuid で、エージェントにはそれを知る手段が無い。スキーマを 2 つ手書きせず `v.omit` で導き、組み合わせの検査は tool の handler も `LaunchInputSchema` で行う

### 3.3 起動コマンドの入力 (stdin の JSON)

起動の入力 (§3.2) とは別の型 (`LaunchCommandInputSchema`) で、`cwd` を daemon が realpath に解決し、新しいセッションを作る時は `session_id` を足したもの。field は全部 claude のオプションと 1 対 1 (`session_id` は `--session-id`) で、オプションに無い名前の field は入れない。依頼者は環境変数で渡す (§3.5 の 6)。

| field | 意味 |
|---|---|
| (§3.2 の field) | 起動の入力のまま。`cwd` は realpath |
| `session_id` | daemon が生成した新しいセッションの id (UUID v4、`crypto.randomUUID()`)。新規 (`continue` も `resume` も無い) と `fork_session` の時だけ |

- 起動コマンドは `session_id` を `claude --session-id` に渡す。fork で `--resume <元> --fork-session --session-id <新>` が効くこと (`-p` と対話の両方、`--resume-session-at` との併用は `-p`) は [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) で確かめた
- fork でない `continue` / `resume` には足さない。claude は fork でない `--continue` / `--resume` に `--session-id` を付けると起動しない (同 findings)。`resume` の id は `resume` のまま、`continue` の id は claude が選ぶセッションの id で、daemon は知らない
- claude の引数への写し方、fork 地点のある fork の二段起動、終了コードの意味は [launch-command](../design/launch-command.md) が正本

### 3.4 protocol

- **`session_launch`** — 起動
  - request: `{ op: "session_launch", launch: LaunchInput }`
  - role: user と session の両方 (§3.8)
  - response: `{ ok: true, session_id?: string, exit_code: number, stdout: string, stderr: string }`
    - `session_id`: 新しいセッションを作る起動 (§3.3) で `exit_code` が 0 の時だけ、起動コマンドに渡した id を返す。非 0 の時と、fork でない `continue` / `resume` では含めない。起動コマンドは失敗を全部セッションを起動する前に非 0 で返し、起動した後は 0 で終わる契約なので ([launch-command](../design/launch-command.md) の「戻り方」)、非 0 ならその id のセッションは無い
    - `exit_code`: 起動コマンドの終了コード。signal で終わった時は `128 + <signal の番号>` (shell の慣習。timeout の SIGTERM なら 143、SIGKILL なら 137)
    - `stdout` / `stderr`: 起動コマンドの出力 (UTF-8)。無ければ `""`。4096 bytes 以上なら本文の代わりに `output is <N> bytes, file: <path>` (§3.6)
  - error: `launcher_not_configured` (config に `session_launcher` が無い)、`invalid_args` (入力がスキーマに合わない、`cwd` が存在するディレクトリでない。msg に最初の理由)、`launch_busy` (`launch_max_concurrency` 個の起動が走っている、または daemon が終わりかけている。起動コマンドは走らせていない)、`launch_command_unavailable` (起動コマンドを起こせなかった。exit code が無いので response の形にできない。msg に起動コマンドの path、cwd、OS の理由)
  - 返事は起動コマンドの終わり (最長 `launch_timeout_seconds` + kill の猶予 + 出力の待ち) まで遅れる。同じ接続の他の依頼は待たせない
- **`session_launcher_config`** — フォームの材料 (user role)。response `{ ok: true, root_dirs: string[], default_effort: { fable?, opus?, sonnet?, haiku? } }`
  - `default_effort`: daemon が自分の `CLAUDE_CONFIG_DIR` (無ければ `~/.claude`) の `settings.json` を依頼のたびに読み、`modelSettings.<model>.effortLevel` を model ごとに返す。settings.json は Claude Code のファイルなので使う field だけをスキーマで読み、model ごとに別に読む。ファイルが無い・読めない時は `{}`、設定の無い model と effort の選択肢に無い値の model は省く。起動コマンドが daemon の `CLAUDE_CONFIG_DIR` を `keep_env` で継ぐ時、これが起動される claude の config dir になる
  - model / effort の選択肢は protocol の picklist から webui が直接取る
- **`dir_tree`** — cwd ツリー (user role、read-only)。request `{ op: "dir_tree", roots: string[], depth?: number, filter?: string }`、response `{ entries: { path, is_dir, children? }[] }` (再帰)。`roots` は config の `root_dirs` の配下であることを検査する (ノードを展開する時の追加 fetch にも使うため、完全一致でなく包含)。ドットで始まるものとファイルは返さない。初期ロードは `dir_tree_depth` の深さを一括で返し、それより深いノードは展開した時に 1 段ずつ取る (LN-Q3)
- hello の capability `launch_available`: user role で `session_launcher` が設定されている時に true。webui はこれで「新規」ボタンと Timeline の fork、Session Search の resume の導線を出す

### 3.5 daemon の起動手順

1. `session_launcher` が無ければ `launcher_not_configured`
2. `launch` を `LaunchInputSchema` で読む。読めなければ `invalid_args`
3. daemon が終わりかけている (§3.5 の終わり方)、または走っている起動が `launch_max_concurrency` 個なら `launch_busy`
4. `cwd` を realpath に解決し、存在するディレクトリでなければ `invalid_args`
5. 新しいセッションを作る起動 (新規か `fork_session`) なら `session_id` を生成する
6. `launch_command` (config を読んだ時に固定した絶対パス) を shell を介さずに spawn する。cwd は 4 の realpath、環境は daemon の環境から `clean_env` に当たるキー (`keep_env` にも当たるものを除く) を落とし、その上に `CCMSG_LAUNCH_REQUESTED_BY` (依頼者: `user` か依頼したセッションの sid) を重ねたもの、stdin は §3.3 の JSON 1 つを末尾に改行を付けずに書いて閉じる。起動コマンドは自分の process group を持つ (setsid) ように起こす
7. `launch_timeout_seconds` で起動コマンドの process group に SIGTERM、その 500 ms 後に SIGKILL。SIGKILL からさらに 500 ms 待っても終わりを見届けられなければ、`exit_code` 137 として返事に進む。timeout で止めた起動コマンドが終わった後に group に残っているものにも SIGKILL を送る。起動コマンドが group から外した子 (setsid した端末 proxy 等) には届かない。timeout でない終わり方では何も止めない
8. stdout / stderr は spawn の直後から読み続ける (pipe の詰まりで子が止まらないように)。取り込むのは出力ごとに先頭の 1 MiB までで、それより後は読んで数えるだけにする。子が終わった後、pipe の EOF を最長 500 ms 待ち、来なければそこまでの出力で打ち切る。起動コマンドが残した子が pipe の書き端を持ち続けると EOF が来ないため
9. 出力ごとに 4096 bytes 以上なら退避ファイルに書き、本文を差し替える (§3.6)
10. daemon.log に 1 行を書く: `session_launch: by=<user か sid> cwd=<JSON の文字列> [continue=true] [resume=<id>] [fork_session=true] [resume_session_at=<uuid>] [session_id=<id>] [prompt_bytes=<N>] exit_code=<N> [timed_out=true] stdout_bytes=<N> stderr_bytes=<N>`。依頼者が書く文字列 (`cwd`) は JSON の文字列にして、行の中に別の field を装えないようにする。`prompt` の本文は書かない (長さだけ)。`timed_out=true` は 7 の timeout で止めた時で、起動コマンドが自分で 143 で終わった時と区別する
11. response を返す

起動コマンドの spawn が失敗した時 (config を読んだ後にファイルが消えた等の ENOENT、EACCES) は `launch_command_unavailable` を返し、10 の行にも残す (msg は JSON の文字列にする)。

**daemon が終わる時**: 終わり始めたら新しい `session_launch` を `launch_busy` で断り、走っている起動の返事を待ってから他のものを止める。走っている起動は自分の `launch_timeout_seconds` で止まる (7) ので、待ちは最長でも timeout と kill の猶予と出力の待ちの分。待たずに止めると、依頼者はセッションが起動したかを知る手段を失う。

### 3.6 出力の退避ファイル

- 置き場: `<state dir>/launches/<launch id>/stdout` と `stderr`。`<launch id>` は起動ごとに新しく作る `<UTC の yyyymmddThhmmssZ>-<8 桁の 16 進乱数>`。`session_id` を使わないのは、fork でない `continue` / `resume` には無く、同じセッションを何度も resume できるため
- 4096 bytes 以上になった出力だけを書く (両方とも小さければディレクトリも作らない)。ファイルはその出力の取り込んだ分の全部で、`<N>` は出力の bytes 数
- 1 MiB を超えて打ち切った出力 (§3.5 の 8) は、ファイルの末尾に `[ccmsg: truncated: the first <取り込んだ bytes 数> of <N> bytes]` の行を足し、返事の文を `output is <N> bytes, truncated to the first <取り込んだ bytes 数>, file: <path>` にする
- ディレクトリは 0700、ファイルは 0600 で作る (起動コマンドが prompt を出力に含めることがある)
- 寿命: 作ってから 7 日。daemon の起動時と、退避ファイルを書く直前に、7 日より古い `<launch id>` のディレクトリを消す。state dir は消えてよい実行時の状態の置き場 ([DR-0002](./DR-0002-daemon-supervision.md) §1) なので、それより前に消えても呼び手が困るのは「後から読み返せない」ことだけ
- 書けなかった時は、本文の代わりに `output is <N> bytes, not saved: <理由>` を返す (本文を丸ごと返して tool の結果を膨らませない)

### 3.7 tool `launch`

[DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 の `send` / `say` / `peers` と同じ形で、module が `session.start` で登録し (`isDeferred: true`、対話のセッションだけ)、`tool.call` の handler が `next` を呼ばずに `{ result }` で答える。

- **description と input schema**: [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 の「mods の tool の作り方」に従う。description は `Launch a Claude session`。input schema は `LaunchToolFieldsSchema` を変換した 1 つの object で、各 field の型と enum (`model` / `effort`)、`required: ["cwd"]`、`additionalProperties: false` だけを持ち、field の説明は `resume` の `Session id to resume` だけ。uuid の形、空文字の禁止、組み合わせの検査 (§3.2) は schema に書かず、handler が読む `LaunchInputSchema` が持つ。使い方 (組み合わせの選び方、`exit_code` 0 はセッションの到達ではなく `peers` で確かめること) は skill に置く。Claude Code は top-level に `oneOf` か `anyOf` を持つ input schema の tool を session の tools から外す ([findings 2026-10-25-launch-tool-input-schema](../findings/2026-10-25-launch-tool-input-schema.md)) ので、input schema は分岐の無い 1 つの object に保つ
- **handler の読み方**: engine は `tool.call` の入力と同じ階層に自分の field (`tool`・`tool_use_id`・subagent なら `agentId`、後で足されるもの) を並べる。handler は `LaunchToolFieldsSchema` の field だけを取り出し (strict でない object で読み、他の field は落とす)、それを `LaunchInputSchema` で読む。engine の field を名前で外す作りにしない (engine が field を足すたびに全部の呼び出しが読めなくなる)。読めなければ「launch の入力が形に合わないので何もしていない: <理由>」で返す
- **transport**: `ccmsg sidecar launch --sid <sid>`。stdin に入力の JSON、stdout に response の JSON。module の待ちは 65 秒: `launch_timeout_seconds` の上限 50 秒 + SIGKILL までの猶予 0.5 秒 + SIGKILL の後の待ち 0.5 秒 + EOF の待ち 0.5 秒 + `ccmsg sidecar launch` が daemon を起動して繋がるまでの待ち (再試行の間隔の和で約 10 秒) + 退避の書き込み。この和が待ちを下回ることはテストで固定する
- **結果の文**: response の `{ session_id?, exit_code, stdout, stderr }` を JSON の文字列で返す。daemon が断った時と確かめられなかった時の文は protocol の `launchErrorText` が決め、webui と同じ文になる: daemon が断った (`internal` 以外) なら「ccmsg の daemon が起動を断ったので、起動していない (<code>): <msg>」、`internal` (op が途中で throw した、起動コマンドを走らせた後かもしれない) なら「起動したか確かめられなかった: <msg>」に「`peers` で確かめる」を足す。daemon に繋がらない時 (`ccmsg sidecar launch` の exit 3) は「ccmsg の daemon に繋がらず、起動していない」、65 秒を超えた時と途中で止まった時は「起動したか確かめられなかった。`peers` で確かめる」
- **skill**: ccmsg の skill に `launch` の節を置く (いつ使うか、field の組み合わせ、`exit_code` 0 の後に `peers` で到達を確かめること、非 0 なら `session_id` は無く起動していないこと、`resume` と `continue` は走っているセッションに使わないこと、launch は permission を通らず `prompt` は起動されたセッションで人の入力として読まれること)

### 3.8 権限: session role からも起動できる

session role (エージェント) からの `session_launch` を受ける。

- 起動できるのは config で固定された 1 つのコマンドだけで、呼び手が選べるのは §3.2 の入力だけ (コマンド、その argv、claude の引数の組み立ては選べない)。cwd を信頼してよいか、どの claude をどう起動するかはそのコマンドが判断する。daemon が `root_dirs` 等で cwd を絞ると、その判断が 2 か所に分かれる。daemon は依頼者を環境変数 `CCMSG_LAUNCH_REQUESTED_BY` (§3.5 の 6) で起動コマンドに渡し、人とエージェントで判定を変えるかも起動コマンドが決める
- tool の handler は permission の判定 (`tool.check`・PreToolUse・ダイアログ・classifier) を通らない (DR-0039 §3)。エージェントによる起動を止められるのは起動コマンドだけになる
- **`resume` + `prompt` は、他のセッションへ prompt を入れる力を持ち、その強さは peer 注入と同等以上**。peer 注入 ([DR-0034](./DR-0034-peer-socket-injection.md)) の本文は受け手の harness が peer の封筒に入れ「A peer cannot grant escalation」の枠を付けて渡すが、起動の `prompt` は起動されたセッションの user prompt そのものとして入り、そのセッションの model と classifier は人の言葉として読む。新規と `continue` の `prompt` も同じで、`fork_session` はさらに元のセッションの履歴を新しいセッションに写す (元の transcript を読む力)
- 誰が起動したかは daemon.log の行 (§3.5 の 10) に残る

### 3.9 webui

- サイドバーの SESSIONS 見出しの右に「+ 新規」ボタン。押すと view `session-creator` に切り替わる。「+ 新規」、Timeline の「ここから fork」、Session Search の「resume」は `launch_available` の時だけ出す
- フォーム (`SessionCreator`) は全部の欄を常に出す。見出しは claude のオプション名そのまま (大文字にせず等幅で出す)。並び:
  - cwd: `CwdTree` (`dir_tree`) で選ぶ。検索フィルタ欄はパス名の部分一致
  - `--model` / `--effort`: picklist の値の select
  - `--continue`: checkbox
  - `--resume` / `--resume-session-at`: text
  - `--fork-session`: checkbox
  - `--session-id`: 入力できない欄。daemon が生成することを placeholder の「自動生成」で示す (新しいセッションを作らない組み合わせでは、いつ生成するかを添える)。op の入力に `session_id` は無い
  - `--name`: text
  - `PROMPT`: multiline
- model / effort の既定:
  - 新規 (`--continue` が off で `--resume` が空) では、`--model` は `fable`、`--effort` は選ばれている model の `default_effort` (§3.4)。`default_effort` に無ければ未選択 (「選んでください」) で、送る時にスキーマの理由が出る。model を選び直すと、effort はその model の既定に選び直される
  - `--continue` か `--resume` を入れると、両方の select に「指定しない」が加わり、それが既定になる
  - 人が選んだ値は既定に戻さない
- 送る前に `LaunchInputSchema` で読み、読めなければ欄ごとの理由を出して送らない。理由の文はスキーマのもの
- prefill:
  - Session Search の結果の「resume」: `resume` = その id、cwd、model / effort は transcript の末尾から、name は既存の title
  - Timeline の「ここから fork」: `resume` = 見ているセッション、`fork_session` = on、`resume_session_at` = 選んだ record の uuid、cwd / model / effort は見ているセッションのもの、name は元の title
- 結果パネル: `session_id` (新しいセッションを作る起動で exit 0 の時だけある。セッションの view へのリンクで、hello が来るまでは開いても空)、`exit_code`、`stdout`、`stderr` (退避の文はそのまま出す)。daemon が断った時と確かめられなかった時は `launchErrorText` の文
- フォームの値の URL 同期 (`sb.*`) は上の欄の field 名に揃える (`sb.continue=true` / `sb.fork_session=true` で on)

## 4. 実装の段

| 段 | 内容 |
|---|---|
| 1 | protocol: `LaunchFieldsSchema` / `LaunchInputSchema` (組み合わせの検査) / `LaunchToolFieldsSchema` / `LaunchCommandInputSchema`、`session_launch` の request / response、`session_launcher_config` の response (`default_effort`)、error code `launch_command_unavailable` / `launch_busy`、capability `launch_available`、結果の文 `launchErrorText` |
| 2 | daemon: config のスキーマ (§3.1、起動コマンドの絶対パスへの固定、組み込みの起動コマンド)、§3.5 の手順 (`launch_max_concurrency`、process group、出力の上限、終わる時の待ち)、§3.6 の退避と掃除、session role の受け付け、`default_effort` の読み取り |
| 3 | module と CLI: `ccmsg sidecar launch`、tool `launch` の登録と handler、input schema と description、skill の節 |
| 4 | webui: 全部の欄のフォーム、model / effort の既定、prefill、結果パネル、`launch_available` |
| 5 | runbook (`session-launcher-setup` と `fork-rescue`) を新しい config と起動コマンドの契約に書き直す |

段 1 → 2 → 3 / 4 の順 (3 と 4 は並行できる)。段 2 の時点で、`session_launcher` の起動コマンドが見つからない config は §3.1 のとおり daemon を起動時に止めるので、kawaz の config と起動コマンドを段 2 と同時に差し替える。

## 5. 裁定記録

- **LN-Q1 = (a)** (kawaz 2026-07-16): 既存 daemon config に統合 — §3.1
- **LN-Q3 = (a)+(b)** (kawaz 2026-07-16): cwd ツリーは初期一括 (`dir_tree_depth`、既定 2) + 境界より深いノードは展開時に lazy fetch — §3.4
- **LN-Q4 = (a)** (kawaz 2026-07-16): config の変更は daemon の再起動で反映 — §3.1
- **2026-10-25 (kawaz)**: エージェント向けの tool `launch` を足す。daemon が新しいセッションの `session_id` を生成して起動コマンドの入力に足す (tool の入力の型と起動コマンドの入力の型は別)。起動コマンドは config の `launch_command` 1 本で、daemon は JSON を stdin で渡すだけ。response は `{ session_id?, exit_code, stdout, stderr }` (`session_id` は新しいセッションを作る起動で exit 0 の時だけ。起動コマンドは失敗を全部セッションの起動より前に返す前提) で、4096 bytes 以上の出力はファイルに退避して置き場を返す。daemon は exit code を解釈しない。session role からの起動を許可する — §3.3〜§3.8
- **2026-10-25 (kawaz、追加)**: 起動の入力の field 名を claude のオプション名の snake_case に揃え、起動の種類を表す `type` を持たない。引数の無いオプションは boolean。claude が拒む・無視する組み合わせはスキーマの組み合わせの検査で弾く。tool の入力は op の入力から `resume_session_at` を外したもの、起動コマンドの入力は op の入力に `session_id` を足したもの (field は claude のオプションと 1 対 1、依頼者は環境変数 `CCMSG_LAUNCH_REQUESTED_BY` で渡し、`clean_env` の判定の後に重ねる)。起動に関わる config のキーは `launch_` で揃える (`launch_timeout_seconds` / `launch_max_concurrency`)。`launch_command` は省略でき、無ければ同梱の組み込みの起動コマンド (`hyoui run --detached -- claude …` を加工せずに実行する) を使う。webui のフォームは全部の欄を常に出し、新規の model の既定は `fable`、effort の既定は daemon の settings.json の `modelSettings.<model>.effortLevel` (`session_launcher_config` の `default_effort`)。あわせてレビューの指摘から、`launch_max_concurrency` と `launch_busy`、daemon が終わる時の待ち、起動コマンドの絶対パスへの固定、process group への signal、出力の 1 MiB の上限、log の行の自由文の JSON の文字列化と `timed_out`、tool の待ちの 65 秒を入れる — §3.1〜§3.9
- **2026-10-25 (kawaz、追加 2)**: `resume_session_at` は `fork_session` と一緒にだけ受ける (fork しない resume に付けた時の claude の挙動は未観測で、意味も無い) — §3.2

## 6. 不採用

| 案 | 理由 |
|---|---|
| config にテンプレート (名前 + コマンド + 変数の宣言) を複数持ち、変数を shell 変数で渡す | 起動の入力の field で足りる。テンプレートの変数を daemon と webui が知る必要が生じ、shell の quote が config を書く人の責務になる。起動の仕方の知識は起動コマンドに閉じる (§2.1) |
| 起動の種類を `type` (新規 / continue / resume / fork の 4 つ) で分け、type ごとの variant にする | field 名が claude のオプション名と別の語彙になり、起動コマンドを書く人もエージェントも ccmsg の語彙と claude の引数の対応を覚える必要が生じる。fork は `--resume` / `--continue` に `--fork-session` を足したもので種類ではなく、type と並べると同じことを 2 通りに書ける。variant は model に見せる input schema が top-level の `oneOf` になり、Claude Code がその tool を外す (§3.7) ので、結局 1 つの object に合併して type ごとの違いを description に書くことになる |
| user role に request ごとのコマンドの上書きを許す | 起動できるものが config の 1 コマンドである、という §3.8 の前提が崩れる |
| エージェントに起動スクリプトを Bash で叩かせる | 引数の渡し方がぶれて prompt が捨てられ、Bash での起動は classifier に止められる (§1) |
| fork の新しい id を、起動したセッションの hello を待って知る | `--fork-session` と `--session-id` の併用で先に決められる (findings 2026-10-25-fork-with-session-id)。hello 待ちは到達の確認であり、§2.3 で daemon がしないと決めたこと |
| daemon が起動の cwd を `root_dirs` の配下に限る | cwd の信頼判定は起動コマンドが持つ (§3.8)。2 か所で判定すると食い違った時にどちらが正か決まらない |
| tool の handler が engine の field (`tool` / `tool_use_id` / `agentId`) を名前で外してから読む | engine が field を足すと全部の呼び出しが読めない入力になる。tool の field だけを取り出す (§3.7) |
| 依頼者ごとに起動の頻度を制限する | daemon が守るべきは抱えるプロセスの数で、`launch_max_concurrency` で足りる。誰の起動を許すかは起動コマンドの判断 (§3.8、`CCMSG_LAUNCH_REQUESTED_BY`) |
| 依頼者を起動コマンドの入力の field (`requested_by`) にする | 入力の field は claude のオプションと 1 対 1 に保つ。オプションに無い名前を混ぜると、field をそのままオプションに写す起動コマンド (組み込みを含む) が名前ごとに例外を持つことになる |
| `launch_command` を必須にし、既定を持たない | 設定を書くまで起動が使えず、hyoui に claude を載せるだけの環境でも同じ起動コマンドを各自が書くことになる。既定の組み込みは加工をしないので、環境の都合が要る人は自前に差し替えればよく、既定があることで失うものが無い |

## 7. 未確定

- **response の `timed_out`**: timeout の SIGTERM で終わった時の `exit_code` 143 は、起動コマンドが自分で 143 で終わった時と response では見分けられない (daemon.log の行には `timed_out=true` が残る)。対話の claude を起動した後に timeout で止められると、セッションはあるのに非 0 なので `session_id` が返らない。response に `timed_out` を足すかは実際に困ったら決める
- **走っているセッションへの `resume` / `continue`**: 同じ transcript に 2 つのプロセスが書くことになる。daemon は止めない (§2.3、起動コマンドの判断) が、skill で使わないよう案内する。起動コマンドか daemon が止めるべきかは未決
- **起動の `prompt` に起動者の印を付けるか**: §3.8 のとおり、起動されたセッションは `prompt` を人の言葉として読む。エージェントが起動した時に本文の頭へ `ccmsg:<起動したセッションの id> から:` のような印 (DR-0039 §6 の印と同型) を付けるかは未決 (起動コマンドは `CCMSG_LAUNCH_REQUESTED_BY` を見て印を付けられる)
- **model が skill に従い、組み合わせを守るか**: input schema は組み合わせを言わない (§3.7)。本物の model の振る舞いは未観測で、守らなくても handler の入口で読めない入力として短い理由とともに返る

## 8. 関連

- [launch-command](../design/launch-command.md) — 起動コマンドの契約 (stdin の JSON、claude の引数への写し方、終了コード)
- [runbook session-launcher-setup](../runbooks/session-launcher-setup.md) / [runbook fork-rescue](../runbooks/fork-rescue.md) — 設定の手順と、fork による救出の手順
- [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id`・`--resume-session-at` の併用の実測、claude が拒む組み合わせ
- [findings 2026-10-25-launch-tool-input-schema](../findings/2026-10-25-launch-tool-input-schema.md) — top-level の `oneOf` / `anyOf` の tool が外されること
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — typed tool (`send` / `say` / `peers` と `launch`) の登録の形
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — 入力と config をスキーマで読む
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入 (§3.8 の比較の相手)
- [DR-0028](./DR-0028-session-kill.md) — セッションの停止 (起動と対になる webui の操作)
- [DR-0008](./DR-0008-workspace-file-access.md) — `fs_list` (`dir_tree` はその subset)
- [DR-0009](./DR-0009-session-transcript-access.md) — 起動したセッションが hello で peers に載る既存の経路
