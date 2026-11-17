# `claude --continue` がどのセッションを選ぶか (配布物のコードから)

- Date: 2026-11-17
- 対象: Claude Code 2.1.326 (`claude --version` = `2.1.326 (Claude Code)`)
- 動機: 起動スクリプトはセッションごとの一時ディレクトリを起動前に決めたい。新規 (`--session-id`) と resume は id が先に分かるが、`--continue` はどの id が続くかが起動前に分からない。daemon も `continue` の時にセッションを特定できない。起動前に外から同じ id を言い当てる手順を得るため、選び方の決まりをコードで確かめる
- 方法: 読み取りのみ。`claude` は起動していない (`--version` を除く)。実機で起動して選ばれ方を測るのは別の作業が担当している

## 配布物の形

- `claude` は `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.326` の symlink。実体は Mach-O arm64 の単一実行ファイル (353,037,664 バイト)。bun の `--compile --bytecode` で作られたもので、JS は `__BUN,__bun` セクション (ファイル内オフセット 129,744,896、大きさ 0xd3f4163) にチャンクごとの平文として入っている。各チャンクの先頭は `// @bun @bytecode` と `// Version: 2.1.326`
- セクションを `dd` で抜き出し、NUL 区切りのチャンクを文字列の literal から辿って読んだ。以下の「位置」は **`__bun` セクション先頭からのバイト位置** (ファイル内の位置はこれに 129,744,896 を足す)
- minify されており、関数名はチャンクをまたいで衝突する (同じ `Cy` が別チャンクでは yoga のレイアウト関数)。import 文と export 文で名前を解決してから定義を読んだ

## 判明した事実

### 1. 入口から「1 つ選ぶ」関数まで

- `-c, --continue` の定義は 175226477 (`"Continue the most recent conversation in the current directory"`)
- 対話の起動は 175384702 の `if(e.continue){...}`、print (`-p`) は 196983339 の `if(a.continue)try{l("tengu_continue_print",...)`。**どちらも同じ `S0e(void 0, void 0, {...})` を呼び**、第 1 引数が `undefined` の時に `zNs` (165493339) が候補を 1 つ選ぶ。`claude --desktop --continue` (197029904) も同じ `zNs` を使う
- 対話の起動の抜粋 (175384702):

```js
lo=await S0e(void 0,void 0,{forkSession:!!e.forkSession,...,onNewestRunningInBackground:(so)=>{Ce=so},onOnlyArchived:(so)=>{Ze=qhr(so)},...});
if(!lo)return ...,await me(j,Ce===void 0?Ze??"No conversation found to continue":nzt(Ce));
```

- 経路の違いは 2 つ: print は `--sdk-url` がある時だけ `acceptCustomIds:!0` を渡す。もう 1 つは後述の entrypoint の除外で、自分の entrypoint が `sdk-*` かどうかで変わる

### 2. 候補の集め方

- 候補の一覧は `VBs` (163784466):

```js
let r=Te(),a=await Cbi(r,ov(y1(n)))??Cy(r),[h,y]=await Promise.all([Fit(a,e,r,n),YQe(r,n)]),k=h;
```

- **cwd**: `Te()` (152212572) は `originalCwd`。既定値は `i0i()` (151954288) で、`realpathSync(process.cwd())` を NFC に正規化したもの (`/` だけは realpath しない)。**symlink は解決される**。`$PWD` は使わない
- **config dir**: `Ye()` (152271741) = `CLAUDE_CONFIG_DIR ?? ~/.claude` を NFC にしたもの。projects は `<config dir>/projects`
- **ディレクトリ名 (slug)**: `nH` (155424630 付近):

