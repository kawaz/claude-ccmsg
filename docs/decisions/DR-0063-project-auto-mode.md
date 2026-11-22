# DR-0063: プロジェクトごとの autoMode を ccmsg が持ち、起動するセッションと btw の fork に `--settings` のファイルで渡す

- Status: Accepted (2026-11-22、kawaz 裁定。裁定は末尾の「裁定」) — 🟡 部分実装 (済み: protocol の `project-auto-mode.ts`・`LaunchCommandInputSchema` / `BtwCommandInputSchema` の `settings`・ErrorCode `project_auto_mode_unreadable` / `auto_mode_defaults_unavailable`・`Paths.projectAutoMode` / `Paths.launchSettingsDir`、daemon の `project-auto-mode.ts` / `auto-mode-defaults.ts` と起動・再起動・btw の settings と 3 つの op・`ev:"project_auto_mode"`、組み込みの起動コマンド・btw コマンドの `--settings`、launch-command / btw-command の契約、webui の `components/ProjectAutoMode.tsx` / `auto-mode-view.ts` の危険ゾーンの autoMode のまとまり。残り: §10 の実機の確かめ 3 件 (足した soft_deny / allow が classifier の判定に効くこと、走っているセッションが settings のファイルを読み直すか、btw の fork が元のセッションの prompt cache を読めるか))
- Date: 2026-11-22

## Context

auto mode の classifier への説明 (`autoMode` の `environment` / `allow` / `soft_deny` / `hard_deny`) を、プロジェクトごとに変えたい。kawaz の依頼 (2026-11-22) の要点:

> リポジトリ内の autoMode は見るべきでない。ccmsg 側でプロジェクトごとの設定 (cwd 基準) として持てるようにするのが良さそう。webui を通じて daemon が管理し、セッションの Status タブに autoMode の調整 UI を追加する。

> 各エントリがセクションごとに 2 段のリスト表示になっており、ルール 1 個をクリックしたら textarea に切り替わって ⌘Enter で保存したり、[＋] で追加したりできる。空文字で保存したらそのエントリは削除するを表現し、削除ボタンは置かない。

> autoMode の編集は危険ゾーン側に置く。終了ボタンの下。

> 適用は再起動で反映される、というのは注釈として書いておく。ユーザは再起動ボタンを押せばよいだけ。

> (`$defaults` の状態を各セクションの頭に必ず見せる) でないと、ルールを全消ししたのか、$defaults を継承してるのかの区別ができない。

### 公式の記述 (code.claude.com の `auto-mode-config` と `settings-reference`、2026-11-22 に読んだ)

- classifier は `autoMode` を user settings・managed settings・`--settings` (「Per-invocation overrides for automation」) から読む。`.claude/settings.json` と `.claude/settings.local.json` の `autoMode` は読まない (「Both files live in the repo directory, so a checked-in repo or a build step could otherwise inject its own allow rules」)
- 「Entries from each scope are combined」「When more than one of those files sets the same array, Claude Code concatenates the entries」
- 「Include the literal string `"$defaults"` in every array you set, so your rules add to the built-in ones. If you leave it out, your rules can replace them」。`$defaults` を置いた位置に組み込みの既定が差し込まれる。「Each section is evaluated independently」(書かなかったリストは組み込みの既定のまま)
- 公式は、scope をまたいで `$defaults` がどう効くか (ある scope が `$defaults` を書き、別の scope が書かない時) と、空のリストの扱いを書いていない。下の実測で決まりを確かめた
- `autoMode.classifyAllShell` (Boolean、既定 `false`): `true` にすると、auto mode の間は Bash / PowerShell の allow rule (`permissions.allow` の `Bash(npm test)` 等) を全部止め、全てのシェルのコマンドを classifier に通す。`false` では任意のコードを走らせうる rule (`Bash(*)`、`Bash(python *)` 等) だけを止める。scope は user か managed で「Read wherever `autoMode` is read」。複数の scope が違う値を書いた時にどちらが勝つかは書いていない
- `claude --help` の `--settings <file-or-json>` は「Settings file or JSON string to load more settings from」で、値は 1 つ (`--add-dir <directories...>` や `--betas <betas...>` のような複数の値の形ではない)。2 回渡した時のことは書いていない

### 実測 (2026-11-22、Claude Code 2.1.330)

`claude [--settings '<JSON>'] auto-mode config` の出力のリストの件数で確かめた。ユーザの側は一時の config dir の `settings.json` に書いた。組み込みの既定は environment 21 / allow 16 / soft_deny 72 / hard_deny 1 件。

| user settings のそのリスト | `--settings` のそのリスト | 結果の件数 |
|---|---|---|
| `$defaults` + 8 件 (allow) | なし | allow 24 |
| 同上 | 1 件、`$defaults` なし | allow 25 (足した項目は user の項目の後ろ) |
| 書いていない | 1 件、`$defaults` なし | soft_deny **1** (組み込みの既定が消える) |
| 書いていない | `$defaults` + 1 件 | soft_deny 73 |
| 書いていない | `[]` | soft_deny 72 (空のリストは書いていないのと同じ) |
| `$defaults` + 1 件 | `[]` | soft_deny 73 |
| 1 件、`$defaults` なし | なし | soft_deny 1 |
| 同上 | `[]` | soft_deny 1 |
| 同上 | `["$defaults"]` | soft_deny **73** (user が外した既定が戻る) |
| 1 件、`$defaults` なし (allow) | 1 件、`$defaults` なし | allow 2 |
| `[]` | なし | soft_deny 72 |

