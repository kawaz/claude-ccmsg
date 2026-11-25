# daemon が継ぐ環境: 起こしたセッションの変数の実測と、落とし方の案 (2026-11-25)

- Date: 2026-11-25
- 対象: ccmsg v0.422.0 (main)、Claude Code 2.1.332 (一部 2.1.331・2.1.322 の子も見た)、macOS (Darwin 25.5.0)
- 動機: issue [2026-11-20-daemon-env-carries-spawning-session-identity](../issue/2026-11-20-daemon-env-carries-spawning-session-identity.md) の「決めること」3 つ (落とす変数の範囲、settings の `env` 由来の値の扱い、起動コマンドの `clean_env` の既定) に、影響の実測を付けて案を出す。直し方の案までで、実装はしていない
- 方法:
  - daemon とその子を起こす所をコードで洗い出した
  - 本番の daemon・動いているサイドカー・このセッションの Bash の環境を、`ps -E` と `env` で**名前だけ**取り出して比べた (値は読んだ側の比較 (一致するか) にだけ使い、記録していない)
  - 隔離した config dir で claude を起こし、継いだ変数をどう扱うかを hook と画面で見た。API は閉じたポートを向けたダミーで、どの claude も API に届いていない
  - 隔離した daemon (`.claude/skills/verify` の形、state / config / data dir と HTTP のポートを分けたもの) を、偽のセッションの環境から CLI に spawn させ、自前の起動コマンドで launch した。本番の daemon と人のセッションには触れていない

## 判明した事実 (観測)

### 本番の daemon の環境

今動いている daemon (2026-11-25 18:21 JST 起動) の環境は 92 個の変数を持ち、`CLAUDE_CODE_SESSION_ID`・`HYOUI_SESSION_ID`・`CLAUDE_CONFIG_DIR`・`GH_CONFIG_DIR`・`SSH_AUTH_SOCK`・`DIRENV_FILE`・`PWD` の値が統括のセッションの Bash の値と一致した。統括のセッションの Bash から spawn された daemon で、名前の集合はその Bash の環境と `_` を除いて同じだった。

名前を出どころで分けると次のとおり。

