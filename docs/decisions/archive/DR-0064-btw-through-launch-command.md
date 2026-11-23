# DR-0064: btw の fork を、セッションの起動と同じ起動コマンドで print (`-p`) の起動として起こす

- Status: Superseded by DR-0060 (btw の fork は、セッションの hooks module が `$.agent.spawn` の fork で起こす。起動コマンドの print の起動は使わない)
- Date: 2026-11-22

## Context

btw ([DR-0060](../DR-0060-btw-mode.md)) の fork は、config の `btw_command` (無ければ組み込みの `default-btw-command.sh`) が起こす。セッションの起動・再起動・fork は別の command、config の `session_launcher.launch_command` (無ければ組み込みの `default-launch-command.sh`、[DR-0018](../DR-0018-session-launcher.md)、[launch-command](../../design/launch-command.md)) が起こす。kawaz の発言 (2026-11-22):

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
- 起動コマンドに足す入力が 2 か所に分かれている。[DR-0063](../DR-0063-project-auto-mode.md) (プロジェクトごとの autoMode) は `settings` を起動コマンドの入力 (`LaunchCommandInputSchema`) と btw コマンドの入力 (`BtwCommandInputSchema`) の両方に足し、自前のコマンドに 2 か所で `--settings` を 1 つにまとめる責務を負わせた
- 起動コマンドの契約 ([launch-command](../../design/launch-command.md)) は対話の claude の起動のためのもの:
  - 入力の field 名は claude のオプション名の snake_case で、`LaunchCommandInputSchema` は strict (知らない field は読めない入力)。起動コマンドも知らない field には非零で終わる取り決め
  - `model` は起動の語彙 (`mythos` / `fable` / `opus` / `sonnet` / `haiku`) の picklist。btw は DR-0060 §2 で正式な id (1M なら `[1m]` 付き) を渡す (別名だと prompt cache がほぼ全部外れた実測がある)
  - `fork_session` の時は daemon が `session_id` を必ず足す (`launchMakesSession` と `session_id` の有無が一致する検査)
  - 戻り方は「速やかに終わる」「detach した子は process group から外す」「claude を起こした後は 0 で終わる」「stdout は呼び手に見せる短い文」。daemon は `launch_timeout_seconds` (既定 10 秒、最大 50 秒) で止め、出力を 1 MiB まで取り込んで 4096 bytes 以上はファイルに退避する
  - daemon は config dir を渡さない。resume (再起動を含む) の config dir は起動コマンドが決める (cwd の `.envrc` 等)
  - 環境は daemon の環境から `clean_env` / `keep_env` で落とし、`TMPDIR` (OS の利用者ごとの一時ディレクトリ) と `CCMSG_LAUNCH_REQUESTED_BY` を重ねたもの
- btw コマンドの契約 ([btw-command](../../design/btw-command.md)) は print の fork のためのもの:
  - 入力は `{ cwd, config_dir, resume, model?, effort?, prompt }` (+ DR-0063 の `settings`)。`config_dir` は claude のオプションでない
  - 標準出力は claude の stream-json で、daemon が逐次読む。期限は無く、止めるのは取り消し (process group に SIGTERM) と daemon の停止
  - 環境は daemon の環境に `TMPDIR` を重ねただけ (`clean_env` / `keep_env` は通らない)。`CCMSG_LAUNCH_REQUESTED_BY` は無い
  - 組み込みは `config_dir` を `direnv exec .` の内側で `CLAUDE_CONFIG_DIR` にし、cwd の `.envrc` が別の config dir を言っても、セッションの config dir で走る
