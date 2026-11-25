# plugin の依存を入れているのは Claude Code か launcher か (2026-11-25)

- Date: 2026-11-25 (19:00〜19:25、JST)
- 対象: ccmsg v0.422.0 (main)、Claude Code 2.1.332、macOS (Darwin 25.5.0)、bun 1.4.4
- 動機: issue [2026-11-25-who-installs-plugin-dependencies](../issue/2026-11-25-who-installs-plugin-dependencies.md)。[DR-0032](../decisions/DR-0032-repo-split-protocol-first.md) §2.2-4 は「`claude plugin install` / `update` は依存を入れない」を前提に launcher (`bin/ccmsg`) が依存を入れる形を決めているが、公式ドキュメントと実行ファイルからは Claude Code も `bun.lock` を見て依存を入れる仕組みを持つと読めた ([findings 2026-11-25-plugin-cache-versions](2026-11-25-plugin-cache-versions.md))
- 方法:
  - 公式ドキュメント (plugin の loading reference の「Node.js package dependencies」の節) を読んだ
  - Claude Code 2.1.332 の実行ファイルから、`claude plugin list` が出した文言の周りの処理を読んだ (minify された JS。関数名は意味を持たないので、定数と文言で書く)
  - 一時ディレクトリに隔離した config dir (`CLAUDE_CONFIG_DIR`) を 7 つ作り、`env -i` で `CLAUDE*`・`ANTHROPIC_*`・`HYOUI_SESSION_ID` と PATH の plugin cache の `bin` を外した環境で、marketplace の追加・plugin の install・試験用のセッション・launcher の直接の呼び出しを流した
  - 誰が依存を入れたかは、PATH の先頭に置いた `bun` の wrapper で見た。呼ばれるたびに時刻・cwd・引数・親プロセス 4 段を記録して本物の bun に exec する。Claude Code は lockfile の package manager を PATH から呼ぶ (公式ドキュメント) ので、この wrapper を通る
  - 試験用のセッションは `claude -p` を、要求を 15 秒 (1 回目だけ 45 秒) 保ってから 400 (1 回目は 401) を返す代役の API に向けて起こした。hooks module はその間に読み込まれて動く。ccmsg の state / config / data のディレクトリと HTTP の port も一時ディレクトリの下に分け、セッションの sidecar が起こした daemon は各回の終わりに止めた

## 結論

- **Claude Code 2.1.332 は ccmsg の依存を入れない。DR-0032 §2.2-4 の前提は正しい。** Claude Code は依存を入れる仕組みを持つが、`bun.lock` の `workspaces` が plugin の root (`""`) 1 つだけの時に限る。ccmsg の `bun.lock` は `packages/*` の 6 つを含む 7 つの workspace を持つので、入れ込みの対象から外れる。`claude plugin list` もそう言う: `Note: The packages it lists were not installed, because its bun.lock does not list the plugin as its only workspace`
- **キャッシュの版のディレクトリの `node_modules` を入れているのは launcher だけ。** 入るのは launcher が初めて呼ばれた時で、セッションの起動では hooks module が起動直後に `bin/ccmsg sidecar begin` を呼ぶので、その launcher が入れる。launcher を直接呼べば、セッションを起こす前でも入る
- **launcher の入れ込みと Claude Code の入れ込みが二重になることは、今の ccmsg では起きない。** launcher を変える必要は無い
- 二重になりうるのは、root の `package.json` から `workspaces` を外して `bun.lock` の workspace が 1 つになった時 (findings 2026-11-25-plugin-cache-versions の案 C の形) で、その時は Claude Code が install / update / 未キャッシュの版の起動のたびに版のディレクトリへ入れる

## 一次資料から読めたこと

### 公式ドキュメント (plugin の loading reference)

「When the dependency install runs」の節:

> Claude Code installs the dependencies into the copied version directory each time it creates one:
>
> * When you install a plugin
> * When Claude Code updates a plugin to a new version
> * At session start when an enabled plugin isn't cached yet, such as on a new machine
>
> For a relative-path plugin loaded in place from a marketplace you added from a local path, Claude Code doesn't install the dependencies into the source directory. Install them there yourself, or from a hook into `${CLAUDE_PLUGIN_DATA}`.
>
> The install runs only when the plugin's root directory contains both a `package.json` and a supported lockfile.

「Limits on the dependency install」の節の 1 項目と、入れ込みの場所の項目:

> * **Registry packages only**: every dependency must be a registry package pinned in the lockfile to an exact version. A plugin with a git, GitHub, folder, workspace, or linked dependency gets no install.
> * **A separate install folder**: the package manager runs in a folder of its own that holds only a copy of the checked dependency list, so npm and Bun don't read the plugin's `.npmrc`, `.env`, or `bunfig.toml`. When the install succeeds, Claude Code moves the resulting `node_modules` into the plugin.

同じ節は `--frozen-lockfile` 相当の固定・`--ignore-scripts`・60 秒の timeout を挙げ、`You can't turn the automatic install off.` と書いている。「When the dependency install fails or is skipped」の節は、入れ込みが失敗か対象外の時も plugin は読み込まれ、`/plugin` と `claude plugin list` に note が出ると書いている。

ドキュメントの言い方は「workspace dependency を持つ plugin には入れない」で、ccmsg の root の `package.json` 自身は `workspace:*` の依存を持たない (持つのは `packages/cli` と `packages/daemon`)。ドキュメントだけでは ccmsg が対象外かを決められず、実行ファイルの判定で決まった (次の節)。

### 実行ファイル (2.1.332)

`bun.lock` を読む関数は、次の順で調べ、当たれば入れ込みをやめる (理由の文言は note に出るもの):

1. JSON として読めない → `its bun.lock is not valid JSON`
2. `lockfileVersion` が 0・1・2 のどれでもない → `its bun.lock is in a format this version of Claude Code does not read`
3. `patchedDependencies` がある → `it patches its dependencies (patchedDependencies), ...`
4. `workspaces` が object でない、`workspaces[""]` が無い、または `Object.keys(workspaces).length !== 1` → `its bun.lock does not list the plugin as its only workspace`
5. `packages` が無い → `its bun.lock lists no packages`

ccmsg の `bun.lock` は `lockfileVersion: 1` で 2 を通り、`workspaces` の key が `""`・`packages/cli`・`packages/daemon`・`packages/protocol`・`packages/testkit`・`packages/translate-helper`・`packages/webui` の 7 つなので 4 で止まる。

## 観測

### 段 1: marketplace の追加と install の直後

| config dir | marketplace | bun wrapper | 版のディレクトリ | `node_modules` | `packages/*/node_modules` | `.ccmsg-deps-installed` | Claude Code の bun 呼び出し |
|---|---|---|---|---|---|---|---|
| gh1 | GitHub (kawaz/claude-ccmsg) | 無し | 19:03:03 | 無し | 無し | 無し | (記録なし) |
| gh2 | GitHub | 無し | 19:03:25 | 無し | 無し | 無し | (記録なし) |
| gh3 | GitHub | 有り | 19:09:50 | 無し | 無し | 無し | 0 回 |
| gh4 | GitHub | 有り | 19:09:54 | 無し | 無し | 無し | 0 回 |
| loc1 | 手元の jj workspace を指す local | 無し | 19:03:31 (キャッシュの写し) | 無し (写しも元も) | 無し | 無し | (記録なし) |
| loc2 | 同上 | 無し | 19:03:33 (同上) | 無し (写しも元も) | 無し | 無し | (記録なし) |

- 4 つの GitHub の config dir とも、`claude plugin list` が上の結論の note を出した
- gh1 で続けて `claude plugin update ccmsg-v1@ccmsg-v1` を打つと `already at the latest version (0.422.0)` で、`node_modules` はできなかった。gh4 でも同じで、wrapper の記録は 0 回 (ドキュメントは「自分で始めた update は終わっていない入れ込みをやり直すことがある」と書くが、対象外の plugin ではやり直さない)
- local の marketplace では、Claude Code はキャッシュに版のディレクトリの写しを作るが、`claude plugin list` は `Read from: <jj workspace>` と出し、セッションの hooks module の `$.plugin.root` も元のディレクトリだった (ドキュメントの「loaded in place」の通り)。`installed_plugins.json` の `installPath` はキャッシュの写しを指していた

### 対照: Claude Code が入れる形の plugin

wrapper が Claude Code の入れ込みを捉えられることを、入れ込みの対象になる最小の plugin で確かめた。root に `package.json` (`dependencies: { "valibot": "1.5.0" }`) と、workspace が `""` 1 つだけの `bun.lock` (`lockfileVersion: 2`) を置いた git リポを、local の marketplace の `url` source (`file://`) で install した。

- wrapper の記録: `bun install --frozen-lockfile --ignore-scripts`、cwd は版のディレクトリの隣の `<version>.tmp~<hash>`、親は `claude plugin install`
- 版のディレクトリは 19:10:16、その中の `node_modules` (`valibot` だけ) は 19:10:17 にでき、`.tmp~` の方は残っていなかった。Claude Code の入れ込みは root の `node_modules` だけを別の場所で作って移す形で、版のディレクトリは `node_modules` が入る前から在る