| 出どころ | 名前 |
|---|---|
| Claude Code がセッションの子に付けるもの (下の節) | `AI_AGENT`、`CLAUDECODE`、`CLAUDE_PID`、`CLAUDE_EFFORT`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_CHILD_NOTES_DIR`、`CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_EXECPATH` |
| 起こしたセッションの config dir の settings の `env` | `ANTHROPIC_BASE_URL`、`ANTHROPIC_DEFAULT_*_MODEL` (3 つ)、`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`、`CLAUDE_CODE_AUTO_MODE_SERVER`、`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`、`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_STREAM_IDLE_TIMEOUT_MS`、`CLAUDE_STREAM_IDLE_TIMEOUT_MS_default`、`JJ_EDITOR` |
| 面 (起こしたセッションの cwd の `.envrc` と起動の仕方) | `CLAUDE_CONFIG_DIR`、`GH_CONFIG_DIR`、`SSH_AUTH_SOCK`、`DIRENV_DIFF`、`DIRENV_DIR`、`DIRENV_FILE`、`DIRENV_IN_ENVRC`、`DIRENV_WATCHES`、`PWD`、`OLDPWD` |
| 起こしたセッションの端末 | `HYOUI_SESSION_ID`、`GHOSTTY_SURFACE_ID`、`GHOSTTY_*` (他 3 つ)、`STARSHIP_SESSION_KEY`、`TERM`、`TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`COLORTERM`、`TERMINFO`、`TERMINFO_DIRS` |
| ログインと shell の profile | `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`XDG_*` (7 つ)、`NIX_*` (4 つ)、`SECURITYSESSIONID`、`__CF_USER_TEXT_ENCODING`、`XPC_*`、`EDITOR`、`GIT_EDITOR`、`PAGER` 等の残り |
| ccmsg が置き換えたもの | `TMPDIR` (DR-0002 §2) |

`JJ_EDITOR` は settings の `env` にある名前で、`CLAUDE` / `ANTHROPIC` で始まらない。settings の `env` の名前は、kawaz の config dir のうち `env` を持つ 3 つで 11〜13 個あり、2 つは同じ集合、1 つは 3 つ欠けて別の 1 つを持っていた。

### Claude Code がセッションの子に付ける変数は、起こし方と版で違う

| 子の種類 (Claude Code の版) | Claude Code が付けていた名前 (settings の `env` にも shell にも無いもの) |
|---|---|
| Bash tool の子 (2.1.332) | `AI_AGENT`、`CLAUDECODE`、`CLAUDE_PID`、`CLAUDE_EFFORT`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_CHILD_NOTES_DIR`、`CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_EXECPATH` |
| hook の子 (2.1.332、隔離した config dir) | 上の Bash の子のうち `CLAUDE_EFFORT`・`CLAUDE_CODE_EXECPATH` を除いたものに、`CLAUDE_ENV_FILE`・`CLAUDE_PROJECT_DIR` |
| module の `$.process.spawn` の子 = サイドカー (2.1.331、2.1.332) | `AI_AGENT`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_CHILD_NOTES_DIR`、`CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS`。`CLAUDECODE`・`CLAUDE_PID`・`CLAUDE_CODE_SESSION_ID`・`CLAUDE_CODE_CHILD_SESSION` は無い |
| 同じくサイドカー (2.1.322) | 上から `CLAUDE_CODE_CHILD_NOTES_DIR`・`CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS` を除いたもの |

- issue の一覧 (2.1.328 の Bash の子) に無い `AI_AGENT` が、2.1.332 の Bash の子にあった (2.1.328 で付いていたかは確かめていない)。`AI_AGENT` はシェルの設定には無く、claude の実行ファイルに名前がある
- `CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS` は、親の claude の環境には無く、サイドカーの環境にだけあった (2.1.331・2.1.332 の 3 本のうち 3 本、2.1.322 の 1 本には無い)。claude の実行ファイルに名前がある
- daemon を起こす経路は、Bash (`just push` の upgrade の接触、エージェントの Bash) と module の `$.process.spawn` (`sidecar begin`、DR-0002 §2) の 2 つあり、それぞれ持ち込む名前の集合が違う。module の経路で起こされた daemon の環境は見ていない (今の本番は Bash の経路)。サイドカーと同じ集合を持つと見ている (未検証)

### 継いだ変数を持つ claude は、自分の子にどれを付け直すか

隔離した config dir の `SessionStart` hook で、hook の子の環境を見た。B は、Claude Code のセッションの子が持つ変数を、偽の値 (新しく作った uuid の session id、無いパスの socket、ダミーの token、生きていない pid) で持たせて起こしたもの。

| 確かめたこと | A: 継いだ変数なし | B: 継いだ変数あり (`claude -p`) |
|---|---|---|
| hook の子の `CLAUDE_CODE_SESSION_ID` | hook の入力の session_id と一致 | hook の入力の session_id と一致 (継いだ値ではない) |
| `CLAUDE_CODE_MESSAGING_SOCKET` / `TOKEN` | claude 自身の値 | claude 自身の値 (継いだ値ではない) |
| `CLAUDE_CODE_CHILD_SESSION` | あり | あり |
| `CLAUDE_EFFORT`、`CLAUDE_CODE_EXECPATH` | 無い | ある (継いだものが素通り) |
| transcript (`claude -p`) | 書いた | 書いた (`CLAUDE_PID` を生きていない pid・生きている別のプロセス・祖先の claude にした 3 通りとも) |

起こされた claude は、身元の変数 (session id・messaging) を自分の値で付け直す。継いだ session id がそのまま届くのは、claude より前の層 (起動コマンドの中) と、claude でない子 (say のコマンド、`claude update` 等の daemon の子) になる。

### 継いだ `CLAUDE_CODE_CHILD_SESSION` で、対話の claude が transcript を保存せず、セッションの記録も書かない

対話の claude (2.1.332) を専用の socket の tmux で 2 つ起こし、起動の画面と `<config dir>/sessions/` を見た。`CLAUDE_PID` は生きている別のプロセス (起こす claude の祖先ではないもの) の pid にした。daemon に起こされた起動コマンドの claude はこの形になる (daemon を起こしたセッションの claude は生きているが、祖先ではない)。

| | 継いだ変数なし | 継いだ変数あり |
|---|---|---|
| 画面 | (警告なし) | `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 …` |
| `sessions/<pid>.json` | 書いた | 書かなかった |

`.claude/skills/verify` に書かれた観測 (Bash から起こした試験用のセッション) と同じことが、2.1.332 の対話の claude で起きた。`sessions/<pid>.json` は daemon がセッションを見つける記録 (`agents.ts`) なので、`clean_env` を書いていない自前の起動コマンドで launch したセッションは、daemon の一覧に出ず、transcript も残らない。`claude -p` では起きなかった (上の表)。

### 隔離した daemon での launch: 起動コマンドの中の CLI が、起こしたセッションを名乗る

偽のセッション A (新しく作った uuid を `CLAUDE_CODE_SESSION_ID` に、隔離した空のディレクトリを `CLAUDE_CONFIG_DIR` に、他に `CLAUDECODE`・`CLAUDE_CODE_MESSAGING_*`・`ANTHROPIC_BASE_URL`) の環境から `ccmsg peers` を呼び、CLI に隔離した daemon を spawn させた。

- spawn された daemon の環境は、A の変数を全部持っていた (`CLAUDE_CODE_SESSION_ID` は A の値)。PATH・HOME・USER・`CCMSG_*` と A の変数だけの環境で、daemon は `peers` と launch に答えた
- 接続を閉じた後、user として `peers` を呼ぶと A が一覧にあった (hello で登録されたまま)
- 起動コマンドは、自分の環境の名前、`CLAUDE_CODE_SESSION_ID` が A と一致するか、`ccmsg notify --self --text …` の結果を記録するスクリプトにした

| `session_launcher` の config | 起動コマンドの `CLAUDE_CODE_SESSION_ID` | 起動コマンドが受けた `CLAUDE` / `ANTHROPIC` の名前 | `ccmsg notify --self` |
|---|---|---|---|
| `clean_env` / `keep_env` を書かない (既定の `[]`) | A と一致 | `CLAUDECODE`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CONFIG_DIR`、`ANTHROPIC_BASE_URL` | daemon が A の notify として受けた (`{"sid": <A>, "outcome": "not_delivered", "reason": "ended"}`。A の実体が無いので届け先が無い) |
| `clean_env: ["CLAUDE*", "ANTHROPIC_*"]`、`keep_env: ["CLAUDE_CONFIG_DIR"]` | 無い | `CLAUDE_CONFIG_DIR` | CLI が断った (`'notify' requires a session identity; refusing to post as u1`) |