- `session_launcher` の節は省ける (無ければ起動は `launcher_not_configured`)。今の btw は `session_launcher` が無くても動く
- 組み込みの起動コマンドは `hyoui` が `PATH` に無いと claude を起こさずに 2 で終わる
- テストの daemon (`CCMSG_TEST_LIFELINE`) は config に `btw_command` が無ければ btw を起こさない (`btw_command_unavailable`)。btw の試験 (`packages/daemon/test/btw*.test.ts`、`packages/webui/e2e/btw.e2e.ts`) は偽の `btw_command` を置いている
- daemon の config は strict で、知らない key があると読めない config として daemon が起動しない
- DR-0063 の段階 1 の実装 (起動コマンドと btw コマンドの両方への `settings`) は main に入る予定 (2026-11-22 時点)
- `claude -p --resume <sid> --fork-session --session-id <新> --no-session-persistence` は起動を受け、stream の全ての行の `session_id` が渡した id になり、fork の transcript は作られない ([findings 2026-11-22](../../findings/2026-11-22-print-fork-session-id-without-persistence.md)、2.1.330)

## 目的

btw の fork を、そのセッションを ccmsg から起こした時と同じユーザの決まり (信頼の判定、claude の差し替え、一時置き場、環境の掃除) の下で走らせる。ユーザは claude の起こし方を 1 つのコマンドに書けば、対話の起動と btw の両方に効く。

増やしたくないもの:

- ユーザが claude の起こし方を書く場所 (起動コマンドの 1 つにする)
- daemon と webui が持つ「claude の起こし方の知識」(DR-0018 §2.1 と同じ。daemon は claude のオプションを field にした入力を渡すだけで、ccmsg 独自の語彙を間に挟まない)
- 起動コマンドの入力に足す field の置き場 (DR-0063 の `settings` のような daemon が足す field を、起動と btw の 2 か所に分けて足さない)

## Decision

### 1. 経路

webui の `btw_ask` → daemon が btw の起動の入力 (§2) を作る → config の `session_launcher.launch_command` (セッションの起動と同じ argv) を、セッションの cwd で起こす → 起動コマンドが print の claude (`claude -p --resume <sid> --fork-session --session-id <新> --no-session-persistence …`) を前景で exec し、claude の stream-json が起動コマンドの標準出力に出る → daemon が読んで btw の記録を作る (DR-0060 §4 以降は変えない)。

- 変わるのは「どの command を、どの入力で、どの環境で起こすか」だけ。答えの読み方・記録・保存・配り方・TL への出し方 (DR-0060 §4〜§11) と、DR-0062 §14 のコメントへの吸収は変えない
- claude を起こす経路は起動コマンドの 1 本にする。`btw_command` の設定、組み込みの btw コマンド、`BtwCommandInputSchema` は消す (§6)。btw だけ別のことをしたい人は、起動コマンドの中で `print` で分ける

### 2. 入力 (起動の入力に print の field を足す)

起動コマンドの入力 (`LaunchCommandInputSchema`) に、claude の print のオプションを個別の field として足す。btw の起動の入力は次のとおり。

| field | claude のオプション | btw での値 |
|---|---|---|
| `cwd` | (起動の cwd) | セッションの cwd (今の `btw_ask` と同じ求め方) の realpath |
| `resume` | `--resume` | セッションの sid |
| `fork_session` | `--fork-session` | `true` |
| `session_id` | `--session-id` | daemon が作る新しい uuid (小文字)。起動の fork と同じ |
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

- print の field は daemon だけが足す。webui のフォームとエージェントの tool `launch` の入力 (`LaunchInputSchema`) には無く、頼み手は渡せない (`session_id`・`settings` と同じ扱い)。`session_launch` で print の起動を頼む口は作らない
- `session_id` の検査 (`launchMakesSession` と `session_id` の有無が一致する) は変えない。btw の起動は fork なので `session_id` を持つ。保存しない fork でも claude は渡した id で走る (findings 2026-11-22)
- 組み合わせの検査をスキーマに足す (DR-0018 §3.2 の組み合わせの検査と同じ置き方)。claude が受けない組は読めない入力にする:
  - `no_session_persistence`・`output_format`・`include_partial_messages`・`permission_prompts` は `print` と一緒に (`claude --help`: それぞれ「only works with --print」「with --print」)
  - `output_format: stream-json` は `verbose` と一緒に (`--verbose` が無いと `Error: When using --print, --output-format=stream-json requires --verbose` で起動しない、2.1.330)
  - `include_partial_messages` は `output_format: stream-json` と一緒に (`claude --help`)
  - `print` は `resume` と `fork_session` と一緒に (print の起動は btw の fork だけ。§2 の表)
