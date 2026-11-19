# `permissions.allow` の Read / Write / Edit の path はどの綴りで当たるか (実測)

- Date: 2026-11-18
- 対象: Claude Code 2.1.327 (主)。中心の 6 配置は 2.1.325 と 2.1.326 でも同じ結果
- 動機: ccmsg の permit はプロジェクトの `.claude/settings.local.json` の `permissions.allow` に rule を足す ([DR-0040](../decisions/DR-0040-permit-request-tool.md) §12)。今の決まりは「Edit / Read / Write の path は `/Users/...` の絶対パスで書き、`~/` は効かないので断る」(`skills/ccmsg/SKILL.md`、`packages/protocol/src/permit-request.ts` の `isTildeFileRule`)。これが正しいかを確かめ、ccmsg が rule を効く形に直す手順の材料にする
- 方法: 一時ディレクトリに試験用の HOME・config dir・プロジェクトを置き、`env -i` で `PATH` / `TERM` / `HOME` / `TMPDIR` / `CLAUDE_CONFIG_DIR` と、127.0.0.1 の Messages API の代役に向けた `ANTHROPIC_BASE_URL`、作り物の `ANTHROPIC_API_KEY` だけを渡して `claude -p --permission-mode default --output-format json` を起動した。代役は、最初の user message の probe から case を引き、決まった tool_use (Edit / Write / Read と対象の path) を返し、tool_result を受けたら text で終わる。1 回の起動ごとに対象のファイルを作り直し、`settings.local.json` (または user の `settings.json`) の `permissions.allow` に rule を置いて走らせた。判定は 3 つを突き合わせた: 結果の JSON の `permission_denials` にその tool があるか、tool_result が `Claude requested permissions to ...` の拒否か、対象のファイルの中身が書き換わったか。rule を置かない時に断られることを各配置で先に確かめた
- 下の記法: `<home>` は試験用の HOME (`/private/var/folders/...` の綴り)、`<vhome>` は同じ場所の `/var/folders/...` の綴り (macOS の `/var` → `/private/var`)、`<project>` は `<home>/work/proj` (`claude` を起動したディレクトリ、git の外)、`<outside>` と `<outside2>` は HOME の外のディレクトリ、`<base>` は `<home>` と `<outside>` を含む置き場、`<config>` は `CLAUDE_CONFIG_DIR`

## 判明した事実

### path の綴り

- **`/` 1 つの絶対パス (`Edit(/Users/...)` の形) は絶対パスとして当たらない**。プロジェクトの中・HOME の中・HOME の外の 3 か所、`settings.local.json` と user の `settings.json` の両方で、すべて断られた。`/` 1 つは settings の置き場に結び付いた基点からの相対として読まれる
- **`//` で始まる絶対パスは当たる** (3 か所 × 2 つの settings で全部)
- **`~/` で始まる path は当たる** (HOME の中の 2 か所 × 2 つの settings で全部)。`~` は起動時の `HOME` に展開される
- `src/a.txt` と `./src/a.txt` はカレントディレクトリ (= 起動したディレクトリ) からの相対で、user の settings に置いても当たる
- `/src/a.txt` は、`settings.local.json` ではプロジェクトの root (`.claude/` ではない) を基点に当たった。user の settings では `CLAUDE_CONFIG_DIR` を基点にし (`<config>/zz/g.txt` に当たり、`<home>/.claude/zz/g.txt` には当たらない)、プロジェクトのファイルには当たらない
- rule の中の `..` は正規化されない (`//<home>/work/../other/b.txt`、`../../other/b.txt`、`~/../...`、`/../...` はどれも当たらない)。tool の入力の側の `..` は正規化されてから照合される (入力 `<project>/../../other/b.txt` に `//<home>/other/b.txt` が当たる)
- 空白と日本語を含む path はエスケープなしでそのまま当たる。`\ ` でエスケープしても当たる
- 大文字小文字の違う rule が当たった (macOS の大文字小文字を区別しない APFS の上で、両方向)
- ファイルの path の末尾に `/` を付けた rule は当たらない。ディレクトリの path は末尾の `/` の有無にかかわらず、その下のファイルに当たる (gitignore の書き方どおり)

### rule の種類と tool の関係