- リストごとに、どれかの scope が空でないリストを書いていれば、全 scope の項目の連結になる。どれかの項目に `$defaults` があればその位置に組み込みの既定が 1 回だけ入る (1 つのリストに `$defaults` を 2 回書いても 1 回)。どの scope も空でないリストを書いていなければ組み込みの既定
- 空のリスト `[]` は、どの scope でも書いていないのと同じ
- `--settings` を 2 回渡すとエラーにならず、後の 1 つだけが効く (前の `--settings` の autoMode は出ない)。ファイルのパスでも JSON の文字列でも同じに読まれる
- `claude auto-mode defaults` は 0.4 秒で、出力は 82 KB。個人面の config dir と空の config dir で出力は同じだった
- `auto-mode config` の出力に `classifyAllShell` は出ない (4 つのリストだけ)
- 未検証: 対話のセッションの classifier が `--settings` の autoMode を実際の判定に使うこと (上は `auto-mode config` の出力で確かめた)。Claude Code が `--settings` のファイルを起動の後に読み直すか。btw の fork に `--settings` を足した時に元のセッションの prompt cache を読めるか。どれも §10 で確かめる

### 読んで分かった前提 (ccmsg)

- daemon は claude を直接起こさない。セッションの起動・continue・resume・fork・再起動は全部、config の起動コマンドに JSON の入力 (`LaunchCommandInputSchema`) を標準入力で渡す 1 つの経路 (`session-launch.ts` の `launchSession`) を通る ([DR-0018](./DR-0018-session-launcher.md) §3、[launch-command](../design/launch-command.md))。再起動は `session-restart.ts` の `resumeLaunch` で入力を作り、プロセスを止めてから同じ `launchSession` を呼ぶ ([DR-0028](./DR-0028-session-kill.md))。webui のフォームとエージェントの tool `launch` の入力は `LaunchInputSchema` で、`session_id` のように daemon だけが足す field は `LaunchCommandInputSchema` にだけある
- btw の fork は config の btw コマンドに JSON の入力 (`BtwCommandInputSchema`: `cwd` / `config_dir` / `resume` / `model` / `effort` / `prompt`) を渡して起こす ([DR-0060](./DR-0060-btw-mode.md) §2、[btw-command](../design/btw-command.md))
- 起動コマンドの入力の field 名は claude のオプション名の snake_case で、起動コマンドは知らない field を推測で補わずに非零で終わる取り決め (launch-command の「入力」)
- ccmsg の起動の経路で `--settings` を付ける所は無い (daemon、組み込みの起動コマンド `default-launch-command.sh`、組み込みの btw コマンド `default-btw-command.sh` のどれも付けない)。自前の起動コマンド・btw コマンドは付けうる
- セッションの repository (`host` / `owner` / `name`) は daemon が cwd から子プロセスなしで導く (`repo-derive.ts` の `deriveLocation`)。jj の別 workspace (`.jj/repo` がファイル) と git の linked worktree も元のリポの remote を辿る。SESSIONS の木はこれを owner → 組の 2 段に使う ([DR-0043](./DR-0043-sidebar-folds-and-globals.md) §10)
- セッションの config dir は agents の行・peers の行の `config_dir` にある
- 人が手で書いてよい設定は ccmsg の config dir、daemon だけが書く状態は state dir に置く (`packages/protocol/src/paths.ts`)。人が書いて daemon が確かめて保存する前例は userscript のソース (`<configDir>/userscript.ts`、[DR-0057](./DR-0057-webui-userscript.md))
- Status タブの下端は「セッション操作」(新セッションを起動・fork・再起動) と、その下の「危険ゾーン」の section (終了ボタンの 1 行) の順 (`StatusPanel.tsx` の `SessionControls` / `KillZone`)

## 目的

人がプロジェクト (repo) ごとに auto mode の classifier への説明を足し、そのプロジェクトで ccmsg が起こすセッションと btw の fork に効かせる。リポの中のファイルからは読まないまま、編集はそのセッションを見ている webui からでき、プロジェクト・ユーザの設定・組み込みの既定のどれが効いているかと、各セクションで組み込みの既定が継がれているかを見比べられる。

増やしたくないもの:

- claude を起こす経路 (起動コマンドと btw コマンドの入力に field を 1 つ足すだけで、`--settings` を付ける別の仕組みを作らない)
- エージェントが自分の classifier の説明を変えられる経路 (書き換えは人の操作だけ)
- 人が見ていないところで組み込みの既定が消えること (既定は `$defaults` を入れる側で、今の結果は画面に出す)
- autoMode 以外の settings を ccmsg が渡すこと (渡す settings の中身は `autoMode` の 4 つのリストだけ)

## Decision

### 1. 層の関係 (`$defaults` の意味)

- プロジェクトの項目はユーザの設定を上書きできず、連結されるだけ。プロジェクトからユーザの項目もユーザの `$defaults` も消せない
- 組み込みの既定は、どこかの層のそのリストに `$defaults` がある時と、どの層もそのリストを (空でなく) 書いていない時に効く
- プロジェクトの各セクションは「`$defaults` を入れる」のチェックと項目を持つ。何も設定していないセクションはチェックが入った状態 (外して組み込みの soft_deny が消え、classifier が緩む事故を避ける安全側の既定)
- セクションごとに、P = プロジェクトに項目がある、Pd = プロジェクトのチェックが入っている、U = ユーザがそのリストを空でなく書いている、Ud = ユーザのリストに `$defaults` がある、とすると:
  - 組み込みが効く = (P かつ Pd) または (U かつ Ud) または (P でも U でもない)
  - 効くリストの中身 = ユーザの項目 (Ud なら `$defaults` の位置に組み込み) に続けて、P ならプロジェクトの項目 (Pd なら先頭に組み込み、ユーザの側で既に入っていれば 1 回だけ)