```js
var INe=200;function Oe(e){return Math.abs($Q(e)).toString(36)}function k(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
function nH(e){let n=k(e);if(n.length<=INe)return n;return`${n.slice(0,INe)}-${Oe(e)}`}
```

  - 英数字以外を 1 文字ずつ `-` にする。`u` フラグの無い正規表現なので **UTF-16 のコード単位ごと** (日本語 1 文字 = `-` 1 個、絵文字 = `--`)
  - 置き換え後が 200 を超えたら先頭 200 + `-` + hash。hash の `$Q` (152375669) は Java の `hashCode` と同じ式 (`e=(e<<5)-e+t.charCodeAt(n)|0`) を **置き換え前の cwd** にかけ、絶対値を 36 進にしたもの
- **slug の上書き**: `pD(e){return $mr()??nH(e)}` (155425507)。`$mr` (152272205) は `CLAUDE_CONFIG_DIR` が空でない (または diskless) 時だけ `CLAUDE_CODE_PROJECT_DIR_NAME` を採る。値は `/^[A-Za-z0-9_-]{1,64}$/` で、`con` / `nul` 等の予約名でないこと
- **どのディレクトリを使うか**: `Cbi` = `RVe(...)[0]` (155427146)。`<projects>/<pD(cwd)>` が在ればそれ。上書きがあって在らず、上書き前の `nH` のディレクトリが在れば、そちらを使う。slug が 200 を超える時は先頭 200 + `-` で始まるディレクトリを読み (`hdr` で同じ cwd のものか確かめる)、最初の 1 つを使う。どれも無ければ `Cy(cwd)` (157512822、`<projects>/<pD(cwd)>`) で、ファイルが無いので候補は 0
- **ファイルの拾い方**: `O3n` (163887348)。そのディレクトリの直下で、`isFile()` (symlink は外れる) で `.jsonl` で終わり、拡張子を除いた名前が UUID (`/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i`) のものだけ。`<id>/subagents/` 等のサブディレクトリは見ない
- **足される候補**
  - `<projects>/<pD(cwd)>/.session-aliases` (`YQe`、163661024) の各行をディレクトリとして読んで足す
  - cwd に `[^a-zA-Z0-9/\\:-]` (`.` や `_` 等) が含まれ、かつ自分のディレクトリの候補が「全部、同じ slug の別ディレクトリのもの」の時 (**候補が 0 の時も含む**。`Uve` は空の一覧で true を返す)、一覧を `HQe` (163875326) の結果で**置き換える**。`HQe` は projects の全ディレクトリについて最も新しいファイルの記録された cwd を読み、それが今の cwd と一致するディレクトリのファイルを集める
- **git worktree・親ディレクトリのセッションは `--continue` の候補に入らない**。worktree を足す処理 (`den`、163871519) は `--resume` の一覧の側にだけある

### 3. 「最も新しい」の基準

- **ファイルの mtime (stat、ミリ秒)**。ファイル中の行の `timestamp` ではない。`O3n` が `mtime:N.mtime.getTime(), ctime:N.birthtime.getTime()` を取り、`Fit` (163895322) が mtime の降順に並べ、`MPe` (152389127) で同点を birthtime の降順で並べる:

```js
function MPe(t){return t.sort((e,r)=>{let s=r.modified.getTime()-e.modified.getTime();if(s!==0)return s;return r.created.getTime()-e.created.getTime()})}
```

- `.session-aliases` の候補がある時だけ `dae` (163895093) で同じ sessionId を 1 つにまとめる (mtime の新しい方)
- 選ぶのは `p2s` (163869947): この順に 1 つずつ読み、条件 (4.) を満たす最初のものを返す。読んだ後に `modified` が「最後のメッセージの時刻と mtime の小さい方」に置き換わる (`Ten` 内) が、`--continue` の順番は置き換え前の mtime の順で決まっている
- mtime も birthtime もミリ秒まで同じ時の順は、stat の Promise が解決した順に Map へ入った順 (`Promise.all` の中で `a.set`) で、外からは決まらない

### 4. 除外・フィルタ

各候補は `bJe` (163889607) が **先頭 64KiB と末尾 64KiB** (`Bk=65536`、`Xxn`) だけを読んで判定する。除かれる条件を、判定する場所ごとに挙げる。