- `model` と `effort` は、print の時だけ起動の語彙の外を受ける。`model` は正式な id (`[1m]` 付き)、`effort` はセッションの綴りのまま。起動の語彙に写すと `[1m]` が落ち、別名を渡すと cache が外れる (DR-0060 §2)。空の綴りは渡さない (field を付けない)
- 起動コマンドは field を同じ名前のオプションに写す (今の契約の「claude の引数への写し方」の続き)
- config dir は渡さない。対話の resume と同じく、config dir は起動コマンドが決める

### 3. print の時の起動コマンドの責務

入力に `print` がある時、起動コマンドは次のとおりにする。launch-command の契約の「戻り方」(速やかに終わる、detach する、起こした後は 0 で終わる、stdout は短い文) は対話の起動の決まりで、print の時はこちらに置き換わる。

- **claude を前景で exec する**。端末 proxy に載せない、detach しない、process group から外さない。daemon の取り消し (process group への SIGTERM) が claude に届くようにする。claude をラッパーに差し替える環境では、ラッパーも同じ group の中で前景で走らせる
- **標準出力には claude の出力だけを書く**。daemon は標準出力を stream-json として読む (読めない行は読み捨てるが、混ぜない)。端末の id 等の起動コマンド自身の出力は書かない
- **print の field は写すだけで、落とさない・値を変えない**。値は daemon の読み方 (stream-json、partial messages) と cache の決まり (tool の集合を変えない、DR-0060 §2) で決まっていて、落とす・変えると答えが読めなくなる
- **`prompt` は claude の標準入力に渡す** (今の起動と同じく argv に置かない)
- **終了コード**: claude を起こす前の失敗 (入力が読めない、cwd が信頼できない等) は非零で終わり、理由を stderr に書く (今と同じ)。claude を exec した後は claude の終了コードがそのまま daemon に届く
- **端末に付随する処理をしない**: 端末 proxy (hyoui 等) への載せ方、画面の罫線の待ち、trust ダイアログの自動応答、セッション名の既定の名前付け (`--name`)。print の claude は端末を持たず、trust ダイアログも出ない (`claude --help` の `-p`: 「The workspace trust dialog is skipped when Claude is run in -p mode」)。fork は保存されないので名前の置き場も無い (DR-0060 の Alternatives の「fork の名前を `--name` で変えて見分ける」は採らない)
- **通るもの**: cwd の信頼の判定、claude の差し替え、一時置き場の用意、環境の掃除、毎回付けるオプション、`--settings` のまとめ方 (DR-0063 §5)。どれも対話の起動と同じ決まりで通る

### 4. daemon の側の起こし方

