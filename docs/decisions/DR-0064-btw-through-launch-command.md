# DR-0064: btw の fork を、セッションの起動と同じ起動コマンドで print (`-p`) の起動として起こす

- Status: Proposed
- 状態: 💭 提案 (2026-11-22) — 未実装。Decision は kawaz の発言 (2026-11-22) と統括の整理から書いたもので、そこに無い判断は「未決」(U 番号) に置いた。各 U の「統括の推し」は統括の整理にあったもの、「起草者の見立て」は起草の時に読んだ材料からの見立てで、どちらも kawaz の判断を待つ。kawaz の裁定は末尾の「裁定」に足す
- Date: 2026-11-22

## Context

btw ([DR-0060](./DR-0060-btw-mode.md)) の fork は、config の `btw_command` (無ければ組み込みの `default-btw-command.sh`) が起こす。セッションの起動・再起動・fork は別の command、config の `session_launcher.launch_command` (無ければ組み込みの `default-launch-command.sh`、[DR-0018](./DR-0018-session-launcher.md)、[launch-command](../design/launch-command.md)) が起こす。kawaz の発言 (2026-11-22):

> btw 用の claude の起動は launch を経由させないとユーザ独自の設定とかありそうでしょ？例えば TMPDIR を add-dir してるのは僕の独自スクリプトの部分だし。そう考えると -p も通さないとか

> hyoui の方は僕のカスタムの部分なので何かしら担保しないとだな。-p があった場合は hyoui を介さないようにすれば辻褄が合うか

### 読んで分かった前提

- DR-0060 §2 の Design rationale は、btw コマンドを起動コマンドと「同じ形の command」にすれば「環境の決め方は起動コマンドと揃い」とした。揃うのは形 (JSON を標準入力で渡す) で、中身は揃わない。ユーザが起動コマンドに書いた決まりは btw コマンドに書き写さない限り btw に効かない
- ユーザの起動コマンドが持ちうる決まり (起動の入力を読んでから claude を起こすまで) の実例:
  - cwd のパスと remote が信頼できるかの判定 (信頼できなければ起こさない)
  - 面によって claude を業務面の sandbox ラッパーに差し替える
  - 一時置き場の用意
  - 環境変数の掃除、`--permission-mode` 等の毎回付けるオプション
  - リポの作業用の置き場 (artifacts) の準備
- kawaz の config には `btw_command` が無い。btw の fork は組み込みの btw コマンドから daemon の `PATH` の素の `claude` で走り、上の決まりが 1 つも効かない。業務面のセッションの btw は sandbox の外で走る
- 起動コマンドに足す入力が 2 か所に分かれている。[DR-0063](./DR-0063-project-auto-mode.md) (プロジェクトごとの autoMode) は `settings` を起動コマンドの入力 (`LaunchCommandInputSchema`) と btw コマンドの入力 (`BtwCommandInputSchema`) の両方に足し、自前のコマンドに 2 か所で `--settings` を 1 つにまとめる責務を負わせた
- 起動コマンドの契約 ([launch-command](../design/launch-command.md)) は対話の claude の起動のためのもの:
  - 入力の field 名は claude のオプション名の snake_case で、`LaunchCommandInputSchema` は strict (知らない field は読めない入力)。起動コマンドも知らない field には非零で終わる取り決め
  - `model` は起動の語彙 (`mythos` / `fable` / `opus` / `sonnet` / `haiku`) の picklist。btw は DR-0060 §2 で正式な id (1M なら `[1m]` 付き) を渡す (別名だと prompt cache がほぼ全部外れた実測がある)
  - `fork_session` の時は daemon が `session_id` を必ず足す (`launchMakesSession` と `session_id` の有無が一致する検査)
  - 戻り方は「速やかに終わる」「detach した子は process group から外す」「claude を起こした後は 0 で終わる」「stdout は呼び手に見せる短い文」。daemon は `launch_timeout_seconds` (既定 10 秒、最大 50 秒) で止め、出力を 1 MiB まで取り込んで 4096 bytes 以上はファイルに退避する
  - daemon は config dir を渡さない。resume (再起動を含む) の config dir は起動コマンドが決める (cwd の `.envrc` 等)
  - 環境は daemon の環境から `clean_env` / `keep_env` で落とし、`TMPDIR` (OS の利用者ごとの一時ディレクトリ) と `CCMSG_LAUNCH_REQUESTED_BY` を重ねたもの