`Ten` (163895892) で除くもの:

- 記録された cwd (末尾の `relocated` 行の `relocatedCwd`、無ければ先頭で最初に `"cwd":` を持つ行の `cwd`) が、今の cwd と slug は同じ (大文字小文字を無視) で別のパスを指し、その realpath も今の cwd と違う (`Bes`)。記録された cwd が今は無ければ除かない
- 先頭に `"isSidechain":true`
- 先頭に `"teamName":"..."`
- `sessionKind` (先頭で最初に `"parentUuid":` を含む行から読む) が `daemon` / `daemon-worker`
- `entrypoint` (先頭で最初のもの、無ければ末尾) が `sdk-cli` / `sdk-ts` / `sdk-py`。ただし自分の `CLAUDE_CODE_ENTRYPOINT` もこのどれかなら除かない (`udr`、155413057)
- `/loop` のセッション (先頭の最初の本物の user 行が `<command-name>/loop</command-name>` を含む)。上と同じ例外がある

`zNs` の条件 (165493339) で除くもの:

- `bookkeepingOnly`: 先頭と末尾に `"parentUuid":` が無い (`Bqn`、161565229。64KiB を超えるファイルは先頭から 16MiB まで探す)。summary だけ・メタデータだけのファイルはこれで除かれる
- `superseded`: 末尾の `continued-in` 行 (`xBr`) の移り先 `<同じディレクトリ>/<移り先 id>.jsonl` が在り、メッセージの行を持つ
- `archived` (`<projectdir>/<id>/archived.json` の `{archived:true, at}`。`aFo`、161560142): サーバの feature flag `tengu_tender_wren` (`vjt`) が on の時だけ読まれる。mtime が `at` 以下ならそもそも読まずに除き、`at` より後の user 行が無ければ除く
- 今動いている **対話でない** セッション (`<config dir>/sessions/<pid>.json` の `kind` が `interactive` 以外で、そのプロセスが生きているもの) の id

`zNs` は次の場合に選ぶのをやめて `null` を返す (エラーになる):

- fork でない時、`continued-in` の移り先が今動いている対話でないセッションなら、そこで選ぶのをやめる。`Your most recent conversation is running in the background (session ...)` が出る (`nzt`、161564398 付近)

どれにも当たらなければ選ばれる:

- 抜粋:

```js
if(_e.bookkeepingOnly)return!1;if(!n&&_e.continuedInSessionId!==void 0&&y?.has(_e.continuedInSessionId))return r?.({...}),N=!0,"stop";
if(_e.superseded)return!1;if(_e.archived)return E.push(_e),!1;if(N=!0,n)return!0;let ke=fg(_e);if(ke!==void 0&&y?.has(ke))return!1;
if(y===void 0&&(_e.sessionKind||_e.continuedInSessionId!==void 0))return!1;return!0
```

- `y` は動いているセッションの記録を全部読めて、どれも `kind` が `interactive` か (`kind` と `sessionId` を両方持つ) 時だけ作られる。読めない時は `sessionKind` (`bg` 等) か `continued-in` を持つ候補を全部除く
- `--fork-session` の時 (`n` が true) は、動いているセッションの除外と `continued-in` で止まる判定をしない
- **今動いている対話のセッション (`kind:"interactive"`) は除かれない**。同じ cwd で別の対話の `claude` が動いていて、そのファイルが最も新しければ、それが選ばれる (`zNs` と `S0e` の中で弾く所は無い。それより後の `Rkr` 以降は読み切れていない)
- **中身が 0 バイトのファイルは除かれない**: `bJe` は先頭が空なら `{firstPrompt:"",isSidechain:!1,bookkeepingOnly:!1}` を返す。最も新しければ選ばれうる (その後の読み込みがどうなるかは読んでいない)
- `-p` で作ったセッションは `entrypoint:"sdk-cli"` で記録される。entrypoint は `bXa` / `g` (152695476、152697777) が決める。`CLAUDE_CODE_ENTRYPOINT` が無ければ、対話でない時に `sdk-cli`、対話の時に `cli` を入れる。環境に既に値があればそれを使う (`cli` で対話でない時だけ `sdk-cli` に直す)。だから **対話の `--continue` は `-p` のセッションを飛ばし、`-p --continue` は飛ばさない**
- 版の古い形式を除く条件は見当たらなかった (読んだ範囲では、ファイル名が UUID であることだけを求める)

