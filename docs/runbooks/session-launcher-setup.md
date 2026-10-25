# Runbook: session launcher のセットアップ

- Last Updated: 2026-10-25

## 適用ケース

ccmsg から Claude Code のセッションを起動できるようにする ([DR-0018](../decisions/DR-0018-session-launcher.md))。起動の口は 2 つある。

- 人が webui から: サイドバーの「+ 新規」、Session Search の結果の「resume」、Timeline の「ここから fork」
- エージェントが tool `launch` から (使い方は plugin の skill ccmsg)

webui の「+ 新規」を押して「daemon にセッションの起動が設定されていません」と出る時、またはエージェントの `launch` が「ccmsg の daemon が起動を断ったので、起動していない: …」(`launcher_not_configured`) で返る時に、この手順で設定する。

## 前提

- daemon の設定ファイルを編集できること。置き場は `<configDir>` (`CCMSG_CONFIG_DIR`、無ければ `$XDG_CONFIG_HOME/ccmsg`、通常 `~/.config/ccmsg/`) の `config.ts` / `config.js` / `config.json` のどれか 1 つ
- 設定を変えた後に daemon を再起動できること (config は daemon の起動時に 1 度だけ読まれる)
- 起動コマンド (下記) を自分の環境に合わせて書けること

## 仕組み

**`session_launcher` の節を書けば、起動コマンドを用意しなくても動く**。`launch_command` を省くと、plugin に同梱の組み込みの起動コマンドが `hyoui run --detached -- claude <オプション>` を加工せずに実行する (hyoui が `PATH` に要る)。面ごとの環境の切替 (direnv 等)、cwd の信頼判定、trust ダイアログの吸収、model 名やセッション名の加工が要るなら、手順 1 のとおり自前の起動コマンドを書いて `launch_command` に置く。

daemon は claude の引数を組み立てない。config の `launch_command` に書いた 1 つのコマンド (起動コマンド、無ければ組み込み) を、shell を介さずに起動の依頼ごとに 1 回実行し、標準入力に起動の入力の JSON を 1 つ渡して、終わりを待ってその終了コードと出力を呼び手に返す。どの claude をどの端末に載せるか、cwd を信頼してよいか、任意の field の既定は、起動コマンドが全部持つ。取り決めの正本は [launch-command](../design/launch-command.md)。

## 手順

1. **起動コマンドを置く** (組み込みで足りるなら飛ばす)

   [launch-command](../design/launch-command.md) の契約に従うコマンドを書き、実行ビットを付けて置く。下は bash と `jq` の例で、claude を hyoui の detached 端末で起こす。cwd の信頼判定は `~/src` の下だけを通す。trust ダイアログの吸収 (契約の「起動コマンドが持つ責務」) は入れていない。

   ```bash
   #!/usr/bin/env bash
   # ccmsg の起動コマンドの例 (docs/design/launch-command.md の契約)。
   # stdin の JSON を読み、claude を hyoui の detached 端末で起こす。
   set -euo pipefail

   input=$(cat)
   get() { jq -r --arg k "$1" '.[$k] // empty' <<<"$input"; }
   fail() { echo "launch-claude: $*" >&2; exit 2; }

   # 知らない field は推測で補わずに断る
   unknown=$(jq -r 'keys - ["cwd","model","effort","continue","resume","resume_session_at","fork_session","session_id","name","prompt"] | join(",")' <<<"$input")
   [[ -z "$unknown" ]] || fail "unknown field: $unknown"

   # cwd の信頼判定 (daemon はしない)。人 (webui) からは ~/src の下を、
   # エージェント (CCMSG_LAUNCH_REQUESTED_BY が依頼したセッションの id) からは
   # ~/src/work の下だけを信頼する
   cwd=$(get cwd)
   if [[ "${CCMSG_LAUNCH_REQUESTED_BY:-}" == user ]]; then trusted="$HOME/src"; else trusted="$HOME/src/work"; fi
   case "$cwd" in
     "$trusted"/*) ;;
     *) fail "cwd is not trusted for ${CCMSG_LAUNCH_REQUESTED_BY:-?}: $cwd" ;;
   esac

   # 起動の入力の field は claude のオプション名なので、同じ名前のオプションに写す。
   # 空の配列の展開は ${a[@]+"${a[@]}"} で書く (macOS の bash 3.2 は set -u で "${a[@]}" を unbound にする)
   source_args=()
   [[ "$(get continue)" == true ]] && source_args+=(--continue)
   [[ -n "$(get resume)" ]] && source_args+=(--resume "$(get resume)")

   args=()
   # resume_session_at は fork_session と一緒にだけ来る (daemon が確かめ済み)
   if [[ -n "$(get resume_session_at)" ]]; then
     # --resume-session-at は -p でしか効かないので、切り詰めた fork を先に作る
     claude -p ${source_args[@]+"${source_args[@]}"} --fork-session --session-id "$(get session_id)" \
       --resume-session-at "$(get resume_session_at)" --output-format json /exit >/dev/null
     args+=(--resume "$(get session_id)")
   else
     args+=(${source_args[@]+"${source_args[@]}"})
     [[ "$(get fork_session)" == true ]] && args+=(--fork-session)
     # session_id は新規と fork_session の時だけ来る
     [[ -n "$(get session_id)" ]] && args+=(--session-id "$(get session_id)")
   fi
   for k in model effort name; do
     if [[ -n "$(get "$k")" ]]; then args+=("--$k" "$(get "$k")"); fi
   done
   # prompt は末尾の改行も本文のうち。$(…) が末尾の改行を落とさないよう x を足して外す
   prompt=$(jq -j '.prompt // empty' <<<"$input"; printf x)
   prompt=${prompt%x}
   if [[ -n "$prompt" ]]; then args+=(-- "$prompt"); fi

   # 対話の claude は detached な端末に載せ、ここはすぐに 0 で終わる
   hyoui run --detached -- claude ${args[@]+"${args[@]}"} </dev/null
   ```

   - `cwd` は daemon が realpath にした値で届き、起動コマンドの cwd もそのディレクトリになる。信頼判定のパターンも realpath で書く (`/var` と `/private/var` のような symlink の違いで外れないように)
   - `prompt` は `--` の後ろに 1 つの引数で置く。`-` で始まる prompt も option として読まれずにそのまま claude に届く ([findings 2026-10-25-claude-prompt-after-double-dash](../findings/2026-10-25-claude-prompt-after-double-dash.md))
   - 非 0 で終わるのは対話の claude を起こす前だけにする。起こした後に非 0 で終わると、呼び手に新しいセッションの `session_id` が返らない (契約の「戻り方」)
   - fork 地点のある fork の一段目 (`claude -p … /exit`) は `launch_timeout_seconds` の中で終わる必要がある。plugin や hook の多い config dir では既定の 10 秒に収まる保証が無いので、使う config dir で一段目を手元で測り、足りなければ `launch_timeout_seconds` を延ばす (上限 50)
   - 載せる端末 (ここでは hyoui) は起動コマンドの process group から外れて動くものにする。timeout で止められた時、group に残ったものは一緒に止められる

   置く前に手元で試せる。`launch_command` と同じ argv を、cwd をそのディレクトリにして、標準入力に JSON を渡して叩く:

   ```bash
   (cd ~/src/<repo> && printf '%s' '{"cwd":"'"$(pwd -P)"'","continue":true}' | CCMSG_LAUNCH_REQUESTED_BY=user ~/bin/launch-claude); echo "exit=$?"
   ```