- btw コマンドの契約 ([btw-command](../design/btw-command.md)) は print の fork のためのもの:
  - 入力は `{ cwd, config_dir, resume, model?, effort?, prompt }` (+ DR-0063 の `settings`)。`config_dir` は claude のオプションでない
  - 標準出力は claude の stream-json で、daemon が逐次読む。期限は無く、止めるのは取り消し (process group に SIGTERM) と daemon の停止
  - 環境は daemon の環境に `TMPDIR` を重ねただけ (`clean_env` / `keep_env` は通らない)。`CCMSG_LAUNCH_REQUESTED_BY` は無い
  - 組み込みは `config_dir` を `direnv exec .` の内側で `CLAUDE_CONFIG_DIR` にし、cwd の `.envrc` が別の config dir を言っても、セッションの config dir で走る
- `session_launcher` の節は省ける (無ければ起動は `launcher_not_configured`)。今の btw は `session_launcher` が無くても動く
- 組み込みの起動コマンドは `hyoui` が `PATH` に無いと claude を起こさずに 2 で終わる
- テストの daemon (`CCMSG_TEST_LIFELINE`) は config に `btw_command` が無ければ btw を起こさない (`btw_command_unavailable`)。btw の試験 (`packages/daemon/test/btw*.test.ts`、`packages/webui/e2e/btw.e2e.ts`) は偽の `btw_command` を置いている
- DR-0063 の段階 1 の実装 (起動コマンドと btw コマンドの両方への `settings`) は main の外で進んでいる (2026-11-22 時点)

## 目的

btw の fork を、そのセッションを ccmsg から起こした時と同じユーザの決まり (信頼の判定、claude の差し替え、一時置き場、環境の掃除) の下で走らせる。ユーザは claude の起こし方を 1 つのコマンドに書けば、対話の起動と btw の両方に効く。

増やしたくないもの:

- ユーザが claude の起こし方を書く場所 (起動コマンドの 1 つにする)
- daemon と webui が持つ「claude の起こし方の知識」(DR-0018 §2.1 と同じ。daemon は claude のオプションを field にした入力を渡すだけで、ccmsg 独自の語彙を間に挟まない)
- 起動コマンドの入力に足す field の置き場 (DR-0063 の `settings` のような daemon が足す field を、起動と btw の 2 か所に分けて足さない)

## Decision

### 1. 経路

webui の `btw_ask` → daemon が btw の起動の入力 (§2) を作る → config の `session_launcher.launch_command` (セッションの起動と同じ argv) を、セッションの cwd で起こす → 起動コマンドが print の claude (`claude -p --resume <sid> --fork-session --no-session-persistence …`) を前景で exec し、claude の stream-json が起動コマンドの標準出力に出る → daemon が読んで btw の記録を作る (DR-0060 §4 以降は変えない)。

- 変わるのは「どの command を、どの入力で、どの環境で起こすか」だけ。答えの読み方・記録・保存・配り方・TL への出し方 (DR-0060 §4〜§11) と、DR-0062 §14 のコメントへの吸収は変えない
- `btw_command` の扱いは U3

### 2. 入力 (起動の入力に print の field を足す)

起動コマンドの入力 (`LaunchCommandInputSchema`) に、claude の print のオプションを field として足す (U1 の統括の推しの形)。btw の起動の入力は次のとおり。

| field | claude のオプション | btw での値 |
|---|---|---|
| `cwd` | (起動の cwd) | セッションの cwd (今の `btw_ask` と同じ求め方) の realpath |
| `resume` | `--resume` | セッションの sid |
| `fork_session` | `--fork-session` | `true` |
| `print` | `-p` / `--print` | `true` |
| `no_session_persistence` | `--no-session-persistence` | `true` |
| `output_format` | `--output-format` | `stream-json` |
| `verbose` | `--verbose` | `true` |
| `include_partial_messages` | `--include-partial-messages` | `true` |
| `permission_prompts` | `--permission-prompts` | `none` |
| `model` | `--model` | DR-0060 §2 のとおり (セッションが最後に答えた model の正式な id、1M なら `[1m]` 付き) |
| `effort` | `--effort` | DR-0060 §2 のとおり |
| `settings` | `--settings` | DR-0063 §4 のファイルのパス (項目のあるプロジェクトだけ) |
| `prompt` | (claude の stdin) | DR-0060 §3 の前置きを付けた全文 |
| `session_id` | `--session-id` | U4 |