issue の「影響 (未検証)」の 1 つ目は、起動コマンドの層では起きる (実測)。起こされた claude の子 (hook) では、claude が session id を付け直すので起きない (上の節)。`clean_env` で落とした時も、`CLAUDE_CONFIG_DIR` は A のもの (起こしたセッションの面) が起動コマンドに届いた。

### 最小の環境で動くもの

- 隔離した daemon は、PATH・HOME・USER・`CCMSG_*`・`TMPDIR` と偽のセッションの変数だけの環境で起動し、`peers`・launch・`daemon stop` に答えた
- `claude --version` と `claude auto-mode defaults` (daemon が launch の設定のために呼ぶもの) は、PATH・HOME・USER だけの環境で終了コード 0 だった。`auto-mode defaults` の出力は、`CLAUDE_CONFIG_DIR` が無い時と隔離した空の config dir を指す時とで同じ大きさ (82,359 byte) だった
- `CLAUDE_CONFIG_DIR` が無い時、claude は `$HOME/.claude.json` を書いた (隔離した HOME で見た。`$HOME/.claude` は普通のファイルにしておいたが、どちらのコマンドも失敗しなかった)

## コードを読んだこと (実測していない)

### daemon とその子を起こす所

`Bun.spawn` に `env` を渡さない時は、daemon の `process.env` をそのまま継ぐ。