- チェックを外して項目も空のセクションの結果は、ユーザの側で 3 通り: (a) ユーザが `$defaults` 入り → 何も変わらない、(b) ユーザが項目ありで `$defaults` 無し → ユーザの項目だけ、(c) ユーザがそのリストを書いていない → 組み込みの既定 (空のリストは書いていないのと同じなので、プロジェクトから空にはできない、実測)
- チェックが結果を変えるのは、プロジェクトに項目があるセクションだけ。項目の無いセクションは settings のファイルに書かない (§4) ので、チェックの有無で結果は変わらない。(b) の時にチェックが入っていて項目が無ければ、組み込みは効かない (ユーザの項目だけ)

### 2. 置き場と形

- 置き場は ccmsg の config dir の `project-auto-mode.json` (`Paths.projectAutoMode`)。人が手で直してもよい設定なので config dir に置き、daemon が webui の操作で書く。書く時は一時ファイルに書き、fsync してから rename する。`project-auto-mode.json` が symlink (dotfiles から張る等) の時は、その実体 (realpath) の隣に一時ファイルを作って実体を置き換え、symlink は残す。mode は元のファイルのものを保つ (無ければ 0644)。daemon は自分が読み直せない内容を書かない (書く前にスキーマで読み直す)
- 形 (valibot、protocol に置く):

```ts
const AutoModeEntrySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(2000),
  v.check((s) => s !== "$defaults", "$defaults is the section's `defaults`"),
);
const AutoModeSectionSchema = v.strictObject({
  /** 「$defaults を入れる」のチェック。無ければ入っている */
  defaults: v.optional(v.boolean(), true),
  entries: v.optional(v.array(AutoModeEntrySchema), []),
});
const AutoModeSectionsSchema = v.strictObject({
  environment: v.optional(AutoModeSectionSchema, {}),
  allow: v.optional(AutoModeSectionSchema, {}),
  soft_deny: v.optional(AutoModeSectionSchema, {}),
  hard_deny: v.optional(AutoModeSectionSchema, {}),
});
const ProjectAutoModeFileSchema = jsonText(
  v.strictObject({ projects: v.record(ProjectKeySchema, AutoModeSectionsSchema) }),
);
```

- `ProjectKeySchema` はプロジェクトのキー (§3)。書く時は既定の値 (`defaults: true`、空の `entries`) を省き、4 つのセクションが全部既定に戻ったキーはキーごと消す
- 項目は文 (classifier が自然文として読む)。中の改行は許す。前後の空白は落とす
- 上限: 1 項目 2000 文字、1 プロジェクトの settings の JSON が 32 KiB まで。classifier の判定ごとに文脈に載るため。32 KiB は webui からの保存 (`project_auto_mode_write`) の時だけ確かめ、起動・btw では確かめない (手で直したファイルが超えていてもそのまま渡す)。保存は、書いた後の大きさが 32 KiB を超え、かつ書く前より大きくなる時だけ `invalid_args` で断る。手で直して超えたプロジェクトでも、消す・チェックを変える・短くする保存は通る (それで上限の内に戻せる)
- ファイルは読むたびに読み直す (起動・btw のたびと op のたび。小さいので持たない)。手で直した内容が daemon の再起動なしに次の起動から効く

Design rationale: `$defaults` はリストの中の文字列でなく、セクションごとの真偽値で持つ。チェックは「先頭に `$defaults` を置くか」の 1 つのスイッチで、リストの中の文字列にすると、画面が表さない位置・重複・項目としての編集が入り込む。「何も設定していない = 入れる」も、値が無い時の既定で表せる。

### 3. プロジェクトのキー

キーはセッション (起動) の cwd から daemon が導く。webui はキーもパスも渡さず、セッションの sid を渡す (§7)。

- repo のキー: `repo:<host>/<owner>/<name>` (`deriveLocation` の `repository`)。同じリポの別の jj workspace・git worktree・リポの外に作った worker の workspace・リポの中のサブディレクトリが、同じ設定になる
- cwd のキー: `cwd:<cwd の realpath>`。repository の導けない cwd だけ
- remote を書き換えるとキーが変わり、別のプロジェクトの設定に当たりうる (kawaz 2026-11-22 に確かめた上で今の決まりを保つ、裁定 14)

### 4. settings のファイル

- daemon は起動と btw のたびに、cwd のキー (§3) の設定から settings の JSON `{ "autoMode": { ... } }` を作る
  - 書くのはプロジェクトに項目のあるセクションだけ。リストは「チェックが入っていれば `"$defaults"`、続けてプロジェクトの項目を保存の順」
  - 項目の無いセクションは、チェックを外していても書かない。`[]` は書いていないのと同じで、効く中身が変わらない (実測)。チェックの入った項目の無いセクションも書かない (何も設定していないのと同じ扱い)
  - 書くセクションが 1 つも無ければ、ファイルを作らず `settings` を渡さない