- print の field は daemon だけが足す。webui のフォームとエージェントの tool `launch` の入力 (`LaunchInputSchema`) には無く、頼み手は渡せない (`session_id`・`settings` と同じ扱い)。`session_launch` で print の起動を頼む口は作らない
- `model` は、print の時だけ起動の語彙の外 (正式な id、`[1m]` 付き) を受ける。起動の語彙に写すと `[1m]` が落ち、別名を渡すと cache が外れる (DR-0060 §2)
- 起動コマンドは field を同じ名前のオプションに写す (今の契約の「claude の引数への写し方」の続き)
- config dir の渡し方は U5

### 3. print の時の起動コマンドの責務

入力に `print` がある時、起動コマンドは次のとおりにする。launch-command の契約の「戻り方」(速やかに終わる、detach する、起こした後は 0 で終わる、stdout は短い文) は対話の起動の決まりで、print の時はこちらに置き換わる。

- **claude を前景で exec する**。端末 proxy に載せない、detach しない、process group から外さない。daemon の取り消し (process group への SIGTERM) が claude に届くようにする。claude をラッパーに差し替える環境では、ラッパーも同じ group の中で前景で走らせる
- **標準出力には claude の出力だけを書く**。daemon は標準出力を stream-json として読む (読めない行は読み捨てるが、混ぜない)。端末の id 等の起動コマンド自身の出力は書かない
- **`prompt` は claude の標準入力に渡す** (今の起動と同じく argv に置かない)
- **終了コード**: claude を起こす前の失敗 (入力が読めない、cwd が信頼できない等) は非零で終わり、理由を stderr に書く (今と同じ)。claude を exec した後は claude の終了コードがそのまま daemon に届く
- **端末に付随する処理をしない**: 端末 proxy (hyoui 等) への載せ方、画面の罫線の待ち、trust ダイアログの自動応答、セッション名の既定の名前付け (`--name`)。print の claude は端末を持たず、trust ダイアログも出ない (`claude --help` の `-p`: 「The workspace trust dialog is skipped when Claude is run in -p mode」)。fork は保存されないので名前の置き場も無い (DR-0060 の Alternatives の「fork の名前を `--name` で変えて見分ける」は採らない)
- **通るもの**: cwd の信頼の判定、claude の差し替え、一時置き場の用意、環境の掃除、毎回付けるオプション、`--settings` のまとめ方 (DR-0063 §5)。どれも対話の起動と同じ決まりで通る

### 4. daemon の側の起こし方

- **argv**: `session_launcher.launch_command` (config を読んだ時に固めた絶対パス、無ければ組み込み)。`session_launcher` の節が無い時の扱いは U3
- **環境**: 起動と同じ。daemon の環境から `clean_env` / `keep_env` で落とし、`TMPDIR` を OS の利用者ごとの一時ディレクトリにし、`CCMSG_LAUNCH_REQUESTED_BY=user` を重ねる (`btw_ask` は user role だけ、DR-0060 §6)
- **process の扱いは DR-0060 のまま**: 自分の process group で起こし、標準出力を逐次読み、期限を持たず、取り消しと daemon の停止で group に SIGTERM を送る。`launch_timeout_seconds`・出力の取り込みの上限と退避ファイル・`launch_max_concurrency` / `launch_busy`・「daemon が終わる時は走っている起動を待つ」は print の起動に当てない。同時の上限は `BTW_MAX_CONCURRENCY` のまま、起動の数とは別に数える
- **断り方**: 起動コマンドを起こせない (spawn の失敗) 時は今の `btw_command_unavailable`。起動コマンドが claude を起こさずに非零で終わった時 (信頼できない cwd 等) は、`result` の前に終わった btw として `failed` (`error` に終了コードと stderr の末尾 2 行、DR-0060 §4)
- **daemon.log**: `btw_ask` の行はそのまま (DR-0063 の `auto_mode_entries` を含む)。`session_launch` の行は書かない (起動の op ではない)