- **`Write(...)` の rule は何にも当たらない**。Write tool にも Edit tool にも、まだ無いファイルにも効かない (docs の記述どおり)
- **`Edit(...)` の rule は Edit と Write の両方に当たり、Read も許す**
- `Read(...)` の rule は Read だけに当たり、Edit を許さない

### symlink

- **利用者が作った symlink を通る path は、書かれた綴りと実体の綴りの両方に rule が要る**。tool の入力が symlink 側の綴りの時、symlink 側の rule だけでも、実体側の rule だけでも断られ、両方を置くと当たる。相対の symlink、絶対の symlink、HOME の外を指す symlink、dotfiles 型 (`~/.cfgl -> ~/dots/config`)、symlink の連鎖 (`chain -> link -> real`) の 5 形で同じ。Read も同じ
- tool の入力が実体側の綴りの時は、実体側の rule だけで当たる。symlink 側の rule は実体側の入力に当たらない
- **macOS の `/var` → `/private/var` だけは片方で足りる場合がある**。rule を `/var` の綴り (`//<vhome>/...`) で書くと、入力が `/var` の綴りでも `/private/var` の綴りでも当たった。rule を `/private/var` の綴りで書くと、`/var` の綴りの入力には当たらない。利用者の symlink では rule 側の綴りが実体へ解決されないので、`/var` は別扱いになっている (仕組みは未特定。OS の symlink は `/var` でしか確かめていない)
- path 自体が symlink のファイル (`flink.txt -> real/c.txt`) への Edit は、rule にかかわらず tool が `Refusing to write ...` で断る (docs の記述どおり)
- まだ無いファイルでも同じ。`<home>/link/new.txt` を Write で作る時、`//<home>/link/new.txt` だけでも `//<home>/real/new.txt` だけでも断られ、両方で当たる

### 判定元の記録

- transcript の tool_result の行に `permissionDecision` が残る。rule で通った時は `{"decision":"accept","source":"user_permanent","reasonType":"rule","ruleSource":"localSettings"}`、`--allowedTools` で通った時は `source:"config"`, `ruleSource:"cliArg"`、rule が無く断られた時は `{"decision":"reject","source":"config","reasonCode":"workingDir"}` と `toolDenialKind:"user-rejected"`。auto mode の classifier が判定元の時の値は確かめていない (auto mode は使っていない)

## 実用的な示唆

### 1 つのファイルを名指す path から足す rule を作る手順

入力: 1 つのファイルを名指す絶対パス `p` (存在するファイル、またはまだ無いファイル) と、許したい操作 (読む / 書く)。

1. rule の種類を決める。書く (Edit / Write) なら `Edit`、読むなら `Read`。`Write(...)` は何にも当たらないので使わない (`Edit` は Read も許す)
2. `p` をそのまま `Edit(/` + `p` + `)` にする (`//` の絶対パス)
3. `p` の realpath を求める。まだ無いファイルは、存在するところまで (存在する最も深い親まで) 解決し、残りの部分を文字列のまま付ける (Python の `os.path.realpath` の非 strict の動き)。それを `Edit(/` + realpath + `)` にする
4. 2 と 3 が同じなら 1 本、違えば 2 本を足す

この手順で作った rule を、下の配置の全部で突き合わせた: 当たった件数 / 試した件数 = **104 / 104**。

- 置き場: `settings.local.json`、user の `settings.json` の 2 つ
- 存在するファイル 14 配置 × Edit / Write / Read の 3 tool: プロジェクトの中、HOME の中、HOME の外、`/var` の綴り、相対の symlink 経由、実体、絶対の symlink 経由、HOME の外を指す symlink 経由、dotfiles 型の symlink 経由、symlink の連鎖経由、`/var` の綴りかつ symlink 経由、`..` を含む入力、空白と日本語、大文字小文字の違う綴り
- まだ無いファイル 10 配置 × Write: HOME の中、HOME の外、symlink のディレクトリの下、`/var` の綴り、`/var` の綴りかつ symlink の下、まだ無い親ディレクトリの下、symlink の下のまだ無い親ディレクトリの下、dotfiles 型の symlink の下、プロジェクトの中、HOME の外を指す symlink の下

realpath の 1 本が要る場面と、書かれた綴りの 1 本が要る場面はどちらもある (symlink 側の入力は両方、実体側の入力は realpath の 1 本で足りる、`/var` の綴りの入力は書かれた綴りの 1 本で足りる)。2 本を常に足せば場合分けが要らない。