### 段 2・段 3: 試験用のセッションと launcher の初回

| config dir | 順序 | `bun install` の呼び出し元 (wrapper の記録) | `node_modules` と `packages/*/node_modules` | 印 |
|---|---|---|---|---|
| gh1 | install → セッション (1 回目) | `bin/ccmsg sidecar begin` の launcher、cwd は版のディレクトリ、引数 `install --frozen-lockfile` (19:10:50) | どちらも 19:10:50 | 19:10:53 |
| gh1 | セッション (2 回目) | 呼ばれない (`bun run .../index.ts sidecar begin` だけ) | 変わらず | 変わらず |
| gh4 | install → update → セッション | `bin/ccmsg sidecar begin` の launcher (19:16:32) | どちらも 19:16:32 | 19:16:32 |
| gh3 | install → launcher を直接 (`bin/ccmsg version`) | `bin/ccmsg version` の launcher (19:16:21) | どちらも 19:16:21 | 19:16:21 |
| gh3 | 続けてセッション | 呼ばれない | 変わらず | 変わらず |
| gh2 | install → launcher を直接 | `bin/ccmsg version` の launcher (19:16:22) | どちらも 19:16:22 | 19:16:22 |
| loc1 | install → セッション | `bin/ccmsg sidecar begin` の launcher、cwd は元の jj workspace (19:19:48) | 元のディレクトリにどちらも 19:19:48。キャッシュの写しには無し | 19:19:48 |
| loc2 | 元の `node_modules` を消して → セッション | 同上 (19:21:19) | 元のディレクトリにどちらも 19:21:20。キャッシュの写しには無し | 19:21:20 |

- どの回も、`bun install` を呼んだのは launcher だけで、Claude Code (`claude -p` や `claude plugin ...`) が親の `bun install` は 1 度も無かった
- launcher が入れた `node_modules` は root に 13 項目、`packages/cli`・`packages/daemon`・`packages/protocol`・`packages/webui` にもそれぞれでき、root の devDependencies (`typescript` 等) も入っていた。Claude Code の入れ込みの形 (root だけ、`--ignore-scripts`、別の場所で作って移す) とは違う
- セッションの debug log に、依存の入れ込みに触れる行 (`bun.lock`・`node_modules`・`dependenc`・`only workspace`) は無かった

## 未確認

- 新しい版への update (版のディレクトリを新しく作る update) と、未キャッシュの版をセッションの起動で取る経路は、観測していない。どちらも実行ファイルでは同じ `bun.lock` の判定を通ると読んだが、経路ごとの呼び出しまでは追っていない
- Claude Code の入れ込みが ccmsg の対象になった時に launcher の入れ込みとどう重なるか (順序・排他) は、今の ccmsg では起きないので観測していない。対照の plugin では、`claude plugin install` の間に版のディレクトリが `node_modules` の無いまま在る時間があった
- Claude Code 2.1.332 より前と後の版

## 検証の詳細

### 環境の作り方

- 一時ディレクトリ `<base>` の下に、config dir (`<base>/cfg-<名前>`)、jj workspace、`TMPDIR`、ccmsg の state / config / data を置いた
- 全てのコマンドは `env -i HOME=… USER=… LOGNAME=… SHELL=… PATH=<plugin cache の bin を外した PATH> TERM=… LANG=… TMPDIR=<base>/tmp/ CLAUDE_CONFIG_DIR=<base>/cfg-<名前> …` で起こした
- セッションには加えて `ANTHROPIC_API_KEY=<ダミー>`、`ANTHROPIC_BASE_URL=http://127.0.0.1:<代役の port>`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` (一時ディレクトリの下)、`CCMSG_HTTP_BIND=127.0.0.1:<空いている port>` を渡した。sidecar が起こした daemon の環境にこれらが乗っていることを `ps eww` で確かめた
- 代役の API は 401 と 400 のどちらも retry され、1 回のセッションは 400 で約 90 秒続いた (6 回の要求)

### 使ったコマンド (抜粋)

- `claude plugin marketplace add kawaz/claude-ccmsg` / `claude plugin marketplace add <jj workspace>`
- `claude plugin install ccmsg-v1@ccmsg-v1 --scope user`、`claude plugin update ccmsg-v1@ccmsg-v1`、`claude plugin list`
- `echo "say hi" | claude -p --debug-file <base>/debug-<回>.log`
- `<版のディレクトリ>/bin/ccmsg version`
- 時刻は `stat -f '%SB'` (作られた時刻) で取った