### 5. 組み込みの起動コマンド

組み込みの起動コマンド (`default-launch-command.sh`) に print の分かれ道を足し、組み込みの btw コマンドがしていたことを引き取る。

- `print` がある時は `hyoui` を前提にしない (`PATH` に無くても断らない)
- 環境の掃除と `direnv exec .` は対話の起動と同じ
- `continue` / `resume` の model / effort の補い (`ccmsg launch-context`) は print の時にはしない。補いは起動の語彙 (別名) で返り、DR-0060 §2 の正式な id の決まりと食い違う。daemon が model を決められなかった btw は今の組み込みの btw コマンドと同じく `--model` を付けない
- model ごとの effort の既定も print の時には当てない (正式な id は表の名前に当たらず、今の btw と同じく effort の無い btw は `--effort` を付けない)
- `exec [direnv exec .] claude <写したオプション> <<< "$prompt"` で前景で走らせる
- config dir の扱いは U5 の結論に従う

### 6. 契約の文書

- [launch-command](../design/launch-command.md): 入力の表に print の field を足し、「print の時」の節 (§3 の責務、戻り方の置き換え、daemon の待ち方) を足す。「取り決めの芯」の「daemon は起動コマンドの出力も終了コードも解釈しない」に、print の時は標準出力を stream-json として読むことを書き添える
- [btw-command](../design/btw-command.md): U3 の結論に従って消すか、btw の起動の入力の作り方 (DR-0060 §2 の model / effort の決め方) だけを残す
- 自前の起動コマンドは、print の field を知るまでは知らない field として非零で終わる (今の取り決めのまま。黙って無視して対話の claude を起こさない)。その間の btw は `failed` で、`error` に起動コマンドの stderr が出る

## 未決 (kawaz の判断を待つ)

### U1: 入力の形

print の起動を、claude のオプションの個別の field で渡すか、`btw: true` の 1 つの印にしてオプションをコマンドに任せるか。

- **統括の推し: 個別の field** (§2 の表)
  - 今の契約「field 名は claude のオプション名の snake_case、写し方は同じ名前のオプションへ」とずれない。起動コマンドは中継するだけで、ccmsg 独自の語彙 (btw) を知らなくてよい (DR-0018 §2.1)
  - 起動コマンドが分かれ道に使う印は `print` 1 つで足りる (kawaz の「-p があった場合は hyoui を介さない」)
- 弱点:
  - print の組み合わせを daemon が正しく組む責務を持つ。`output_format: stream-json` は `-p` と `--verbose` を要し (`--verbose` が無いと `Error: When using --print, --output-format=stream-json requires --verbose` で起動しない。2.1.330、認証の無い一時の config dir で確かめた)、`include_partial_messages` は `-p` と stream-json を要する (`claude --help`)。組み合わせの検査をスキーマに足す (DR-0018 §3.2 の組み合わせの検査と同じ置き方)
  - 6 つの field は実際には選べない。daemon の読み方 (stream-json、partial messages) と cache の決まり (tool の集合を変えない) で値が決まっていて、自前の起動コマンドがどれかを落とす・変えると答えが読めなくなる。field の形が「変えてよい」と読める
  - `model` が print の時だけ語彙の外を受ける (§2)。同じ field の型が print の有無で変わる
- 対案 `btw: true`: daemon の組み立てが要らず、選べない値を field に見せない。代わりに起動コマンドが btw の意味 (どのオプションを付けるか、stream-json の形) を知る必要があり、ccmsg 独自の語彙が起動コマンドに入る。組み込みの起動コマンドが持つ分には困らないが、自前の起動コマンドを書く人は ccmsg の版が上がるたびにオプションの組を追うことになる

### U3: `btw_command` を消すか