### 5. `--continue --fork-session` と `--session-id`

- fork 元を選ぶのも同じ `zNs`。違いは上に書いた 2 つの判定を飛ばすことだけ
- `--session-id` との組み合わせは `tl` (174800040) で検証し、174866269 で呼ぶ:

```js
function tl(e){if(!e.sessionId)return{ok:!0};if((e.continue||e.resume)&&!e.forkSession&&!e.sdkUrl)return{ok:!1,error:"Error: --session-id with --continue or --resume also needs --fork-session."};return{ok:!0}}
```

  - **`--continue --session-id X` は断られる**。`--fork-session` を付ければ通り、fork 先の id が X になる (起動時の id は `qvn` (160319817) が `--session-id` から取る)

### 6. 続けた後の id

- `S0e` は選んだファイルの sessionId (`fg(k)` = ファイル名の UUID) を `sessionId:oe` として返す。対話の側は `Rkr` (173969334) が `Edt(n.sessionIdOverride??e.sessionId,n.forkSession)` で採るかを決め、採るなら `Jb(m,"resume",...)` (152210767) で今のセッションの id をそれに切り替える
- `Edt` (158210234):

```js
function Edt(e,o,n={}){if(o)return{adoptedSessionId:null,effectiveFork:!0};if(e===void 0)return{adoptedSessionId:null,effectiveFork:!1};
if(p3r(e,n))return{adoptedSessionId:e,effectiveFork:!1};return t(`resume: ... rejected by the adoption gate; continuing as a fork under the fresh session id`),...,{adoptedSessionId:null,effectiveFork:!0}}
```

- fork でなく、id が `p3r` (`wYe`: UUID か、決まった形の名前) を通れば、**続けたセッションの id は選ばれたファイルの id と同じ**。通らなければ新しい id の fork になる。ただし `O3n` が UUID の名前のファイルしか拾わないので、`--continue` で通らない id が来る経路は見当たらない
- print の側 (196984826 付近) も `Edt(N.sessionId,!!a.forkSession,{acceptCustomIds:!!a.sdkUrl})` で同じ

### 7. `--resume` の一覧との違い

`--resume` の一覧の読み込みは `x3n` → `E9e` → `den` (163871519) → `$it` で、並べ替えは同じ `MPe`。ただし 2 つの点で `--continue` と違い、**一覧の先頭が `--continue` の選ぶものとは限らない**。

- 集める範囲が広い: git worktree のディレクトリ、`<slug>--claude-worktrees-*` のディレクトリ、aliases を足す
- 並べる時刻が違う: `Ten` で読んだ後の `modified` (= `min(最後のメッセージの時刻, mtime)`) で並べる。`--continue` は読む前の mtime の順

### 8. 選ぶはずの id を起動せずに出す手段

- 見つからなかった。オプション名 (`--dry-run` 等)、環境変数、debug の出力を探したが、`--continue` の選び方だけを走らせて id を出す経路は無い
  - debug log には除外の理由 (`Session <id> filtered from /resume: ...`) が出るが、起動しないと出ない
  - `claude --desktop --continue` は同じ `zNs` で id を決めるが、そのまま Desktop アプリへ渡す (副作用がある)
- `claude agents` の出力は読んでいない
- 外から確かめるのは無理で、外で同じ決まりを再現するしかない

### 9. 起動前に外から言い当てる手順

ASCII だけの cwd の基本形を下に示す (aliases が無く、自分のディレクトリに候補がある場合)。

