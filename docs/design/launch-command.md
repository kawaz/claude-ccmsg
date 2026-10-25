# launch-command: 起動コマンドの契約

## コンテキスト

daemon は Claude セッションの起動を、config の `session_launcher.launch_command` で指定された 1 つのコマンド (以下、起動コマンド) に任せる ([DR-0018](../decisions/DR-0018-session-launcher.md) §3)。起動コマンドは ccmsg の外にあり、使う人が自分の環境に合わせて書く。この文書は daemon と起動コマンドの間の取り決めの正本で、起動コマンドを書く人と daemon を実装する人の両方が読む。

取り決めの芯は「daemon は型の決まった入力を渡して終わりを待つだけで、claude をどう起動するかは起動コマンドが全部持つ」こと。daemon は claude の引数を組み立てず、起動コマンドの出力も終了コードも解釈しない。

## 呼ばれ方

| 項目 | 内容 |
|---|---|
| argv | `launch_command` の配列そのまま。daemon は引数を足さず、shell を介さない |
| cwd | 入力の `cwd` を daemon が realpath に解決したディレクトリ (存在するディレクトリであることは daemon が確かめ済み) |
| 環境 | daemon の環境から `clean_env` に当たるキー (`keep_env` にも当たるものを除く) を落としたもの。daemon は変数を足さない |
| stdin | 入力の JSON (UTF-8) を 1 つ書いて閉じる。末尾に改行は付かない |
| 回数 | 起動の依頼 1 つにつき 1 回。複数の依頼が来れば並行して呼ばれる |
| 待ち | config の `timeout_seconds` (既定 10 秒) を超えると SIGTERM、その 500 ms 後に生きていれば SIGKILL |

## 入力

形は `packages/protocol` の `LaunchCommandInputSchema` (DR-0018 §3.3)。`type` で 4 つに分かれる。

| field | `new` | `continue` | `resume` | `fork` | 意味 |
|---|---|---|---|---|---|
| `type` | 必須 | 必須 | 必須 | 必須 | 起動の種類 |
| `cwd` | 必須 | 必須 | 必須 | 必須 | 起動するディレクトリ (realpath)。`continue` はここで最も新しいセッションを続ける |
| `session_id` | 必須 | - | - | 必須 | daemon が生成した新しいセッションの id (UUID v4)。起動コマンドが 0 で終われば呼び手にこの値が返る |
| `model` | 必須 | 任意 | 任意 | 任意 | `fable` / `opus` / `sonnet` / `haiku` |
| `effort` | 必須 | 任意 | 任意 | 任意 | `low` / `medium` / `high` / `xhigh` / `max` |
| `name` | 任意 | 任意 | 任意 | 任意 | セッション名 (空でない) |
| `prompt` | 任意 | 任意 | 任意 | 任意 | 最初の prompt (空でない) |
| `resume_session_id` | - | - | 必須 | 必須 | 続ける / 写す元のセッションの id |
| `resume_at` | - | - | - | 任意 | fork 地点の transcript の record の uuid。無ければ先端まで写す |

- 任意の field が無い時の値は起動コマンドが決める (例: model ごとの effort の既定、リポ名と日時からのセッション名、既定の prompt、元のセッションの model)
- 読めない入力 (知らない `type`、知らない field、必須の欠落) には推測で補って起動せず、非零で終わって理由を stderr に書く。daemon が新しい field を足した時に、古い起動コマンドが黙って無視して別の起動をするのを避けるため

## claude の引数への写し方

| type | claude の起動 |
|---|---|
| `new` | `claude --session-id <session_id> --model <model> --effort <effort> [--name <name>] [<prompt>]` |
| `continue` | `claude --continue [--model <model>] [--effort <effort>] [--name <name>] [<prompt>]` |
| `resume` | `claude --resume <resume_session_id> [--model …] [--effort …] [--name …] [<prompt>]` |
| `fork` (`resume_at` なし) | `claude --resume <resume_session_id> --fork-session --session-id <session_id> [--model …] [--effort …] [--name …] [<prompt>]` |
| `fork` (`resume_at` あり) | 二段 (下記) |

`fork` で `resume_at` がある時は二段で起動する。`--resume-session-at` は `-p` でしか効かず、対話の起動に付けると黙って無視されて先端まで写されるため ([findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md))。