- **argv**: `session_launcher.launch_command` (config を読んだ時に固めた絶対パス、無ければ組み込み)
- **`session_launcher` の節が無い時**: 組み込みの起動コマンドと空の `clean_env` / `keep_env` (節の既定) で起こす。今 btw が使える構成 (節を書いていない構成) で btw を止めない。節の必須の `root_dirs` は起動のフォームのためのもので、btw には要らない。DR-0018 §3.1 の「節が無ければ起動は設定されていない」は、人とエージェントからの起動の口 (フォームと tool `launch`) の話として残る
- **環境**: 起動と同じ。daemon の環境から `clean_env` / `keep_env` で落とし、`TMPDIR` を OS の利用者ごとの一時ディレクトリにし、`CCMSG_LAUNCH_REQUESTED_BY=user` を重ねる (`btw_ask` は user role だけ、DR-0060 §6)
- **process の扱いは DR-0060 のまま**: 自分の process group で起こし、標準出力を逐次読み、期限を持たず、取り消しと daemon の停止で group に SIGTERM を送る。`launch_timeout_seconds`・出力の取り込みの上限と退避ファイル・`launch_max_concurrency` / `launch_busy`・「daemon が終わる時は走っている起動を待つ」は print の起動に当てない。同時の上限は `BTW_MAX_CONCURRENCY` のまま、起動の数とは別に数える
- **断り方**: 起動コマンドを起こせない (spawn の失敗) 時は ErrorCode `btw_launch_unavailable` (`btw_command_unavailable` を改名する。消える設定 `btw_command` の名を持つため)。起動コマンドが claude を起こさずに非零で終わった時 (信頼できない cwd 等) は、`result` の前に終わった btw として `failed` (`error` に終了コードと stderr の末尾 2 行、DR-0060 §4)
- **テストの daemon** (`CCMSG_TEST_LIFELINE`): config に `session_launcher.launch_command` が無ければ btw を起こさず、`btw_ask` を `btw_launch_unavailable` で断る (組み込みは本物の claude で model の request を出す。今の `btw_command` と同じ構え)
- **daemon.log**: `btw_ask` の行はそのまま (DR-0063 の `auto_mode_entries` を含む)。`session_launch` の行は書かない (起動の op ではない)

### 5. 組み込みの起動コマンド

組み込みの起動コマンド (`default-launch-command.sh`) に print の分かれ道を足し、組み込みの btw コマンドがしていたことを引き取る。

- `print` がある時は `hyoui` を前提にしない (`PATH` に無くても断らない)
- 環境の掃除と `direnv exec .` は対話の起動と同じ。config dir は対話の起動と同じく、daemon の環境に残った `CLAUDE_CONFIG_DIR` と cwd の `.envrc` で決まる (入れ直さない)
- `continue` / `resume` の model / effort の補い (`ccmsg launch-context`) は print の時にはしない。補いは起動の語彙 (別名) で返り、DR-0060 §2 の正式な id の決まりと食い違う。daemon が model を決められなかった btw は今の組み込みの btw コマンドと同じく `--model` を付けない
- model ごとの effort の既定も print の時には当てない (正式な id は表の名前に当たらず、今の btw と同じく effort の無い btw は `--effort` を付けない)
- `--name` は print の時には付けない (§3)
- `exec [direnv exec .] claude <写したオプション> <<< "$prompt"` で前景で走らせる

### 6. 消すもの

- config の `btw_command`。config は strict なので、`btw_command` を書いた config は読めない config になり、daemon は起動しない (読み替えは持たない。CHANGELOG で知らせる)
- 組み込みの btw コマンド (`default-btw-command.sh`、`DEFAULT_BTW_COMMAND_SCRIPT`、`defaultBtwCommand`、`btwCommandOf`)
- `BtwCommandInputSchema` と、その入力にだけあった `config_dir`
- 契約の文書 [btw-command](../../design/btw-command.md)。標準出力の stream-json の読み方 (「戻り方」の表) は launch-command の「print の時」の節へ移し、model / effort の決め方は DR-0060 §2 を正本にする

### 7. 契約の文書

- [launch-command](../../design/launch-command.md):
  - 入力の表に print の field を足し、組み合わせの検査と、`model` が print の時だけ正式な id を受けることを書く
  - 「print の時」の節を足す: §3 の責務、戻り方の置き換え、daemon の待ち方 (期限なし、取り消しは group に SIGTERM、`BTW_MAX_CONCURRENCY`)、daemon が読む stream-json の行 (btw-command の「戻り方」から移す)
  - 「取り決めの芯」の「daemon は起動コマンドの出力も終了コードも解釈しない」に、print の時は標準出力を stream-json として読み、終了コードを btw の失敗の文に使うことを書き添える
  - 「組み込みの起動コマンド」に print の分かれ道 (§5) を足す