- ファイルの置き場は state dir の `launch-settings/<内容の SHA-256 の hex>.json` (`Paths.launchSettingsDir`)。ディレクトリは 0700 (前からあるディレクトリも 0700 に直す)、ファイルは 0600
  - 作る時機は起動・btw の時。その名前のファイルを読み、中身が作る内容と同じなら書かずに mtime だけ更新し、無い・違う (0 バイト・壊れた JSON・手で書き換えた) なら一時ファイルに書いて fsync してから rename する。claude は空や壊れた settings のファイルを黙って無視する (実測、2.1.330) ので、名前だけで同じとみなさない
  - 内容で名前が決まるので、一度できたファイルの中身は変わらない。走っているセッションが起動の後にファイルを読み直しても (未検証、Context)、起動の時の内容のまま。保存は次の起動・再起動から効き、注釈 (§6) と一致する
  - 起動・btw のたびに、mtime が 30 日より古いファイルをこのディレクトリから消す。今渡すファイルは消さない。作る・消すは daemon の中で 1 つずつ行い、別の起動が渡そうとしているファイルを消さない (30 日より長く走り続けるセッションのファイルは消えうる。読み直すかは未検証、Context)
- `project-auto-mode.json` が読めない (JSON でない、スキーマに合わない) 時と、settings のファイルを書けない時は、新しい ErrorCode `project_auto_mode_unreadable` で断り、起動コマンド・btw コマンドを呼ばない。settings 無しで起動すると、人が足した `soft_deny` / `hard_deny` が黙って外れるため。`project-auto-mode.json` が無いのは何も設定していないこと

Design rationale: ファイルで渡す (kawaz 2026-11-22)。JSON の文字列は長くなると `ps` / `pstree` の見た目を崩し、起動コマンドでの引用・エスケープの扱いも要る。パスなら起動の引数は短い 1 語で済む。

### 5. 起動コマンド・btw コマンドへの渡し方

- 起動コマンドの入力 (`LaunchCommandInputSchema`) と btw コマンドの入力 (`BtwCommandInputSchema`) に、任意の field `settings` (§4 のファイルの絶対パス) を足す。claude のオプション `--settings` に当たる
- `settings` は daemon だけが足す。webui のフォームとエージェントの tool `launch` の入力 (`LaunchInputSchema`) と `btw_ask` には無く、頼み手は渡せない (`session_id` と同じ扱い)
- 起動の全ての種類 (新規・continue・resume・fork・再起動) と btw に、依頼者 (人・エージェント) を問わず入れる。起動は起動の cwd で、btw はセッションの cwd でキーを決める
- 再起動は、止める前にファイルを作る。作れない時 (§4) は止めずに断る (DR-0028 の「断る理由は止める前に確かめる」)
- daemon.log の `session_launch` と `btw_ask` の行に `auto_mode_entries=<件数>` を足す (項目の文は書かない)
- `--settings` は 1 回しか効かない (2 回渡すと後の 1 つだけが効く、Context の実測)。コマンドは claude の引数を組み立てる場所なので、ほかの目的で `--settings` を付けていないかはコマンドが確かめる
  - 組み込みの起動コマンドと btw コマンドは `--settings` をほかに付けないので、`settings` があればそのまま `--settings <path>` を付ける
  - 自前のコマンドが自分でも settings を渡すなら、2 つを 1 つの settings にまとめて `--settings` を 1 回だけ付ける。自前の settings を土台にし、`autoMode` の 4 つのリストは「自前のリスト、続けて ccmsg のファイルのリスト」の連結にする (`$defaults` が 2 回になっても組み込みの既定は 1 回しか入らない、実測)。ccmsg のファイルは `autoMode` の 4 つのリストしか持たないので、ほかの key は食い違わない。まとめたものはコマンドが自分の一時の置き場に書き、そのパスを渡す。ccmsg のファイルは書き換えない
- launch-command と btw-command の契約に足すこと: 入力の表に `settings`、写し方 (`--settings <path>`)、上のまとめ方をコマンドの責務に。起動コマンドと btw コマンドでは知らない欄の取り決めが違う。起動コマンドは知らない field に非零で終わるので、`settings` を知らない古い自前の起動コマンドは項目のあるプロジェクトの起動で非零で終わる (黙って無視しない)。btw コマンドは知らない欄を無視する取り決めなので、自前の btw コマンドは `settings` を読んで `--settings` に渡すことをコマンドの責務とし、btw-command に書く (読まないとプロジェクトの `soft_deny` / `hard_deny` が fork に効かない)

### 6. 画面 (Status タブの危険ゾーン)

- 危険ゾーンの section の中、終了の行の下に「autoMode (このプロジェクト)」のまとまりを置く
- 見出しの下にキーの表示 (`github.com/kawaz/claude-ccmsg` の形、cwd のキーは cwd のパス) と注釈「ccmsg が起動・再起動するセッションと btw に `--settings` で渡す。今のセッションに効かせるには再起動する」を出す。`session_launcher` が無い時は「起動コマンドが設定されていないので、起動には渡らない」を足す
- 1 段目は 4 つのセクション (`environment` / `allow` / `soft_deny` / `hard_deny`、この順、項目が 0 件でも全部出す)

#### 各セクションの頭の `$defaults` の行 (常に出す)

項目が空でも、全てのセクションの頭に 1 行で出す。ルールを全部消したのか、組み込みを継いでいるのかを見分けるため (kawaz)。