2. **設定ファイルに `session_launcher` を書く**

   キーは次の 7 つだけで、他のキーがあると daemon は起動しない。

   | キー | 必須 | 既定 | 意味 |
   |---|---|---|---|
   | `launch_command` | | 組み込み | 起動コマンドの argv (空でない文字列の配列)。省くと同梱の組み込みの起動コマンド (`hyoui run --detached -- claude …`)。先頭は絶対パス、`~/` で始まるパス、または daemon の `PATH` で探す名前。daemon の起動時に実行できるファイルの絶対パスに固定し、見つからなければ daemon は起動しない |
   | `root_dirs` | 必須 | | webui の cwd ツリーの根 (絶対パスか `~/…`、1 つ以上)。起動の cwd をこの配下に限るものではない |
   | `dir_tree_depth` | | 2 | cwd ツリーを最初に読む深さ |
   | `launch_timeout_seconds` | | 10 | 起動コマンドを待つ秒数 (1〜50 の整数)。超えると起動コマンドの process group に SIGTERM、500 ms 後に SIGKILL |
   | `launch_max_concurrency` | | 4 | 同時に走らせる起動コマンドの数 (1〜16 の整数)。超えた依頼は `launch_busy` で断る |
   | `clean_env` | | `[]` | 起動コマンドに渡す環境から落とすキーのパターン (`*` が任意の文字列、大文字小文字を区別、キー名全体と一致) |
   | `keep_env` | | `[]` | `clean_env` に当たっても残すキーのパターン |

   daemon はあるセッションの中の shell から起動されることがあり、そのセッションの変数 (`CLAUDE_CODE_SESSION_ID` 等) を持っている。`clean_env` に `CLAUDE*` を入れて新しいセッションへ流れないようにし、面の分離に要る `CLAUDE_CONFIG_DIR` を `keep_env` で残す。

   `config.json` の例:

   ```json
   {
     "session_launcher": {
       "launch_command": ["~/bin/launch-claude"],
       "root_dirs": ["~/src/"],
       "launch_timeout_seconds": 10,
       "clean_env": ["CLAUDE*", "ANTHROPIC_*"],
       "keep_env": ["CLAUDE_CONFIG_DIR"]
     }
   }
   ```

   `config.ts` / `config.js` は、同じオブジェクトを ES module の default export にする (Promise でもよい。top-level await も使える。関数は受けない)。複数あれば `config.ts` > `config.js` > `config.json` の順で 1 つだけが読まれ、残りは起動ログに warn が 1 行出る。`config.ts` には daemon が起動のたびに `<configDir>/ccmsg-config.d.ts` を生成するので、型を当てられる:

   ```ts
   import type { CcmsgConfig } from "./ccmsg-config.d.ts";

   export default {
     session_launcher: {
       launch_command: ["~/bin/launch-claude"],
       root_dirs: ["~/src/"],
       clean_env: ["CLAUDE*", "ANTHROPIC_*"],
       keep_env: ["CLAUDE_CONFIG_DIR"],
     },
   } satisfies CcmsgConfig;
   ```