- 自前の起動コマンドは、print の field を知るまでは知らない field として非零で終わる (今の取り決めのまま。黙って無視して対話の claude を起こさない)。その間の btw は `failed` で、`error` に起動コマンドの stderr が出る
- README (英・日) の btw の説明の「`btw_command` が起こす」を「起動コマンドが print で起こす」に、[TESTING](../../TESTING.md) の偽の `btw_command` を偽の起動コマンドに改める

## 裁定 (kawaz 2026-11-22)

1. **入力の形**: 「個別に決まってるだろ」。claude の print のオプションを個別の field で渡す (§2 の表)。`btw: true` の 1 つの印にしてオプションの組を起動コマンドに任せる形は採らない
2. **`btw_command` を消すか**: 「消すに決まってるだろ」。`btw_command` の設定、組み込みの btw コマンド、`BtwCommandInputSchema` を消し、claude を起こす経路を起動コマンドの 1 本にする (§1、§6)
   - 付随する `session_launcher` の節が無い時の btw は、組み込みの起動コマンドと空の `clean_env` / `keep_env` で起こす (§4)。これは統括の判断で、kawaz の明示の裁定ではない
3. **print の fork に `session_id` を渡すか**: 「どっちでも良い。併用 OK ならつければ良いんじゃね」。claude が `-p --resume <sid> --fork-session --session-id <新> --no-session-persistence` を受け、`init` の `session_id` が渡した id になることを測ったので ([findings 2026-11-22](../../findings/2026-11-22-print-fork-session-id-without-persistence.md))、渡す (§2)。起動の入力の `session_id` の検査は変えない
4. **config dir の渡し方**: 「何もしなくて良い。余計なお世話」。渡さない (§2、§5)

## 実装の段階分け

DR-0063 が main に入ってから始める。各段階はその前の段階だけに依り、段階ごとに `just test` が通る。

1. **protocol**: `LaunchCommandInputSchema` に print の field (§2 の表の `print` / `no_session_persistence` / `output_format` / `verbose` / `include_partial_messages` / `permission_prompts`) と組み合わせの検査を足し、`model` を print の時だけ正式な id に広げる。`LaunchInputSchema` には足さない。ErrorCode `btw_command_unavailable` を `btw_launch_unavailable` に改める (webui の `btw-input.ts` の文の分かれ道も)。`BtwCommandInputSchema` はこの段では残す
2. **組み込みの起動コマンド**: §5 の print の分かれ道。偽の claude と `hyoui` の無い `PATH` で、写したオプション・前景の exec・標準出力に claude の出力だけ・`ccmsg launch-context` を呼ばないことを確かめる
3. **daemon**: `btw_ask` が btw の起動の入力 (§2) を作り、起動コマンドを起動の環境 (§4) で起こす。`session_launcher` の節が無い時の組み込み、テストの daemon の条件、断り方、`session_id` の uuid。DR-0063 が btw コマンドの入力に足した `settings` は、btw の起動の入力の `settings` に寄せる (DR-0063 §8 の「btw コマンドの入力の `settings`」がこの入力の field になり、キーの決め方 (セッションの cwd) とファイルの作り方は変えない)。btw の試験 (`packages/daemon/test/btw*.test.ts`、`packages/webui/e2e/btw.e2e.ts`) の偽の `btw_command` を、print を扱う偽の起動コマンド (`session_launcher.launch_command`) に移す
4. **btw コマンドの削除**: §6 のもの (config の `btw_command`、組み込みの btw コマンドと `btwCommandOf`、`BtwCommandInputSchema`)。試験に残る `btw_command` の参照を消す
5. **docs**: §7 (launch-command の入力の表と「print の時」の節、btw-command の削除、README、TESTING)、CHANGELOG (`btw_command` が読めない config になること)
6. **試験の観点の網羅と実機の確認**: Consequences の「持たない」ことの試験の観点を埋め、「測ること」1〜3 を使い捨てのセッションで測る

