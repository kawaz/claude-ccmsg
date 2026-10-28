# hooks module から daemon への `POST /op` (DR-0046) を実機で確かめた

- Date: 2026-10-28
- 対象: Claude Code 2.1.312、Bun 1.4.2、ccmsg の作業コピー (v0.205.0 の上の DR-0046 の実装)
- 動機: [DR-0046](../decisions/DR-0046-module-op-over-http.md) の前提 (`$.http.fetch` の `socketPath` が任意の Unix socket に繋がるか、`init` に無い時間の上限、socket の相手の pid が何で、Bun で読めるか) を確かめ、実装した口で tool `send` / `peers`、事実、案内の URL が CLI の process を起こさずに通ること、旧 CLI 経由との往復時間の差、1 要求 1 接続の負荷を見る
- 方法:
  - `$.http.fetch` の前提: `session.start` で fetch を並べる小さな mod を `claude -p --plugin-dir` で読み、一時ディレクトリの Bun の HTTP server (Unix socket、path の長さ違い、500 を返すもの、答えないもの) に向けた。結果は mod が `$.fs.write` でファイルに書いた
  - 実装の確認: daemon は作業コピーの `packages/daemon/src/index.ts --foreground` を、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` を一時ディレクトリに向け、`CCMSG_CLAUDE_CONFIG_DIRS` に試験用の config home だけを名指し、`CCMSG_HTTP_ALLOW_ORIGIN=https://ccmsg-verify.example.com` で起動した (verify skill の手順)
  - 試験セッションは 2 つ (`🤖ccmsg-verify-modhttp-a` / `-b`)。一時ディレクトリの config home と空の作業ディレクトリで、`--plugin-dir <plugin の複製>` を付け、daemon と同じ `CCMSG_*` を渡して専用 socket の tmux の中で起動した。継いだセッションの変数は `env -i` で落とした
  - plugin の複製は `.claude-plugin` / `hooks` (hooks.json と bundle) / `skills` / `package.json` を写したもので、`bin/ccmsg` だけを「起動された引数を 1 行記録してから作業コピーの `bin/ccmsg` を exec する」script にした。module が起こした CLI はこの記録に全部残る。`hooks` を symlink にすると Claude Code は `Path escapes plugin directory` で module を読まない
  - model の応答は Messages API の代役 (reference `claude-mods/lab-setup`) が返した。prompt に `PEERS` があれば `mcp__ccmsg-v1__peers`、`SENDTO <sid>` があればその sid への `mcp__ccmsg-v1__send` の tool_use を返し、全 request の body を記録する
  - tool を呼ぶ間、`ps` を 10 ms ごとに (実際は `ps` 自体の遅さで 1 秒に約 10 回) 15 秒採り、`bin/ccmsg` と `packages/cli/src/index.ts` の process (常駐のサイドカーを除く) を記録した
  - 往復時間: 直前の commit (0a0304a6) の CLI を一時ディレクトリに書き出し、同じ daemon に対して `claude -p` の mod から旧 CLI (`$.process.run`) と `POST /op` (`$.http.fetch`) を 10 回ずつ交互の組で測った

## `$.http.fetch` の `socketPath`

| 宛先 | 結果 |
|---|---|
| 一時 dir の下の Unix socket、path が 93 / 100 / 103 / 104 / 110 / 150 / 189 byte | どれも `200`。189 byte はその dir で Bun が listen できた最長。curl (`--unix-socket`) は 104 byte 以上で繋がらなかった |
| 相対 path | `socketPath probe/s/a.sock refused: takes an absolute path` で reject |
| 無い path | `… failed: ENOENT` で reject |
| socket でないファイル | `… failed: ENOTSOCK` で reject |
| 500 を返す server | `{ status: 500, ok: false, text: "boom" }` で resolve |
| 1 MiB の body | `200` |
| 答えない server | 30 秒で `aborted: no complete answer within 30000ms` で reject (1 回) |
| 答えない server と `$.clock.after(12000)` の race (`session.start` の hook の中) | 12 秒で timer の側が勝ち、hook は 10 秒の予算で飛ばされなかった (debug log に `ran past its 10s budget` 無し、1 回) |
| 往復 (同じ socket に 10 回) | 0〜2 ms |

型定義の `socketPath` の説明「near 100 B at most」「one per session, in a private directory」は、2.1.312 では制限として働いていない。

## Bun の HTTP server の idle の打ち切り (Unix socket)

| server の設定 | 25 秒かかる handler への要求 |
|---|---|
| 既定 | 約 12 秒で切られた (curl exit 52、空の応答) |
| 要求ごとに `server.timeout(req, 0)` / `server.timeout(req, 60)` | 約 12 秒で切られた |
| `idleTimeout: 0` | 25 秒で答えた |