- **統括の推し: 消して、claude を起こす経路を起動コマンドの 1 本にする**。組み込みの btw コマンド (`default-btw-command.sh`)、`BtwCommandInputSchema`、config の `btw_command` を消す。btw だけ別のことをしたい人は、起動コマンドの中で `print` で分ける
- 弱点:
  - btw だけを別のコマンドにしたい使い方 (試験・別の claude) の口が無くなる
  - 試験は偽の `btw_command` から、print を扱う偽の起動コマンド (`session_launcher.launch_command`) に移す。起動の試験の偽の起動コマンドにも btw が届くようになる
- 対案: `btw_command` を残し、無い時に起動コマンドを使う。経路が 2 本のままで、目的の「書く場所を 1 つ」に反する。残す理由は上の弱点の 1 つ目だけ
- 付随する問い (U3-b): **`session_launcher` の節が無い時の btw**。今の btw は節が無くても動く
  - 案 (a) 節が無ければ btw も断る (`launcher_not_configured`)。「節が無ければ claude を起こす口が無い」で揃うが、今 btw を使えている構成で btw が止まる
  - 案 (b) 節が無ければ組み込みの起動コマンドと既定の `clean_env` / `keep_env` (空) で起こす。今の動きを保てる。DR-0018 §3.1 の「節が無ければ起動は設定されていない」は、人とエージェントからの起動の口 (`root_dirs` を要るフォームと tool) の話として残る
  - 起草者の見立て: (b)。節の必須の `root_dirs` は起動のフォームのためのもので、btw には要らない。どちらでもテストの daemon は、config に起動コマンドが無ければ btw を起こさない (今の `btw_command` と同じ構え。組み込みは本物の claude で model の request を出す)

### U4: print の fork に `session_id` を渡すか

今の起動の入力は `fork_session` の時に `session_id` が必ずある (`launchMakesSession` と一致する検査)。

- 案 (a) 渡す。検査は変えずに済み、daemon は fork の sid を前もって知る。`--session-id` と `--no-session-persistence` の併用を claude が受けるかは未検証 (`-p --fork-session --session-id` は [findings 2026-10-25](../findings/2026-10-25-fork-with-session-id.md) で確かめ済み)
- 案 (b) 渡さない。検査を「保存される新しいセッションを作る時だけ」に変える。daemon は fork の sid を使わない (DR-0060 §11 は SESSIONS の判定に fork の sid を使わない)
- 起草者の見立て: (b)。daemon が使わない値を渡さない。fork の sid が要る用途が出たら (a) を測ってから入れる

### U5: config dir の渡し方

今の btw コマンドは入力の `config_dir` を、cwd の `.envrc` を通した後に `CLAUDE_CONFIG_DIR` にする。起動コマンドの契約は config dir を渡さず、resume (再起動を含む) の config dir を起動コマンドに任せている (launch-command の「端末と環境」)。

- 案 (a) 渡さない (再起動と同じ)。field 名は claude のオプションのままで揃う。cwd の `.envrc` が言う config dir とセッションの config dir が違う時 (端末から別の面の config dir で起こしたセッション等) は、claude が resume する transcript を見つけられず btw が `failed` になる。同じ時に再起動も今失敗するので、btw だけの穴ではない
- 案 (b) 渡す。`config_dir` は claude のオプションでないので、field にすると「field は claude のオプションと 1 対 1」(DR-0018 §3.3) が崩れる。環境変数 (`CLAUDE_CONFIG_DIR` を `TMPDIR` のように重ねる) にしても、起動コマンドの `direnv exec .` の `.envrc` が上書きする (今の組み込みの btw コマンドはそれを避けるため `direnv exec .` の内側で入れ直している)
- 起草者の見立て: (a)。今の btw より失敗する場面が増える (上の config dir の食い違い) のを受け入れ、再起動と同じ穴として 1 か所で扱う。その穴を塞ぐなら、再起動と btw の両方に効く形で別に決める

## 測ること

受理の前か実装の段で、使い捨てのセッションで測る。