### 外からは決められない要素

- 入力に `..` を含む時、書かれた綴りの rule (`..` を含む) は当たらず、realpath の 1 本だけが効く。害はないが無駄な 1 本になる
- 大文字小文字の違う入力の扱いはファイルシステムに依存する。大文字小文字を区別するファイルシステムでは試していない。また realpath の実装によって大文字小文字を実体に合わせるもの (Node の `fs.realpathSync.native` 等) と合わせないもの (Python の `os.path.realpath`) がある
- symlink が rule を足した後に張り替えられると、足した realpath は外れる
- まだ無いファイルの親が後から symlink として作られると、足した realpath の 1 本は外れる

### ccmsg の今の決まりとの差

- 「`/Users/...` の絶対パスで書く」は誤り。その形は settings の置き場を基点にした相対として読まれ、当たらない。`//Users/...` で書く
- 「`~/` は `permissions.allow` では効かない」は誤り。`~/` は当たる。ただし `~/.config` のような symlink を通る path は `~/` の 1 本だけでは当たらず、実体の綴りも要る (`~/.config` が dotfiles への symlink の環境で、`~/.config/...` の 1 本が効かないと見えるのはこの形と一致する。過去の観測の原因がこれだったかは未確認)
- `Write(...)` の rule を受け付けても効かない

## 検証の詳細

結果の列: 許可 = `permission_denials` にその tool が無く、ファイルが書き換わった (Read は内容が返った)。拒否 = `permission_denials` にその tool があり、tool_result が `Claude requested permissions to ...`。

Edit / Write の対象が working directory の外の既存ファイルの時、先に Read していないと permission の判定の前に `File has not been read yet` で断られる。このため Edit / Write の case は、`--allowedTools=Read` (path の無い Read の許可) を付けて Read → Edit / Write の 2 手にした。この CLI の許可が Edit の判定に効かないことは、rule 無しの基準 (下の表の「なし」) が全部拒否であることで確かめた。

### 1. 綴りごとの当たり方 (Edit tool、入力は `/private/var` の綴りの実パス)

| rule | 対象 | settings.local.json | user settings.json |
|---|---|---|---|
| なし | `<project>/src/a.txt` | 拒否 | 拒否 |
| なし | `<home>/other/b.txt` | 拒否 | 拒否 |
| なし | `<outside>/d.txt` | 拒否 | 拒否 |
| `Edit(<project>/src/a.txt)` (`/` 1 つ) | `<project>/src/a.txt` | 拒否 | 拒否 |
| `Edit(<home>/other/b.txt)` (`/` 1 つ) | `<home>/other/b.txt` | 拒否 | 拒否 |
| `Edit(<outside>/d.txt)` (`/` 1 つ) | `<outside>/d.txt` | 拒否 | 拒否 |
| `Edit(/<project>/src/a.txt)` (`//`) | `<project>/src/a.txt` | 許可 | 許可 |
| `Edit(/<home>/other/b.txt)` (`//`) | `<home>/other/b.txt` | 許可 | 許可 |
| `Edit(/<outside>/d.txt)` (`//`) | `<outside>/d.txt` | 許可 | 許可 |
| `Edit(~/work/proj/src/a.txt)` | `<project>/src/a.txt` | 許可 | 許可 |
| `Edit(~/other/b.txt)` | `<home>/other/b.txt` | 許可 | 許可 |
| `Edit(src/a.txt)` | `<project>/src/a.txt` | 許可 | 許可 |
| `Edit(./src/a.txt)` | `<project>/src/a.txt` | 許可 | 許可 |
| `Edit(/src/a.txt)` | `<project>/src/a.txt` | 許可 | 拒否 |
| `Edit(/work/proj/src/a.txt)` (HOME 基点のつもり) | `<project>/src/a.txt` | 拒否 | 拒否 |
| `Edit(/zz/g.txt)` | `<config>/zz/g.txt` | 未試行 | 許可 |
| `Edit(/zz/g.txt)` | `<home>/.claude/zz/g.txt` | 未試行 | 拒否 |
| `Edit(/<config>/zz/g.txt)` (`//`) | `<config>/zz/g.txt` | 未試行 | 許可 |