| 子 | 場所 | 環境 |
|---|---|---|
| daemon 本体 | `packages/cli/src/client.ts` の `spawnDaemon` | CLI の環境。`TMPDIR` だけ `userTempDir()` に置き換える |
| 起動コマンド (launch、restart) | `packages/daemon/src/session-launch.ts` の `launchSession` | daemon の環境から `clean_env` に当たるものを落とし (`keep_env` が勝つ)、`TMPDIR` を置き換え、`CCMSG_LAUNCH_REQUESTED_BY` を重ねる |
| `claude auto-mode defaults` と `claude --version` | `packages/daemon/src/server.ts` の `AutoModeDefaultsCache` の `run` | `buildLaunchEnv` (`clean_env` / `keep_env`)。`TMPDIR` は置き換えない |
| `claude update` と `claude --version` (claude_update) | `packages/daemon/src/claude-update.ts` の `productionClaudeUpdateDeps(host.env)` | daemon の環境そのまま。claude の子で `clean_env` を通らないのはここだけ |
| say のコマンド | `packages/daemon/src/say-speech.ts` の `speakOnce` | そのまま |
| 組み込みの say のコマンドが起こす `/usr/bin/say` | `packages/daemon/src/default-say-command.ts` | say のコマンドの環境そのまま |
| 翻訳の helper の build (`swiftc`) と helper 本体 | `packages/daemon/src/translate-helper.ts` | そのまま |
| `tailscale serve status` | `packages/daemon/src/tailscale-origin.ts` | そのまま |
| `scutil`、`route -n monitor` | `packages/daemon/src/network-watch.ts` | そのまま |
| `ps` (argv[0]、セッションの環境) | `packages/daemon/src/session-kill.ts`、`packages/daemon/src/session-env.ts` | `process.env` |
| `getconf DARWIN_USER_TEMP_DIR` | `packages/daemon/src/user-temp-dir.ts` | 空 |

daemon は git・jj・bump-semver を起こさない (リポの根は `repo-derive.ts` がファイルを見て決める)。bump-semver を呼ぶのは CLI の `sidecar begin` (`packages/cli/src/session-begin.ts`) で、セッションの側のプロセスで走る。

組み込みの起動コマンド (`default-launch-command.sh`) は、`CLAUDECODE` と `(CLAUDE|ANTHROPIC|HYOUI|CCMSG)_*` (`CLAUDE_CONFIG_DIR` を除く) を自分で unset してから `direnv exec .` で claude を起こす。kawaz の config の `clean_env` は `CLAUDE*`・`ANTHROPIC_*`・`CCMSG_*`・`AI_AGENT`・`HYOUI_*` 等、`keep_env` は `CLAUDE_CONFIG_DIR`。DR-0066 (未実装) は agy の既定の `clean_env` を `CLAUDE*`・`ANTHROPIC_*` にしている。

### daemon とその子が依る変数