1. ユーザの起動コマンドが足すオプション (`--permission-mode` 等、sandbox ラッパー) を通した btw の fork が、元のセッションの prompt cache を読めるか (`btw_end` の行の `cache_read_input_tokens` と `cache_creation_input_tokens` を、組み込みで起こした時と比べる)
2. sandbox ラッパーを通した print の claude に、取り消しの SIGTERM (process group) が届いて止まるか。標準入力の prompt と標準出力の stream-json がラッパーを素通りするか
3. ユーザの起動コマンドの信頼の判定 (remote の確認に network を使うもの等) が btw 1 回に足す時間
4. U4 で (a) を採る時: `claude -p --resume <sid> --fork-session --session-id <新> --no-session-persistence` が起動を受け、`init` の `session_id` が渡した id になるか

## 既存の DR との関係

- **[DR-0060](./DR-0060-btw-mode.md) (btw モード)**:
  - 裁定 1「btw コマンドは config の command にする。daemon が `PATH` の `claude` を直接起こす形は採らない」のうち、btw 専用の command (`btw_command`) の部分を覆す。「config の command にする」「`PATH` の claude を直接起こさない」は残る (起こすのは config の起動コマンド)
  - §1 の「新しい経路は daemon と btw コマンドの間だけ」は「daemon と起動コマンドの間」になる
  - §2 の config・組み込みの btw コマンド・入力の形・Design rationale は、U1 と U3 の結論に従って置き換わる。§2 の model / effort の決め方 (正式な id、`[1m]`、単発の上書きを入れない effort) と tool の集合を変えない決まりはそのまま使う
  - 目的の「セッションを起こす仕組みの種類を増やさない」は、この DR で種類が 1 つ減る方向に進む
- **[DR-0018](./DR-0018-session-launcher.md) (Session Launcher)**:
  - §2.3「プロセス管理をしない」「起動コマンドの終了コードを解釈しない」と launch-command の芯の「daemon は出力も終了コードも解釈しない」は、print の起動に当てない (§4)。print の起動のプロセスの扱いは DR-0060 の btw のもので、DR-0018 の起動の op (`session_launch`) には足さない
  - §3.1 の「`session_launcher` の節が無ければ起動は設定されていない」は U3-b
  - §3.3 の「field は全部 claude のオプションと 1 対 1」は保つ (print の field も claude のオプション)。`model` の型が print の時だけ広がる (§2)
- **[DR-0062](./DR-0062-comments.md) (コメント)**: §14 の「変えずに使うもの: btw コマンドと標準入力・標準出力の契約 (DR-0060 §2、`btw_command`)」の `btw_command` は、この DR の経路 (起動コマンドの print) に読み替える。前置き・stream-json の読み方・`BTW_MAX_CONCURRENCY` は変わらない。実装の段階 5 (btw モードの吸収) とこの DR は、btw の記録の側と btw を起こす側で分かれていて、どちらが先でもよい。段階 5 の移行の段 4 で DR-0060 の本文を書き換える時は、btw コマンドの契約を残す必要が無くなる (U3 で消すなら)
- **[DR-0063](./DR-0063-project-auto-mode.md) (プロジェクトごとの autoMode)**:
  - §5 の「起動コマンドの入力と btw コマンドの入力の両方に `settings` を足す」は、起動コマンドの入力の 1 か所になる (U3 で消すなら)。自前のコマンドが `--settings` を 1 つにまとめる責務 (§5) も起動コマンドの 1 か所で済む
  - §8 の「btw コマンドの入力の `settings`、組み込みの btw コマンドは `--settings <path>` を付ける」は、btw の起動の入力 (§2) の `settings` と組み込みの起動コマンドの写し方になる。btw に渡すかとキーの決め方 (セッションの cwd) は変わらない
  - §7 の Design rationale が引く DR-0060 の裁定 1 は、この DR の後も「btw のセッションを起こす経路を config の command に限る」として読める
  - DR-0063 の段階 1 の実装が btw コマンドに `settings` を足していれば、この DR の実装で起動コマンドの側に寄せる