`settings.local.json` の `/path` の基点が `.claude/` かプロジェクトの root かは、`/src/a.txt` が `<project>/src/a.txt` に当たったことで root と決まる。基点がプロジェクトの root か起動したディレクトリ (primary working directory) かは、この配置では同じ場所なので切り分けていない。

2.1.325 と 2.1.326 での同じ配置 (`settings.local.json`、対象 `<home>/other/b.txt`): なし → 拒否、`/` 1 つ → 拒否、`//` → 許可、`~/` → 許可、symlink 側の 1 本 (入力 symlink 側) → 拒否、`/var` の綴りの rule (入力 `/private/var`) → 許可。2.1.327 と同じ。

### 2. Read / Write / Edit の関係 (`settings.local.json`、対象は HOME の中・プロジェクトの外)

| rule | tool | 結果 |
|---|---|---|
| なし | Read | 拒否 |
| `Read(//<home>/other/b.txt)` | Read | 許可 |
| `Read(~/other/b.txt)` | Read | 許可 |
| `Edit(//<home>/other/b.txt)` | Read | 許可 |
| `Write(//<home>/other/b.txt)` | Read | 拒否 |
| なし | Write (既存) | 拒否 |
| `Edit(//<home>/other/b.txt)` | Write (既存) | 許可 |
| `Write(//<home>/other/b.txt)` | Write (既存) | 拒否 |
| `Write(//<home>/other/b.txt)` | Edit | 拒否 |
| `Read(//<home>/other/b.txt)` | Edit | 拒否 |
| `Read(~/other/b.txt)` | Edit | 拒否 |
| `Write(//<project>/src/a.txt)` | Write (プロジェクトの中) | 拒否 |
| `Write(src/a.txt)` | Edit (プロジェクトの中) | 拒否 |
| `Write(//<home>/other/new.txt)` | Write (まだ無い) | 拒否 |
| `Edit(//<home>/other/new.txt)` | Write (まだ無い) | 許可 |

プロジェクトの中のファイルの Read は rule が無くても通る (working directory の中なので)。

### 3. symlink (`settings.local.json`)

`<home>/link -> real` (相対の symlink)、対象 `<home>/real/c.txt`。

| tool | 入力 | rule | 結果 |
|---|---|---|---|
| Edit | `link/c.txt` | なし | 拒否 |
| Edit | `link/c.txt` | `//<home>/link/c.txt` だけ | 拒否 |
| Edit | `link/c.txt` | `//<home>/real/c.txt` だけ | 拒否 |
| Edit | `link/c.txt` | `~/link/c.txt` だけ | 拒否 |
| Edit | `link/c.txt` | `~/real/c.txt` だけ | 拒否 |
| Edit | `link/c.txt` | `//<home>/link/c.txt` と `//<home>/real/c.txt` | 許可 |
| Edit | `real/c.txt` | なし | 拒否 |
| Edit | `real/c.txt` | `//<home>/link/c.txt` だけ | 拒否 |
| Edit | `real/c.txt` | `//<home>/real/c.txt` だけ | 許可 |
| Edit | `real/c.txt` | `~/link/c.txt` だけ | 拒否 |
| Edit | `real/c.txt` | `~/real/c.txt` だけ | 許可 |
| Edit | `real/c.txt` | 両方 | 許可 |
| Read | `link/c.txt` | なし / link だけ / real だけ (`//` と `~/` の 4 通り) | 全部拒否 |
| Read | `real/c.txt` | link だけ (`//`、`~/`) | 拒否 |
| Read | `real/c.txt` | real だけ (`//`、`~/`) | 許可 |

他の形の symlink (Edit、片方だけの rule):

