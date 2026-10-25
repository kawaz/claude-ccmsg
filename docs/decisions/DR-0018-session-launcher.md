# DR-0018: Session Launcher (エージェントの tool `launch` と webui のフォームから、config で固定した 1 つの起動コマンドでセッションを起動する)

Status: Accepted (2026-07-16、§3 は 2026-10-25 の kawaz 裁定) — ⬜ 未実装 (cwd ツリーの `dir_tree` と webui の `CwdTree` は実装済み。§3 の入力・op・起動コマンドの契約・tool `launch`・フォームの 4 type は未実装)
Date: 2026-07-15
Sponsor: kawaz

## 1. 背景

別の Claude セッションを起動したい場面は 2 つある。

- **人が webui から**: model / effort / cwd / プロンプトを毎回端末でタイプせずに、サイドバーの「新規」や、過去セッションの検索結果の「resume」、Timeline の「ここから fork」から起動したい
- **エージェントが**: worker を立てる、作業を別セッションへ引き継ぐ。今はエージェントが起動用のスクリプトを Bash で叩いており、(a) 引数の渡し方がぶれて prompt が捨てられる事故が起き、(b) Bash で別セッションを起動すること自体が auto mode の classifier に止められる

どの claude を、どの端末 (detached の端末 proxy 等) で、どの trust 判定の下で起動するかは kawaz の環境の都合で、ccmsg が知るべきことではない。

## 2. スコープ

### 2.1 目的

起動の依頼を、型の決まった入力 (4 つの type) で人とエージェントの両方から受け、config で固定した 1 つの起動コマンドに渡し、そのコマンドの結果をそのまま返す。

**増やしたくないもの**: daemon と webui が持つ「起動の仕方の知識」。claude の引数の組み立て、端末への載せ方、cwd の信頼判定、model ごとの effort の既定、セッション名の装飾、trust ダイアログの通し方は起動コマンドが持つ。daemon が持つのは「入力を検査し、新しいセッションの id を決め、コマンドに JSON で渡し、終わりを待って結果を返す」だけ。

### 2.2 やること

- 4 つの type (`new` / `continue` / `resume` / `fork`) を持つ起動の入力 (§3.2) と、それを受ける op `session_launch` (§3.4)
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
  launch_command: ["launch-claude"],
  root_dirs: ["~/src/github.com/kawaz/", "~/src/github.com/<organization>/"],
  dir_tree_depth: 2,
  timeout_seconds: 10,
  clean_env: ["CLAUDE*", "ANTHROPIC_*"],
  keep_env: ["CLAUDE_CONFIG_DIR"],
}
```

- **`launch_command`** (必須): 起動コマンドの argv (空でない文字列の配列)。shell を介さずに実行する。先頭の要素は絶対パス、`~/` で始まるパス、または daemon の `PATH` で探す名前。起動コマンドが受ける入力と返すものの契約は [launch-command](../design/launch-command.md)
- **`root_dirs`** (必須、空でない): webui の cwd ツリーの根。絶対パスか `~/…`。起動の cwd をこの配下に限ることはしない (cwd の信頼判定は起動コマンドの責務、§3.8)
- **`dir_tree_depth`** (既定 2): cwd ツリーの初期ロードの深さ (LN-Q3)
- **`timeout_seconds`** (既定 10、1〜50 の整数): 起動コマンドを待つ時間。超えたら SIGTERM、その 500 ms 後に生きていれば SIGKILL。上限は tool の待ち (§3.7 の 60 秒) に、kill の猶予と退避の書き込みが収まるように置く
- **`clean_env` / `keep_env`** (既定 `[]`): 起動コマンドに渡す環境から落とすキーと、落とさずに残すキーのパターン。daemon はあるセッションの中の shell から起動されることがあり、そのセッション由来の変数 (`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_CHILD_SESSION` 等) を持っている。それが新しいセッションへ流れて動作を変えるのを防ぐ。パターンは `*` がキー名の中の任意の文字列で、それ以外はリテラル (大文字小文字を区別、キー名全体との一致)。両方に当たるキーは残す (`keep_env` が勝つ)。広い `CLAUDE*` で落としつつ、面の分離に要る `CLAUDE_CONFIG_DIR` を残すのがこの優先の用途
- config は 1 つのスキーマで読み ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §6)、読めなければ daemon は起動時に止まる。エラーは読めない所ごとに `config: <file>: <場所>: <理由>` の 1 行で daemon.log に書かれ、CLI が spawn した daemon ならその行が CLI のエラーとして出る。壊れた所だけ捨てて起動したり、不正な値を既定値に読み替えたりはしない。既定値は値が無い時だけスキーマが与える。`session_launcher` に上の 6 つ以外のキーがあっても読めない
- config の変更は daemon の再起動で反映する (LN-Q4)

### 3.2 起動の入力 (tool と op で共通)

`packages/protocol` に置き、tool の handler と daemon の op が同じスキーマで読む。

```ts
const LaunchModelSchema = v.picklist(["fable", "opus", "sonnet", "haiku"]);
const LaunchEffortSchema = v.picklist(["low", "medium", "high", "xhigh", "max"]);
const LaunchCwdSchema = v.pipe(v.string(), v.check((p) => p.startsWith("/"), "must be an absolute path"));
const NonEmptySchema = v.pipe(v.string(), v.minLength(1));

