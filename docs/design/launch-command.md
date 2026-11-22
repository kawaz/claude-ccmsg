# launch-command: 起動コマンドの契約

## コンテキスト

daemon は Claude セッションの起動を、config の `session_launcher.launch_command` で指定された 1 つのコマンド (以下、起動コマンド) に任せる ([DR-0018](../decisions/DR-0018-session-launcher.md) §3)。btw ([DR-0060](../decisions/DR-0060-btw-mode.md)) の fork も同じ起動コマンドが print (`-p`) の起動として起こす ([DR-0064](../decisions/DR-0064-btw-through-launch-command.md)、下の「print の時」)。起動コマンドは ccmsg の外にあり、使う人が自分の環境に合わせて書く。この文書は daemon と起動コマンドの間の取り決めの正本で、起動コマンドを書く人と daemon を実装する人の両方が読む。

取り決めの芯は「daemon は型の決まった入力を渡して終わりを待つだけで、claude をどう起動するかは起動コマンドが全部持つ」こと。daemon は claude の引数を組み立てず、起動コマンドの出力も終了コードも解釈しない。ただし print の起動では、daemon は標準出力を claude の stream-json として読み、`result` の前に終わった時は終了コードと stderr を btw の失敗の文に使う。入力の field 名は claude のオプション名の snake_case なので、写し方は field ごとに同じ名前のオプションへ置くことが基本になる。

## 呼ばれ方

| 項目 | 内容 |
|---|---|
| argv | `launch_command` の配列そのまま (先頭は daemon が config を読んだ時に固定した絶対パス)。daemon は引数を足さず、shell を介さない |
| cwd | 入力の `cwd` を daemon が realpath に解決したディレクトリ (存在するディレクトリであることは daemon が確かめ済み) |
| 環境 | daemon の環境から `clean_env` に当たるキー (`keep_env` にも当たるものを除く) を落とし、その上に daemon が `TMPDIR` と `CCMSG_LAUNCH_REQUESTED_BY` を重ねたもの (下の「環境変数」) |
| stdin | 入力の JSON (UTF-8) を 1 つ書いて閉じる。末尾に改行は付かない (最後の byte は `}`)。`read` のように改行までを読む道具では最後の行を取りこぼすので、`cat` や `jq` で全部を読む |
| process group | 起動コマンドは自分の process group を持って起こされる (setsid)。timeout の signal は group に送られる |
| 回数 | 起動の依頼 1 つにつき 1 回。複数の依頼が来れば並行して呼ばれる (同時に最大 `launch_max_concurrency` 個) |
| 待ち | config の `launch_timeout_seconds` (既定 10 秒) を超えると process group に SIGTERM、その 500 ms 後に SIGKILL。timeout で止めた時は、起動コマンドが終わった後に group に残っているものにも SIGKILL が届く |
| daemon が終わる時 | daemon は走っている起動コマンドの終わり (最長で上の待ち) を待ってから終わる |

print の起動 (btw の fork) は回数・待ち・daemon が終わる時が違う (下の「print の時」)。

## 入力

形は `packages/protocol` の `LaunchCommandInputSchema` (DR-0018 §3.3)。