| symlink の形 | 入力 | rule | 結果 |
|---|---|---|---|
| 絶対 `alink -> <home>/real` | `alink/c.txt` | `//<home>/alink/c.txt` だけ | 拒否 |
| 同上 | `alink/c.txt` | `//<home>/real/c.txt` だけ | 拒否 |
| 同上 | `real/c.txt` | `//<home>/alink/c.txt` だけ | 拒否 |
| HOME の外を指す `dlink -> <outside2>` | `dlink/g.txt` | `//<home>/dlink/g.txt` だけ | 拒否 |
| 同上 | `dlink/g.txt` | `//<outside2>/g.txt` だけ | 拒否 |
| 同上 | `dlink/g.txt` | `~/dlink/g.txt` だけ | 拒否 |
| dotfiles 型 `.cfgl -> <home>/dots/config` | `.cfgl/app/x.toml` | `~/.cfgl/app/x.toml` だけ | 拒否 |
| 同上 | `.cfgl/app/x.toml` | `~/dots/config/app/x.toml` だけ | 拒否 |
| 連鎖 `chain -> link -> real` | `chain/c.txt` | `//<home>/chain/c.txt` だけ | 拒否 |
| 同上 | `chain/c.txt` | `//<home>/real/c.txt` だけ | 拒否 |
| ファイルの symlink `flink.txt -> real/c.txt` | `flink.txt` | `//<home>/flink.txt` または `//<home>/real/c.txt` | 拒否 (`Refusing to write ...`) |
| 絶対 `alink` (Read) | `alink/c.txt` | `Read` の alink だけ / real だけ | 両方拒否 |

両方の綴りを置いた時はどの形も許可 (下の 8 の表)。

macOS の `/var` → `/private/var`:

| tool | 入力 | rule | 結果 |
|---|---|---|---|
| Edit | `<home>/other/b.txt` | `//<home>/other/b.txt` | 許可 |
| Edit | `<home>/other/b.txt` | `//<vhome>/other/b.txt` | 許可 |
| Edit | `<vhome>/other/b.txt` | `//<home>/other/b.txt` | 拒否 |
| Edit | `<vhome>/other/b.txt` | `//<vhome>/other/b.txt` | 許可 |
| Read | 上の 4 通り | 同上 | Edit と同じ (許可 / 許可 / 拒否 / 許可) |
| Write (まだ無い) | `<home>/other/new.txt` | `//<vhome>/other/new.txt` | 許可 |
| Write (まだ無い) | `<vhome>/other/new.txt` | `//<home>/other/new.txt` | 拒否 |

### 4. glob (参考。permit は glob を扱わないので追加の配置は作っていない)

| rule | 入力 | 結果 |
|---|---|---|
| `Edit(//<home>/other/**)`、`/*`、`/*.txt` | `<home>/other/b.txt` | 許可 |
| `Edit(~/other/*.txt)`、`~/other/**`、`~/**` | `<home>/other/b.txt` | 許可 |
| `Edit(//<outside>/**)`、`Edit(//<base>/**)` | `<outside>/d.txt` | 許可 |
| `Edit(//<home>/link/**)`、`//<home>/real/**`、`~/link/**`、`~/real/**` (どれか 1 本) | `<home>/link/c.txt` | 拒否 |
| `Edit(~/**)` (link と real の両方を覆う) | `<home>/link/c.txt` | 許可 |
| `Edit(//<home>/link/**)` | `<home>/real/c.txt` | 拒否 |
| `Edit(//<home>/real/**)` | `<home>/real/c.txt` | 許可 |
| `Edit(//<vhome>/other/**)` | `<home>/other/b.txt` と `<vhome>/other/b.txt` | 両方許可 |
| `Edit(//<home>/other/**)` | `<vhome>/other/b.txt` | 拒否 |

### 5. まだ無いファイル (Write、`settings.local.json`)

| rule | 入力 | 結果 |
|---|---|---|
| なし | `<home>/other/new.txt` | 拒否 |
| `Edit(//<home>/other/new.txt)` | 同上 | 許可 |
| `Edit(<home>/other/new.txt)` (`/` 1 つ) | 同上 | 拒否 |
| `Edit(~/other/new.txt)` | 同上 | 許可 |
| `Edit(//<outside>/new.txt)` | `<outside>/new.txt` | 許可 |
| `Edit(//<home>/other/sub/new.txt)` (親も無い) | `<home>/other/sub/new.txt` | 許可 |
| `Edit(src/new.txt)` | `<project>/src/new.txt` | 許可 |
| `Edit(//<home>/link/new.txt)` だけ | `<home>/link/new.txt` | 拒否 |
| `Edit(//<home>/real/new.txt)` だけ | `<home>/link/new.txt` | 拒否 |
| 両方 | `<home>/link/new.txt` | 許可 (8 の表) |
| `Edit(//<home>/real/new.txt)` | `<home>/real/new.txt` | 許可 |
| `Edit(//<home>/link/new.txt)` | `<home>/real/new.txt` | 拒否 |
| (参考) `Edit(//<home>/other/**)`、`Edit(~/other/*.txt)` | `<home>/other/new.txt`、`<home>/other/sub/new.txt` | 許可 |