| 変数 | daemon のコードが読む | 子が使う (コードからは読めない依存) |
|---|---|---|
| `PATH` | 読む: `claude` を探す (`Bun.which`)、config を読む時に `launch_command`・`say_command`・`zsh` を絶対パスに固定する | 全部の子 |
| `HOME` | 読む: `os.homedir()` (既定の置き場、受け持つ config dir を `~/.claude*` から探す) | claude、say のコマンド |
| `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME` | 読む: 置き場 (`protocol/src/paths.ts`) | — |
| `CCMSG_*` | 読む: 置き場、HTTP、受け持つ config dir (`CCMSG_CLAUDE_CONFIG_DIRS`)、試験用の口 | 起動コマンドの中の `ccmsg` (daemon の置き場を見つける) |
| `TMPDIR` | 読む: 添付の置き場 (置き換え済み) | 全部の子 |
| `CLAUDE_CONFIG_DIR` | 読まない (受け持つ config dir は `HOME` の `.claude*` か `CCMSG_CLAUDE_CONFIG_DIRS`) | 起動コマンド (組み込みも kawaz のものも daemon の値を残して使い、cwd の `.envrc` があればそれで上書きされる)。`claude update` (どの config dir に書くか、未検証) |
| `ANTHROPIC_*` | 読まない (翻訳は macOS の Translation の helper と HTTP の `translate_plamo_url` で、Claude を呼ばない) | `claude auto-mode defaults` は依らない (上の実測)。`claude update` は未検証 |
| Claude Code のセッションの変数 | 読まない | 起動された claude (`CLAUDE_CODE_CHILD_SESSION` で transcript が止まる)、起動コマンドの中の `ccmsg` (`CLAUDE_CODE_SESSION_ID` で名乗る)。どちらも上の実測 |
| `SSH_AUTH_SOCK`、`GH_CONFIG_DIR`、`DIRENV_*` | 読まない | 起動されたセッションの git・gh (cwd の `.envrc` があれば `direnv exec .` が上書きする) |
| `HYOUI_SESSION_ID` | 読まない | 起動されたセッションの hooks module (prompt.send の Enter、DR-0035 §3)。組み込みの起動コマンドと kawaz の起動コマンドは unset する |
| `LANG`、`__CF_USER_TEXT_ENCODING`、`SECURITYSESSIONID`、`NIX_SSL_CERT_FILE` 等 | 読まない | say、`swiftc`、claude (keychain)、say のコマンドの中の curl 等 (未検証) |

## 未検証

- module の `$.process.spawn` の経路 (`sidecar begin`) で起こされた daemon の環境 (サイドカーの環境から推している)
- `claude update` が `CLAUDECODE` 等を持って走った時に挙動が変わるか、`CLAUDE_CONFIG_DIR` に何を書くか (実物の install を書き換えるので走らせていない)
- say のコマンド・翻訳の helper・`swiftc` が、`LANG` や macOS のログインの変数を落とした時に動くか
- Linux での同じ観測 (kawaz の環境は macOS だけ)

## 案

daemon を spawn する所 (`spawnDaemon`、`TMPDIR` を置き換えているのと同じ所) で環境を作る案を 3 つ比べる。DR-0002 §2 のとおり、手で `ccmsg daemon run` した daemon は起こした人の環境のまま (どの案もそこは変えない)。

- **案 A: 名前の列挙で落とす**。Claude Code がセッションの子に付ける名前を ccmsg に列挙して落とす。settings の `env` 由来は残す
- **案 B: 形で落とす**。`CLAUDE*`・`ANTHROPIC_*` と `AI_AGENT` を落とし、`CLAUDE_CONFIG_DIR` だけ残す (組み込みの起動コマンドと kawaz の `clean_env` と同じ形)
- **案 C: 残す名前を列挙して作り直す**。`PATH`・`HOME`・`USER`・`LOGNAME`・`SHELL`・`LANG`・`XDG_*`・`CCMSG_*`・`TMPDIR` 等の残す名前だけで daemon の環境を作る