12 秒かかる handler は既定の server でも答えた。bun-types (1.3.14、1.4.4) は `idleTimeout` を TCP の server の option にしか書いていない。実装は相手の pid のために `Bun.listen` に移ったので、この打ち切りは今の口には当たらない (`Bun.listen` の接続は idle で切られない)。

## socket の相手の pid

| 確かめたこと | 結果 |
|---|---|
| `Bun.listen({ unix })` の socket が fd を持つか | `fd` を持つ (bun-types 1.3.14 / 1.4.4 の `Socket` の型には無い) |
| その fd に `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` (macOS、`bun:ffi`) | 繋いだ子の process の pid が返った |
| 同じことを Linux で (`oven/bun:1.4.2` の image、`SOL_SOCKET` / `SO_PEERCRED`) | 繋いだ子の pid が返った |
| `Bun.serve({ unix })` の handler から接続の socket に届くか | 届く口が無い (`server.requestIP` は Unix socket では null) |
| `claude -p` の mod の `$.http.fetch` の相手の pid | `claude -p …` の process の pid (`ps` で確認)。同じ mod が `$.process.run` で起こした子の `$PPID` と一致 (2 回)。`lsof -U` でもその process が 2 本の Unix socket の接続を持っていた |
| `$.http.fetch` が送る要求 | `POST /op HTTP/1.1`、`Connection: keep-alive`、`User-Agent: Bun/1.4.4`、`Host: ccmsg`、`Content-Length: <n>` (chunked ではない) |
| `claude -p` の `session.start` の時点の `<config dir>/sessions/` | `<pid>.json` (`pid`・`sessionId`・`kind: interactive`・`entrypoint: sdk-cli` 等) があった |
| 対話のセッションで `/clear` | 同じ `sessions/<pid>.json` の `sessionId` が新しい id に変わった (Enter から 1 秒以内、50 ms ごとの読み取り)。その後の新しい id の事実は daemon に届いた (1 回) |
| curl (セッションでない process) から `POST /op` | `unknown_peer`: `process <curl の pid> is not a Claude Code session in a config dir this daemon reaches` |

## 実装の口で通したこと

下の表は自己申告の hello で頼み手を決めていた段階の実装で通したもの。相手の pid で決める実装に変えた後も、A の `peers` / B 宛ての `send` (届いた)、CLI の起動の記録 (起動時の `sidecar begin` / `sidecar` / `sidecar reply` だけ)、`ps` の採取 (234 回、ccmsg の CLI の process 無し)、事実の到着、curl の `unknown_peer`、`/clear` の後の事実を通した。


| 場面 | 操作 | 結果 |
|---|---|---|
| 2 つのセッションの起動 | — | CLI の起動の記録は `sidecar begin` と常駐の `sidecar` が各 1 つと、daemon がサイドカーに問う `session.facts` への `sidecar reply` が各 1 つだけ。`sidecar facts` / `status` は無い |
| A の最初の prompt | `PEERS` | 代役が受けた request の user message に案内と `ccmsg_url: https://ccmsg-verify.example.com` の行があった (`ping` の `webui_url`) |
| A で tool `peers` | `PEERS again` | 「送れる相手のセッション」に B (`🤖ccmsg-verify-modhttp-b`、cwd 付き) が出た |
| A で tool `send` (B 宛て) | `SENDTO <B の sid>` | 「1 件の宛先すべてに届いた」。B の TUI に `Message from @ccmsg-<A の sid>: hello from A over POST /op`。daemon.log `peer-inject … -> <B>.<pid> (send_message): delivered` |
| 上の 2 つの tool の間の CLI の起動 | 記録と `ps` | 記録は起動時の 6 行から増えなかった。`ps` の採取 (148 回と 158 回) に ccmsg の CLI の process は 1 つも出なかった (出たのは別の、普段の daemon の process だけ) |
| 事実 | `session_status` (user role、`POST /op`) | A と B とも、module だけが持つ `context.window` (1000000) と、最後の turn の終わりの時刻の `turn: idle` が載っていた |
| 名乗りの所在と版 | `peers` (user role) | A と B の行の cwd はサイドカーの名乗り (state file) のまま、`client_version: 0.205.0`、`protocol: 1` |
| daemon を止めた後 | A で `peers` | 「一覧を返せなかった: ccmsg の daemon が動いていない」 |
| `http.sock` を持たない直前の commit の daemon を同じ state dir で起動 | A で `peers` | 「一覧を返せなかった: ccmsg の daemon がこの plugin より古い。daemon を更新する (`ccmsg daemon restart`)」。サイドカーはその daemon に名乗り直した |

daemon を止めると `daemon.sock` と `http.sock` はどちらも消えていた。