### 6. 大文字小文字、末尾の `/`、`..`、空白と日本語 (Edit、`settings.local.json`)

対象は `<home>/Upper/F.txt`、`<home>/other/b.txt`、`<home>/sp ace/日本語/e.txt`。

| rule | 入力 | 結果 |
|---|---|---|
| `//<home>/upper/f.txt` | `<home>/Upper/F.txt` | 許可 |
| `//<home>/Upper/F.txt` | `<home>/upper/f.txt` | 許可 |
| `//<home>/upper/f.txt` | `<home>/upper/f.txt` | 許可 |
| `//<home>/other/` | `<home>/other/b.txt` | 許可 |
| `//<home>/other` | `<home>/other/b.txt` | 許可 |
| `//<home>/other/b.txt/` | `<home>/other/b.txt` | 拒否 |
| `//<home>/work/../other/b.txt` | `<home>/other/b.txt` | 拒否 |
| `//<home>/other/b.txt` | `<project>/../../other/b.txt` | 許可 |
| `../../other/b.txt`、`./../../other/b.txt` | `<home>/other/b.txt` | 拒否 |
| `/../../other/b.txt` | `<home>/other/b.txt` | 拒否 |
| `~/../<outside の名前>/d.txt` | `<outside>/d.txt` | 拒否 |
| `~/work/proj/../../other/b.txt` | `<home>/other/b.txt` | 拒否 |
| `/../src/a.txt`、`/.claude/../src/a.txt` | `<project>/src/a.txt` | 拒否 |
| `//<home>/sp ace/日本語/e.txt` | 同じ path | 許可 |
| `~/sp ace/日本語/e.txt` | 同じ path | 許可 |
| `//<home>/sp\ ace/日本語/e.txt` | 同じ path | 許可 |
| (参考) `//<home>/sp ace/**`、`~/sp*/日本語/*.txt` | 同じ path | 許可 |

完全形でない入力の扱いの材料: ファイルの path の末尾の `/` は当たらない。`..` は rule に残すと当たらないが、入力の側では正規化される。文字列として `..` を畳む正規化は、symlink を挟まない限り realpath と同じ結果になる。symlink の後ろに `..` があると、文字列の畳み方と realpath は別の場所を指しうる (`link/../x` を realpath は `link` の実体の親を基点に解決する。POSIX の path 解決の一般的な動きで、この実験では測っていない) ので、文字列だけの正規化は realpath の代わりにならない。

### 8. 手順の突き合わせ (rule = 書かれた綴りの `//` と realpath の `//`)

| 置き場 | 配置 | tool | rule の本数 | 結果 |
|---|---|---|---|---|
| 両方 | `<project>/src/a.txt` | Edit / Write / Read | 1 | 許可 (Read は rule が無くても通る) |
| 両方 | `<home>/other/b.txt` | Edit / Write / Read | 1 | 許可 |
| 両方 | `<outside>/d.txt` | Edit / Write / Read | 1 | 許可 |
| 両方 | `<vhome>/other/b.txt` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<home>/link/c.txt` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<home>/real/c.txt` | Edit / Write / Read | 1 | 許可 |
| 両方 | `<home>/alink/c.txt` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<home>/dlink/g.txt` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<home>/.cfgl/app/x.toml` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<home>/chain/c.txt` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<vhome>/link/c.txt` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<project>/../../other/b.txt` | Edit / Write / Read | 2 | 許可 |
| 両方 | `<home>/sp ace/日本語/e.txt` | Edit / Write / Read | 1 | 許可 |
| 両方 | `<home>/upper/f.txt` (実体は `Upper/F.txt`) | Edit / Write / Read | 1 | 許可 |
| 両方 | `<home>/other/new.txt` (まだ無い) | Write | 1 | 許可 |
| 両方 | `<outside>/new.txt` (まだ無い) | Write | 1 | 許可 |
| 両方 | `<home>/link/new.txt` (まだ無い) | Write | 2 | 許可 |
| 両方 | `<vhome>/other/new.txt` (まだ無い) | Write | 2 | 許可 |
| 両方 | `<vhome>/link/new.txt` (まだ無い) | Write | 2 | 許可 |
| 両方 | `<home>/other/sub/new.txt` (親も無い) | Write | 1 | 許可 |
| 両方 | `<home>/link/sub/new.txt` (symlink の下、親も無い) | Write | 2 | 許可 |
| 両方 | `<home>/.cfgl/app/new.toml` (まだ無い) | Write | 2 | 許可 |
| 両方 | `<project>/src/new.txt` (まだ無い) | Write | 1 | 許可 |
| 両方 | `<home>/dlink/new.txt` (まだ無い) | Write | 2 | 許可 |

Edit / Write の rule は `Edit(...)`、Read の rule は `Read(...)`。合計 (14 × 3 + 10) × 2 = 104 件、全部許可で、Edit / Write はファイルが書き換わった。

### docs の記述

出典: https://code.claude.com/docs/en/permissions (2026-11-18 取得) の「Read and Edit」節。引用の中の HOME (`/Users/` の下の利用者名のディレクトリ) は `<HOME>` と書いた (`//Users/...` は `/<HOME>/...` になる)。

