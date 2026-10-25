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

daemon は claude の引数を組み立てない。config の `launch_command` に書いた 1 つのコマンド (起動コマンド) を、shell を介さずに起動の依頼ごとに 1 回実行し、標準入力に起動の入力の JSON を 1 つ渡して、終わりを待ってその終了コードと出力を呼び手に返す。どの claude をどの端末に載せるか、cwd を信頼してよいか、任意の field の既定は、起動コマンドが全部持つ。取り決めの正本は [launch-command](../design/launch-command.md)。

## 手順

1. **起動コマンドを置く**

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
   unknown=$(jq -r 'keys - ["type","cwd","session_id","model","effort","name","prompt","resume_session_id","resume_at"] | join(",")' <<<"$input")
   [[ -z "$unknown" ]] || fail "unknown field: $unknown"
   need() { local k; for k in "$@"; do [[ -n "$(get "$k")" ]] || fail "missing $k"; done; }

   # cwd の信頼判定 (daemon はしない)。ここでは ~/src の下だけを信頼する
   cwd=$(get cwd)
   case "$cwd" in
     "$HOME"/src/*) ;;
     *) fail "cwd is not trusted: $cwd" ;;
   esac

   args=()
   case "$(get type)" in
     new)
       need session_id model effort
       args+=(--session-id "$(get session_id)")
       ;;
     continue)
       args+=(--continue)
       ;;
     resume)
       need resume_session_id
       args+=(--resume "$(get resume_session_id)")
       ;;
     fork)
       need session_id resume_session_id
       if [[ -n "$(get resume_at)" ]]; then
         # --resume-session-at は -p でしか効かないので、切り詰めた fork を先に作る
         claude -p --resume "$(get resume_session_id)" --fork-session \
           --session-id "$(get session_id)" --resume-session-at "$(get resume_at)" \
           --output-format json /exit >/dev/null
         args+=(--resume "$(get session_id)")
       else
         args+=(--resume "$(get resume_session_id)" --fork-session --session-id "$(get session_id)")
       fi
       ;;
     *) fail "unknown type: $(get type)" ;;
   esac
   for k in model effort name; do
     if [[ -n "$(get "$k")" ]]; then args+=("--$k" "$(get "$k")"); fi
   done
   if [[ -n "$(get prompt)" ]]; then args+=(-- "$(get prompt)"); fi

   # 対話の claude は detached な端末に載せ、ここはすぐに 0 で終わる
   hyoui run --detached -- claude "${args[@]}" </dev/null
   ```

   - `cwd` は daemon が realpath にした値で届き、起動コマンドの cwd もそのディレクトリになる。信頼判定のパターンも realpath で書く (`/var` と `/private/var` のような symlink の違いで外れないように)
   - `prompt` は `--` の後ろに置く。`-` で始まる prompt も option として読まれずにそのまま claude に届く
   - 非 0 で終わるのは対話の claude を起こす前だけにする。起こした後に非 0 で終わると、呼び手に新しいセッションの `session_id` が返らない (契約の「戻り方」)

   置く前に手元で試せる。`launch_command` と同じ argv を、cwd をそのディレクトリにして、標準入力に JSON を渡して叩く:

   ```bash
   (cd ~/src/<repo> && printf '%s' '{"type":"continue","cwd":"'"$(pwd -P)"'"}' | ~/bin/launch-claude); echo "exit=$?"
   ```

2. **設定ファイルに `session_launcher` を書く**

   キーは次の 6 つだけで、他のキーがあると daemon は起動しない。

   | キー | 必須 | 既定 | 意味 |
   |---|---|---|---|
   | `launch_command` | 必須 | | 起動コマンドの argv (空でない文字列の配列)。先頭は絶対パス、`~/` で始まるパス、または daemon の `PATH` で探す名前 |
   | `root_dirs` | 必須 | | webui の cwd ツリーの根 (絶対パスか `~/…`、1 つ以上)。起動の cwd をこの配下に限るものではない |
   | `dir_tree_depth` | | 2 | cwd ツリーを最初に読む深さ |
   | `timeout_seconds` | | 10 | 起動コマンドを待つ秒数 (1〜50 の整数)。超えると SIGTERM、500 ms 後に SIGKILL |
   | `clean_env` | | `[]` | 起動コマンドに渡す環境から落とすキーのパターン (`*` が任意の文字列、大文字小文字を区別、キー名全体と一致) |
   | `keep_env` | | `[]` | `clean_env` に当たっても残すキーのパターン |

   daemon はあるセッションの中の shell から起動されることがあり、そのセッションの変数 (`CLAUDE_CODE_SESSION_ID` 等) を持っている。`clean_env` に `CLAUDE*` を入れて新しいセッションへ流れないようにし、面の分離に要る `CLAUDE_CONFIG_DIR` を `keep_env` で残す。

   `config.json` の例:

   ```json
   {
     "session_launcher": {
       "launch_command": ["~/bin/launch-claude"],
       "root_dirs": ["~/src/"],
       "timeout_seconds": 10,
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

   - webui のサイドバーの「+ 新規」を押し、type・cwd ツリー・model / effort・name・prompt の欄が出れば設定は読めている
   - `type` を `new` にして起動すると、結果パネルに `exit_code`・`stdout`・`stderr` と、exit 0 なら新しいセッションへのリンク (`session_id`) が出る。セッションが hello で daemon に名乗るまでは、リンク先は空のまま
   - daemon.log に `session_launch: by=user type=new cwd=… session_id=… exit_code=0 …` の行が残る (エージェントの起動なら `by=<依頼したセッションの id>`)

## 失敗時の切り分け

| 症状 | 原因 | 対処 |
|---|---|---|
| 「+ 新規」で未設定の案内が出る / `launcher_not_configured` | `session_launcher` を書いたファイルが読まれていない | 起動ログの `also present and being ignored` の warn を見て、優先順 (`config.ts` > `config.js` > `config.json`) で読まれているファイルを確かめる。書いた後に daemon を再起動したか確かめる |
| daemon が起動しない | 設定が読めない | エラーの `config: <file>: <場所>: <理由>` が壊れた場所を指す。`session_launcher` に 6 つ以外のキー (別の方式の名残り等) があっても読めない |
| `launch_command_unavailable` | 起動コマンドを起こせない (見つからない、実行ビットが無い) | `launch_command` の先頭が絶対パスか、daemon の `PATH` にある名前かを確かめる。相対パスは受けない |
| `invalid_args` | 起動の入力がスキーマに合わない、または `cwd` が存在するディレクトリでない | msg の最初の理由を読む。webui は送る前に欄ごとの理由を出す |
| `exit_code` が 0 でない | 起動コマンドが断った (信頼できない cwd、読めない入力、fork の一段目の失敗) | `stderr` の最初の行を読む。手順 1 の手元での叩き方で再現する |
| `exit_code` が 143 か 137 | `timeout_seconds` を超えて SIGTERM / SIGKILL で止められた | 起動コマンドが対話の claude を待っていないか確かめる。claude は detached な端末に載せてすぐ終わる |
| `stdout` / `stderr` が `output is <N> bytes, file: <path>` | 出力が 4096 bytes 以上で、state dir の `launches/` に退避された | その file を読む。7 日で消える |
| exit 0 なのにセッションが peers / サイドバーに出ない | 起動コマンドは終わったが、claude が立ち上がらなかった (端末の問題、trust ダイアログで止まっている等) | 起動コマンドが載せた端末を見る。exit 0 は到達を意味しない |

## 関連

- [DR-0018](../decisions/DR-0018-session-launcher.md) — 起動の入力、op、daemon の手順、tool `launch`、webui
- [launch-command](../design/launch-command.md) — 起動コマンドの契約
- [fork-rescue](./fork-rescue.md) — fork でコンテキストの尽きたセッションを救う
