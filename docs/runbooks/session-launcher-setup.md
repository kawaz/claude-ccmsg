# Runbook: session launcher (webui の「+ 新規」)のセットアップ

- Last Updated: 2026-07-17

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
         "~/.local/share/repos/github.com/zunsystem/",
         "~/.local/share/repos/github.com/emeradaco/",
         "~/.local/share/repos/github.com/syun/",
         "~/.local/share/repos/github.com/tfabworks/"
       ],
       "default_prompt": "ccmsg subscribe起動。このセッションではultracode許可。pre-clear出力があればロード",
       "shell": "zsh",
       "command": "direnv exec \"$CWD\" hyoui run --dettach -- claude --model \"$MODEL\" --effort \"$EFFORT\" --name \"${$(bump-semver vcs get repository):t1}@$(bump-semver vcs get worktree-name) $(date +%Y%m%dT%H%M)\" \"$PROMPT\"",
       "timeout_seconds": 10,
       "dir_tree_depth": 2
     }
   }
   ```

   フィールドの意味 (詳細は `docs/decisions/DR-0018-session-launcher.md` §3.1):
   - `root_dirs`: cwd ピッカー (CwdTree) が表示するルート一覧。`~/` プレフィクス
     または絶対パスのみ有効、相対パスは無視される
   - `default_prompt`: SessionCreator フォームの「default」ボタンで戻る
     プロンプト文字列
   - `shell`: `"bash"` または `"zsh"` のみ (暗黙の `sh -c` はしない、LN-Q2 裁定)。
     上の `command` 例は `${...:t1}` (zsh の modifier 展開) を使うため `"zsh"`
     必須 — bash では `bad substitution` になる。bash 互換の command を書くなら
     `"bash"` で良い
   - `command`: 実行するコマンド。`$CWD` / `$MODEL` / `$EFFORT` / `$PROMPT`
     の 4 環境変数が渡される (文字列置換ではなく env、quote は書き手の責務)
   - `timeout_seconds`: 省略時 10。超過で SIGTERM → 少し待って SIGKILL
   - `dir_tree_depth`: cwd ツリーの初期一括ロード深さ。省略時 2

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
| 「+ 新規」を押しても未設定の案内のまま | `config.json` の JSON 構文エラー、または `session_launcher.root_dirs` / `command` が空・不正 | daemon の起動ログ (`config: <file>: ...` の warn 行) を確認。`root_dirs` は非空の絶対パス配列、`command` は非空文字列である必要がある |
| cwd ツリーが空 | `root_dirs` の各パスが実在しない、または権限がない | パスを `ls` で確認、`~/` 展開後の絶対パスであることを確認 |
| 実行ボタンを押しても反応がない/エラーになる | `command` のシェル構文エラー、`shell` の指定ミス | config の `shell` と同じ起動形 (`bash -eu -o pipefail -c "<command>"` / `zsh -e -u -o pipefail -c "<command>"`) を手元で `CWD`/`MODEL`/`EFFORT`/`PROMPT` を export した状態で試して構文を確認 |
| 実行結果が `timed_out: true` で返る | `command` が `timeout_seconds` 以内に終わらない (例: フォアグラウンドで待ち続けるプロセス) | `command` に `--dettach` 相当のバックグラウンド化オプションを使う (DR-0018 §2.3: webui はプロセス管理をしない、起動だけを担う設計) |

## 関連

- `docs/decisions/DR-0018-session-launcher.md` — 本機能の設計正本 (LN-Q1..4 裁定含む)