1. 切り詰めた fork を作る (同期): `claude -p --resume <resume_session_id> --fork-session --session-id <session_id> --resume-session-at <resume_at> --output-format json /exit`。`/exit` は `-p` では何も実行されず API を呼ばない。非零で終わったら、そこで起動コマンドも非零で終わり、claude の stderr を自分の stderr に出す。fork 地点を外した先端 fork や、id の違う fork に切り替えない (成功したように見えて意図と違うセッションができる)
2. できたセッションを対話で続ける: `claude --resume <session_id> [--model …] [--effort …] [--name …] [<prompt>]`。fork でない resume なので `--fork-session` も `--session-id` も付けない

守ること:

- `--session-id` は `new` と `fork` だけに付ける。fork でない `--continue` / `--resume` に付けると claude は `--session-id can only be used with --continue or --resume if --fork-session is also specified.` で起動しない
- 二段の両方を同じ `CLAUDE_CONFIG_DIR` で起動する (一段目が書いた transcript を二段目が同じ `projects` ディレクトリから読むため)
- `prompt` は本文を変えずに claude に届ける (shell の語分割、quote の除去、切り詰めをしない)
- `resume_at` が user の record を指す時、claude は二段目の resume で `No response requested.` の synthetic な assistant 行を足してから続ける (同 findings)。これは claude の挙動で、起動コマンドが手を入れるものではない

## 戻り方

- **速やかに終わる**: 対話の claude は detached な端末 (端末 proxy 等) で起こし、起動コマンド自身は `timeout_seconds` より十分前に終わる。待ち続けると SIGTERM / SIGKILL で止められる
- **detach した子に stdout / stderr を継がせない**: daemon は起動コマンドが終わった後、pipe の EOF を 500 ms しか待たない。子が pipe を持ち続けると、その後の出力は呼び手に届かない
- **終了コード**: 失敗 (入力が読めない、cwd が信頼できない、fork の一段目の失敗等) は全部、対話の claude を起動する前に非零で返す。**対話の claude を起動した後は 0 で終わる** (起動の後の失敗を非零で返さない。非零は「起動していない」を意味する)。daemon は `new` / `fork` の response の `session_id` を exit 0 の時だけ返すので (DR-0018 §3.4)、起動した後に非零で終わると、立ち上がったセッションの id が呼び手に届かなくなる。0 はセッションが立ち上がって daemon に名乗ったこと (到達) ではない。detached に起こした claude がその後 `Session ID … is already in use.` 等で終わっても、起動コマンドの 0 は変わらない。daemon は値を解釈せず、そのまま呼び手に返す
- **stdout**: 呼び手に見せる短い文 (例: claude を載せた端末の id)。4096 bytes 以上は daemon がファイルに退避し、呼び手には置き場だけが返る
- **stderr**: 非零で終わる時の理由。呼び手 (エージェントや webui の結果パネル) が最初の行で事情を掴めるように、要点を先頭に書く

## 起動コマンドが持つ責務

daemon が持たず、起動コマンドが判断するもの。

- **cwd の信頼判定**: その cwd でセッションを起動してよいか (リポの置き場所、所有者、remote 等)。信頼できなければ起動せず非零で終わる。daemon は cwd が存在するディレクトリであることしか見ない。エージェントからの起動 (DR-0018 §3.8) を止められるのはこの判定だけ
- **trust ダイアログの吸収**: 対話の claude は初めての workspace で trust ダイアログ (`Quick safety check`) を出し、答えるまで先へ進まない。cwd の信頼判定を通った時に限り、起動コマンドが端末の画面を読んで承認のキーを送る。ダイアログが出なければ何もしない。想定外の画面なら操作せず人に任せる (claude は起動済みなので、その時も起動コマンドは 0 で終わる。到達は呼び手が確かめる)
- **端末と環境**: どの端末に載せるか、面ごとの `CLAUDE_CONFIG_DIR` 等の環境をどう整えるか、daemon の環境から継いだ変数をさらに落とすか
- **任意の field の既定**: 上の「入力」の節
- **走っているセッションへの `resume`**: 止めるか (DR-0018 §7 の未確定)

## 関連

- [DR-0018](../decisions/DR-0018-session-launcher.md) — 起動の入力、op、daemon の手順、tool `launch`
- [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id` / `--resume-session-at` の併用、`--session-id` を拒む組み合わせ
