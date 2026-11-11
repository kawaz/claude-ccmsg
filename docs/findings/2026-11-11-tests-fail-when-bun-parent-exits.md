# bun test の親が先に終わると、`process.ppid` を生きている pid にしたテストが落ちる

## 判明した事実

- `bun test` を起こした親 (shell) が先に終わると、daemon の 4 ファイル (agents / send-message / op-http と、同じ形の network-wake-integration) のテストが落ちる。原因は 2 プロセスの並走ではなかった。1 プロセスでも親が先に終わる形で起こせば落ち、親が生きている形なら 2 プロセス並走でも落ちない (修正後に並走 ×3 で確認)
- 親が終わった後の bun の `process.ppid` は `1` (launchd) を返す。`isProcessAlive` (`packages/daemon/src/sidecar-call.ts` の `process.kill(pid, 0)`) は pid 1 に EPERM を受けて `false` を返す (自分のユーザのプロセスでないものは生きていない扱い)
- 落ちたテストはどれも、2 つ目のセッション / run の state file の pid に `process.ppid` を書いていた。daemon は state file を `readSessionsDir` (`packages/daemon/src/session-runs.ts` の `isAlive(read.value.pid)`) で読み、pid が生きていない file を捨てる。そのため 2 つ目の run が daemon から見えなくなる
  - agents の config dir 検出: `~/.claude-b` のセッションが一覧に出ない
  - send_message の「1 セッションの全 run に届く」: 2 つ目の run に届かず、`nextUser()` の待ちが 15 秒の期限で切れる
  - op-http の send_message / peer_list: `to` が `BARE` のセッションが ended になる
- network-wake-integration の「API エラー停止中のセッションだけが起こされる」は、親が先に終わる形でも通っていた。B の pid が生きていない扱いになり B が daemon から見えないので、「B は停止していないから起こされない」の主張が B の不在で満たされていた (落ちないが、保証が空になっていた)
- session-runs は `liveRuns` に生死の判定を注入しているので、`process.ppid` が 1 でも通る
- 直し方: テストが起こして終わりまで持つ子プロセスの pid を使う (`perTestLivePid()`、`packages/testkit/src/live-pid.ts`)。子は stdin を閉じられるまで読み続ける `cat` で、そのテストの `afterEach` が止める。テストの process が先に死んでも、カーネルが pipe を閉じて子は去る。テストの期待値・期限・assert は変えていない
- 未確認: Linux で親が先に終わった時の `process.ppid` (1 か subreaper の pid か) と、その pid への `kill(pid, 0)` の結果。観測は macOS (Darwin 25.5.0、bun 1.4.2) の 1 台だけ

## 実用的な示唆 / ベストプラクティス

- テストで「生きている別のプロセス」が要る時は、`process.ppid`・`1`・固定の数値を使わない。どれもテストの外の事情 (起動のされ方、OS、たまたま走っているプロセス) で生死が変わる。テストが起こした子の pid を使う
- 生きていない pid が「起きないこと」を主張するテストを素通りさせることがある (network-wake の B)。落ちないことは、その pid が生きていた証拠にならない
- 並走で落ちたように見えた時は、並走そのものと、並走させるための起動の形 (`&` で親の shell がすぐ終わる) を分けて試す

## 検証の詳細

### 起動の形と結果 (修正前、統括の実行、4 ファイル)

| 形 | 結果 |
|---|---|
| `sh -c "bun test <4 ファイル> 2>&1 &" \| cat > log` (親の sh がすぐ終わる) | 61 pass / 5 fail |
| `sh -c "bun test <4 ファイル> 2>&1" > log` (親が生きている) | 66 pass / 0 fail |

4 ファイルは `packages/daemon/test/` の `agents.test.ts` `session-runs.test.ts` `send-message.test.ts` `op-http.test.ts`。issue に書かれていた元の再現手順 `(bun test > bg.log 2>&1 &)` も、subshell がすぐ終わって bun の親が居なくなる形だった。

### `process.ppid` と `isProcessAlive` の観測

`process.ppid` を読み、その pid に `process.kill(pid, 0)` と `isProcessAlive` を当てる小さなスクリプトを bun で走らせた。

| 形 | `process.ppid` | `kill(ppid, 0)` | `isProcessAlive(ppid)` |
|---|---|---|---|
| `sh -c "bun probe.ts"` (親が生きている) | sh の pid | 成功 | `true` |
| `sh -c "bun probe.ts &" \| cat` (親がすぐ終わる) | `1` | EPERM | `false` |

親がすぐ終わる形では、スクリプトの冒頭で読んだ時点で既に `1` だった。

### 子の `cat` が親より長く生きないこと

`Bun.spawn(["cat"], { stdin: "pipe" })` で子を起こした bun を SIGKILL すると、子は stdin の EOF で去った (`kill -0` が SIGKILL 前は成功、`caffeinate -w <子の pid>` が返った後は失敗)。

### 修正前後 (5 ファイル: 上の 4 ファイル + `network-wake-integration.test.ts`)

| 形 | 修正前 | 修正後 |
|---|---|---|
| 親が先に終わる | 62 pass / 5 fail | 67 pass / 0 fail |
| 親が生きている | (未実行) | 67 pass / 0 fail |
| 2 プロセス並走 (片方を `&`)、3 回 | (未実行) | 6 run とも 67 pass / 0 fail |

修正前に落ちた 5 件:

- agents「$HOME/.claude* のうちディレクトリのみ読み、regular file の ~/.claude は除外される」
- send-message「a session id reaches every run of the session」(15 秒の期限切れ)
- send-message「a result spells the session's directory as a realpath; the sender's own id is not sent to」
- send-message「a run refusing while another takes it is delivered; every run refusing is refused」
- op-http「sends to the session `to` names, as the asking process's session, and lists them」
