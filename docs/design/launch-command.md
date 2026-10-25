# launch-command: 起動コマンドの契約

## コンテキスト

daemon は Claude セッションの起動を、config の `session_launcher.launch_command` で指定された 1 つのコマンド (以下、起動コマンド) に任せる ([DR-0018](../decisions/DR-0018-session-launcher.md) §3)。起動コマンドは ccmsg の外にあり、使う人が自分の環境に合わせて書く。この文書は daemon と起動コマンドの間の取り決めの正本で、起動コマンドを書く人と daemon を実装する人の両方が読む。

取り決めの芯は「daemon は型の決まった入力を渡して終わりを待つだけで、claude をどう起動するかは起動コマンドが全部持つ」こと。daemon は claude の引数を組み立てず、起動コマンドの出力も終了コードも解釈しない。入力の field 名は claude のオプション名の snake_case なので、写し方は field ごとに同じ名前のオプションへ置くことが基本になる。

## 呼ばれ方

| 項目 | 内容 |
|---|---|
| argv | `launch_command` の配列そのまま (先頭は daemon が config を読んだ時に固定した絶対パス)。daemon は引数を足さず、shell を介さない |
| cwd | 入力の `cwd` を daemon が realpath に解決したディレクトリ (存在するディレクトリであることは daemon が確かめ済み) |
| 環境 | daemon の環境から `clean_env` に当たるキー (`keep_env` にも当たるものを除く) を落とし、その上に daemon が `CCMSG_LAUNCH_REQUESTED_BY` を重ねたもの (下の「環境変数」) |
| stdin | 入力の JSON (UTF-8) を 1 つ書いて閉じる。末尾に改行は付かない (最後の byte は `}`)。`read` のように改行までを読む道具では最後の行を取りこぼすので、`cat` や `jq` で全部を読む |
| process group | 起動コマンドは自分の process group を持って起こされる (setsid)。timeout の signal は group に送られる |
| 回数 | 起動の依頼 1 つにつき 1 回。複数の依頼が来れば並行して呼ばれる (同時に最大 `launch_max_concurrency` 個) |
| 待ち | config の `launch_timeout_seconds` (既定 10 秒) を超えると process group に SIGTERM、その 500 ms 後に SIGKILL。timeout で止めた時は、起動コマンドが終わった後に group に残っているものにも SIGKILL が届く |
| daemon が終わる時 | daemon は走っている起動コマンドの終わり (最長で上の待ち) を待ってから終わる |

## 入力

形は `packages/protocol` の `LaunchCommandInputSchema` (DR-0018 §3.3)。

