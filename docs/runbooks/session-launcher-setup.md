# Runbook: session launcher (webui の「+ 新規」)のセットアップ

- Last Updated: 2026-08-12

## 適用ケース

webui のサイドバー SESSIONS 見出し付近にある「+ 新規」ボタンを押すと
「session launcher が未設定です」という案内が出る場合。DR-0018 の機能
(webui から新規 Claude Code セッションを起動する) を使うための設定手順。

## 前提

- daemon の設定ファイル (`<dataDir>/config.json`、通常
  `~/.local/share/ccmsg/config.json`。`CCMSG_DATA_DIR` を設定していれば
  そのディレクトリ) を編集できること
- 設定変更後に daemon を再起動できること (LN-Q4 裁定: config はホット
  リロードされない、明示的な再起動が必要)

## 手順

1. **`<dataDir>/config.json` に `session_launcher` キーを追加する**

   YAML ではなく **JSON** (このリポの daemon 設定は JSON、DR-0018 §3.1 の
   YAML 表記は設計時のスケッチ)。既存の `config.json` に他のキーがあれば
   マージする、無ければ新規作成する:

   ```json
   {
     "session_launcher": {
       "root_dirs": [
         "~/.local/share/repos/github.com/kawaz/",
         "~/.local/share/repos/github.com/zunsystem/"
       ],
       "shell": "zsh",
       "timeout_seconds": 10,
       "dir_tree_depth": 2,
       "templates": [
         {
           "name": "new",
           "command": "direnv exec \"$CWD\" hyoui run --detached -- claude --model \"$MODEL\" --effort \"$EFFORT\" --name \"${$(bump-semver vcs get repository):t1}@$(bump-semver vcs get worktree-name) $(date +%Y%m%dT%H%M)\" \"$PROMPT\"",
           "params": {
             "CWD": "",
             "MODEL": "fable",
             "EFFORT": "low",
             "PROMPT": "ccmsg subscribe起動。pre-clear出力があればロード"
           }
         }
       ]
     }
   }
   ```

   フィールドの意味 (詳細は `docs/decisions/DR-0018-session-launcher.md` §3.1):
   - `root_dirs`: cwd ピッカー (CwdTree) が表示するルート一覧。`~/` プレフィクス
     または絶対パスのみ有効、相対パスは無視される
   - `shell`: `"bash"` または `"zsh"` のみ (暗黙の `sh -c` はしない、LN-Q2 裁定)。
     上の `command` 例は `${...:t1}` (zsh の modifier 展開) を使うため `"zsh"`
     必須 — bash では `bad substitution` になる。bash 互換の command を書くなら
     `"bash"` で良い
   - `timeout_seconds`: 省略時 10。超過で SIGTERM → 少し待って SIGKILL
   - `dir_tree_depth`: cwd ツリーの初期一括ロード深さ。省略時 2
   - `templates`: 名前付きの起動レシピ一覧。`templates[0]` が既定のレシピ
   - `templates[].command`: 実行するコマンド。文字列置換ではなく **変数渡し**
     なので quote は書き手の責務
   - `templates[].params`: そのレシピが受け取る変数の宣言 (**変数名 →
     フォーム初期値**)。宣言した変数だけが command から見え、フォームには
     **宣言順に** 入力欄が並ぶ。宣言していない変数は shell に定義すらされない

### params — フォームは宣言そのもの

`params` に書いた変数が、そのまま SessionCreator の入力欄になる:

| 変数名 | 出る入力欄 |
|---|---|
| `CWD` | ディレクトリピッカー (CwdTree)。**全レシピ必須** — 書かなければ先頭に自動追加される |
| `MODEL` | model ドロップダウン |
| `EFFORT` | effort ドロップダウン |
| `PROMPT` | プロンプト textarea |
| それ以外 (`RESUME_SID` / `BRANCH` など任意の名前) | プレーンなテキスト入力 |

- 値は **export されていないシェル変数** として渡る — command が起動する
  プロセス (= claude セッションとその子孫) には引き継がれない
- 宣言した変数は必ず定義される (未入力なら空文字。`set -u` で落ちない)
- 変数名はシェル識別子 (`[A-Za-z_][A-Za-z0-9_]*`) のみ。それ以外はその
  1 件だけ warn して無視される
- `CWD` の値は `root_dirs` に対して realpath で封じ込め検査される唯一の値

### 複数テンプレート (fork 等の起動形を並べる)

`templates` が 2 件以上なら SessionCreator に template ドロップダウンが出る。