## 測ること

実装の段 6 で、使い捨てのセッションで測る。

1. ユーザの起動コマンドが足すオプション (`--permission-mode` 等、sandbox ラッパー) を通した btw の fork が、元のセッションの prompt cache を読めるか (`btw_end` の行の `cache_read_input_tokens` と `cache_creation_input_tokens` を、組み込みで起こした時と比べる)
2. sandbox ラッパーを通した print の claude に、取り消しの SIGTERM (process group) が届いて止まるか。標準入力の prompt と標準出力の stream-json がラッパーを素通りするか
3. ユーザの起動コマンドの信頼の判定 (remote の確認に network を使うもの等) が btw 1 回に足す時間

## 既存の DR との関係

- **[DR-0060](../DR-0060-btw-mode.md) (btw モード)**:
  - 裁定 1「btw コマンドは config の command にする。daemon が `PATH` の `claude` を直接起こす形は採らない」のうち、btw 専用の command (`btw_command`) の部分を覆す。「config の command にする」「`PATH` の claude を直接起こさない」は残る (起こすのは config の起動コマンド)
  - §1 の「新しい経路は daemon と btw コマンドの間だけ」は「daemon と起動コマンドの間」になる
  - §2 の config・組み込みの btw コマンド・入力の形・Design rationale は、この DR の §2・§5・§6 に置き換わる。§2 の model / effort の決め方 (正式な id、`[1m]`、単発の上書きを入れない effort) と tool の集合を変えない決まりはそのまま使い、DR-0060 §2 が正本
  - §6 の ErrorCode `btw_command_unavailable` は `btw_launch_unavailable` になる
  - 目的の「セッションを起こす仕組みの種類を増やさない」は、この DR で種類が 1 つ減る方向に進む
- **[DR-0018](../DR-0018-session-launcher.md) (Session Launcher)**:
  - §2.3「プロセス管理をしない」「起動コマンドの終了コードを解釈しない」と launch-command の芯の「daemon は出力も終了コードも解釈しない」は、print の起動に当てない (§4)。print の起動のプロセスの扱いは DR-0060 の btw のもので、DR-0018 の起動の op (`session_launch`) には足さない
  - §3.1 の「`session_launcher` の節が無ければ起動は設定されていない」は、起動の口 (フォームと tool `launch`) の話として残る。btw は節が無くても組み込みで起こす (§4)
  - §3.3 の「field は全部 claude のオプションと 1 対 1」は保つ (print の field も claude のオプション)。`model` と `effort` の型が print の時だけ広がる (§2)
- **[DR-0062](../DR-0062-comments.md) (コメント)**: §14 の「変えずに使うもの: btw コマンドと標準入力・標準出力の契約 (DR-0060 §2、`btw_command`)」の `btw_command` は、この DR の経路 (起動コマンドの print) に読み替える。前置き・stream-json の読み方・`BTW_MAX_CONCURRENCY` は変わらない。実装の段階 5 (btw モードの吸収) とこの DR は、btw の記録の側と btw を起こす側で分かれていて、どちらが先でもよい。段階 5 の移行の段 4 で DR-0060 の本文を書き換える時は、btw コマンドの契約を残す必要は無い
- **[DR-0063](../DR-0063-project-auto-mode.md) (プロジェクトごとの autoMode)**:
  - §5 の「起動コマンドの入力と btw コマンドの入力の両方に `settings` を足す」は、起動コマンドの入力の 1 か所になる。自前のコマンドが `--settings` を 1 つにまとめる責務 (§5) も起動コマンドの 1 か所で済む
  - §8 の「btw コマンドの入力の `settings`、組み込みの btw コマンドは `--settings <path>` を付ける」は、btw の起動の入力 (§2) の `settings` と組み込みの起動コマンドの写し方になる。btw に渡すかとキーの決め方 (セッションの cwd) は変わらない
  - §7 の Design rationale が引く DR-0060 の裁定 1 は、この DR の後も「btw のセッションを起こす経路を config の command に限る」として読める
  - DR-0063 の段階 1 の実装が btw コマンドの入力に足した `settings` は、この DR の実装の段 3 で起動の入力の `settings` に寄せる