- `[✓] $defaults を入れる` のチェックボックス (プロジェクトの `defaults`)。押すとすぐ保存する (`project_auto_mode_write` の `defaults`)
- ユーザの側の状態: `ユーザ: $defaults あり` / `ユーザ: $defaults なし (N 件)` / `ユーザ: 書いていない` / `ユーザ: 読めない`
- 今の結果の文 (§1 の決まりから webui が導く):
  - ユーザの `$defaults` で効いている: 「ユーザの設定に $defaults があるので組み込みは効いています」
  - プロジェクトのチェックで効いている: 「プロジェクトの $defaults で組み込みが効いています」
  - どの層も書いていないので効いている: 「どの設定もこのセクションを書いていないので組み込みが効いています」。チェックを外していれば「項目が無いのでチェックを外しても変わりません」を足す
  - 効いていない、ユーザが `$defaults` なしで書いていてプロジェクトに項目が無い: 「ユーザの設定が $defaults なしで書いているので組み込みは効いていません (ユーザの項目だけ)」。チェックが入っていれば「チェックはプロジェクトに項目がある時に効きます」を足す
  - 効いていない、プロジェクトに項目がありチェックを外している: 「組み込みは効いていません」
  - ユーザの設定が読めない: 「ユーザの設定が読めないので結果は分かりません」

#### 3 つの段

`$defaults` の行の下に、効く順に上から並べる:

| 段 | 見出しの文字 | 中身 | 出す時 | 色 (既存のトークン) |
|---|---|---|---|---|
| プロジェクト | `プロジェクト (編集できる)` | §2 の項目。最後に [＋] | 常に | 地 `--self-surface`、左の罫 `--self-border` (紫。`--accent-*` はブランドの青で、ユーザの段の `--info-*` とライト・ダークのどちらでも色相が近く見分けられないので使わない。人の発言の吹き出しの緑も避ける) |
| ユーザ | `ユーザ (<config dir の名前>/settings.json、読むだけ)` | セッションの config dir の `settings.json` の `autoMode` のそのリスト。`$defaults` は書かれた位置に「$defaults ← ここに組み込みの既定が入る」の 1 行で出す | 常に (書いていなければ「書いていない」の 1 行) | 地 `--info-surface`、左の罫 `--info-border` |
| 組み込み | `組み込みの既定 (Claude Code <版>、読むだけ)` | `claude auto-mode defaults` のそのリスト | 組み込みが効く時だけ (§1) | 地 `--gray-3`、左の罫 `--gray-7` |

- 色だけで分けない。段ごとに見出しの文字を出し、読むだけの段の項目はクリックしても何も起きない (カーソルも変えない)
- ユーザの段・組み込みの段が取れない時は、その段に理由の 1 行 (`config dir が分からない`、`settings.json が読めない: <理由>`、`claude auto-mode defaults が答えなかった: <理由>`) を出す
- 開閉: プロジェクトの段とユーザの段は開いて始め、組み込みの段は閉じて始めて見出しに件数を出す (`組み込みの既定 (72)`)。ユーザの段は項目が少なく (kawaz の面で各リスト 9 件まで) プロジェクトの項目と見比べる相手で、組み込みの段は soft_deny だけで 72 件あり、開いていると縦に長くなりすぎるため。開閉は保存しない (DR-0043 §1 の区画と同じ)

#### プロジェクトの段の編集

- 項目をクリックすると、その場で textarea に切り替わる (中身はその項目の文)
- ⌘Enter (他の OS は Ctrl+Enter。FAB と同じ判定 `composer-keydown.ts`) で保存。Enter は改行
- textarea の下に「やめる」「保存」のボタンを置く (右寄せ、この順。並びと見た目はコメントのフォーム [DR-0062](./DR-0062-comments.md) の `CommentForm` の組に揃える)。端末で出し分けず PC でも出す。「保存」は ⌘Enter と、「やめる」は Esc と同じ (裁定 13)
- Esc で編集をやめて元の表示に戻す。フォーカスが外れても編集は閉じない (書いた文を失わない)。別の項目をクリックしても、[＋] を押しても、開いている textarea は閉じない (同じセクションで複数を開ける)
- 別の画面が項目を足す・消す・動かしても、編集中の textarea はその項目 (文で探す) に付いて残る。項目の数が編集を始めた時と同じでその位置の文が変わっていれば、別の画面がその項目を変えたとみなし、textarea の上に「別の画面が先に変えた。今の文: <今の文>」を出す。数が違ってその項目が見つからなければ、消されたとみなして textarea を項目の後ろに残し、「別の画面が先にこの項目を消した」を出す
- 変えられた項目の保存は、まず編集を始めた時の文を `before` に送って `file_conflict` で断られ、注釈が「別の画面が先に変えた。もう一度保存すると上書きする。今の文: <今の文>」に変わる。次の保存は今の文を `before` にして上書きする (見た上での上書き)。消された項目の保存は、1 回目は送らずに注釈を「別の画面が先にこの項目を消した。もう一度保存すると最後に足す」に変え、次の保存で最後に足す
- 空 (空白だけを含む) で保存するとその項目を消す。削除ボタンは置かない。確認の dialog は出さない
- [＋] で、そのセクションのプロジェクトの段の最後に空の textarea を開く。空のまま ⌘Enter / Esc なら何も足さずに閉じる
- 保存の間は textarea・チェックボックスを disabled にし、成功で表示に戻る。断られたら textarea を開いたまま (チェックボックスは元の状態に戻し)、理由をその下に出す
- 同じキーの設定が、別のタブ・別のデバイス・同じ repo の別のセッションの画面から変わったら、`ev` (§7) で開いている画面のプロジェクトの段・チェックボックス・結果の文が更新される。自分が編集中の項目の textarea の中身は上書きしない (保存すると `before` の食い違いで `file_conflict` になり、最新を読み直す)
- ユーザの段は Status タブを表に出した時・保存の後・接続が戻った時に読み直す (変更の push はしない)。読み直しが失敗しても、前に読めた内容と開いている textarea は残し、理由を 1 行足す
- 組み込みの段の読みが失敗したら、次の読み直し (タブを出し直す・保存・接続が戻る) が答えた時に取り直す