```json
   {
     "session_launcher": {
       "root_dirs": ["~/.local/share/repos/github.com/kawaz/"],
       "shell": "zsh",
       "templates": [
         {
           "name": "new",
           "command": "direnv exec \"$CWD\" hyoui run --detached -- claude --model \"$MODEL\" --effort \"$EFFORT\" \"$PROMPT\"",
           "params": { "CWD": "", "MODEL": "fable", "EFFORT": "low", "PROMPT": "ccmsg subscribe起動" }
         },
         {
           "name": "fork",
           "command": "fork_args=(--resume \"$RESUME_SID\" --fork-session)\nif [[ -n \"$RESUME_AT\" ]]; then fork_args+=(--resume-session-at \"$RESUME_AT\"); fi\nfork_json=\"$(direnv exec \"$CWD\" claude -p \"${fork_args[@]}\" --output-format json '/exit')\"\nfork_sid=\"$(printf '%s' \"$fork_json\" | jq -r '.session_id // empty')\"\nif [[ -z \"$fork_sid\" ]]; then print -u2 \"fork bootstrap failed (no session_id): $fork_json\"; exit 1; fi\ndirenv exec \"$CWD\" hyoui run --detached -- claude --resume \"$fork_sid\" --model \"$MODEL\" --effort \"$EFFORT\" \"$PROMPT\"",
           "params": { "CWD": "", "MODEL": "fable", "EFFORT": "low", "PROMPT": "", "RESUME_SID": "", "RESUME_AT": "" }
         }
       ]
     }
   }
```

- 個別エントリが壊れていても (name が空 / 重複 / command が無い) そのエントリ
  だけ warn して無視し、残りは生きる。全滅すると launcher 無効
- **fork テンプレの判定は `params` に `RESUME_AT` があるか**: 宣言している
  最初のテンプレートを Timeline の「ここから fork」が選ぶ。名前は自由。
  逆に「+ 新規」は `RESUME_AT` を宣言していない最初のテンプレートを開く
- `--resume-session-at` は `claude --help` に出ない非公開オプション。daemon
  は起動時に 1 度だけ「この claude が受け付けるか」を実測し、受け付けない
  ホストでは webui の fork 導線を出さない (`fork_available`)
- fork テンプレが **二段** なのは `--resume-session-at` が print mode 専用で、
  対話起動では黙って無視されるため (DR-0018 §3.3.1)。1 段目の
  `claude -p ... '/exit'` が API 呼び出しゼロで切り詰め済み transcript を作り、
  その `session_id` を 2 段目が対話で resume する。`RESUME_AT` が空なら
  `--resume-session-at` を付けない (空文字は 1 段目のエラーになる)

### 旧形式 (`params` 以前) からの移行

`session_launcher` 直下の `command` / `default_prompt` と、`params` を持たない
`templates` エントリは **まだ動く** が、起動時に deprecation warn が 1 行出る。
旧形式は各 command が実際に読んでいる変数 (`$CWD` / `$MODEL` / `$EFFORT` /
`$PROMPT` / `$RESUME_SID` / `$RESUME_AT`) から `params` を推定して正規化される。
`default_prompt` は `PROMPT` の初期値になる。推定に頼ると「command がまだ
使っていない変数を先に入力欄として出す」ことができないので、上の形に書き直す。

2. **daemon を再起動する**

   ```bash
   ccmsg daemon stop   # または現在の運用手順に沿った停止方法
   ccmsg daemon run    # または通常の起動手順
   ```

   期待結果: 起動ログにエラーが出ない。`root_dirs` / `command` が不正な形
   (非配列、絶対パスでない要素のみ、等) だと daemon はクラッシュせず
   session launcher を無効化した状態で起動する (warn ログが出る)。

3. **webui で確認する**

   サイドバー SESSIONS 見出しの「+ 新規」ボタンを押す → cwd 選択ツリー・
   model/effort ドロップダウン・プロンプト欄が表示されれば設定成功。
   まだ「未設定」の案内が出る場合は手順4へ。

## 失敗時の切り分け

| 症状 | 原因 | 対処 |
|---|---|---|
| 「+ 新規」を押しても未設定の案内のまま | `config.json` の JSON 構文エラー、または `session_launcher.root_dirs` / `command` が空・不正 | daemon の起動ログ (`config: <file>: ...` の warn 行) を確認。`root_dirs` は非空の絶対パス配列、各 template は非空の `command` を持つ必要がある |
| cwd ツリーが空 | `root_dirs` の各パスが実在しない、または権限がない | パスを `ls` で確認、`~/` 展開後の絶対パスであることを確認 |
| 実行ボタンを押しても反応がない/エラーになる | `command` のシェル構文エラー、`shell` の指定ミス | config の `shell` と同じ起動形 (`bash -eu -o pipefail -c "<command>"` / `zsh -e -u -o pipefail -c "<command>"`) の `<command>` の頭に 宣言した各変数への代入 (`CWD=...; MODEL=...; ...`) を書いた状態で手元で試して構文を確認 |
| 実行結果が `timed_out: true` で返る | `command` が `timeout_seconds` 以内に終わらない (例: フォアグラウンドで待ち続けるプロセス) | `command` に `--detached` 相当のバックグラウンド化オプションを使う (DR-0018 §2.3: webui はプロセス管理をしない、起動だけを担う設計) |

## 関連

- `docs/decisions/DR-0018-session-launcher.md` — 本機能の設計正本 (LN-Q1..4 裁定含む)