- **[DR-0028](../DR-0028-session-kill.md) (再起動)**: 再起動と btw が同じ起動コマンドを通り、config dir を渡さないことも同じになる

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| `btw_command` のまま、ユーザが起動コマンドの決まりを btw コマンドにも書き写す | 決まりを書く場所が 2 つになり、片方だけ直す食い違いが起きる。kawaz の構成のように `btw_command` を書かない人には、組み込みの btw コマンドが素の claude で走る今の状態が残る |
| `btw_command` を残し、無い時に起動コマンドを使う | 経路が 2 本のままで、目的の「書く場所を 1 つ」に反する (裁定 2) |
| print の起動を `btw: true` の 1 つの印で渡し、オプションの組を起動コマンドに任せる | ccmsg 独自の語彙 (btw) が起動コマンドに入り、自前の起動コマンドを書く人が ccmsg の版が上がるたびにオプションの組を追うことになる。今の契約の「field 名は claude のオプション名、写し方は同じ名前のオプションへ」からずれる (裁定 1) |
| `session_launcher` の節が無ければ btw も断る (`launcher_not_configured`) | 今 btw を使えている構成 (節を書いていない構成) で btw が止まる。節の必須の `root_dirs` は起動のフォームのためのもので、btw には要らない |
| print の fork に `session_id` を渡さず、検査を「保存される新しいセッションを作る時だけ」に変える | claude は保存しない fork でも `--session-id` を受けて渡した id で走る (findings 2026-11-22)。渡せば検査を変えずに済み、daemon は fork の id を前もって知る (裁定 3) |
| config dir を渡す (field か環境変数) | `config_dir` は claude のオプションでなく、field にすると「field は claude のオプションと 1 対 1」(DR-0018 §3.3) が崩れる。config dir は対話の resume と同じく起動コマンドが決める (裁定 4) |
| 起動コマンドに argv で印を足す (`launch_command` の後ろに `--btw` 等) | 契約は「daemon は引数を足さない」。入力の JSON の外に 2 つ目の入力の経路ができる |
| print を環境変数 (`CCMSG_LAUNCH_PRINT=1` 等) で知らせる | `CCMSG_LAUNCH_REQUESTED_BY` は claude のオプションでない「誰が頼んだか」だから環境変数にした。print は claude のオプションで、入力の field に置く決まり (DR-0018 §3.3) に当たる |
| daemon が `PATH` の claude を直接 `-p` で起こす | DR-0060 の裁定 1 の残る部分 (config の command に限る) に反し、ユーザの決まりがどれも効かない |
| print の時も起動コマンドを対話の起動と同じに扱い、起動コマンドが claude を detach して出力を別の経路 (ファイル等) で daemon に渡す | daemon の取り消しが claude に届かず、答えの逐次の読み方 (標準出力の stream-json) を作り直すことになる |

## Consequences

