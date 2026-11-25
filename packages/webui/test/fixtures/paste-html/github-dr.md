auto mode の classifier への説明 (`autoMode` の `environment` / `allow` / `soft_deny` / `hard_deny`) を、プロジェクトごとに変えたい。kawaz の依頼 (2026-11-22) の要点:

> リポジトリ内の autoMode は見るべきでない。ccmsg 側でプロジェクトごとの設定 (cwd 基準) として持てるようにするのが良さそう。webui を通じて daemon が管理し、セッションの Status タブに autoMode の調整 UI を追加する。

> 各エントリがセクションごとに 2 段のリスト表示になっており、ルール 1 個をクリックしたら textarea に切り替わって ⌘Enter で保存したり、\[＋] で追加したりできる。空文字で保存したらそのエントリは削除するを表現し、削除ボタンは置かない。

> autoMode の編集は危険ゾーン側に置く。終了ボタンの下。

> 適用は再起動で反映される、というのは注釈として書いておく。ユーザは再起動ボタンを押せばよいだけ。

> `--settings` では完全上書きはそもそも出来ないんだよね？なら出す必要性自体ゼロ (2026-11-23、`$defaults` を画面に出すことについて)

### 公式の記述 (code.claude.com の `auto-mode-config` と `settings-reference`、2026-11-22 に読んだ)

- classifier は `autoMode` を user settings・managed settings・`--settings` (「Per-invocation overrides for automation」) から読む。`.claude/settings.json` と `.claude/settings.local.json` の `autoMode` は読まない (「Both files live in the repo directory, so a checked-in repo or a build step could otherwise inject its own allow rules」)
- 「Entries from each scope are combined」「When more than one of those files sets the same array, Claude Code concatenates the entries」
- 「Include the literal string `"$defaults"` in every array you set, so your rules add to the built-in ones. If you leave it out, your rules can replace them」。`$defaults` を置いた位置に組み込みの既定が差し込まれる。「Each section is evaluated independently」(書かなかったリストは組み込みの既定のまま)
- 公式は、scope をまたいで `$defaults` がどう効くか (ある scope が `$defaults` を書き、別の scope が書かない時) と、空のリストの扱いを書いていない。下の実測で決まりを確かめた
- `autoMode.classifyAllShell` (Boolean、既定 `false`): `true` にすると、auto mode の間は Bash / PowerShell の allow rule (`permissions.allow` の `Bash(npm test)` 等) を全部止め、全てのシェルのコマンドを classifier に通す。`false` では任意のコードを走らせうる rule (`Bash(*)`、`Bash(python *)` 等) だけを止める。scope は user か managed で「Read wherever `autoMode` is read」。複数の scope が違う値を書いた時にどちらが勝つかは書いていない
- `claude --help` の `--settings <file-or-json>` は「Settings file or JSON string to load more settings from」で、値は 1 つ (`--add-dir <directories...>` や `--betas <betas...>` のような複数の値の形ではない)。2 回渡した時のことは書いていない

### 実測 (2026-11-22、Claude Code 2.1.330)

`claude [--settings '<JSON>'] auto-mode config` の出力のリストの件数で確かめた。ユーザの側は一時の config dir の `settings.json` に書いた。組み込みの既定は environment 21 / allow 16 / soft\_deny 72 / hard\_deny 1 件。

| user settings のそのリスト | `--settings` のそのリスト | 結果の件数 |
| --- | --- | --- |
| `$defaults` + 8 件 (allow) | なし | allow 24 |
| 同上 | 1 件、`$defaults` なし | allow 25 (足した項目は user の項目の後ろ) |
| 書いていない | 1 件、`$defaults` なし | soft\_deny **1** (組み込みの既定が消える) |
| 書いていない | `$defaults` + 1 件 | soft\_deny 73 |
| 書いていない | `[]` | soft\_deny 72 (空のリストは書いていないのと同じ) |
| `$defaults` + 1 件 | `[]` | soft\_deny 73 |
| 1 件、`$defaults` なし | なし | soft\_deny 1 |
| 同上 | `[]` | soft\_deny 1 |
| 同上 | `["$defaults"]` | soft\_deny **73** (user が外した既定が戻る) |
| 1 件、`$defaults` なし (allow) | 1 件、`$defaults` なし | allow 2 |
| `[]` | なし | soft\_deny 72 |

- リストごとに、どれかの scope が空でないリストを書いていれば、全 scope の項目の連結になる。どれかの項目に `$defaults` があればその位置に組み込みの既定が 1 回だけ入る (1 つのリストに `$defaults` を 2 回書いても 1 回)。どの scope も空でないリストを書いていなければ組み込みの既定
- 空のリスト `[]` は、どの scope でも書いていないのと同じ
- `--settings` を 2 回渡すとエラーにならず、後の 1 つだけが効く (前の `--settings` の autoMode は出ない)。ファイルのパスでも JSON の文字列でも同じに読まれる
- `claude auto-mode defaults` は 0.4 秒で、出力は 82 KB。個人面の config dir と空の config dir で出力は同じだった
- `auto-mode config` の出力に `classifyAllShell` は出ない (4 つのリストだけ)
- 対話のセッションの classifier は `--settings` の autoMode の allow と soft\_deny の項目を判定に使った ([findings 2026-11-23](https://github.com/kawaz/claude-ccmsg/blob/e1b87b69dd961723e1ecc1b75c03d37063c55263/docs/findings/2026-11-23-project-auto-mode-effective-in-classifier.md)。ユーザの発言の影響は切り分けていない)
- 未検証: Claude Code が `--settings` のファイルを起動の後に読み直すか。§10 で確かめる