const common = {
  cwd: LaunchCwdSchema,
  name: v.optional(NonEmptySchema),
  prompt: v.optional(NonEmptySchema),
};

const NewLaunchSchema = v.strictObject({
  type: v.literal("new"),
  ...common,
  model: LaunchModelSchema,
  effort: LaunchEffortSchema,
});
const ContinueLaunchSchema = v.strictObject({
  type: v.literal("continue"),
  ...common,
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
});
const ResumeLaunchSchema = v.strictObject({
  type: v.literal("resume"),
  ...common,
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
  resume_session_id: v.pipe(v.string(), v.uuid()),
});
const ForkLaunchSchema = v.strictObject({
  type: v.literal("fork"),
  ...common,
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
  resume_session_id: v.pipe(v.string(), v.uuid()),
  resume_at: v.optional(v.pipe(v.string(), v.uuid())),
});

export const LaunchInputSchema = v.variant("type", [
  NewLaunchSchema,
  ContinueLaunchSchema,
  ResumeLaunchSchema,
  ForkLaunchSchema,
]);
export type LaunchInput = v.InferOutput<typeof LaunchInputSchema>;
```

| field | 意味 | type |
|---|---|---|
| `type` | `new`: 新しいセッション。`continue`: cwd で最も新しいセッションの続き。`resume`: 指定したセッションの続き (id は変わらない)。`fork`: 指定したセッションの履歴を写した新しいセッション | 全部 |
| `cwd` | セッションを起動するディレクトリ (絶対パス)。`continue` はここで「最も新しい」を探す | 全部 |
| `model` / `effort` | `claude --model` / `--effort` に渡す値。`new` 以外で無ければ起動コマンドが決める | `new` は必須、他は任意 |
| `name` | セッション名 (`claude --name`)。無ければ起動コマンドが決める | 全部 |
| `prompt` | 最初の prompt。無ければ起動コマンドが決める | 全部 |
| `resume_session_id` | 続ける / 写す元のセッションの id (`claude --resume`) | `resume` / `fork` は必須 |
| `resume_at` | fork 地点の transcript の record の uuid (`claude --resume-session-at`)。その record までを写す。無ければ先端まで | `fork` のみ |

- 元のセッションを指す field は `resume_session_id` と呼ぶ。type の値 `resume` と同名になるのを避け、起動コマンドの入力に daemon が足す `session_id` (新しいセッションの id、§3.3) と取り違えない名前にするため
- `name` と `prompt` に空文字は受けない。「指定しない」の言い方を field の不在 1 つにする
- 各 type は `strictObject` で、その type に無い field (`new` の `resume_session_id` 等) は読めない入力になる。黙って捨てると、呼び手は渡した値が効いたと思い込む

### 3.3 起動コマンドの入力 (stdin の JSON)

起動の入力 (§3.2) とは別の型で、`new` と `fork` にだけ daemon が生成した `session_id` を足したもの。`cwd` は daemon が realpath に解決した値になる。

```ts
export const LaunchCommandInputSchema = v.variant("type", [
  v.strictObject({ ...NewLaunchSchema.entries, session_id: v.pipe(v.string(), v.uuid()) }),
  ContinueLaunchSchema,
  ResumeLaunchSchema,
  v.strictObject({ ...ForkLaunchSchema.entries, session_id: v.pipe(v.string(), v.uuid()) }),
]);
```

- `session_id` は UUID v4 (`crypto.randomUUID()`)。起動コマンドはこれを `claude --session-id` に渡す。fork で `--resume <元> --fork-session --session-id <新>` が効くこと (`-p` と対話の両方、`--resume-session-at` との併用は `-p`) は [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) で確かめた
- `continue` と `resume` には足さない。claude は fork でない `--continue` / `--resume` に `--session-id` を付けると起動しない (同 findings)。`resume` の id は `resume_session_id` のまま、`continue` の id は claude が選ぶセッションの id で、daemon は知らない
- type ごとの claude の引数への写し方、fork 地点のある fork の二段起動、終了コードの意味は [launch-command](../design/launch-command.md) が正本

### 3.4 protocol

- **`session_launch`** — 起動
  - request: `{ op: "session_launch", launch: LaunchInput }`
  - role: user と session の両方 (§3.8)
  - response: `{ ok: true, session_id?: string, exit_code: number, stdout: string, stderr: string }`
    - `session_id`: `new` / `fork` で `exit_code` が 0 の時だけ、起動コマンドに渡した id を返す。非 0 の時と `continue` / `resume` では含めない。起動コマンドは失敗を全部セッションを起動する前に非 0 で返し、起動した後は 0 で終わる契約なので ([launch-command](../design/launch-command.md) の「戻り方」)、非 0 ならその id のセッションは無い
    - `exit_code`: 起動コマンドの終了コード。signal で終わった時は `128 + <signal の番号>` (shell の慣習。timeout の SIGTERM なら 143、SIGKILL なら 137)
    - `stdout` / `stderr`: 起動コマンドの出力 (UTF-8)。無ければ `""`。4096 bytes 以上なら本文の代わりに `output is <N> bytes, file: <path>` (§3.6)
  - error: `launcher_not_configured` (config に `session_launcher` が無い)、`invalid_args` (入力がスキーマに合わない、`cwd` が存在するディレクトリでない。msg に最初の理由)、`launch_command_unavailable` (起動コマンドを起こせなかった。exit code が無いので response の形にできない。msg に OS の理由)
  - 返事は起動コマンドの終わり (最長 `timeout_seconds` + kill の猶予 + 出力の待ち) まで遅れる。同じ接続の他の依頼は待たせない
- **`session_launcher_config`** — フォームの材料 (user role)。response `{ ok: true, root_dirs: string[] }`。model / effort の選択肢は protocol の picklist から webui が直接取る
- **`dir_tree`** — cwd ツリー (user role、read-only)。request `{ op: "dir_tree", roots: string[], depth?: number, filter?: string }`、response `{ entries: { path, is_dir, children? }[] }` (再帰)。`roots` は config の `root_dirs` の配下であることを検査する (ノードを展開する時の追加 fetch にも使うため、完全一致でなく包含)。ドットで始まるものとファイルは返さない。初期ロードは `dir_tree_depth` の深さを一括で返し、それより深いノードは展開した時に 1 段ずつ取る (LN-Q3)
- hello の capability `launch_available`: user role で `session_launcher` が設定されている時に true。webui はこれで「新規」ボタンと Timeline の fork の導線を出す

### 3.5 daemon の起動手順

1. `session_launcher` が無ければ `launcher_not_configured`
2. `launch` を `LaunchInputSchema` で読む。読めなければ `invalid_args`
3. `cwd` を realpath に解決し、存在するディレクトリでなければ `invalid_args`
4. `new` / `fork` なら `session_id` を生成する
5. `launch_command` を shell を介さずに spawn する。cwd は 3 の realpath、環境は daemon の環境から `clean_env` に当たるキー (`keep_env` にも当たるものを除く) を落としたもの、stdin は §3.3 の JSON 1 つを書いて閉じる
6. `timeout_seconds` で SIGTERM、その 500 ms 後に生きていれば SIGKILL
7. stdout / stderr は spawn の直後から読み続ける (pipe の詰まりで子が止まらないように)。子が終わった後、pipe の EOF を最長 500 ms 待ち、来なければそこまでの出力で打ち切る。起動コマンドが detach した孫が pipe の書き端を持ち続けると EOF が来ないため
8. 出力ごとに 4096 bytes 以上なら退避ファイルに書き、本文を差し替える (§3.6)
9. daemon.log に 1 行を書く: 依頼者 (`user` か依頼したセッションの sid)、`type`、`cwd`、`resume_session_id`、`session_id`、`exit_code`、stdout / stderr の bytes 数。`prompt` の本文は書かない (長さだけ)
10. response を返す

起動コマンドの spawn が失敗した時 (ENOENT、EACCES 等) は `launch_command_unavailable` を返し、9 の行にも残す。

### 3.6 出力の退避ファイル

- 置き場: `<state dir>/launches/<launch id>/stdout` と `stderr`。`<launch id>` は起動ごとに新しく作る `<UTC の yyyymmddThhmmssZ>-<8 桁の 16 進乱数>`。`session_id` を使わないのは、`continue` / `resume` には無く、同じセッションを何度も resume できるため
- 4096 bytes 以上になった出力だけを書く (両方とも小さければディレクトリも作らない)。ファイルはその出力の全部で、`<N>` はその bytes 数
- ディレクトリは 0700、ファイルは 0600 で作る (起動コマンドが prompt を出力に含めることがある)
- 寿命: 作ってから 7 日。daemon の起動時と、退避ファイルを書く直前に、7 日より古い `<launch id>` のディレクトリを消す。state dir は消えてよい実行時の状態の置き場 ([DR-0002](./DR-0002-daemon-supervision.md) §1) なので、それより前に消えても呼び手が困るのは「後から読み返せない」ことだけ
- 書けなかった時は、本文の代わりに `output is <N> bytes, not saved: <理由>` を返す (本文を丸ごと返して tool の結果を膨らませない)

### 3.7 tool `launch`

[DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 の `send` / `say` / `peers` と同じ形で、module が `session.start` で登録し (`isDeferred: true`、対話のセッションだけ)、`tool.call` の handler が `next` を呼ばずに `{ result }` で答える。

- **description**: `Start a Claude Code session through the configured launch command (see the ccmsg skill). exit_code 0 means the launch command finished normally, not that the session is up; check that with peers.` 使い方の正本は skill に置く (DR-0039 §3) が、この 1 文は結果を読み違えると誤った報告に直結するので description に置く
- **model に見せる input schema**: `LaunchInputSchema` の 4 つの option を合併した 1 つの object (properties は全 option の和、`type` の enum は 4 値、required は全 option に共通の `type` と `cwd`)。Messages API の tool の input_schema は top-level が `type: "object"` の schema とされており (API の型の記述。top-level の `anyOf` を `$.tool.register` に渡した時の挙動は未検証)、合併した object ならその制約の有無に関わらず渡せるため。合併は variant の option から機械的に導き (`tool-input-schemas.ts` の macro)、手で別に書かない ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §1)。type ごとの必須は各 field の description に書き、handler の入口で `LaunchInputSchema` に通して読めなければ「launch の入力が形に合わないので何もしていない: <理由>」で返す
- **transport**: `ccmsg sidecar launch --sid <sid>`。stdin に入力の JSON、stdout に response の JSON。module の待ちは 60 秒 (`timeout_seconds` の上限 50 秒 + kill の猶予 + 退避の書き込み + daemon の起動を待つ分)
- **結果の文**: response の `{ session_id?, exit_code, stdout, stderr }` を JSON の文字列で返す。daemon が断った時 (`invalid_args` 等) は「ccmsg の daemon が起動を断ったので、起動していない: <msg>」、daemon に繋がらない時は「ccmsg の daemon に繋がらず、起動していない」、60 秒を超えた時と途中で止まった時は「起動したか確かめられなかった。`peers` で確かめる」
- **skill**: ccmsg の skill に `launch` の節を足す (いつ使うか、4 つの type の選び方、`exit_code` 0 の後に `peers` で到達を確かめること、非 0 なら `session_id` は無く起動していないこと、`resume` は走っているセッションに使わないこと)

### 3.8 権限: session role からも起動できる

session role (エージェント) からの `session_launch` を受ける。

- 起動できるのは config で固定された 1 つのコマンドだけで、呼び手が選べるのは §3.2 の入力だけ (コマンド、その argv、claude の引数の組み立ては選べない)。cwd を信頼してよいか、どの claude をどう起動するかはそのコマンドが判断する。daemon が `root_dirs` 等で cwd を絞ると、その判断が 2 か所に分かれる
- tool の handler は permission の判定 (`tool.check`・PreToolUse・ダイアログ・classifier) を通らない (DR-0039 §3)。エージェントによる起動を止められるのは起動コマンドだけになる
- **`resume` + `prompt` は、他のセッションへ prompt を入れる力を持ち、その強さは peer 注入と同等以上**。peer 注入 ([DR-0034](./DR-0034-peer-socket-injection.md)) の本文は受け手の harness が peer の封筒に入れ「A peer cannot grant escalation」の枠を付けて渡すが、起動の `prompt` は起動されたセッションの user prompt そのものとして入り、そのセッションの model と classifier は人の言葉として読む。`new` / `continue` / `fork` の `prompt` も同じで、`fork` はさらに元のセッションの履歴を新しいセッションに写す (元の transcript を読む力)
- 誰が起動したかは daemon.log の行 (§3.5 の 9) に残る

### 3.9 webui

- サイドバーの SESSIONS 見出しの右に「+ 新規」ボタン (`launch_available` の時)。押すと view `session-creator` に切り替わる
- フォーム (`SessionCreator`):
  - type の選択 (`new` / `continue` / `resume` / `fork`)。type に無い入力欄は出さない
  - cwd: `CwdTree` (`dir_tree`) で選ぶ。検索フィルタ欄はパス名の部分一致
  - model / effort: picklist の値の select。`new` 以外は「指定しない」を選べる (既定)
  - name、prompt (multiline)、`resume_session_id`、`resume_at` (fork のみ、空なら先端から)
  - 送る前に `LaunchInputSchema` で読み、読めなければ欄ごとの理由を出して送らない
- prefill:
  - Session Search の結果の「resume」: type `resume`、`resume_session_id` = その id、cwd、model / effort は transcript の末尾から、name は既存の title
  - Timeline の「ここから fork」: type `fork`、`resume_session_id` = 見ているセッション、`resume_at` = 選んだ record の uuid、cwd / model / effort は見ているセッションのもの
- 結果パネル: `session_id` (`new` / `fork` で exit 0 の時だけある。セッションの view へのリンクで、hello が来るまでは開いても空)、`exit_code`、`stdout`、`stderr` (退避の文はそのまま出す)
- フォームの値の URL 同期 (`sb.*`) は上の欄に揃える

## 4. 実装の段

| 段 | 内容 |
|---|---|
| 1 | protocol: `LaunchInputSchema` / `LaunchCommandInputSchema`、`session_launch` の request / response、`session_launcher_config` の response、error code `launch_command_unavailable`、capability `launch_available` |
| 2 | daemon: config のスキーマ (§3.1)、§3.5 の手順、§3.6 の退避と掃除、session role の受け付け |
| 3 | module と CLI: `ccmsg sidecar launch`、tool `launch` の登録と handler、合併した input schema の macro、skill の節 |
| 4 | webui: フォームの 4 type、prefill、結果パネル、`launch_available` |
| 5 | runbook (`session-launcher-setup` と `fork-rescue`) を新しい config と起動コマンドの契約に書き直す |

段 1 → 2 → 3 / 4 の順 (3 と 4 は並行できる)。段 2 の時点で、`session_launcher` に `launch_command` を持たない config は §3.1 のとおり daemon を起動時に止めるので、kawaz の config と起動コマンドを段 2 と同時に差し替える。

## 5. 裁定記録

- **LN-Q1 = (a)** (kawaz 2026-07-16): 既存 daemon config に統合 — §3.1
- **LN-Q3 = (a)+(b)** (kawaz 2026-07-16): cwd ツリーは初期一括 (`dir_tree_depth`、既定 2) + 境界より深いノードは展開時に lazy fetch — §3.4
- **LN-Q4 = (a)** (kawaz 2026-07-16): config の変更は daemon の再起動で反映 — §3.1
- **2026-10-25 (kawaz)**: エージェント向けの tool `launch` を足す。入力は 4 type の variant、`new` / `fork` で daemon が `session_id` を生成して起動コマンドの入力に足す (tool の入力の型と起動コマンドの入力の型は別)。起動コマンドは config の `launch_command` 1 本で、daemon は JSON を stdin で渡すだけ。response は `{ session_id?, exit_code, stdout, stderr }` (`session_id` は `new` / `fork` で exit 0 の時だけ。起動コマンドは失敗を全部セッションの起動より前に返す前提) で、4096 bytes 以上の出力はファイルに退避して置き場を返す。daemon は exit code を解釈しない。session role からの起動を許可する。webui のフォームも 4 type に合わせる — §3.2〜§3.9

## 6. 不採用

| 案 | 理由 |
|---|---|
| config にテンプレート (名前 + コマンド + 変数の宣言) を複数持ち、変数を shell 変数で渡す | 4 つの type で足りる。テンプレートの変数を daemon と webui が知る必要が生じ、shell の quote が config を書く人の責務になる。起動の仕方の知識は起動コマンドに閉じる (§2.1) |
| user role に request ごとのコマンドの上書きを許す | 起動できるものが config の 1 コマンドである、という §3.8 の前提が崩れる |
| エージェントに起動スクリプトを Bash で叩かせる | 引数の渡し方がぶれて prompt が捨てられ、Bash での起動は classifier に止められる (§1) |
| fork の新しい id を、起動したセッションの hello を待って知る | `--fork-session` と `--session-id` の併用で先に決められる (findings 2026-10-25-fork-with-session-id)。hello 待ちは到達の確認であり、§2.3 で daemon がしないと決めたこと |
| daemon が起動の cwd を `root_dirs` の配下に限る | cwd の信頼判定は起動コマンドが持つ (§3.8)。2 か所で判定すると食い違った時にどちらが正か決まらない |
| tool の input schema を `LaunchInputSchema` の変換 (top-level `anyOf`) にする | Messages API の input_schema は top-level が object とされている (§3.7)。合併した object なら確かめなくても渡せる |

## 7. 未確定

- **timeout と起動コマンド自身の終了コードの区別**: timeout の SIGTERM で終わった時の `exit_code` 143 は、起動コマンドが自分で 143 で終わった時と見分けられない。対話の claude を起動した後に timeout で止められると、セッションはあるのに非 0 なので `session_id` が返らない。response に `timed_out` を足すかは実際に困ったら決める
- **走っているセッションへの `resume`**: 同じ transcript に 2 つのプロセスが書くことになる。daemon は止めない (§2.3、起動コマンドの判断) が、skill で使わないよう案内する。起動コマンドか daemon が止めるべきかは未決
- **起動の `prompt` に起動者の印を付けるか**: §3.8 のとおり、起動されたセッションは `prompt` を人の言葉として読む。エージェントが起動した時に本文の頭へ `ccmsg:<起動したセッションの id> から:` のような印 (DR-0039 §6 の印と同型) を付けるかは未決
- **tool の合併した input schema を `$.tool.register` が受け、model が type ごとの必須を守るか**: 段 3 の実装時に実機で確かめる

## 8. 関連

- [launch-command](../design/launch-command.md) — 起動コマンドの契約 (stdin の JSON、claude の引数への写し方、終了コード)
- [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id`・`--resume-session-at` の併用の実測
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — typed tool (`send` / `say` / `peers` と `launch`) の登録の形
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — 入力と config をスキーマで読む
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入 (§3.8 の比較の相手)
- [DR-0028](./DR-0028-session-kill.md) — セッションの停止 (起動と対になる webui の操作)
- [DR-0008](./DR-0008-workspace-file-access.md) — `fs_list` (`dir_tree` はその subset)
- [DR-0009](./DR-0009-session-transcript-access.md) — 起動したセッションが hello で peers に載る既存の経路