- protocol: `LaunchCommandInputSchema` に print の field と組み合わせの検査。`model` と `effort` の型が print の時だけ広がる。`session_id` の検査は変わらない。`BtwCommandInputSchema` が消え、ErrorCode `btw_command_unavailable` が `btw_launch_unavailable` になる
- daemon: `btw_ask` が起動コマンドを起動の環境 (`clean_env` / `keep_env`、`TMPDIR`、`CCMSG_LAUNCH_REQUESTED_BY=user`) で起こし、`session_id` に新しい uuid を入れる。`session_launcher` の節が無ければ組み込みの起動コマンドで起こす。process の扱い (逐次の読み、取り消し、上限) は今の btw のまま。config の `btw_command`、`btwCommandOf`、組み込みの btw コマンドが消える。テストの daemon が btw を起こさない条件は、起動コマンドの有無になる
- config: `btw_command` を書いた config は読めなくなり、daemon が起動しない
- 組み込みの起動コマンド: print の分かれ道 (§5)
- 文書: [launch-command](../../design/launch-command.md) の入力の表と「print の時」の節、[btw-command](../../design/btw-command.md) の削除、README、TESTING
- 試験: btw の試験の偽の `btw_command` を、print を扱う偽の起動コマンドに移す。起動の試験の偽の起動コマンドにも btw が届くようになる。組み込みの起動コマンドが print で `hyoui` を要らず、claude を前景で exec し、写したオプションを付けることを偽の claude で確かめる
- btw だけを別のコマンドにしたい使い方 (試験・別の claude) は、起動コマンドの中で `print` で分けて書く
- ユーザの起動コマンドは、print の field を読めるように直すまで btw が `failed` になる (知らない field で非零)。直す時に §3 の責務 (前景で exec、標準出力に claude だけ、print の field を落とさない、端末の処理を飛ばす) を足す
- btw の fork に config dir を渡さなくなる。前は agents の行 (または hello) の config dir を `CLAUDE_CONFIG_DIR` にしていたので動いた btw が、cwd の `.envrc` と daemon の環境の config dir がセッションの config dir と食い違うと、resume する transcript が見つからず `failed` になりうる
- btw にもユーザの起動コマンドの信頼の判定が効く。端末から起こしたセッションで、起動コマンドが信頼しない cwd のものは btw が `failed` になる (今は走る)
- btw 1 回の始まりまでの時間に、ユーザの起動コマンドの前処理の時間が足される (「測ること」3)
- 「持たない」ことを壊す変更を止める試験の観点:
  - webui のフォーム・tool `launch`・`session_launch` の入力に print の field を書いても読めない入力になる (daemon だけが足す)
  - claude が受けない print の field の組 (§2 の組み合わせの検査) は、起動の入力として読めない
  - btw の起動コマンドの入力の `model` は、別名で起動したセッションでも正式な id で、1M のセッションでは `[1m]` を落とさない (DR-0060 の観点を起動コマンドの入力で見る)
  - btw の起動コマンドの入力は `fork_session` と新しい `session_id` を持ち、`config_dir` を持たない
  - print の起動に `launch_timeout_seconds` が効かない (期限を超えて答える btw が止められない)
  - btw の取り消しで、起動コマンドが exec した claude が止まる
  - 組み込みの起動コマンドは print の時に `hyoui` を呼ばず、`ccmsg launch-context` を呼ばず、標準出力に claude の出力以外を書かない
  - `session_launcher` の節の無い本番の daemon は btw を組み込みの起動コマンドで起こし、テストの daemon は起こさずに `btw_launch_unavailable` で断る
  - `btw_command` を書いた config は読めない config になる

## 関連

- [DR-0060](../DR-0060-btw-mode.md) — btw モード (経路の一部を覆す)
- [DR-0018](../DR-0018-session-launcher.md) — 起動コマンドと起動の入力
- [DR-0062](../DR-0062-comments.md) §14 — btw のコメントへの吸収
- [DR-0063](../DR-0063-project-auto-mode.md) §5、§8 — 起動と btw への `--settings`
- [DR-0028](../DR-0028-session-kill.md) — 再起動 (同じ起動コマンドを通る)
- [launch-command](../../design/launch-command.md) / [btw-command](../../design/btw-command.md) — コマンドの契約 (btw-command は消す)
- [findings 2026-11-22-print-fork-session-id-without-persistence](../../findings/2026-11-22-print-fork-session-id-without-persistence.md) — 保存しない print の fork への `--session-id`
- [findings 2026-10-25-fork-with-session-id](../../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id` の併用
- [findings 2026-11-22-dr62-btw-cache-and-prompt-concat](../../findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md) — btw の fork の cache と model の別名
