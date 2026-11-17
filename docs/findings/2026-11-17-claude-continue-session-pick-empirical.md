# `claude --continue` はどのセッションを選ぶか (実測)

- Date: 2026-11-17
- 対象: Claude Code 2.1.326
- 動機: 起動スクリプトはセッションごとの一時ディレクトリを起動前に決めたい。`--session-id` の新規と id の分かる resume は決められるが、`--continue` は続くセッションの id が起動前に分からない。daemon も `continue` の起動ではセッションを特定できない ([DR-0018](../decisions/DR-0018-session-launcher.md) §3.2、[launch-command](../design/launch-command.md))。起動前に外から `--continue` が選ぶ id を言い当てる手順が要る
- 方法: 一時ディレクトリに試験用の config dir と cwd を置き、`env -i` で `PATH` / `TERM` / `HOME` / `TMPDIR` / `CLAUDE_CONFIG_DIR` と、127.0.0.1 の Messages API の代役 (固定の応答を返す小さい HTTP サーバ) に向けた `ANTHROPIC_BASE_URL`、作り物の `ANTHROPIC_API_KEY` だけを渡して `claude` を起動した。まず代役を相手に `-p` と対話で本物のセッションを作り (`-p` 4 本、subagent を 1 つ起こしたもの、`-n` で名前を付けたもの、`--fork-session` で作ったもの、対話 1 本、git の repo と worktree で 1 本ずつ)、その行を写して sid・mtime・行の中身を変えた配置を、配置ごとに新しい config dir に置いた。`-p` は `-p --continue --output-format json` の `session_id` と、どのファイルに行が足されたかで判定した。対話は private な tmux の中で `claude --continue <prompt>` を起動し、prompt がどのファイルに書かれたか (または `No conversation found to continue` で終わったか) で判定した。対話のターンの終わりは config dir の settings.json に置いた Stop hook が tmux の wait-for に知らせ、`/exit` で閉じた
- 下の「`<config dir>`」は試験用の config dir、「`<cwd>`」は `claude` を起動したディレクトリ、「slug」は `projects/` の下のディレクトリ名

## 判明した事実

### 候補の集め方