```sh
cwd=$(cd "$PWD" && pwd -P)                    # realpath (NFC 正規化は省略)
cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
slug=$(printf %s "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')   # ASCII の cwd で 200 文字以下の時だけ正しい
dir="$cfg/projects/$slug"
# mtime (ms) の降順、同点は birthtime の降順に並べ、先頭から 4. の条件で除き、最初に残ったものの id
```

非 ASCII の cwd、200 文字を超える slug、上書き、aliases、`HQe` の置き換え、4. の除外を入れた手順は、python で書いて合成データで確かめた (下の「再現スクリプト」。実際の claude との突き合わせはまだ)。

外から決められずに残るもの:

- サーバの feature flag `tengu_tender_wren` (archived を見るか)。`archived.json` のある候補では結果が分かれうる
- 環境変数 `CLAUDE_CODE_HOVER_REST` が立っている時 (bg のセッションの子に親が渡す)。この時はファイルでなく storage backend から一覧と時刻を取る (`hir`、`O3n` の先頭)。この backend が何に載っているかは読んでいない。普通に起動した `claude` ではこの環境変数が無く、ファイルを読む (`J()` を立てるのは `pinStorageV5FromEnv` だけ、151971388)
- mtime も birthtime もミリ秒まで同点の時の順
- 予想してから claude が読むまでの間に、別のプロセスが追記して mtime が変わること
- 動いているセッションの判定の細部 (pid の再利用の照合、`pidDomain`)

## 実用的な示唆

- `--continue` の順番は mtime で決まる。**中身を変えないメタデータの追記 (タイトル等の行) でも、古いセッションが最新になる**。行の `timestamp` は効かない
- 同じ cwd で動いている対話のセッションも選ばれる。daemon が「`continue` は今動いていないセッションを続ける」と仮定してはいけない
- 起動前に置き場を決めたいなら、外で id を予想して **`--continue` でなく `--resume <予想した id>` で起動する**方が確実 (予想と claude の選択のずれが消える)。代わりに、`--continue` だけが持つ判定 (bg に移ったセッションで止まる等) は失われる。`--resume <id>` と `--continue` で、起動の他の部分が同じかは確かめていない
- 対話の `--continue` は `-p` のセッションを飛ばす。webui / daemon が `-p` で走らせたセッションは、後から人が `claude --continue` しても続かない

## 読み切れなかった所

- `Rkr` の後 (`Jb` で id を切り替えた後) の流れで、動いている対話のセッションや 0 バイトのファイルを改めて弾くか
- `xBr` の `oe()` (`continued-in` より後ろにある assistant 行のうち、どれを「続いた」と見なすか) の細部。再現スクリプトは user / assistant の行があれば `continued-in` を無視する近似にした
- `Bes` が使う `pI` / `HZt` (ネットワークパス等で判定を外す条件) の中身
- slug が 200 を超える時に、`hdr` がディレクトリをどう確かめるか
- `.session-aliases` を誰が書くか
- storage backend (`tengu_hover_rest`) の中身
- `claude agents` 等のサブコマンドの出力

## 検証の詳細

### 抜き出しの手順

- `otool -l` で `__BUN,__bun` セクションのオフセットと大きさを取り、`dd bs=16384 skip=7919` でセクションを抜き出した
- `// @bun @bytecode` で始まり NUL で終わる区間を 1 チャンクとして扱った。主な処理は 163193333〜169133225 の 5.9MB のチャンクにある
- import 文 (`import{a,b as c}from"/$bunfs/root/chunk-xxxx.js"`) の名前を、その名前を export するチャンクの定義へ辿った

### 再現スクリプトを合成データで試した結果

一時ディレクトリに偽の config dir を作り、`CLAUDE_CONFIG_DIR` をそこへ向けて走らせた。config dir 本体は読んでいない。