> `Edit` rules apply to all built-in tools that edit files.

> Claude Code checks file permissions against `Edit(path)` and `Read(path)` rules. It accepts a rule with a path other than `*` for one of the tools below but doesn't match a read, search, or edit against it. ... **`Write`, `NotebookEdit`, or legacy `MultiEdit`**: use `Edit(docs/**)` in place of `Write(docs/**)`.

> | `//path` | Absolute path from filesystem root | `Read(/<HOME>/secrets/**)` | `<HOME>/secrets/**` |
> | `~/path` | Path from home directory | `Read(~/Documents/*.pdf)` | `<HOME>/Documents/*.pdf` |
> | `/path` | Path relative to the settings source | `Edit(/src/**/*.ts)` | `<primary working directory>/src/**/*.ts` in project settings |
> | `path` or `./path` | Path relative to current directory | `Read(*.env)` | `<cwd>/*.env` |
>
> A pattern like `<HOME>/file` isn't an absolute path. The single leading slash anchors at the settings source, not the filesystem root. Use `/<HOME>/file` for absolute paths.

> | Local settings at `.claude/settings.local.json` | `<primary working directory>/path` |
> | User settings at `~/.claude/settings.json` | `~/.claude/path` |

> **Allow rules**: apply only when both the requested path and the file it resolves to match. A read through a symlink inside an allowed directory that points outside it doesn't match the rule.
>
> On macOS and Linux, a deny or ask rule written through a symlinked directory with a `//`, `~/`, or `/` pattern also applies at the directory's real location. For example, on macOS, where `/etc` resolves to `/private/etc`, `Read(//etc/**)` blocks `/private/etc/hosts` too.

> If the path Claude asks to edit or write is itself a symlink, the Edit and Write tools refuse the write and direct Claude to the link's target.

docs と実測の食い違い・docs に無いこと:

- user の settings の `/path` の基点は、`CLAUDE_CONFIG_DIR` を設定している時は `~/.claude` ではなく `CLAUDE_CONFIG_DIR` だった (docs の表は `~/.claude/path`)
- docs が「symlink 越しに書いた rule が実体にも効く」と書くのは deny / ask だけだが、`/var` の綴りの allow rule も `/private/var` の入力に当たった。利用者の symlink では allow も deny も確かめた範囲で、allow は実体に効かなかった (deny は範囲外で未試行)
- `Edit` の allow rule が Read を許すことは docs の allow の文脈には書かれていない (deny の側で「`Read` deny は Edit / Write も止める」とある)
- 大文字小文字を区別せずに当たることは docs に書かれていない

### 未確認

- auto mode で `/` 1 つの rule が効いて見えた時の判定元 (`permissionDecision.source` が classifier を示すか)。auto mode は使っていない
- `settings.local.json` の `/path` の基点がプロジェクトの root か起動したディレクトリか (同じ場所でしか試していない)、git の repo の中・worktree の中での基点
- 大文字小文字を区別するファイルシステム、Linux、Windows
- 対話のセッションでの照合 (全部 `-p` で試した)
- `/tmp` → `/private/tmp`、`/etc` → `/private/etc` (置き場の外になるので試していない。`/var` と同じ扱いかは未確認)
- deny / ask の rule (範囲外)
- 過去 (2026-11-08) に「`~/` は効かない」と観測した時の配置と原因