3. **daemon を再起動する**

   ```bash
   ccmsg daemon restart
   ```

   期待結果: エラーが出ない。設定が読めない (構文エラー、知らないキー、型の合わない値) と daemon は起動せず、`config: <file>: <場所>: <理由>` の行を daemon.log に書いて終わる。CLI から daemon を起動した時は同じ行が CLI のエラーとして出る。接続中の webui と `ccmsg subscribe` は自動で繋ぎ直す。

4. **確かめる**

   - webui のサイドバーの「+ 新規」を押し、cwd ツリーと `--model`・`--effort`・`--continue`・`--resume`・`--resume-session-at`・`--fork-session`・`--session-id`・`--name`・`PROMPT` の欄が出れば設定は読めている。`--model` は `fable`、`--effort` は daemon の `CLAUDE_CONFIG_DIR` の settings.json の `modelSettings.fable.effortLevel` (無ければ未選択) で開く
   - `--continue` も `--resume` も入れずに起動すると新しいセッションで、結果パネルに `exit_code`・`stdout`・`stderr` と、exit 0 なら新しいセッションへのリンク (`session_id`) が出る。セッションが hello で daemon に名乗るまでは、リンク先は空のまま
   - daemon.log に `session_launch: by=user cwd="…" session_id=… exit_code=0 …` の行が残る (エージェントの起動なら `by=<依頼したセッションの id>`。timeout で止めた起動には `timed_out=true` が付く)

## 失敗時の切り分け

| 症状 | 原因 | 対処 |
|---|---|---|
| 「+ 新規」で未設定の案内が出る / `launcher_not_configured` | `session_launcher` を書いたファイルが読まれていない | 起動ログの `also present and being ignored` の warn を見て、優先順 (`config.ts` > `config.js` > `config.json`) で読まれているファイルを確かめる。書いた後に daemon を再起動したか確かめる |
| daemon が起動しない | 設定が読めない | エラーの `config: <file>: <場所>: <理由>` が壊れた場所を指す。`session_launcher` に 7 つ以外のキー (別の方式の名残り等) があっても読めない。`launch_command.0: … is not found in PATH` / `… is not an executable file` は起動コマンドが daemon の起動時に見つからない (daemon の `PATH`、実行ビット、相対パスでないか) |
| `launch_command_unavailable` | daemon の起動の後で起動コマンドが消えた・実行できなくなった | 起動コマンドを置き直して daemon を再起動する (起動コマンドの path は daemon の起動時に固定される) |
| `launch_busy` | `launch_max_concurrency` 個の起動が走っている、または daemon が終わりかけている | 走っている起動が終わってから依頼し直す。いつも当たるなら起動コマンドが速やかに終わっているか (`exit_code` が 143 / 137 で終わっていないか) を見る |
| `invalid_args` | 起動の入力がスキーマに合わない、または `cwd` が存在するディレクトリでない | msg の最初の理由を読む。webui は送る前に欄ごとの理由を出す |
| `exit_code` が 0 でない | 起動コマンドが断った (信頼できない cwd、読めない入力、fork の一段目の失敗) | `stderr` の最初の行を読む。手順 1 の手元での叩き方で再現する |
| `exit_code` が 143 か 137 | `launch_timeout_seconds` を超えて SIGTERM / SIGKILL で止められた (daemon.log の行に `timed_out=true`) | 起動コマンドが対話の claude を待っていないか確かめる。claude は detached な端末に載せてすぐ終わる。fork 地点のある fork なら一段目の所要を測る |
| `stdout` / `stderr` が `output is <N> bytes, file: <path>` | 出力が 4096 bytes 以上で、state dir の `launches/` に退避された | その file を読む。7 日で消える。`truncated to the first …` が付く時は 1 MiB を超えた分が捨てられている |
| exit 0 なのにセッションが peers / サイドバーに出ない | 起動コマンドは終わったが、claude が立ち上がらなかった (端末の問題、trust ダイアログで止まっている等) | 起動コマンドが載せた端末を見る。exit 0 は到達を意味しない |

## 関連

- [DR-0018](../decisions/DR-0018-session-launcher.md) — 起動の入力、op、daemon の手順、tool `launch`、webui
- [launch-command](../design/launch-command.md) — 起動コマンドの契約
- [fork-rescue](./fork-rescue.md) — fork でコンテキストの尽きたセッションを救う