- **候補は `<config dir>/projects/<slug>/` の直下にある、名前が UUID の `.jsonl` だけ**。`notauuid.jsonl` のような名前は候補にならない。`<sid>/subagents/agent-*.jsonl` も候補にならず、その mtime は親のセッションの順位も上げない
- **slug は realpath した cwd から作る**。英数字 (`[A-Za-z0-9]`) 以外を 1 文字ずつ `-` に置き換える。数え方は UTF-16 の code unit 単位で、`ユニ` は `--`、`😀` は `--` になる。200 文字を超えると先頭 200 文字 + `-` + cwd の文字列の Java 式 hash (`h = h*31 + code unit` の 32 bit、絶対値) の 36 進
- **symlink 経由で起動しても `$PWD` (論理パス) は使わない**。新しいセッションは realpath の slug に作られ、`--continue` も realpath の slug を見る。`$PWD` の末尾の `/` も効かない
- **サブディレクトリ・親ディレクトリ・git の worktree のセッションは拾わない**。`<cwd>/sub` からは `<cwd>` のセッションを、`<cwd>` からは `<cwd>/sub` のセッションを、worktree からは本体の、本体からは worktree のセッションを選ばなかった
- **行の `cwd` は、自分の slug のディレクトリの中では順番にも可否にもほぼ効かない**。`/tmp/elsewhere` のような slug の違う cwd が書かれていても選ばれた。例外は、書かれた cwd が「実在する別のディレクトリで、slug が同じもの」(例: `<cwd>` が `x/proj/a` で行の cwd が `x/proj-a`) の時で、そのファイルは飛ばされる
- **自分の slug のディレクトリに候補の UUID ファイルが 1 つも無い (ディレクトリが無い、空、UUID でない名前だけ) か、全部が上の「slug が同じ別のディレクトリ」のものだと、`projects/` の他の全部のディレクトリを探す**。あるディレクトリの最も新しい UUID ファイルの先頭 64 KiB で最初に出る `"cwd":"..."` が realpath の cwd と文字列で一致すれば、そのディレクトリの UUID ファイルが全部候補になる (cwd の違うファイルも含めて)。一致しない (末尾の `/`、`/private` の無い形、親・子のパス、最初の cwd が 64 KiB より後ろ) ディレクトリは候補を出さない。続けた行は、見つかった元のディレクトリのファイルに足される。この探索が起きた cwd はどれも `.` を含んでいた (試験の置き場のパスに `.` が入るため)。cwd が英数字と `/` `\` `:` `-` だけの時に探索が起きないかは未確認

### 「最も新しい」の基準

- **ファイルの mtime の降順**。mtime の順と行の `timestamp` の順を逆にした 2 本では、両方向とも mtime の新しい方が選ばれた。mtime を未来 (2030 年) にしたファイルも選ばれた。ctime・ファイル名・行の中身の時刻は効かない
- **mtime が同じなら birthtime の新しい方**。名前の大小を入れ替えた 2 通りで、どちらも後から作った方が選ばれた
- `sessions/<pid>.json` は順番に効かない (候補を置いただけの config dir では空)

### 除外されるもの

新しい順に 1 つずつ見て、次のものを飛ばし、最初に残ったものを選ぶ。判定は行の JSON の解釈ではなく、ファイルの文字列で行われる (壊れた行も読み飛ばされず、文字列が合えば効く)。

| 飛ばされる条件 | 見る範囲 | `-p` | 対話 |
|---|---|---|---|
| `"isSidechain":true` が含まれる (どの行でも) | 先頭 64 KiB | 飛ばす | 飛ばす |
| `"teamName":"<空でない値>"` | 先頭 64 KiB | 飛ばす | 飛ばす |
| `"parentUuid":` を含む最初の行の `sessionKind` が `daemon` | 先頭 64 KiB | 飛ばす | 飛ばす |
| `"parentUuid":` が 1 つも無い (メタデータの行だけ・`{}`・改行だけ・ゴミだけ) | 先頭 16 MiB。16 MiB を超えるファイルは、無くても飛ばさない | 飛ばす | 飛ばす |
| 末尾に `"type":"continued-in"` の行があり、その `continuedInSessionId` のファイルが同じディレクトリにあって会話の行を持つ | 末尾 64 KiB | 飛ばす | 飛ばす |
| 最初に出る `"entrypoint":"..."` が `sdk-cli` / `sdk-ts` / `sdk-py` (= `-p` や SDK で作ったセッション) | 先頭 64 KiB | 飛ばさない | 飛ばす |
| 最初の user 行の内容が `<command-name>/loop</command-name>` | 先頭 64 KiB | 飛ばさない | 飛ばす |

飛ばされないもの:

- **0 バイトのファイル** (`-p` でも対話でも選ばれ、空の履歴にその id のまま続ける)。改行 1 つだけのファイルは飛ばされる
- **今動いているセッション** (`-p` で応答待ちのもの、対話で応答待ちのもの)。2 つ目のプロセスが同じ id で同じファイルに書き足し、`sessions/` に同じ `sessionId` の `<pid>.json` が 2 つ並んだ
- user 行が無いファイル、assistant 行が無いファイル、attachment 行だけのファイル、行の `sessionId` がファイル名と違うファイル (続いた後の id はファイル名の方)、末尾や先頭に壊れた行があるファイル
- `-n` で名前を付けたセッション、`--fork-session` で作ったセッション、subagent を起こしたセッション
- `entrypoint` が `cli` / `claude-vscode` / `mcp` のセッション、`entrypoint` の無いセッション
- 先頭 64 KiB より後ろにだけ `"isSidechain":true` / `"entrypoint":"sdk-cli"` があるファイル (対話でも選ばれた)

### 対話と `-p` の違い

- **対話の `--continue` は `-p` で作ったセッションを選ばない**。`-p` で作ったセッションの行の `entrypoint` は `sdk-cli`、対話で作ったものは `cli`。`entrypoint` を書き換えると扱いも入れ替わった (`sdk-cli` → `cli` で対話が選ぶ、`cli` → `sdk-cli` で選ばない)
- **候補が尽きた時**、`-p` は新しい id のセッションを始め (exit 0)、対話は `No conversation found to continue` で終わる (exit 1)
- `--continue --fork-session` の fork 元は、`-p` でも対話でも、それぞれの `--continue` と同じ決まりで選ばれた (メタデータだけの最新ファイルを飛ばす、mtime の順、他のディレクトリの探索、対話は `-p` のセッションを飛ばす)。fork の新しいファイルは realpath の slug に作られる

### 続けた後の id

- **fork でない `--continue` の id は、選ばれたファイルの名前の id と同じ**。そのファイルに行が足され、新しいファイルは作られない
- **`--continue --session-id <uuid>` (fork なし) は起動しない**: `Error: --session-id with --continue or --resume also needs --fork-session.` (exit 1)。`--continue --fork-session --session-id <uuid>` は通り、新しいセッションの id は `<uuid>`
- **`--resume <選ばれる id>` は `--continue` と同じ結果になった** (`-p` と対話で各 1 配置): 同じ id、同じファイル、足された行の種類・`cwd`・`parentUuid` の繋がりも同じ。ただし `--resume <id>` は cwd に関係なく `projects/` の全部のディレクトリから id で探す (cwd の違うディレクトリにあるファイルも開いて続けた)。メタデータの行だけのファイルの id は `No conversation found with session ID: <id>` (exit 1) で断られる

## 実用的な示唆

- 起動前に外から `--continue` の選ぶ id を言い当てられる。決まりは上の通りで、下の手順 (bash) は試した配置の全部で実際の選択と一致した (検証の詳細)
- 言い当てた id で `--continue` の代わりに `--resume <id>` で起動すれば、言い当てと実際の食い違いは起きない (`-p` と対話の両方で、同じセッションに同じ形の行が足されることを確かめた。各 1 配置)。外れた時に `--resume` だと別のセッションを開くか断られるだけで、`--continue` の選んだものと違うセッションに一時ディレクトリを割り当てる事故は起きない
- 対話と `-p` で選ばれるものが違う。起動スクリプトが対話で `--continue` するなら、`-p` で作ったセッション (`entrypoint` が `sdk-*`) を候補から外して言い当てる
- 候補が無い時は `-p` だと新規、対話だとエラー。言い当ての結果が「無い」なら、`-p` は新規のセッション (`--session-id` で id を決めて起動できる)、対話はそもそも起動に失敗する
- 今動いているセッションも選ばれる。同じ id のプロセスが 2 つになるので、起動スクリプトが「動いている id」を避けたいなら、言い当てた id を `sessions/*.json` の `sessionId` と突き合わせて自分で止める

### 言い当てる手順

`pick.sh <config dir> <print|interactive> [cwd]`。選ばれる id を出す。候補が無ければ `-p` は `NEW`、対話は `NONE`。slug の計算に bun を使う (JS の文字列の code unit 単位で数えるため)。macOS の `/usr/bin/stat` を使う。

```bash
#!/bin/bash
set -u
cfg=$1 mode=$2
cwd=$(cd "${3:-.}" && pwd -P)
K=65536
# slug: each UTF-16 code unit outside [A-Za-z0-9] becomes "-"; over 200 -> first 200 + "-" + base36(|java hash|)
slug() { bun -e '
  const s = process.argv[1]; const r = s.replace(/[^a-zA-Z0-9]/g, "-");
  if (r.length <= 200) { console.log(r); process.exit(0); }
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  console.log(r.slice(0, 200) + "-" + Math.abs(h).toString(36));' "$1"; }
me=$(slug "$cwd")
uuidre='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.jsonl$'
# list <dir>...: "<mtime> <birthtime> <path>" of top-level <uuid>.jsonl, newest mtime first, then newest birthtime
list() { for d in "$@"; do [ -d "$d" ] || continue; ls -1 "$d" | grep -E "$uuidre" | while read -r n; do
  /usr/bin/stat -f '%Fm %FB %N' "$d/$n"; done; done | sort -k1,1gr -k2,2gr; }
head64() { head -c $K "$1"; }
firstval() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed "s/^\"$1\":\"//; s/\"\$//"; }
reccwd() { head64 "$1" | firstval cwd; }
# foreign: the recorded cwd is another existing directory whose slug is the same as this cwd's
foreign() { r=$(reccwd "$1"); [ -n "$r" ] && [ "$r" != "$cwd" ] && [ -d "$r" ] && [ "$(slug "$(cd "$r" && pwd -P)")" = "$me" ]; }
logs=$(list "$cfg/projects/$me")
allforeign=1; while read -r _ _ f; do [ -n "$f" ] && ! foreign "$f" && allforeign=0; done <<< "$logs"
if [ $allforeign = 1 ] && printf '%s' "$cwd" | grep -q '[^A-Za-z0-9/\\:-]'; then
  # every project dir whose newest log records this cwd contributes all of its logs
  logs=$(for d in "$cfg"/projects/*/; do d=${d%/}; [ "$(basename "$d")" = "$me" ] && continue
    n=$(list "$d" | head -1 | cut -d' ' -f3-); [ -n "$n" ] && [ "$(reccwd "$n")" = "$cwd" ] && list "$d"; done | sort -k1,1gr -k2,2gr)