## サイドカーの依頼への返事を `POST /op` に移した後

返事を `sidecar_reply` で `POST /op` から渡す実装 (同じ process が以前に走らせた id を名乗れる、DR-0046 §3) で、試験セッション B を起こし直して確かめた。

| 場面 | 結果 |
|---|---|
| B の起動 | CLI の起動の記録は `sidecar begin` と常駐の `sidecar` の 2 行だけ。daemon がサイドカーの名乗りで問う `session.facts` への返事の `sidecar reply` は無くなった |
| user role で B に `user_prompt` | 5 ms で `{ ok: true, outcome: "not_delivered", reason: "no_terminal" }` (試験セッションに hyoui の端末が無いので、module が `prompt.send` に答えた結果)。返事は `POST /op` で届いた |
| B で 1 turn | `session_status` に module の事実 (`window: 1000000`、`turn: idle`) |

`/clear` の前に届いた依頼への古い id での返事は、実機で起こす手順を作っておらず、daemon の endpoint のテスト (`op-http.test.ts`) でだけ確かめた。

## 往復時間 (同じ daemon、host の中から 10 回ずつ、ms)

| 呼び出し | 旧 CLI (`$.process.run`) | `POST /op` (`$.http.fetch`) |
|---|---|---|
| `peer_list` (`sidecar peer-list`) | 中央値 113、最小 100、最大 578 (1 回目) | 中央値 2、最小 2、最大 4 |
| `session_facts` (`sidecar facts`) | 中央値 96.5、最小 93、最大 133 | 中央値 1.5、最小 1、最大 3 |
| `ping` (`status`) | 中央値 117、最小 95、最大 169 | 中央値 2、最小 1、最大 3 |

旧 CLI の 1 回目の 578 ms は bun の冷えた起動を含む。DR-0039 の約 0.3 秒 (B7) より短いのは、このマシンで続けて起動した時のキャッシュの効いた値だから (同じ条件で測っていない)。この表は自己申告の hello の段階の実装で測った。

## 1 要求 1 接続の負荷 (daemon をテストの process に置き、`session_facts`、ms)

テストの process 自身を `sessions/<pid>.json` でセッションとして書き、Bun の fetch で `POST /op` を流した。

| 条件 | 結果 |
|---|---|
| transcript の path が無いセッション、実の home (`~/.claude*` が 9 つ) | 1 要求 約 32 ms (`answerOp` だけでも 31.6 ms)。直列 1000 回で 38.7 秒 |
| 同じ、home を空の dir にした | 1 要求 0.35 ms (`answerOp`)、0.53 ms (fetch) |
| transcript の path を採用済みのセッション、hello が採用済みの path を探し直さない形 (実装) | `answerOp` 0.23 ms、生の socket 0.39 ms、fetch 0.44 ms。直列 1000 回 450 ms |
| 同じセッションで、hello が毎回探し直す形 (直す前) | `answerOp` 33 ms |
| 同時 10 / 50 / 100 / 150 / 200 本 | 2.3 / 6.3 / 12.5 / 18.4 / 28.0 ms で全部 200 |
| 同時 500 本 | 接続が張れず fetch が `FailedToOpenSocket` で失敗 |
| 1 MiB の body | 200、73 ms |

時間の大半は hello の transcript の探し直し (全 config dir の `projects/` を読む) だった。

## 試験の環境に由来すること

- model は代役で、tool の呼び出しは代役が返した tool_use。代役の URL は first-party の host でないが、この版では ToolSearch が有効のままで、ccmsg の tool は request の `tools` に載らず、名前での直接の呼び出しが handler に届いた
- 試験セッションの module は plugin の複製から読んだ。複製の bundle は作業コピーの `bun hooks/bundle.ts --check` が通る時点のもの

## 未検証

- 待ちの間に人が Esc を押した時に `$.http.fetch` がどう終わるか (`$.process.run` は `aborted` で reject する)
- `tool.call` の hook の中で、時計の待ちが 10 秒の予算に数えられるか (案内の `ping` の 3 秒の上限は予算より短いので、どちらでも飛ばされない)
- `send_message` の往復時間 (配送の待ち、拒否の窓 0.25 秒を含むので、transport の差が見えにくい)
- 長い state dir (`daemon.sock` の path が 104 byte を超える環境) での `http.sock` への fetch。上の表で 189 byte まで繋がったので、Bun が bind できる長さなら繋がると読める
- Linux で Claude Code の `$.http.fetch` の相手の pid (Linux で見たのは Bun の子の process まで)
- `/clear` の直後に module の id が state file より先に変わる順になるか (観測した 1 回は state file が先)
- `/clear` の前に届いた依頼に古い id で答える返事 (endpoint のテストだけ)