### 7. op と ev (どれも user role だけ)

- `project_auto_mode_read { session_id }` → `{ ok: true, key, label, project, user, builtin_version? }`
  - `key` / `label`: daemon がそのセッションの cwd から導くキーと、画面に出す文 (§6)
  - `project`: 4 つのセクションの `{ defaults, entries }` (既定の値を埋めたもの)
  - `user`: `{ config_dir_name, autoMode }` (`autoMode` は書かれたリストだけ、`$defaults` もそのまま) か `{ unavailable: <理由> }`。セッションの config dir の `settings.json` を毎回読む (小さいので持たない)。config dir は agents / peers の行の `config_dir`
  - `builtin_version`: 組み込みの既定の版のキー (下の `auto_mode_defaults_read`)。取れなければ無い
  - `session_not_found`: daemon がその sid の cwd を知らない (hello が cwd を名乗らず空のもの、絶対パスでないもの、キーのスキーマを満たさないキーになるものを含む。daemon はそういうキーを作らず、書かない)。`project_auto_mode_unreadable`: `project-auto-mode.json` が読めない
- `auto_mode_defaults_read { version }` → `{ ok: true, version, label, defaults: { environment, allow, soft_deny, hard_deny } }`
  - daemon が `claude auto-mode defaults` を子プロセスで走らせた出力。82 KB あるので `project_auto_mode_read` に毎回は載せず、webui は版のキーごとにメモリに持つ
  - 走らせる claude は daemon の PATH の `claude`。環境は起動コマンドと同じく `clean_env` / `keep_env` で掃除したもの。`session_launcher` が無い時は、`clean_env` / `keep_env` を省いた時と同じ空のリスト (組み込みの既定は無い) として扱い、daemon の環境を掃除せずに渡す。10 秒で止める。config dir は付けない (個人面と空の config dir で出力が同じ、Context)
  - PATH に `claude` が無ければ `claude_not_found`。`claude auto-mode defaults` か `claude --version` が非零で終わった・10 秒で止めた・出力が読めない時は新しい ErrorCode `auto_mode_defaults_unavailable` で、msg に理由を書く
  - 版のキーは `claude` の realpath と mtime から作る不透明な文字列 (更新で実体が替わると変わる)。daemon は出力と `claude --version` の 1 行目 (`label`、画面の版の表示) をこのキーでメモリに持ち、キーが変わった時だけ取り直す。失敗は持たず、次の読みで取り直す
  - `version` が今のキーと違えば `invalid_args` (webui は `project_auto_mode_read` から読み直す)
- `project_auto_mode_write` → `{ ok: true, project }`。形は 2 つ:
  - `{ session_id, section, defaults }`: そのセクションのチェックを変える
  - `{ session_id, section, text }` / `{ session_id, section, index, before, text }`: 項目を変える。`index` と `before` は組で来る (片方だけは `invalid_args`)。`index` 無しは `text` を最後に足す (`text` が空なら何もしない)。`index` ありは `before` がその位置の今の文と同じ時だけ `text` に置き換える (空なら消す)。違えば `file_conflict` (別の画面が先に変えた)。webui は読み直して編集を開いたままにする
  - `invalid_args`: `section` が 4 つの外、`index` が範囲の外、`text` が上限を超える・`$defaults`
  - 書いた後、全ての user role の接続に `ev:"project_auto_mode" { key, project }` を送る。webui は表示中のセッションのキーと同じ時だけ反映する
- session role (エージェント) の接続と hooks module の `POST /op` からは `bad_request` で断る。エージェントが自分のプロジェクトの allow を広げる口にしない。項目の追加を頼む経路も作らない

Design rationale: 組み込みの既定は daemon が `claude` を子プロセスで走らせて取る (kawaz の裁定)。[DR-0060](./DR-0060-btw-mode.md) の裁定 1 は btw のセッションを起こす経路を config の command に限ったもので、ここで走らせるのはセッションを起こさない読むだけのサブコマンド。daemon の PATH の claude と、セッションを走らせている claude の版が違う時 (古い版のまま走っているセッション)、組み込みの段は PATH の claude の版の既定になる。

### 8. btw の fork

- btw の fork にもプロジェクトの autoMode を渡す (kawaz: btw も同じ)。btw の fork は permission mode が settings の既定 (auto の面では auto) で、書き込みの tool も classifier を通れば走るので、本体と同じ説明で判定させる
- `btw_ask` で daemon がセッションの cwd のキーから §4 のファイルを作り、btw コマンドの入力の `settings` に入れる。組み込みの btw コマンドは `--settings <path>` を付ける
- 本体が古い内容で起動されたままでも、btw はその時の保存の内容で走る
- `--settings` を足した fork が元のセッションの prompt cache を読めるかは未測 (§10 で確かめる)

### 9. やらないこと