| 観点 | A: 名前の列挙で落とす | B: 形で落とす | C: 残す名前で作り直す |
|---|---|---|---|
| 今観測した Claude Code の変数 | 列挙に入れたものだけ落ちる (issue の列挙は、2.1.332 の Bash の子・hook の子・サイドカーと比べて 4 つ足りない: `AI_AGENT`、`CLAUDE_ENV_FILE`、`CLAUDE_PROJECT_DIR`、`CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS`) | 全部落ちる | 全部落ちる |
| Claude Code の版で名前が増えた時 | 列挙を直すまで漏れる。起こし方 (Bash・hook・module) ごとに集合が違うので、全部を追う必要がある | `CLAUDE` で始まる名前なら落ちる。`AI_AGENT` のように別の形で増えると漏れる | 落ちる |
| settings の `env` 由来 | 残る | `CLAUDE*`・`ANTHROPIC_*` の名前は落ち、それ以外 (`JJ_EDITOR`) は残る | 落ちる |
| 面と端末の変数 (`CLAUDE_CONFIG_DIR`、`GH_CONFIG_DIR`、`HYOUI_SESSION_ID` 等) | 残る | `CLAUDE_CONFIG_DIR` も含め残る | 落ちる |
| 落とし過ぎで壊れるもの | ほぼ無い | shell で export した `ANTHROPIC_API_KEY`・`CLAUDE_CODE_USE_*` 等を当てにする自前の起動コマンドと `claude update`。daemon に無い値は `keep_env` で戻せない (組み込みの起動コマンドは今も自分で落としているので変わらない) | 利用者の profile が付ける変数を暗に使う子の全部 (`SSH_AUTH_SOCK` が無いと起動されたセッションの git の署名、`NIX_SSL_CERT_FILE` が無いと curl 等)。何が要るかは環境ごとに違い、ccmsg からは列挙できない |
| 複数の config dir を受け持つこと | 起こしたセッションの面の settings を持ち続ける | 起こしたセッションの面の `CLAUDE_CONFIG_DIR` だけが残る。daemon のコードは読まず、起動コマンドで cwd に `.envrc` が無い時の既定の面になる | 面を持たない。代わりに起動コマンドの既定の面が無くなる |

### 推し: 案 B

1. Claude Code が付ける変数は、起こし方 (Bash・hook・module) と版で集合が違い (`CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS` は 2.1.322 の子に無く 2.1.331 以降の子にある)、issue の列挙 (Bash の子だけを見たもの) に無い名前が既に 4 つある。名前の列挙 (A) は追い続ける必要があり、漏れは目に見えない
2. 観測した Claude Code の変数は全部 `CLAUDE` で始まるか `AI_AGENT` で、`CLAUDE*`・`ANTHROPIC_*` の形は settings の `env` 由来の大半も一緒に落とす。daemon のコードはこれらを読まず、最小の環境で daemon の `peers`・launch と、claude の `--version`・`auto-mode defaults` が動いた (実測)
3. 同じ形を組み込みの起動コマンド・kawaz の `clean_env`・DR-0066 の agy の既定が既に使っていて、daemon の外へ出る環境の規則が 1 つになる
4. C は面と端末まで落とせるが、落とし過ぎた時に壊れるものを ccmsg から列挙できず、`keep_env` のような戻し方も無い

B の悪い面:

- `AI_AGENT` は形に当たらない名前として個別に書く。同じ形の外の名前が増えれば漏れる (A と同じ弱さが一部に残る)
- `CLAUDE_CONFIG_DIR` (起こしたセッションの面) が残る。daemon のコードは読まないが、`.envrc` の無い cwd への launch の既定の面になる
- `JJ_EDITOR` のような settings の `env` の形の外の名前と、端末の変数 (`HYOUI_SESSION_ID` 等) は残る
- shell から `ANTHROPIC_*` や `CLAUDE_CODE_*` を渡して使っている人の `claude update` と自前の起動コマンドには、それが届かなくなる

### 「決めること」への推し

**1. 落とす変数の範囲 (名前の列挙か形か)**

| 選択肢 | 意味 |
|---|---|
| 名前の列挙 | Claude Code がセッションごとに付けるものだけを落とす。settings の `env` と shell から来た `CLAUDE*` は残る。版と起こし方で増えた名前は漏れる |
| 形 (`CLAUDE*`・`ANTHROPIC_*`、`AI_AGENT`、`CLAUDE_CONFIG_DIR` を残す) | Claude Code の付けるものと、settings の `env` の `CLAUDE*`・`ANTHROPIC_*` と、shell から来たそれらを区別せずに落とす |

推し: 形。理由は上の推しの 1〜3。

**2. settings の `env` 由来の値の扱い**