| ファイル (mtime の新しい順) | 中身 | 判定 (対話) |
|---|---|---|
| E | 先頭に `"isSidechain":true` | 除く (isSidechain) |
| C | `{"type":"summary",...}` だけ | 除く (bookkeepingOnly) |
| B | `"entrypoint":"sdk-cli"` | 除く (entrypoint) |
| A | `"entrypoint":"cli"` の user 行 | 選ぶ |

- 対話として走らせると A を、`--print` として走らせると B を選んだ。どちらも 4. の読みと同じ結果
- サブディレクトリ (`<id>/`) は候補に入らなかった
- cwd は `/var/...` が `/private/var/...` に解決された slug になった

<details>
<summary>再現スクリプト (python3、標準ライブラリのみ)</summary>

`python3 -I predict_continue.py [--print] [-v] [<cwd>]`。選ぶ id を 1 行出して終了コード 0。候補が無ければ `NONE` で 1。bg に移ったセッションで止まる時は `STOP: ...` で 2。`-v` で各候補の判定を stderr に出す。

```python
import os, sys, re, json, unicodedata

args = sys.argv[1:]
PRINT = '--print' in args
VERBOSE = '-v' in args
rest = [a for a in args if a not in ('--print', '-v')]
NFC = lambda s: unicodedata.normalize('NFC', s)

raw = rest[0] if rest else os.getcwd()
cwd = NFC(raw if raw == '/' else os.path.realpath(raw))
cfg_env = os.environ.get('CLAUDE_CONFIG_DIR')
cfg = NFC(cfg_env if cfg_env is not None else os.path.join(os.path.expanduser('~'), '.claude'))
projects = os.path.join(cfg, 'projects')
BK = 65536
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

def units(s):
    b = s.encode('utf-16-le', 'surrogatepass')
    return [int.from_bytes(b[i:i + 2], 'little') for i in range(0, len(b), 2)]

def sanitize(s):
    return ''.join(chr(u) if (48 <= u <= 57 or 65 <= u <= 90 or 97 <= u <= 122) else '-' for u in units(s))

def jhash(s):
    h = 0
    for u in units(s):
        h = ((h << 5) - h + u) & 0xffffffff
    return abs(h - (1 << 32) if h >= 1 << 31 else h)

def b36(n):
    d = '0123456789abcdefghijklmnopqrstuvwxyz'
    o = ''
    while True:
        n, r = divmod(n, 36)
        o = d[r] + o
        if n == 0:
            return o

def nH(s):
    k = sanitize(s)
    return k if len(k) <= 200 else k[:200] + '-' + b36(jhash(s))

def override():
    v = os.environ.get('CLAUDE_CODE_PROJECT_DIR_NAME')
    if not cfg_env or v is None:
        return None
    if re.fullmatch(r'[A-Za-z0-9_-]{1,64}', v) and not re.fullmatch(r'con|prn|aux|nul|com[0-9]|lpt[0-9]', v, re.I):
        return v
    return None

def project_dir():
    pd = override() or nH(cwd)
    first = os.path.join(projects, pd)
    cands = [first] if os.path.isdir(first) else []
    if override() and override() != nH(cwd):
        alt = os.path.join(projects, nH(cwd))
        if os.path.isdir(alt):
            cands.append(alt)
    elif len(nH(cwd)) > 200:
        print('warn: slug > 200: prefix-scan fallback is not reproduced', file=sys.stderr)
    return (cands[0] if cands else first), first

def list_dir(d):
    out = []
    try:
        it = list(os.scandir(d))
    except OSError:
        return out
    for e in it:
        if not e.is_file(follow_symlinks=False) or not e.name.endswith('.jsonl'):
            continue
        sid = e.name[:-6]
        if not UUID.match(sid):
            continue
        st = os.stat(e.path)
        bt = getattr(st, 'st_birthtime', st.st_mtime)
        out.append({'id': sid, 'path': e.path, 'mtime': st.st_mtime_ns // 1000000, 'birth': int(bt * 1000), 'size': st.st_size})
    return out

def head_tail(p, size):
    with open(p, 'rb') as f:
        h = f.read(BK).decode('utf-8', 'replace')
        if not h:
            return '', ''
        off = max(0, size - BK)
        if off == 0:
            return h, h
        f.seek(off)
        return h, f.read(BK).decode('utf-8', 'replace')

def first_str(text, key):
    m = re.search(r'"%s": ?"((?:\\.|[^"\\])*)"' % re.escape(key), text)
    return json.loads('"%s"' % m.group(1)) if m else None

def last_str(text, key):
    ms = list(re.finditer(r'"%s": ?"((?:\\.|[^"\\])*)"' % re.escape(key), text))
    return json.loads('"%s"' % ms[-1].group(1)) if ms else None

def strict_cwd(head):
    for line in head.split('\n'):
        if '"cwd":' in line:
            try:
                v = json.loads(line).get('cwd')
                if isinstance(v, str):
                    return v
            except Exception:
                pass
    return None

def relocated(tail):
    for line in reversed(tail.split('\n')):
        if '"relocated"' in line:
            try:
                o = json.loads(line)
                if o.get('type') == 'relocated' and isinstance(o.get('relocatedCwd'), str):
                    return o['relocatedCwd']
            except Exception:
                pass
    return None

def has_rows(p, head, tail, size):
    if '"parentUuid":' in head or '"parentUuid":' in tail:
        return True
    if size <= BK:
        return False
    with open(p, 'rb') as f:
        return b'"parentUuid":' in f.read(16 * 1024 * 1024)

def continued_in(tail):
    if '"type":"continued-in"' not in tail:
        return None
    for line in reversed(tail.split('\n')):
        ci = '"type":"continued-in"' in line
        ua = '"type":"user"' in line or '"type":"assistant"' in line
        if not (ci or ua):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if ci and isinstance(o.get('continuedInSessionId'), str) and UUID.match(o['continuedInSessionId']):
            return o['continuedInSessionId']
        if ua:
            return None
    return None

def is_loop(head):
    for line in head.split('\n'):
        if ('"type":"user"' not in line and '"type": "user"' not in line) or '"tool_result"' in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get('type') != 'user' or o.get('isMeta') is True or o.get('isCompactSummary') is True:
            continue
        c = (o.get('message') or {}).get('content')
        texts = [c] if isinstance(c, str) else [x.get('text', '') for x in (c or []) if isinstance(x, dict) and x.get('type') == 'text']
        return any('<command-name>/loop</command-name>' in t for t in texts)
    return False

def foreign(rec):
    a, b = NFC(rec), cwd
    if sanitize(a).lower() != sanitize(b).lower() or a.replace('\\', '/').lower() == b.replace('\\', '/').lower():
        return False
    try:
        ra = NFC(os.path.realpath(a, strict=True))
    except OSError:
        return False
    return sanitize(ra).lower() == sanitize(b).lower() and ra.lower() != b.lower()

def live_sets():
    d = os.path.join(cfg, 'sessions')
    recs = []
    try:
        names = [n for n in os.listdir(d) if re.fullmatch(r'\d+\.json', n)]
    except OSError:
        return set()
    for n in names:
        try:
            o = json.load(open(os.path.join(d, n)))
            os.kill(int(n[:-5]), 0)
        except Exception:
            continue
        recs.append(o)
    if not all(r.get('kind') == 'interactive' or (r.get('kind') and r.get('sessionId')) for r in recs):
        return None
    return {r['sessionId'] for r in recs if r.get('kind') != 'interactive' and r.get('sessionId')}

own_ep = os.environ.get('CLAUDE_CODE_ENTRYPOINT')
if own_ep == 'cli' and PRINT:
    own_ep = 'sdk-cli'
if own_ep is None:
    own_ep = 'sdk-cli' if PRINT else 'cli'
SDK = {'sdk-cli', 'sdk-ts', 'sdk-py'}

pdir, cydir = project_dir()
logs = list_dir(pdir)
logs.sort(key=lambda x: (-x['mtime'], -x['birth']))

def is_foreign_log(l):
    h, t = head_tail(l['path'], l['size'])
    rec = relocated(t) or strict_cwd(h)
    return rec is not None and foreign(rec)

if re.search(r'[^a-zA-Z0-9/\\:-]', cwd) and all(is_foreign_log(l) for l in logs):
    alt = []
    for name in (os.listdir(projects) if os.path.isdir(projects) else []):
        d = os.path.join(projects, name)
        if d == pdir or not os.path.isdir(d):
            continue
        ls = sorted(list_dir(d), key=lambda x: -x['mtime'])
        if not ls:
            continue
        h, t = head_tail(ls[0]['path'], ls[0]['size'])
        rec = relocated(t) or strict_cwd(h)
        if rec and rec.replace('\\', '/') == cwd.replace('\\', '/'):
            alt += ls
    logs = sorted(alt, key=lambda x: (-x['mtime'], -x['birth']))
alias_file = os.path.join(cydir, '.session-aliases')
if os.path.isfile(alias_file):
    best = {l['id']: l for l in logs}
    for a in dict.fromkeys(x for x in open(alias_file).read().split('\n') if x):
        for l in list_dir(a):
            if l['id'] not in best or l['mtime'] > best[l['id']]['mtime']:
                best[l['id']] = l
    logs = sorted(best.values(), key=lambda x: (-x['mtime'], -x['birth']))

live = live_sets()
for l in logs:
    h, t = head_tail(l['path'], l['size'])
    why = None
    if h:
        rec = relocated(t) or strict_cwd(h)
        kind_line = next((x for x in h.split('\n') if '"parentUuid":' in x), h)
        kind = first_str(kind_line, 'sessionKind')
        ep = first_str(h, 'entrypoint') or last_str(t, 'entrypoint')
        ci = continued_in(t)
        ci_path = os.path.join(os.path.dirname(l['path']), (ci or '') + '.jsonl')
        if rec is not None and foreign(rec):
            why = 'recorded cwd is a different directory with the same slug'
        elif '"isSidechain":true' in h or '"isSidechain": true' in h:
            why = 'isSidechain'
        elif first_str(h, 'teamName'):
            why = 'teamName'
        elif kind in ('daemon', 'daemon-worker'):
            why = 'sessionKind=' + kind
        elif own_ep not in SDK and ep in SDK:
            why = 'entrypoint=' + ep
        elif own_ep not in SDK and is_loop(h):
            why = '/loop session'
        elif not has_rows(l['path'], h, t, l['size']):
            why = 'bookkeepingOnly'
        elif ci and live is not None and ci in live:
            print('STOP: newest conversation continued in live background session %s' % ci)
            sys.exit(2)
        elif ci and os.path.isfile(ci_path) and has_rows(ci_path, *head_tail(ci_path, os.path.getsize(ci_path)), os.path.getsize(ci_path)):
            why = 'superseded by ' + ci
        elif live is not None and l['id'] in live:
            why = 'live non-interactive session'
        elif live is None and (kind == 'bg' or ci):
            why = 'live registry unreadable and sessionKind/continued-in present'
    if why is None and os.path.isfile(os.path.join(os.path.dirname(l['path']), l['id'], 'archived.json')):
        print('warn: %s has archived.json; skipped only if the server flag is on' % l['id'], file=sys.stderr)
    if VERBOSE:
        print('%s mtime=%d birth=%d %s' % (l['id'], l['mtime'], l['birth'], why or 'PICK'), file=sys.stderr)
    if why is None:
        print(l['id'])
        sys.exit(0)
print('NONE')
sys.exit(1)
```

</details>

- スクリプトは `--fork-session` を扱っていない (fork の時は、動いているセッションの除外と `continued-in` で止まる判定を飛ばすだけ)
- `sessions/<pid>.json` の照合は pid が生きているかだけを見ている。claude は pid の再利用も照合している (`Fv` / `procStart`)