- リポの中のファイル (`.claude/settings*.json` 等) から autoMode を読む・書く
- autoMode の 4 つのリスト以外の settings (`permissions`、`env`、`autoMode.classifyAllShell` 等) を `--settings` で渡す。classifyAllShell は classifier への説明でなく permission rule の効き方のスイッチで、複数の scope が違う値を書いた時の決まりを公式が書いておらず、`claude auto-mode config` にも出ないので、プロジェクトで足した時に効くかを画面で示せない
- 走っているセッションへの即時の反映 (反映は再起動)
- プロジェクトの設定でユーザの設定・managed settings の項目や `$defaults` を消すこと
- managed settings の項目を画面に出すこと
- ユーザの段の編集 (user settings は Claude Code の `/permissions` の Auto mode タブ等で直す)
- 項目の並べ替えの操作
- CLI からの編集

### 10. 試験の観点

- user role 以外の `project_auto_mode_read` / `project_auto_mode_write` / `auto_mode_defaults_read` は `bad_request` で、ファイルを書かず、claude を走らせない
- tool `launch` の入力・webui の起動のフォーム・`btw_ask` に `settings` を書いても、コマンドの入力の `settings` は daemon が作ったファイルのパスだけ。launch (tool と webui のフォーム) は知らない field として `invalid_args` で断り、`btw_ask` は知らない field を落とす
- 何も設定していないプロジェクトの起動と btw の入力に `settings` が無い (今の入力と同じ)
- settings のファイルには項目のあるセクションだけがあり、チェックが入っていればリストの先頭が `$defaults`、外していれば `$defaults` が無い。続く項目が保存の順。項目の無いセクションはチェックの有無によらず書かれない。`autoMode` 以外の key が無い
- 同じ内容の 2 回の起動は同じパスを渡し、ファイルを書き直さない。設定を変えた後の起動は別のパスを渡し、前のファイルの中身は変わらない
- 新規・continue・resume・fork・再起動・btw の全てに `settings` が入る。再起動で `project-auto-mode.json` が読めない時はプロセスを止めずに `project_auto_mode_unreadable`
- 起動の cwd が同じリポの別の jj workspace・git worktree・サブディレクトリの時、同じキーになる。repository の導けない cwd は cwd のキー
- `before` の違う項目の `project_auto_mode_write` は `file_conflict` で、ファイルを変えない
- 空で保存した項目が消え、4 つのセクションが全部既定 (チェックあり・項目なし) に戻ったキーがファイルから消える
- 書いた後、別の接続の user role に `ev:"project_auto_mode"` が届き、同じキーのセッションを表示中の画面のプロジェクトの段・チェックボックス・結果の文が変わる。編集中の textarea の中身は変わらない
- `$defaults` の行は項目が 0 件のセクションにも出る
- 組み込みの段の出る・出ないと結果の文が §1 の決まりどおり: プロジェクトの項目 (あり / なし) × チェック (あり / なし) × ユーザ ((a) `$defaults` あり / (b) `$defaults` なしで項目あり / (c) 書いていない) の 12 通り
- `auto_mode_defaults_read` は claude の realpath と mtime が変わるまで claude を走らせ直さない
- 組み込みの起動コマンド・btw コマンドが `settings` を `--settings <path>` 1 つで claude に渡す (偽の claude で引数を見る)
- 実機 (使い捨てのセッション):
  - 項目を足したプロジェクトで ccmsg から起動したセッションの classifier が、足した `soft_deny` で止める・足した `allow` で通す
  - 起動の後に settings のファイルを別の内容に差し替えて、走っているセッションが読み直すか
  - btw の fork に `settings` を渡した時に元のセッションの prompt cache を読めているかを、`btw_end` の行の token の数 (`cache_read_input_tokens` が渡さない時と同じ程度で、`cache_creation_input_tokens` が小さい) で確かめる

## 裁定 (kawaz 2026-11-22)