| field | 型 | 意味 |
|---|---|---|
| `cwd` | 文字列 (必須) | 起動するディレクトリ (realpath)。`continue` はここで最も新しいセッションを続ける |
| `model` | `fable` / `opus` / `sonnet` / `haiku` | `--model`。新規 (`continue` も `resume` も無い) では必ずある |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max` | `--effort`。新規では必ずある |
| `continue` | boolean | `--continue` |
| `resume` | uuid | `--resume` の id |
| `resume_session_at` | uuid | `--resume-session-at`: fork 地点の transcript の record の uuid。無ければ先端まで写す |
| `fork_session` | boolean | `--fork-session` |
| `session_id` | uuid | daemon が生成した新しいセッションの id (UUID v4)。新規と `fork_session` の時だけある。起動コマンドが 0 で終われば呼び手にこの値が返る |
| `name` | 文字列 (空でない) | `--name` |
| `prompt` | 文字列 (空でない) | 最初の prompt |

- field は全部 claude のオプションと 1 対 1 (`session_id` は `--session-id`、`prompt` は位置引数)。オプションに無い名前の field は来ない
- 無い field と、`false` の `continue` / `fork_session` は指定されていない
- daemon は組み合わせを確かめてから渡す: `continue` と `resume` は同時に来ない、`fork_session` と `resume_session_at` は `continue` か `resume` と一緒にだけ来る、新規には `model` と `effort` がある
- 任意の field が無い時の値は起動コマンドが決める (例: model ごとの effort の既定、リポ名と日時からのセッション名、既定の prompt、元のセッションの model)
- 読めない入力 (知らない field、型の違う値) には推測で補って起動せず、非零で終わって理由を stderr に書く。daemon が新しい field を足した時に、古い起動コマンドが黙って無視して別の起動をするのを避けるため

## 環境変数

daemon が起動コマンドの環境に足す変数。`clean_env` / `keep_env` の判定の後に重ねるので、`CCMSG_*` を落とすパターンを書いても必ず届く。

| 変数 | 値 |
|---|---|
| `CCMSG_LAUNCH_REQUESTED_BY` | 依頼者: `user` (人、webui から) か、依頼したセッションの sid (エージェント、tool `launch` から)。人とエージェントで cwd の信頼判定を変える時に使う |

## claude の引数への写し方

field ごとに同じ名前のオプションへ写す: `model` → `--model`、`effort` → `--effort`、`continue` → `--continue`、`resume` → `--resume <id>`、`fork_session` → `--fork-session`、`session_id` → `--session-id <id>`、`name` → `--name`、`prompt` → 位置引数。`prompt` は `--` の後ろに置く (`-` で始まる prompt を option として読ませない、[findings 2026-10-25-claude-prompt-after-double-dash](../findings/2026-10-25-claude-prompt-after-double-dash.md))。

| 入力 | claude の起動 |
|---|---|
| 新規 | `claude --session-id <session_id> --model <model> --effort <effort> [--name <name>] [-- <prompt>]` |
| `continue` | `claude --continue [--model …] [--effort …] [--name …] [-- <prompt>]` |
| `resume` | `claude --resume <resume> [--model …] [--effort …] [--name …] [-- <prompt>]` |
| `continue` / `resume` + `fork_session` (`resume_session_at` なし) | 上に `--fork-session --session-id <session_id>` を足す |
| `fork_session` + `resume_session_at` | 二段 (下記) |

`fork_session` と `resume_session_at` がある時は二段で起動する。`--resume-session-at` は `-p` でしか効かず、対話の起動に付けると黙って無視されて先端まで写されるため ([findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md))。

1. 切り詰めた fork を作る (同期): `claude -p (--resume <resume> | --continue) --fork-session --session-id <session_id> --resume-session-at <resume_session_at> --output-format json /exit`。`/exit` は `-p` では何も実行されず API を呼ばない。非零で終わったら、そこで起動コマンドも非零で終わり、claude の stderr を自分の stderr に出す。fork 地点を外した先端 fork や、id の違う fork に切り替えない (成功したように見えて意図と違うセッションができる)
2. できたセッションを対話で続ける: `claude --resume <session_id> [--model …] [--effort …] [--name …] [-- <prompt>]`。fork でない resume なので `--fork-session` も `--session-id` も付けない

一段目は `launch_timeout_seconds` の中で終わる必要がある。plugin も settings も無い config dir で 0.6〜0.7 秒だった (同 findings) が、plugin や hook の多い config dir ではそれより延びる。既定の 10 秒に収まる保証は無いので、使う config dir で測って `timeout_seconds` を決める。

守ること:

- `--session-id` は `session_id` がある時だけ付ける。fork でない `--continue` / `--resume` に付けると claude は `--session-id can only be used with --continue or --resume if --fork-session is also specified.` で起動しない
- 二段の起動を確かめたのは `fork_session` のある `resume_session_at` だけ。`fork_session` の無い `resume_session_at` (daemon は `continue` か `resume` があれば渡す) で claude が元のセッションをどう扱うかは確かめていない
- 二段の両方を同じ `CLAUDE_CONFIG_DIR` で起動する (一段目が書いた transcript を二段目が同じ `projects` ディレクトリから読むため)
- `prompt` は本文を変えずに claude に届ける (shell の語分割、quote の除去、切り詰め、末尾の改行の除去をしない)
- `resume_session_at` が user の record を指す時、claude は二段目の resume で `No response requested.` の synthetic な assistant 行を足してから続ける (同 findings)。これは claude の挙動で、起動コマンドが手を入れるものではない

## 戻り方

- **速やかに終わる**: 対話の claude は detached な端末 (端末 proxy 等) で起こし、起動コマンド自身は `launch_timeout_seconds` より十分前に終わる。待ち続けると SIGTERM / SIGKILL で止められる
- **detach した子は process group から外す**: 対話の claude を載せた端末 proxy 等は setsid して起動コマンドの process group から外す。group に残った子は、timeout で止められた時に一緒に止められる
- **detach した子に stdout / stderr を継がせない**: daemon は起動コマンドが終わった後、pipe の EOF を 500 ms しか待たない。子が pipe を持ち続けると、その後の出力は呼び手に届かない
- **終了コード**: 失敗 (入力が読めない、cwd が信頼できない、fork の一段目の失敗等) は全部、対話の claude を起動する前に非零で返す。**対話の claude を起動した後は 0 で終わる** (起動の後の失敗を非零で返さない。非零は「起動していない」を意味する)。daemon は response の `session_id` を exit 0 の時だけ返すので (DR-0018 §3.4)、起動した後に非零で終わると、立ち上がったセッションの id が呼び手に届かなくなる。0 はセッションが立ち上がって daemon に名乗ったこと (到達) ではない。detached に起こした claude がその後 `Session ID … is already in use.` 等で終わっても、起動コマンドの 0 は変わらない。daemon は値を解釈せず、そのまま呼び手に返す
- **stdout**: 呼び手に見せる短い文 (例: claude を載せた端末の id)。4096 bytes 以上は daemon がファイルに退避し、呼び手には置き場だけが返る。daemon が取り込むのは先頭の 1 MiB まで
- **stderr**: 非零で終わる時の理由。呼び手 (エージェントや webui の結果パネル) が最初の行で事情を掴めるように、要点を先頭に書く

## 組み込みの起動コマンド

config に `launch_command` が無い時、daemon は plugin に同梱の `packages/daemon/src/default-launch-command.ts` を、daemon を動かしている bun で起動コマンドとして実行する (DR-0018 §3.1)。この契約に従う最小の起動コマンドで、次のことだけをする。

- stdin の JSON を `LaunchCommandInputSchema` で読む。読めなければ非零 (2) で終わる
- field を上の「claude の引数への写し方」のとおり同じ名前のオプションに写し、`hyoui run --detached -- claude <オプション>` を shell を介さずに実行して、hyoui の終了コードで終わる。`hyoui` が `PATH` に無ければ非零 (2)
- `fork_session` と `resume_session_at` がある時は二段で起動する (一段目の `claude -p` が非零なら非零 (2) で終わり、hyoui は起こさない)。`fork_session` の無い `resume_session_at` は claude の扱いが未観測なので断る (2)

加工はしない: direnv の適用、model 名への `[1m]` 等の付与、セッション名の装飾、trust ダイアログの吸収、cwd の信頼判定、`CCMSG_LAUNCH_REQUESTED_BY` による判定の切り替えはどれもしない。面ごとの環境の切替や trust ダイアログの吸収が要る環境は、自前の起動コマンドを書いて `launch_command` に置く。

## 起動コマンドが持つ責務

daemon が持たず、起動コマンドが判断するもの。

- **cwd の信頼判定**: その cwd でセッションを起動してよいか (リポの置き場所、所有者、remote 等)。信頼できなければ起動せず非零で終わる。daemon は cwd が存在するディレクトリであることしか見ない。エージェントからの起動 (DR-0018 §3.8) を止められるのはこの判定だけで、`CCMSG_LAUNCH_REQUESTED_BY` で人とエージェントの判定を分けられる
- **trust ダイアログの吸収**: 対話の claude は初めての workspace で trust ダイアログ (`Quick safety check`) を出し、答えるまで先へ進まない。cwd の信頼判定を通った時に限り、起動コマンドが端末の画面を読んで承認のキーを送る。ダイアログが出なければ何もしない。想定外の画面なら操作せず人に任せる (claude は起動済みなので、その時も起動コマンドは 0 で終わる。到達は呼び手が確かめる)
- **端末と環境**: どの端末に載せるか、面ごとの `CLAUDE_CONFIG_DIR` 等の環境をどう整えるか、daemon の環境から継いだ変数をさらに落とすか
- **任意の field の既定**: 上の「入力」の節
- **走っているセッションへの `resume` / `continue`**: 止めるか (DR-0018 §7 の未確定)

## 関連

- [DR-0018](../decisions/DR-0018-session-launcher.md) — 起動の入力、op、daemon の手順、tool `launch`
- [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id` / `--resume-session-at` の併用、`--session-id` を拒む組み合わせ
- [findings 2026-10-25-claude-prompt-after-double-dash](../findings/2026-10-25-claude-prompt-after-double-dash.md) — `--` の後ろの prompt が option として読まれないこと