fi
while read -r _ _ f; do
  [ -n "$f" ] || continue
  if [ -s "$f" ]; then
    h=$(head64 "$f")
    foreign "$f" && continue
    grep -q '"isSidechain":true' <<< "$h" && continue
    [ -n "$(firstval teamName <<< "$h")" ] && continue
    k=$(grep -m1 '"parentUuid":' <<< "$h" | firstval sessionKind); case "$k" in daemon|daemon-worker) continue;; esac
    if [ "$mode" = interactive ]; then
      case "$(firstval entrypoint <<< "$h")" in sdk-cli|sdk-ts|sdk-py) continue;; esac
      grep '"type":"user"' <<< "$h" | grep -v tool_result | head -1 | grep -q '<command-name>/loop</command-name>' && continue
    fi
    # no conversation rows ("parentUuid":) in the first 16 MiB -> skipped, unless the file is larger than that
    [ "$(/usr/bin/stat -f %z "$f")" -gt 16777216 ] || head -c 16777216 "$f" | grep -q '"parentUuid":' || continue
    ci=$(tail -c $K "$f" | grep '"type":"continued-in"' | tail -1 | firstval continuedInSessionId)
    [ -n "$ci" ] && [ -f "$(dirname "$f")/$ci.jsonl" ] && grep -q '"parentUuid":' "$(dirname "$f")/$ci.jsonl" && continue
  fi
  basename "$f" .jsonl; exit 0