| field | 型 | 意味 |
|---|---|---|
| `cwd` | 文字列 (必須) | 起動するディレクトリ (realpath)。`continue` はここで最も新しいセッションを続ける |
| `model` | `mythos` / `fable` / `opus` / `sonnet` / `haiku` (print の時は空でない文字列) | `--model`。新規 (`continue` も `resume` も無い) では必ずある。`resume` では daemon が読めた限りある (下の注)。`continue` では依頼にある時だけ。print の時は、セッションが最後に答えた model の正式な id に、1M の context のセッションでは `[1m]` を付けたもの (`claude-opus-5-5[1m]`、`claude-haiku-5-5`)。別名だと元のセッションの prompt cache に当たらないため ([DR-0060](../decisions/DR-0060-btw-mode.md) §2)。daemon が分からない時は無い |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max` (print の時は空でない文字列) | `--effort`。新規では必ずある。`resume` では daemon が読めた限りある (下の注)。`continue` では依頼にある時だけ。print の時は、セッションの綴りのまま (起動の選択肢に絞らない)。daemon が分からない時は無い |
| `continue` | boolean | `--continue` |
| `resume` | uuid | `--resume` の id |
| `fork_session` | boolean | `--fork-session`: 元のセッションの履歴を先端まで写した新しいセッションにする |
| `session_id` | uuid | daemon が生成した新しいセッションの id (UUID v4)。新規と `fork_session` の時だけある (print の fork にもある)。起動コマンドが 0 で終われば呼び手にこの値が返る |
| `name` | 文字列 (空でない) | `--name` |
| `prompt` | 文字列 (空でない) | 最初の prompt。起動した claude の stdin に書く |
| `print` | boolean | `-p`。btw の fork の時だけ `true` で来る (下の「print の時」)。`resume` と `fork_session` と一緒にだけ来る |
| `no_session_persistence` | boolean | `--no-session-persistence`。print の時だけ |
| `output_format` | `text` / `json` / `stream-json` | `--output-format`。print の時だけ |
| `verbose` | boolean | `--verbose` |
| `include_partial_messages` | boolean | `--include-partial-messages`。print の時だけ |
| `permission_prompts` | `host` / `none` | `--permission-prompts`。print の時だけ |
| `settings` | 文字列 (絶対パス) | `--settings`。起動の cwd のプロジェクトの autoMode から daemon が作った settings のファイル ([DR-0063](../decisions/DR-0063-project-auto-mode.md) §4)。そのプロジェクトに項目のあるセクションがある時だけある。中身は `{"autoMode": {...}}` だけで、ファイルは内容で名前が決まり、一度できたら変わらない。起動の全ての種類 (新規・`continue`・`resume`・fork・再起動・btw の fork) に、依頼者を問わず入る。daemon だけが足す field で、頼み手 (webui のフォーム、tool `launch`) は渡せない。`project-auto-mode.json` が読めない時と settings のファイルを書けない時、daemon は起動を断り (`project_auto_mode_unreadable`)、起動コマンドを呼ばない |

- field は全部 claude のオプションと 1 対 1 (`session_id` は `--session-id`、`settings` は `--settings`、`print` は `-p`)。`prompt` だけはオプションでなく claude の stdin に当たる。claude の起動に無い名前の field は来ない
- 無い field と、`false` の `continue` / `fork_session` は指定されていない
- daemon は組み合わせを確かめてから渡す: `continue` と `resume` は同時に来ない、`fork_session` は `continue` か `resume` と一緒にだけ来る、新規には `model` と `effort` がある。print のオプションは claude が受ける組でだけ来る: `no_session_persistence`・`output_format`・`include_partial_messages`・`permission_prompts` は `print` と一緒に、`output_format: stream-json` は `verbose` と一緒に (無いと claude は起動しない)、`include_partial_messages` は `output_format: stream-json` と一緒に
- `session_id`・`settings`・print のオプションは daemon だけが足す field で、頼み手 (webui のフォーム、tool `launch`、op `session_launch`) は渡せない
- `resume` (fork を含む) の `model` / `effort` は、依頼に無ければ daemon がそのセッションの今の値 (通しの上書きを含む) で埋める ([DR-0018](../decisions/DR-0018-session-launcher.md) §3.2 の「resume の model / effort」)。daemon がどこからも読めなかった欄と、依頼が別の model を名指して `effort` を省いた時の `effort` は無いまま来る。`continue` の `model` / `effort` は daemon が埋めない (どのセッションを続けるかを daemon は特定できない、DR-0018 §3.2)。どちらも起動コマンドが補う (下の「model / effort の補い」)
- 任意の field が無い時の値は起動コマンドが決める (例: model ごとの effort の既定、リポ名と日時からのセッション名、既定の prompt)
- 読めない入力 (知らない field、型の違う値) には推測で補って起動せず、非零で終わって理由を stderr に書く。daemon が新しい field を足した時に、古い起動コマンドが黙って無視して別の起動をするのを避けるため。`settings` を知らない自前の起動コマンドは、autoMode に項目のあるプロジェクトの起動で非零で終わる (項目の無いプロジェクトでは `settings` は来ない)

## 環境変数

daemon が起動コマンドの環境に重ねる変数。`clean_env` / `keep_env` の判定の後に重ねるので、`CCMSG_*` や `TMPDIR` を落とす・残すパターンを書いても、この値で届く。

| 変数 | 値 |
|---|---|
| `CCMSG_LAUNCH_REQUESTED_BY` | 依頼者: `user` (人、webui から) か、依頼したセッションの sid (エージェント、tool `launch` から)。人とエージェントで cwd の信頼判定を変える時に使う |
| `TMPDIR` | OS の利用者ごとの一時ディレクトリ (macOS は `getconf DARWIN_USER_TEMP_DIR` の値、末尾に `/`)。それが無い OS では `TMPDIR` を渡さない。daemon の `TMPDIR` (daemon を起こした人の一時置き場) は渡さない ([DR-0018](../decisions/DR-0018-session-launcher.md) §3.1)。セッションごとの一時置き場を使わせる起動コマンドは、自分で `TMPDIR` を export してから claude を起こす |

## claude の引数への写し方

field ごとに同じ名前のオプションへ写す: `model` → `--model`、`effort` → `--effort`、`continue` → 続けるセッションの `--resume <id>` (下の「continue」。続けられるセッションが無い時と、`--resume` に断られるセッションの時は `--continue`)、`resume` → `--resume <id>`、`fork_session` → `--fork-session`、`session_id` → `--session-id <id>`、`name` → `--name`、`settings` → `--settings <path>`、`print` → `-p`、`no_session_persistence` → `--no-session-persistence`、`output_format` → `--output-format <format>`、`verbose` → `--verbose`、`include_partial_messages` → `--include-partial-messages`、`permission_prompts` → `--permission-prompts <target>`。

`prompt` は起動した claude の stdin に書く (位置引数にしない: `ps` に見える、引数の長さの上限に当たる、shell や option として解釈されうる)。対話の claude は端末でない stdin を読み切り、その中身を最初の prompt として送信する。改行も末尾の改行もそのまま 1 つの prompt になる ([findings 2026-10-30-launch-prompt-on-stdin](../findings/2026-10-30-launch-prompt-on-stdin.md))。`prompt` が無い時に何を渡すか (既定の prompt、`/dev/null`) は起動コマンドが決める。端末 proxy は stdin を claude にそのまま継ぐもの (`hyoui run` は端末でない stdin の fd を子の stdin に渡す) を使う。

| 入力 | claude の起動 |
|---|---|
| 新規 | `claude --session-id <session_id> --model <model> --effort <effort> [--name <name>]` |
| `continue` | `claude --resume <選んだ id> [--model …] [--effort …] [--name …]` (選べない時と `keep_continue` の時は `--resume <選んだ id>` の代わりに `--continue`) |
| `resume` | `claude --resume <resume> [--model …] [--effort …] [--name …]` |
| `continue` / `resume` + `fork_session` | 上に `--fork-session --session-id <session_id>` を足す |
| `settings` がある時 | どの起動にも `--settings <settings>` を足す |
| `print` (btw の fork) | `claude -p --resume <resume> --fork-session --session-id <session_id> --no-session-persistence [--model …] [--effort …] [--settings …] --permission-prompts none --output-format stream-json --verbose --include-partial-messages` (下の「print の時」) |

守ること:

- `model` / `effort` が入力にあれば、`continue` / `resume` / fork でも `--model` / `--effort` を付ける。claude は `--model` の無い `--resume` / `--resume --fork-session` を、元のセッションの model ではなく settings の model (`model`) で続け、cache を書き直す (実測 2026-11-15: haiku で作ったセッションを `--model` なしで resume・fork すると、続きのターンは settings の fable で走った。`--model haiku` を付けると haiku のまま cache に当たった)。daemon は `resume` (再起動と fork を含む) の入力にセッションの今の model / effort を入れるので、それを渡せば同じ model で続く
- `--settings` は 1 回だけ付ける。claude は `--settings` を 2 回渡すとエラーにせず後の 1 つだけを読む (実測、[DR-0063](../decisions/DR-0063-project-auto-mode.md) Context)。起動コマンドが自分でも settings を渡すなら、下の「起動コマンドが持つ責務」のとおり 1 つにまとめる
- `--session-id` は `session_id` がある時だけ付ける。fork でない `--continue` / `--resume` に付けると claude は `--session-id can only be used with --continue or --resume if --fork-session is also specified.` で起動しない
- `prompt` は本文を変えずに claude に届ける (shell の語分割、quote の除去、切り詰めをしない)
- `prompt` を pipe で渡す時は、起動コマンドが終わった後に claude が読んでも欠けないようにする。端末 proxy が detach してすぐ終わると、pipe が受け取りきっていない分は失われる。here-string や一時ファイルのような通常のファイルなら、claude が後から読んでも全部ある

## continue

`continue` は `--continue` をそのまま渡さず、claude が選ぶはずのセッションを起動の前に選び、その `--resume <id>` で起動する。起動コマンドがセッションの id で用意するもの (一時ディレクトリ等) と、実際に続くセッションがずれないようにするため。選んだセッションを `--resume` が断る時だけは `--continue` のまま渡す (下の `keep_continue`)。

- 選ぶのは `ccmsg launch-context --continue` (対話の claude を起動するので `--print` は付けない)。claude と同じ環境 (config dir は `CLAUDE_CONFIG_DIR`、無ければ `~/.claude`。cwd の `.envrc` が変えるならその後の値) で、起動の cwd で走らせる。stdout の 1 行の JSON の `session_id` が選んだセッション
- `session_id` が無ければ続けられるセッションは無い。`--continue` のまま渡して claude に断らせる (対話は `No conversation found to continue` で終わる)。claude の振る舞いを起動コマンドが真似ない
- 選び方は Claude Code 2.1.326 で実測した決まり ([findings 2026-11-17-claude-continue-session-pick-empirical](../findings/2026-11-17-claude-continue-session-pick-empirical.md))。claude の版が上がって選び方が変わっても、起動は選んだ id の `--resume` なので、選んだ id と違うセッションが続くことは無い。変わりうるのは、それが `--continue` の選ぶセッションと同じかどうかだけ
- 今動いているセッションも選ばれる (claude の `--continue` と同じ)。その時は同じ id のプロセスが 2 つになり、同じ transcript に書く
- JSON に `keep_continue: true` があれば、選んだセッションは `--resume` に断られる (`No conversation found with session ID: <id>`)。`--continue` のまま渡す。`--continue` はそのファイルを選び、その id のまま続けるので、`session_id` はそのまま続くセッションの id として使える (一時ディレクトリ等もその id で用意する)。`--session-id` は付けない (fork でない `--continue` には付けられない)。この時の起動は `--continue` なので、上の「選んだ id と違うセッションが続くことは無い」は成り立たない (claude の選び方が変わっていれば、別のセッションが続きうる)。claude が `--resume` を断るのは、そのファイルに claude の読み込める会話が無い時: 0 バイト、壊れた行だけ、メタデータの行だけ (16 MiB を超えるものも)、会話の行が全部 sidechain、最後の行から辿った user / assistant の行に読める `timestamp` が無い、等。決まりは [findings 2026-11-17-claude-continue-session-pick-empirical](../findings/2026-11-17-claude-continue-session-pick-empirical.md) の「`--resume` に断られる形」
- `fork_session` は選んだセッションの `--resume <id> --fork-session --session-id <session_id>`。`keep_continue` の時は `--continue --fork-session --session-id <session_id>` (`--resume <id> --fork-session` は断られ、`--continue --fork-session` はそのファイルから fork する)

## model / effort の補い

`continue` と `resume` (fork を含む) で入力に無い `model` / `effort` は、続けるセッションの値で補ってから `--model` / `--effort` に写す (無いと claude は settings の model で続け、cache を書き直す。上の「守ること」)。

- 値は `ccmsg launch-context` に `--continue` か `--resume <id>` と、入力にある `--model` / `--effort` を渡して聞く。返る `model` / `effort` は、続けるセッションの transcript の末尾の main context の assistant 行 (sidechain と `<synthetic>` の行を除いた最後のもの) の値を起動の入力の選択肢に写したもの。返るのは入力に無い欄だけで、入力の `model` がそのセッションの model と違う時は `effort` を返さない (model を選び直した時の effort はその model の既定)。daemon が `resume` を埋める規則 ([DR-0018](../decisions/DR-0018-session-launcher.md) §3.2) と同じ
- daemon が埋めて渡した欄は入力にあるので、そのまま使う。起動コマンドの補いは daemon が埋めなかった時 (`continue`、daemon がどこからも読めなかった `resume`、daemon を通らずに起動コマンドを直に使う時) の受け皿
- transcript が無い時、読める assistant 行が無い時は補わない (起動コマンドの既定、それも無ければ claude の既定で続く)。`keep_continue` のセッションも同じ決まりで、0 バイトのファイル等からは何も返らない

## 戻り方

- **速やかに終わる**: 対話の claude は detached な端末 (端末 proxy 等) で起こし、起動コマンド自身は `launch_timeout_seconds` より十分前に終わる。待ち続けると SIGTERM / SIGKILL で止められる
- **detach した子は process group から外す**: 対話の claude を載せた端末 proxy 等は setsid して起動コマンドの process group から外す。group に残った子は、timeout で止められた時に一緒に止められる
- **detach した子に stdout / stderr を継がせない**: daemon は起動コマンドが終わった後、pipe の EOF を 500 ms しか待たない。子が pipe を持ち続けると、その後の出力は呼び手に届かない
- **終了コード**: 失敗 (入力が読めない、cwd が信頼できない等) は全部、対話の claude を起動する前に非零で返す。**対話の claude を起動した後は 0 で終わる** (起動の後の失敗を非零で返さない。非零は「起動していない」を意味する)。daemon は response の `session_id` を exit 0 の時だけ返すので (DR-0018 §3.4)、起動した後に非零で終わると、立ち上がったセッションの id が呼び手に届かなくなる。0 はセッションが立ち上がって daemon に名乗ったこと (到達) ではない。detached に起こした claude がその後 `Session ID … is already in use.` 等で終わっても、起動コマンドの 0 は変わらない。daemon は値を解釈せず、そのまま呼び手に返す
- **stdout**: 呼び手に見せる短い文 (例: claude を載せた端末の id)。4096 bytes 以上は daemon がファイルに退避し、呼び手には置き場だけが返る。daemon が取り込むのは先頭の 1 MiB まで
- **stderr**: 非零で終わる時の理由。呼び手 (エージェントや webui の結果パネル) が最初の行で事情を掴めるように、要点を先頭に書く

## print の時 (btw の fork)

webui の btw ([DR-0060](../decisions/DR-0060-btw-mode.md)) は、走っているセッションを fork して横道の質問・依頼に答えさせ、そのやりとりを本体の会話に残さない。daemon はその fork を、セッションの起動と同じ起動コマンドに `print: true` の入力で起こさせる ([DR-0064](../decisions/DR-0064-btw-through-launch-command.md))。起動コマンドに書いた決まり (cwd の信頼判定、claude の差し替え、一時置き場、環境の掃除、毎回付けるオプション、`--settings` のまとめ方) が、対話の起動と同じく btw にも効く。

### 入力

btw の fork の入力は次のとおり。`name` と `continue` は来ない。

```json
{"cwd":"/work/claude-ccmsg","resume":"5a900000-0000-4000-8000-000000000001","fork_session":true,"session_id":"6b000000-0000-4000-8000-000000000002","print":true,"no_session_persistence":true,"output_format":"stream-json","verbose":true,"include_partial_messages":true,"permission_prompts":"none","model":"claude-opus-5-5[1m]","effort":"high","prompt":"<btw>\n...\n</btw>\n\nこの関数は何をしている?"}
```

- `cwd` はセッションの cwd の realpath、`resume` はセッションの id、`session_id` は fork の新しい id。claude は保存しない fork (`--no-session-persistence`) でも渡した id で走り、transcript を作らない ([findings 2026-11-22-print-fork-session-id-without-persistence](../findings/2026-11-22-print-fork-session-id-without-persistence.md))
- `model` / `effort` は DR-0060 §2 の決め方 (`model` は上の「入力」の表)。`effort` は人が FAB の ⏱️ で選んだもの、無ければセッションが今走っている effort をセッションの綴りのまま (起動の選択肢の外のものも)。空の綴りは渡さない (field が無い)
- `settings` は対話の起動と同じ (セッションの cwd のプロジェクトの autoMode)
- `prompt` は btw の前置き (`BTW_PROMPT_PREFIX`) を付けた全文
- config dir は渡さない。対話の `resume` と同じく、起動コマンドが決める (下の「起動コマンドが持つ責務」の「端末と環境」)

### 起動コマンドの責務

上の「戻り方」は対話の起動の決まりで、print の時は次のものに置き換わる。

- **claude を前景で exec する**: 端末 proxy に載せない、detach しない、process group から外さない。daemon の取り消し (process group への SIGTERM) が claude に届くようにする。claude をラッパーに差し替える環境では、ラッパーも同じ group の中で前景で走らせる
- **標準出力には claude の出力だけを書く**: daemon は標準出力を stream-json として読む (読めない行は読み捨てるが、混ぜない)。端末の id 等の起動コマンド自身の出力は書かない
- **print のオプションは写すだけで、落とさない・値を変えない**: 値は daemon の読み方 (stream-json、partial messages) と cache の決まりで決まっている。tool の集合を変える引数 (`--tools`、`--disallowedTools`、`--restricted`、`--bare` 等) も足さない。request の tools が元のセッションと変わると、prompt cache の前方一致がそこで切れる
- **`prompt` は claude の標準入力に渡す** (対話の起動と同じ)
- **終了コード**: claude を起こす前の失敗 (入力が読めない、cwd が信頼できない等) は非零で終わり、理由を stderr に書く。claude を exec した後は claude の終了コードがそのまま daemon に届く
- **端末に付随する処理をしない**: 端末 proxy への載せ方、画面の罫線の待ち、trust ダイアログの自動応答、セッション名の既定の名前付け (`--name`)。print の claude は端末を持たず、trust ダイアログも出ない。fork は保存されないので名前の置き場も無い
- **`model` / `effort` を補わない**: 「model / effort の補い」は対話の起動のもの。補いは起動の選択肢 (別名) で返り、正式な id の決まりと食い違う

`print` を知らない自前の起動コマンドは、知らない field として非零で終わる (上の「入力」の取り決め。黙って無視して対話の claude を起こさない)。その間の btw は失敗し、失敗の文に起動コマンドの stderr が出る。

### daemon の待ち方

| 項目 | 内容 |
|---|---|
| argv | `session_launcher.launch_command`。`session_launcher` の節が無ければ組み込みの起動コマンド |
| 環境 | 対話の起動と同じ (`clean_env` / `keep_env`、`TMPDIR`、`CCMSG_LAUNCH_REQUESTED_BY=user`。btw を頼めるのは人だけ)。節が無い時の `clean_env` / `keep_env` は空 |
| 回数 | btw 1 つにつき 1 回。daemon 全体で同時に `BTW_MAX_CONCURRENCY` (4) まで。`launch_max_concurrency` とは別に数える |
| 待ち | 期限は無い (`launch_timeout_seconds` を当てない)。止めるのは人の取り消し (op `btw_cancel`) と daemon の停止で、どちらも process group に SIGTERM を送る |
| stdout | 1 行ずつ claude の stream-json として逐次読む (下の表)。取り込みの上限と退避ファイルは無い |
| stderr | `result` の前に終わった時、終了コードと末尾 2 行を btw の失敗の文にする |
| 断る時 | 起動コマンドを起こせない (spawn の失敗) 時は `btw_launch_unavailable` |

daemon が読む行:

| 行 | 使い方 |
|---|---|
| `stream_event` (`parent_tool_use_id` が null) | `message_start` で新しい応答、`content_block_start` の `text` で新しい文のブロック、`content_block_delta` の `text_delta` で文を伸ばす。`content_block_start` の `tool_use` の `name` を今走っている tool として出す |
| `assistant` (`parent_tool_use_id` が null) | 差分の来なかった応答 (`message.id` で突き合わせる) の text のブロックを答えに足す。`tool_use` の `name` を今走っている tool にする |
| `result` | 終わり。`is_error` が false なら答えた (done)、true なら失敗 (`result` の文、無ければ `subtype`) |

- `parent_tool_use_id` のある行 (fork の中の subagent) は答えにしない
- 起動コマンドで `claude` 以外を起こす時も、この形の行を書く。差分の行を書かない (partial messages の無い) 出力も読める

### テストの daemon

テストの run の lifeline (`CCMSG_TEST_LIFELINE`) の下で起きた daemon は、組み込みの起動コマンドで btw を起こさず、`btw_ask` を `btw_launch_unavailable` で断る (組み込みは本物のセッションを fork し、model の request を出す)。`session_launcher` の節が無い時と、節の `launch_command` を省いた時 (組み込みになる) がこれに当たる。btw を確かめるテストは、入力を記録して決まった stream-json を書く起動コマンドを `session_launcher.launch_command` に書く。発声コマンド ([say-command](./say-command.md)) の「テストの daemon」と同じ形。

## 組み込みの起動コマンド

config に `launch_command` が無い時、daemon は plugin に同梱の zsh スクリプト `packages/daemon/src/default-launch-command.sh` を `zsh -f <スクリプト>` で起動コマンドとして実行する (DR-0018 §3.1)。`zsh` は daemon の `PATH` で探す。`-f` で `~/.zshenv` 等を読まないので、スクリプトは daemon が渡した環境で動く。スクリプトがすることは次のとおり。

- **前提**: `jq`・`claude` のどれかが `PATH` に無ければ非零 (2) で終わり、理由を stderr に書く。print でない起動は `hyoui` も要る
- **入力を読む**: stdin の JSON の各 field を `jq` で取り出す。入力の検査はしない。組み込みは同じ版の daemon が `LaunchCommandInputSchema` で検査した入力だけを受けるので、知らない field は来ない
- **オプション**: field を上の「claude の引数への写し方」のとおり同じ名前のオプションに写す。`settings` はそのまま `--settings <path>` にする (組み込みはほかに `--settings` を付けないので、まとめるものは無い)
- **continue と model / effort の補い**: 上の「continue」「model / effort の補い」を、plugin に同梱の CLI (plugin の `bin/ccmsg launch-context`。bun で動く) に聞いて行う。claude と同じ環境で聞くため、`direnv` があれば `direnv exec .` を通す。CLI が答えなければ (bun が無い等) claude を起動せず非零 (2) で終わる
- **effort の既定**: 補った後も `effort` が無い時は model ごとに決める (mythos は low、fable は low、opus は medium、sonnet は medium、haiku は low)。`model` も無ければ `--model` も `--effort` も付けない
- **prompt**: `prompt` が無い時は `.`。claude の stdin に here-string (`<<<`) で渡す。here-string は通常のファイルなので、claude が後から読んでも欠けない。`jq -r` で取り出す時に末尾の改行が落ち、here-string が改行を 1 つ足すので、claude に届く prompt の末尾は改行 1 つになる
- **環境**: `CLAUDE_CONFIG_DIR` を除く `CLAUDE*`・`ANTHROPIC_*`・`HYOUI_*`・`CCMSG_*` の変数を消してから claude を起動する (daemon の `clean_env` が残したものも含めて、別のセッションや端末の変数を継がない)
- **起動**: `hyoui run --detached -- claude <オプション>` を exec し、hyoui の stdout (端末の id) と終了コードをそのまま返す。`direnv` が `PATH` にあれば `direnv exec .` を通し、cwd の `.envrc` (config dir、リポの持ち主のアカウントの鍵等) を claude に効かせる
- **print の時**: `hyoui` を使わず `claude <オプション>` を前景で exec する (`direnv` があれば `direnv exec .` を通す)。`continue` / `resume` の model / effort の補いと effort の既定は当てず、`name` があっても `--name` を付けない。config dir は対話の起動と同じく、daemon から継いだ `CLAUDE_CONFIG_DIR` と cwd の `.envrc` で決まる

cwd の信頼判定と trust ダイアログの吸収はしない。`CCMSG_LAUNCH_REQUESTED_BY` による判定の切り替え、permission mode の指定、セッション名の既定もしない。どれかが要る環境は、自前の起動コマンドを書いて `launch_command` に置く。

## 起動コマンドが持つ責務

daemon が持たず、起動コマンドが判断するもの。

- **cwd の信頼判定**: その cwd でセッションを起動してよいか (リポの置き場所、所有者、remote 等)。信頼できなければ起動せず非零で終わる。btw の fork (print の時) にも同じ判定が効き、信頼しない cwd のセッションの btw は失敗する。daemon は cwd が存在するディレクトリであることしか見ない。エージェントからの起動 (DR-0018 §3.8) を止められるのはこの判定だけで、`CCMSG_LAUNCH_REQUESTED_BY` で人とエージェントの判定を分けられる
- **trust ダイアログの吸収**: 対話の claude は初めての workspace で trust ダイアログ (`Quick safety check`) を出し、答えるまで先へ進まない。cwd の信頼判定を通った時に限り、起動コマンドが端末の画面を読んで承認のキーを送る。ダイアログが出なければ何もしない。想定外の画面なら操作せず人に任せる (claude は起動済みなので、その時も起動コマンドは 0 で終わる。到達は呼び手が確かめる)
- **端末と環境**: どの端末に載せるか、面ごとの `CLAUDE_CONFIG_DIR` 等の環境をどう整えるか、daemon の環境から継いだ変数をさらに落とすか。`resume` (再起動を含む) は元のセッションの config dir で claude を起こす: claude はセッションの transcript をそのセッションの config dir の下にしか持たないので、別の config dir で起こすと resume する transcript が無い。daemon は config dir を渡さない
- **任意の field の既定**: 上の「入力」の節
- **自前の settings とのまとめ**: `--settings` を自分でも付ける (ほかの目的で settings を渡す) 起動コマンドは、入力の `settings` と 2 つを 1 つの settings にまとめて `--settings` を 1 回だけ付ける。自前の settings を土台にし、`autoMode` の 4 つのリスト (`environment` / `allow` / `soft_deny` / `hard_deny`) は「自前のリスト、続けて入力の `settings` のファイルのリスト」の連結にする (`$defaults` が 2 回になっても組み込みの既定は 1 回しか入らない、実測)。入力の `settings` のファイルは `autoMode` の 4 つのリストしか持たないので、ほかの key は食い違わない。まとめたものは起動コマンドが自分の一時の置き場に書いてそのパスを渡し、入力の `settings` のファイルは書き換えない
- **走っているセッションへの `resume` / `continue`**: 止めるか (DR-0018 §7 の未確定)

## 関連

- [DR-0018](../decisions/DR-0018-session-launcher.md) — 起動の入力、op、daemon の手順、tool `launch`
- [DR-0063](../decisions/DR-0063-project-auto-mode.md) — プロジェクトごとの autoMode と、`settings` のファイル
- [DR-0060](../decisions/DR-0060-btw-mode.md) — btw の全体
- [DR-0064](../decisions/DR-0064-btw-through-launch-command.md) — btw の fork を起動コマンドの print の起動で起こす
- [findings 2026-11-22-print-fork-session-id-without-persistence](../findings/2026-11-22-print-fork-session-id-without-persistence.md) — 保存しない print の fork への `--session-id`
- [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id` の併用、`--session-id` を拒む組み合わせ
- [findings 2026-10-30-launch-prompt-on-stdin](../findings/2026-10-30-launch-prompt-on-stdin.md) — stdin の prompt が対話の claude の最初の prompt になること、pipe で渡した prompt が detach の後に欠けること
- [findings 2026-11-17-claude-continue-session-pick-empirical](../findings/2026-11-17-claude-continue-session-pick-empirical.md) — `claude --continue` がどのセッションを選ぶか (実測)。`ccmsg launch-context` の選び方の元