1. リポの中の autoMode は見ない。ccmsg がプロジェクトごとの設定として持ち、webui を通じて daemon が管理する
2. 設定の単位は repo (`<host>/<owner>/<name>`) で、repo の無い cwd だけ cwd (§3)
3. 書き換えは user role だけ。エージェントが項目の追加を頼む経路は作らない (§7)
4. 編集はセッションの Status タブの危険ゾーン、終了ボタンの下。4 つのセクションを全部置く (§6)
5. セクションごとの 2 段のリスト、クリックで textarea、⌘Enter で保存、[＋] で追加、空で保存すると削除、削除ボタンは無し (§6)
6. 反映は再起動で、そのことを注釈で書く (§6)
7. `--settings` は 1 つにまとめる。渡し方は JSON の文字列でなく、daemon が state dir の下に作るファイル (§4、§5)
8. 画面はプロジェクト (編集できる)・ユーザ (config dir の `settings.json`、読むだけ)・組み込みの既定 (`claude auto-mode defaults`、読むだけ) の 3 段を色と見出しで分けて並べる。同じ repo の設定の変更は開いている画面に反映する (§6、§7)
9. `$defaults` は daemon が常に入れるのでなく、プロジェクトの各セクションの「`$defaults` を入れる」チェックボックスにする。何も設定していないセクションはチェックが入った状態。ユーザの側の `$defaults` も読むだけで出し、チェックの横に今の実際の結果を出す。組み込みの段は組み込みが効く時だけ出す (§1、§6)
10. 各セクションの頭に `$defaults` の行 (チェックボックスとユーザの側の状態) を、項目が空でも必ず出す (§6)
11. settings のファイルには項目のあるセクションだけを書き、チェックが入っていて項目の無いセクションは書かない (§4)
12. btw の fork にも同じ settings を渡す (§8)
13. 編集中の textarea の下に「保存」「やめる」のボタンを出す。PC でも出す (端末で出し分けない)。⌘Enter / Ctrl+Enter と Esc はそのまま残す (§6)。原文の要点:「C6 確かに必要ですね。PC の場合も別に出して良いね」
14. プロジェクトのキーは今の決まりのまま (§3)。remote を書き換えるとキーが変わり別のプロジェクトの設定に当たりうることは確かめた上で保つ。原文の要点:「remote があればそこから取って、無ければパスから取るで良い」

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| プロジェクトの `.claude/settings.local.json` に `autoMode` を書く | Claude Code が読まない (Context)。リポの中のファイルなので、読まれたとしてもリポやエージェントが差し込める |
| daemon が user settings (`<config dir>/settings.json`) の `autoMode` にプロジェクトの項目を書き足す | 全プロジェクトのセッションに効く。user settings は人と Claude Code (`/permissions` の Auto mode タブ、`/auto-mode-setup`) が書くファイルで、daemon が書くと取り合いになる |
| キーを cwd にする | 同じリポの別の workspace・worktree、リポの外に作った worker の workspace に効かない (裁定 2) |
| settings を JSON の文字列で起動の引数に載せる | 裁定 7 (`ps` / `pstree` の見た目、エスケープ) |
| settings のファイルを保存の時にキーごとに 1 つ作り、保存のたびに書き換える | 走っているセッションが読み直すと、再起動の前に中身が変わりうる (未検証)。手で直した `project-auto-mode.json` が次の保存まで反映されない。内容で名前を決めて起動の時に作れば、どちらも起きない |
| 起動コマンドが cwd から自分で項目を読んで settings を作る | 置き場と形を起動コマンドごとに持つことになり、webui で編集した値と起動の値を daemon が一致させられない |
| daemon が各リストに `$defaults` を常に入れる | ユーザが外した既定を、プロジェクトに項目がある間だけ戻してしまい、人がそれを選べない (裁定 9) |
| チェックの入った項目の無いセクションも `["$defaults"]` として書く | 何も設定していない全てのプロジェクトで、(b) のユーザが外した既定を戻してしまう (裁定 11) |
| `$defaults` をリストの中の文字列で持つ | §2 の Design rationale |
| 組み込みの既定を `claude auto-mode config` で実効の値として 1 つの段に出す | どの項目がどの層から来たかが分からず、`$defaults` で既定が効いているかを見比べられない |
| 削除ボタンを置く | 裁定 5 (空で保存すると削除) |

## Consequences

- protocol: `LaunchCommandInputSchema` と `BtwCommandInputSchema` の `settings`、`ProjectAutoModeFileSchema` と op `project_auto_mode_read` / `project_auto_mode_write` / `auto_mode_defaults_read`、`ev:"project_auto_mode"`、ErrorCode `project_auto_mode_unreadable` / `auto_mode_defaults_unavailable`、`Paths.projectAutoMode` / `Paths.launchSettingsDir`
- daemon: settings のファイルの作成と log の件数 (`launchSession`、`resumeLaunch` の止める前、`btw_ask`)、`project-auto-mode.json` の読み書き、`claude auto-mode defaults` の子プロセスと版のキーのメモリ、セッションの config dir の `settings.json` の読み
- 組み込みの起動コマンドと btw コマンド: `settings` → `--settings <path>`。[launch-command](../design/launch-command.md) と [btw-command](../design/btw-command.md) の入力の表・写し方・コマンドの責務 (自前の settings とまとめる、§5) を足す
- webui: 危険ゾーンの autoMode のまとまり (4 つのセクション × 頭の `$defaults` の行と 3 つの段、クリックで textarea、⌘Enter、[＋]、注釈)
- 自前の起動コマンド・btw コマンドを使う人は、項目のあるプロジェクトで起動する前に `settings` を読めるようにする必要がある (読めない間は非零で断られる)
- daemon が PATH の `claude` を走らせる口が 1 つ増える (`auto-mode defaults` と `--version`、読むだけ)
- (b) のユーザ (そのリストを `$defaults` なしで書いている) では、チェックの入ったセクションに項目を足すと組み込みが効き始める。結果は `$defaults` の行の文に出る
- [DR-0028](./DR-0028-session-kill.md) の Consequences の「起動時の `--settings` は再起動で起動コマンドの既定になる」は、プロジェクトの autoMode の分だけ再起動でも渡るようになる

## 関連

- [DR-0018](./DR-0018-session-launcher.md) — 起動コマンドと起動の入力
- [DR-0028](./DR-0028-session-kill.md) — 再起動と危険ゾーン
- [DR-0040](./DR-0040-permit-request-tool.md) §12 — settings の変更を人が webui で押して daemon が書く前例 (`project_permissions`)
- [DR-0043](./DR-0043-sidebar-folds-and-globals.md) §10 — SESSIONS の owner/repo の木
- [DR-0057](./DR-0057-webui-userscript.md) — 人が書いた設定を daemon が確かめて config dir に保存する前例
- [DR-0060](./DR-0060-btw-mode.md) — btw コマンド
- [launch-command](../design/launch-command.md) / [btw-command](../design/btw-command.md) — コマンドの契約