- **[DR-0028](./DR-0028-session-kill.md) (再起動)**: 再起動と btw が同じ起動コマンドを通り、config dir の決まり (U5) も同じになる

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| `btw_command` のまま、ユーザが起動コマンドの決まりを btw コマンドにも書き写す | 決まりを書く場所が 2 つになり、片方だけ直す食い違いが起きる。kawaz の構成のように `btw_command` を書かない人には、組み込みの btw コマンドが素の claude で走る今の状態が残る |
| 起動コマンドに argv で印を足す (`launch_command` の後ろに `--btw` 等) | 契約は「daemon は引数を足さない」。入力の JSON の外に 2 つ目の入力の経路ができる |
| print を環境変数 (`CCMSG_LAUNCH_PRINT=1` 等) で知らせる | `CCMSG_LAUNCH_REQUESTED_BY` は claude のオプションでない「誰が頼んだか」だから環境変数にした。print は claude のオプションで、入力の field に置く決まり (DR-0018 §3.3) に当たる |
| daemon が `PATH` の claude を直接 `-p` で起こす | DR-0060 の裁定 1 の残る部分 (config の command に限る) に反し、ユーザの決まりがどれも効かない |
| print の時も起動コマンドを対話の起動と同じに扱い、起動コマンドが claude を detach して出力を別の経路 (ファイル等) で daemon に渡す | daemon の取り消しが claude に届かず、答えの逐次の読み方 (標準出力の stream-json) を作り直すことになる |

## Consequences

- protocol: `LaunchCommandInputSchema` に print の field (U1) と組み合わせの検査。`model` の型が print の時だけ広がる。U3 で消すなら `BtwCommandInputSchema` を消す。U4 の結論で `session_id` の検査が変わる
- daemon: `btw_ask` が起動コマンドを起動の環境 (`clean_env` / `keep_env`、`TMPDIR`、`CCMSG_LAUNCH_REQUESTED_BY=user`) で起こす。process の扱い (逐次の読み、取り消し、上限) は今の btw のまま。U3 で消すなら config の `btw_command`、`btwCommandOf`、組み込みの btw コマンドを消す。テストの daemon が btw を起こさない条件を、起動コマンドの有無に移す
- 組み込みの起動コマンド: print の分かれ道 (§5)
- 文書: [launch-command](../design/launch-command.md) の入力の表と「print の時」の節、[btw-command](../design/btw-command.md) の削除か縮小 (U3)
- 試験: btw の試験の偽の `btw_command` を、print を扱う偽の起動コマンドに移す。組み込みの起動コマンドが print で `hyoui` を要らず、claude を前景で exec し、写したオプションを付けることを偽の claude で確かめる
- ユーザの起動コマンドは、print の field を読めるように直すまで btw が `failed` になる (知らない field で非零)。直す時に §3 の責務 (前景で exec、標準出力に claude だけ、端末の処理を飛ばす) を足す
- btw にもユーザの起動コマンドの信頼の判定が効く。端末から起こしたセッションで、起動コマンドが信頼しない cwd のものは btw が `failed` になる (今は走る)
- btw 1 回の始まりまでの時間に、ユーザの起動コマンドの前処理の時間が足される (「測ること」3)
- 「持たない」ことを壊す変更を止める試験の観点:
  - webui のフォーム・tool `launch`・`session_launch` の入力に print の field を書いても読めない入力になる (daemon だけが足す)
  - btw の起動コマンドの入力の `model` は、別名で起動したセッションでも正式な id で、1M のセッションでは `[1m]` を落とさない (DR-0060 の観点を起動コマンドの入力で見る)
  - print の起動に `launch_timeout_seconds` が効かない (期限を超えて答える btw が止められない)
  - btw の取り消しで、起動コマンドが exec した claude が止まる
  - 組み込みの起動コマンドは print の時に `hyoui` を呼ばず、標準出力に claude の出力以外を書かない

## 関連

- [DR-0060](./DR-0060-btw-mode.md) — btw モード (経路の一部を覆す)
- [DR-0018](./DR-0018-session-launcher.md) — 起動コマンドと起動の入力
- [DR-0062](./DR-0062-comments.md) §14 — btw のコメントへの吸収
- [DR-0063](./DR-0063-project-auto-mode.md) §5、§8 — 起動と btw への `--settings`
- [DR-0028](./DR-0028-session-kill.md) — 再起動 (同じ起動コマンドを通る)
- [launch-command](../design/launch-command.md) / [btw-command](../design/btw-command.md) — コマンドの契約
- [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id` の併用
- [findings 2026-11-22-dr62-btw-cache-and-prompt-concat](../findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md) — btw の fork の cache と model の別名