done <<< "$logs"
[ "$mode" = interactive ] && echo NONE || echo NEW
```

### 外からは決めきれないもの

- `--bg` で起動した裏のセッション (`sessions/<pid>.json` の `kind` が `interactive` でないもの) が今動いている時の扱い、`continued-in` の先が今動いている裏のセッションの時の扱い。`-p` で起動したプロセスの `sessions/<pid>.json` も `kind` は `interactive` だった。未確認
- 言い当ててから起動するまでの間に、別のセッションがファイルに書き足して mtime が変わる競合。言い当てと起動の間で順番が変わりうる (`--resume <id>` で起動すれば起きない)
- 次は試していない (コードを読んだ別の調査が挙げたもの): `sessionKind` が `daemon-worker`、`type: "relocated"` の行 (cwd の付け替え)、`.session-aliases`、`archived.json`、`CLAUDE_CODE_PROJECT_DIR_NAME`、cwd が英数字と `/` `\` `:` `-` だけの時に他のディレクトリを探さないこと、UUID のファイル名の大文字
- `--resume` の一覧 (picker) の並びは見ていない

## 検証の詳細

### 本物の行の形

- `-p` で作ったセッションの行: `queue-operation` ×2、`user` (`parentUuid: null`、`isSidechain: false`、`entrypoint: "sdk-cli"`、`cwd` は realpath)、`attachment` 数行、`atis-latch`、`api-request-shape` / `api-request-blob` / `api-request`、`assistant`、`last-prompt`、`cost-state`。1 ターンで 22 行、約 136 KB
- 対話で作ったセッションは `mode` / `permission-mode` / `file-history-snapshot` の行で始まり、`entrypoint: "cli"`
- `-n` は `custom-title` と `agent-name` の行を足す。`--fork-session` で作ったものは元の `user` / `assistant` 行を写す (`forkedFrom` のような印は無い)
- subagent の行は `<sid>/subagents/agent-<id>.jsonl` に `isSidechain: true`、`sessionId` は親の id で書かれ、隣に `agent-<id>.meta.json` が置かれる
- 対話で起動して何も打たずに `/exit` すると、transcript のファイルは作られない (`sessions/<pid>.json` は起動中だけある)

### 順番 (`-p`)

基準は S1 (mtime 00:01)。各行は新しい config dir。

| 配置 | 選ばれたもの |
|---|---|
| S1, S2, S3 を作った順に mtime 00:01 / 00:02 / 00:03 | S3 (行が足された、id は S3 のまま) |
| S1 の mtime 00:03 (中身は最も古い)、S3 の mtime 00:01 (中身は最も新しい) | S1 |
| 上の逆 | S3 |
| S1 の mtime を 2030 年に | S1 |
| 同じ mtime (2030 年)、後から作った方 = 名前 `0000…` | `0000…` |
| 同じ mtime (2030 年)、後から作った方 = 名前 `ffff…` | `ffff…` |

mtime を作成時刻より前にすると macOS では birthtime も同じ時刻に下がり、両方が同点になる。その時は名前 `ffff…` の方が選ばれた (2/2)。この同点の扱いは決まりとしては扱わない。

### 除外 (`-p`、最新に罠のファイル、S1 は mtime 00:01)

| 罠のファイル (mtime 00:05) | 選ばれたもの |
|---|---|
| 0 バイト | 罠 (空の履歴でその id のまま続く) |
| 改行 1 つ / 空白 1 つ / `{}` / ゴミの行だけ | S1 |
| `uuid` の無い行だけ (queue-operation、last-prompt、cost-state、custom-title、api-request 系) | S1 |
| user 行を抜いたもの / assistant 行を抜いたもの / attachment 行だけ / attachment 行 1 つ | 罠 |
| user 行 1 つ / assistant 行 1 つ / `uuid` を消した user 行 1 つ | 罠 |
| `parentUuid` を消した user 行 1 つ | S1 |
| `{"parentUuid":null}` / `{"type":"user","parentUuid":null}` / 壊れた行 `xx "parentUuid":null yy` | 罠 |
| `{"type":"last-prompt","x":"parentUuid"}` / `"parentUuid" : null` (空白入り) | S1 |
| `{"type":"user"}` / `type`・`sessionId`・`uuid`・`message` を組み合わせた `parentUuid` の無い行 | S1 |
| user 行の `isSidechain` を true に | S1 |
| user 行から `isSidechain` を消したもの | 罠 |
| 非 sidechain の user 行の後に sidechain の行 (小さいファイル) | S1 |
| 1 MB のファイルの中ほど (先頭から 480 KB) に sidechain の行 | 罠 |
| `"isSidechain":true` を先頭から 48 KB / 58 KB に | S1 |
| `"isSidechain":true` を先頭から 67 KB / 77 KB / 115 KB に | 罠 |
| `"isSidechain":true` を末尾から 0〜115 KB に (先頭からは 382 KB 以降) | 罠 |
| `"parentUuid":` が 1 MB / 2 MB のファイルの中ほどにだけ (ゴミの行でも) | 罠 |
| `"parentUuid":` の無いメタデータの行だけで 1 MB / 9.5 MB / 16.67 MB | S1 |
| `"parentUuid":` の無いメタデータの行だけで 16.81 MB / 17.33 MB | 罠 |
| `"parentUuid":` が 17.0 MB の位置にだけ (17.3 MB のファイル) | 罠 |
| UUID でない名前 `notauuid.jsonl` | S1 |
| subagent の行をトップに `<uuid>.jsonl` として置いたもの | S1 |
| 行の `sessionId` がファイル名と違うもの | 罠 (続いた id はファイル名) |
| user 行の `cwd` を `/tmp/elsewhere` に / `cwd` を消したもの | 罠 |
| user 行の `cwd` を、実在する別のディレクトリで slug が同じもの (`x/proj-a`) に | S1 |
| user 行に `teamName` | S1 |
| user 行に `sessionKind: "daemon"` | S1 |
| 末尾に `continued-in` の行 (先は同じディレクトリの会話のあるセッション) | 罠を飛ばし、次に新しいもの |
| `-n` で名前を付けたセッション / `--fork-session` で作ったセッション | 罠 |
| `timestamp`・`gitBranch`・`entrypoint`・`version`・`userType`・`message`・`sessionId`・`promptId` を user 行から消したもの | 罠 |
| `<sid>/subagents/` だけ最も新しい (親のファイルは無い、または親の mtime は S1 より古い) | S1 |
| 親 (Agent の tool_use を持つ) のファイルが最も新しい | 親 |

### 候補のディレクトリ (`-p`)

| 配置 | 起動した cwd | 選ばれたもの |
|---|---|---|
| realpath の slug に S1 | symlink (`$PWD` は論理パス) | S1 |
| 論理パスの slug にだけ S1 (行の cwd は realpath) | symlink (`$PWD` は論理パス) | S1 (他のディレクトリの探索で見つかる。論理パスだから見つかったのではない) |
| realpath の slug に S1 (古い)、論理パスの slug に S2 (新しい) | symlink (`$PWD` あり / なし) | S1 |
| 無関係な名前のディレクトリにだけ S1 (行の cwd は realpath) | `<cwd>` | S1 (そのファイルに足された) |
| 同上、行の cwd が `/tmp/elsewhere` / 論理パス / 末尾 `/` / `/private` の無い形 / 子 / 親 | `<cwd>` | 新規 |
| 無関係な 2 つのディレクトリに S1 と S2 | `<cwd>` | mtime の新しい方 (2/2) |
| 自分の slug は空のディレクトリ、無関係なディレクトリに S1 | `<cwd>` | S1 |
| 自分の slug に UUID でない名前のファイルだけ / subagents だけ | `<cwd>` | 無関係なディレクトリの S1 |
| 自分の slug にメタデータだけのファイル / sidechain のファイル、無関係なディレクトリに S1 | `<cwd>` | 新規 (探索しない) |
| 自分の slug に「slug が同じ別のディレクトリ」のファイルだけ、無関係なディレクトリに I1 | `<cwd>` | I1 |
| 無関係なディレクトリの S1 の先頭に `"isSidechain":true` / `parentUuid` の無い行だけ | `<cwd>` | 新規 |
| 無関係なディレクトリの S1 の最初の cwd が先頭から 48 KB / 58 KB / 68 KB | `<cwd>` | S1 / S1 / 新規 |
| 無関係なディレクトリの 1 つに、最も新しいファイル (cwd が別) と古いファイル (cwd が一致) | `<cwd>` | 新規 |
| 無関係なディレクトリ U1 に、最も新しいファイル (cwd 一致、sidechain で飛ぶ) と次のファイル (cwd が別)、U2 に cwd 一致の古いファイル | `<cwd>` | U1 の cwd が別のファイル |
| 無関係なディレクトリの深い所 (`U1/deep/`) にだけ S1 | `<cwd>` | 新規 |
| 本体のディレクトリにだけ G | worktree | 新規 |
| worktree に GW (古い)、本体に G (新しい) | worktree / 本体 | GW / G |
| `<cwd>` にだけ S1 | `<cwd>/sub` | 新規 |
| `<cwd>/sub` にだけ SSUB | `<cwd>` | 新規 |

slug の形の確認: `we.ird_name dir` → `we-ird-name-dir`、`ユニ` → `--`、`e😀x` → `e--x`、230 文字の名前 → 200 文字 + `-nmc03v` (cwd の文字列の Java 式 hash の 36 進と一致)。

### 対話

| 配置 | 選ばれたもの |
|---|---|
| 対話で作った I1 だけ | I1 |
| I1 (古い)、`-p` の S2 (新しい) | I1 (`-p` は同じ配置で S2) |
| `-p` の S2 だけ / `-p` の S1, S2 とメタデータだけのファイル | `No conversation found to continue` (exit 1) |
| S2 の `entrypoint` を `cli` に | S2 |
| S2 から `entrypoint` を消したもの | S2 |
| I1 の `entrypoint` を `sdk-cli` / `sdk-ts` / `sdk-py` に | No conversation |
| I1 の `entrypoint` を `claude-vscode` / `mcp` に | I1 |
| I1 の先頭に `{"type":"last-prompt","entrypoint":"sdk-cli"}` | No conversation |
| I1 の user 行の後 (先頭 64 KiB の中) に同じ行 | I1 (最初の `entrypoint` が `cli`) |
| I1 の後ろ (先頭から 64 KiB より後) に同じ行 | I1 |
| 無関係なディレクトリにだけ `-p` の S2 / 対話の I1 | No conversation / I1 |
| I1 (古い) と最も新しい 0 バイトのファイル | 0 バイトのファイル |
| I1 (古い) と、別の対話のプロセスが応答待ちで掴んでいるセッション (最も新しい) | 応答待ちのセッション |
| `--fork-session`: I1 (古い)、`-p` の S2 (新しい) | I1 から fork した新しい id |

### `-p` の `--continue --fork-session` と `--session-id`

| 引数 | 結果 |
|---|---|
| `--continue --fork-session` (S1 とメタデータだけの最新ファイル) | S1 の履歴を写した新しい id |
| `--continue --fork-session` (S1 の mtime が新しく、S3 の中身が新しい) | S1 から fork |
| `--continue --fork-session` (自分の slug は無し、無関係なディレクトリに S1) | S1 から fork、新しいファイルは realpath の slug |
| `--continue --session-id <uuid>` | exit 1、`Error: --session-id with --continue or --resume also needs --fork-session.` |
| `--continue --fork-session --session-id <uuid>` | exit 0、id は `<uuid>` |

### `--resume <id>` との比較

| 配置 | 引数 | 結果 |
|---|---|---|
| S1 | `--continue` / `--resume S1` | 同じ id、同じファイル、足された 8 行の種類・`cwd`・`parentUuid` の繋がりが同じ |
| 無関係なディレクトリに S1 (行の cwd は realpath) | `--resume S1` | S1、そのファイルに足された |
| 無関係なディレクトリに S1 (行の cwd は `/tmp/else`) | `--resume S1` | S1 (`--continue` は新規) |
| メタデータだけのファイル | `--resume <その id>` | exit 1、`No conversation found with session ID: <id>` |
| 対話で作った I1 | `-p --resume I1` | I1 |
| 対話で作った I1 (対話で起動) | `--continue` / `--resume I1` | 同じ id、同じファイル、足された行の種類・`cwd`・`parentUuid` の有無が同じ |

### 言い当ての突き合わせ

上の決まりから、次の配置を新しい config dir に組み、起動前に手順を走らせてから実際に `--continue` を起動した。`-p` と対話で別々に組んだ (`-p` の起動はファイルに書き足すため)。

配置: L01 3 本を順に / L02 mtime と中身の時刻が逆 / L03 メタデータだけが最新 / L04 0 バイトが最新 / L05 先頭に sidechain / L06 1 MB の中ほどに sidechain / L07 `parentUuid` 無しが最新 / L08 `-p` が最新、対話が古い / L09 対話が最新、`-p` が古い / L10 自分の slug 無し、無関係な 3 ディレクトリ (cwd 一致 2、不一致が最新) / L11 自分の slug にメタデータだけ + 無関係なディレクトリ / L12 自分の slug に UUID でない名前だけ + 無関係なディレクトリ / L13 subagents が最新 / L14 何も無い / L15 先頭 64 KiB より後に `sdk-cli` / L16 ゴミの行の `parentUuid` が中ほどに / L17 無関係なディレクトリの最初の cwd が 64 KiB より後 / L18 `claude-vscode` / L19d・L19e 同じ mtime で birthtime 違い / L20 `teamName` / L21 `sessionKind: daemon` / L22 `/loop` / L23 `continued-in` / L24 slug が同じ別のディレクトリの cwd / L25 そのファイルだけ + 無関係なディレクトリ / L26 無関係なディレクトリの最新が cwd 不一致 / L27b 無関係なディレクトリの最新が cwd 一致だが飛ぶ / L28b `parentUuid` が 17 MB の位置にだけ / L29 メタデータだけで 17.3 MB / L30 同 9.5 MB / L31 同 16.67 MB / L32 同 16.81 MB

| 予想 | `-p` | 対話 |
|---|---|---|
| この手順 | 33 / 33 | 33 / 33 |
| コードを読んだ別の調査の予想 (python) | 30 / 33 | 30 / 33 |

別の調査の予想が外れたのは両方の起動とも L28b・L29・L32 の 3 つで、どれも 16 MiB を超えるファイル。その予想は「先頭 16 MiB に `"parentUuid":` が無ければ飛ばす」だが、実際は 16 MiB を超えるファイルは `"parentUuid":` が無くても選ばれた (16.67 MB は飛ばされ、16.81 MB は選ばれた)。この 3 つの対話は、Stop hook の時点では prompt がまだファイルに無く、判定の仕掛けが選ばれたファイルを拾えなかった。後からファイルを調べ、prompt がこの手順の予想したファイルに書かれていたことで判定した。

この手順は途中で 2 回直した。最初の版 (候補のディレクトリの探索をファイルごとの cwd で行い、同点を名前で決め、`teamName` 等を見ない) は L19e・L20・L21・L23〜L26・L27b で外れた。それらの配置は、別の調査の予想と実際の選択を突き合わせるために足したもので、外れ方から決まりを直した。

対話の配置の多くは `-p` で作ったセッションから組んだので、対話では `No conversation` になるものが多い (L20・L21・L24 などは対話では決まりを分けない)。