| 選択肢 | 意味 |
|---|---|
| 持ったままにする | daemon が起こしたセッションの面の設定を持ち、その子 (起動コマンド等) に配る。起動された claude は自分の settings の `env` で同じ名前を上書きするが、相手の settings に無い名前はそのまま届く |
| 形で落とす (案 B に含まれる) | `CLAUDE*`・`ANTHROPIC_*` の名前が落ちる。形の外の名前 (`JJ_EDITOR`) は残る |
| settings を読んで同じ名前を落とす | CLI が `CLAUDE_CONFIG_DIR` の `settings.json` の `env` の名前を読んで落とす。形の外の名前も落ちるが、settings の層 (user・project・local・managed・`--settings`) を Claude Code と同じに合わせる必要があり、同じ名前の shell の値と区別できない |

推し: 形で落とす。`CLAUDE_CONFIG_DIR` は残す。落とすと daemon に無い値を `keep_env` で戻せず、`.envrc` の無い cwd への launch が claude の既定の config dir に落ちる (kawaz の環境では既定の `~/.claude` は使えないようにしてある)。どの面で起動するかは起動コマンドの責務 (DR-0018 §3.1、§3.5) で、daemon が残すのは起動コマンドの既定の値までにとどめる。

**3. 起動コマンドの `clean_env` の既定**

| 選択肢 | 意味 |
|---|---|
| 空のまま | CLI が spawn した daemon は案 B で掃除済みなので届かない。手で `ccmsg daemon run` した daemon (セッションの Bash から起こした検証用の daemon を含む) の起動コマンドには、そのセッションの変数がそのまま届く |
| 既定を `clean_env: ["CLAUDE*", "ANTHROPIC_*", "AI_AGENT"]`、`keep_env: ["CLAUDE_CONFIG_DIR"]` にする | daemon の起こされ方によらず、起動コマンドに Claude Code の変数が届かない。組み込みの起動コマンド・DR-0066 の agy の既定と同じ形になる |

推し: 既定を変える。手で起こした daemon の起動コマンドに届いた時の害は、起動したセッションが一覧に出ず transcript も残らない、起動コマンドの中の `ccmsg` が起こしたセッションを名乗る (どちらも実測) で、どちらも黙って起きる。悪い面: `clean_env` を明示した config では既定は置き換わるので効かない。shell から `ANTHROPIC_*` を渡したい自前の起動コマンドは、その名前を `keep_env` に書く必要がある。

## 検証の詳細

### 条件

- 名前の取り出しは `ps -E -ww -o command= -p <pid> | tr ' ' '\n' | grep -oE '^[A-Za-z_][A-Za-z0-9_]*='`。値に空白があり、その続きが `NAME=` の形の時は余計な名前を拾いうる (`session-env.ts` の `parsePsEnv` と同じ限界)。値は出力していない
- claude の実測は、隔離した config dir (settings には `SessionStart` hook だけ)、ダミーの `ANTHROPIC_API_KEY`、閉じたポートの `ANTHROPIC_BASE_URL`、`env -i` で作った環境。`claude -p` は 40〜60 秒の timeout で止めた (API に届かないので応答は無い)。対話の claude は専用の socket の tmux で起動し、ダミーの key を受け入れた後の画面を見て止めた
- hook は、`CLAUDE_CODE_SESSION_ID` と hook の入力の session_id・偽の session id との一致、messaging の socket と token の偽の値との一致、`CLAUDE_CODE_CHILD_SESSION` の有無、`CLAUDE` / `ANTHROPIC` / `AI_AGENT` / `CCMSG` で始まる名前だけを書いた
- 隔離した daemon は、作業用の jj workspace の `packages/cli/src/index.ts` を CLI として呼んで spawn させた。state / config / data dir は一時ディレクトリ、HTTP は `127.0.0.1` の別のポート。launch は user として `session_launch` の op を送った (model と effort を付けた)。終わりに `daemon stop` で止め、プロセスが残っていないことを見た
