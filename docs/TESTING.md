# テスト規約

このリポのテストを書く・直す・レビューする時の規約。一般的な規約 (テスト改変で green を作らない、網羅観点、テストを仕様書として書く) は kawaz の共通規約を正本とし、ここにはこのリポ固有のものだけを書く。

- [test-integrity](https://github.com/kawaz/claude-rules-personal/blob/main/for-all/rules/test-integrity.md) — テストを緩めて green にしない
- [test-coverage-checklist](https://github.com/kawaz/claude-rules-personal/blob/main/reference/testing/test-coverage-checklist.md) — RED / GREEN / REFACTOR と網羅観点
- [test-as-spec-comments](https://github.com/kawaz/claude-rules-personal/blob/main/reference/testing/test-as-spec-comments.md) — 意図コメントの書き方
- [flaky-accountability](https://github.com/kawaz/claude-rules-personal/blob/main/reference/testing/flaky-accountability.md) — 失敗テストへの対処順と flaky 認定の説明責任

## 原則

- バグ修正は、まずそのバグで落ちるテストを書き、落ちることを確かめてから直す。再現できる基盤が無い層では、基盤を足すことまでが fix に含まれる。
- テストが落ちた時に入力・assert・timeout を緩めて green に戻さない (test-integrity)。仕様が変わった時だけ、意図と assert を新しい仕様に合わせて書き換える。
- テストは仕様 (外から観測できる振る舞い) を固定し、実装の手順 (呼び出し順、内部の中間状態、件数や index) を固定しない。

## 構造

- daemon との通信は `packages/daemon/test/helpers.ts` の `TestClient` を通す。daemon が書いた行は wire スキーマで読み (`readStreamItem`)、スキーマ外のフィールドは失敗にする。
- hello 済みの接続は同じ helpers.ts の `sessionConn` / `userConn` で作る。テストごとに connect と hello を書き直さない。fixture のディレクトリは `fixtureDir`、CLI の実行は `packages/cli/test/run-cli.ts` の `runCli`。
- JSON を文字列のまま assert しない。行はスキーマか `jsonObjectOf` で読んでから比較する。
- transcript / room の行は `packages/protocol/test/transcript-rows.ts` のビルダーで作る。テストごとに行の形を手書きしない。
- 送信されたフレームは op で引く。何番目か・何件目かで固定しない。
- daemon の子プロセス起動 (`startTestDaemon`) は、プロセスとして確かめるテストにだけ使う (環境変数で切り替わる振る舞い、lock / pid / 再起動、HTTP、agents poll)。wire 越しに確かめる op (hello した接続の状態が要るもの) は同じプロセスに立てた daemon (`startInProcessDaemon`) に UDS で繋ぐ。1 つの op の応答だけを見るテストは `packages/daemon/test/drive-request.ts` の `stubDaemon` で `handleRequest` を直接叩く。どちらも本番と同じ `createDaemon` で daemon を組む。

## 決定性

- 「起きないこと」は sleep で待って主張しない。marker の round-trip (`readEventUntil` 等) で順序づけた後に、溜まったイベントやファイルを読んで主張する。
- 時間に依存するコードは clock を注入する (`hooks/engine.ts` の `Engine.clock` と同型)。テストは実時間を待たない。実時間の待ちは外部プロセスの観測だけに使い、deadline 付きの retry にする。
- ポートは `0` で取る。固定ポートを書かない。
- timeout は preload (`packages/testkit/src/test-env.ts`) の `setDefaultTimeout` で全テストに 1 つ。bun は bunfig.toml の `[test]` の `timeout` を読まない。個別に長くするテストは理由をコメントに書く。
- 一時ディレクトリは `os.tmpdir()` の下に `mkdtemp` で作り、そのテストの後で消す。ファイルの各テストが作るものは `perTestTmpDir()` (`packages/testkit/src/tmp.ts`) で作れば、テストの終わりに消える。preload は run ごとの dir (`/tmp/ccmsg-run-*`) を作って TMPDIR をそこに向け、テストと、テストが起こすプロセス (CLI・daemon・スクリプト) の一時ファイルをすべてそこに入れて、run の終わりに消す (timeout・失敗でも消える)。最後のテストの後にまだ残っているものは、消さなかったテストのものとして run を落とす。UNIX socket のために短いパスが要るテストは `/tmp` を直に書かず `shortTmpDir` で作る (run の終わりの検査と削除の対象になる)。
- 開発者の shell の `CCMSG_*` はテストに届かない。preload (`packages/testkit/src/test-env.ts`) がテストのプロセスの環境から `CCMSG_` で始まるものを全部消し、テストの値 (`CCMSG_AGENTS_POLL=off`、`CCMSG_TEST_LIFELINE`) だけを入れる。テストが起こす CLI・sidecar・daemon はこの環境を継ぐ。要るテストは自分で渡す。
- daemon は設定をプロセスの環境変数から直に読まず、渡された環境 (`DaemonHost.env`、`daemon.env`) から読む。プロセスの環境を渡すのは本番の組み立ての `startDaemon` だけ。テストの daemon の環境は `packages/daemon/test/helpers.ts` の `testProcessEnv()` (テストのプロセスから `PATH`・`TMPDIR`・`CCMSG_TEST_LIFELINE` だけ) にテストの値を足して組む: `spawnDaemonProc` (と `startTestDaemon`) は dir と HOME と既定の `CCMSG_*` を、`startInProcessDaemon` は HOME・`CLAUDE_CONFIG_DIR` と `env` を、`stubDaemon` は存在しない base の下の HOME・`CLAUDE_CONFIG_DIR` を足す。テストのプロセスの環境をそのまま渡さない。
- テストが起こす daemon と、テストが daemon に向けて起こす CLI・sidecar の `HOME` と `CLAUDE_CONFIG_DIR` は、`packages/daemon/test/helpers.ts` の `testHomeEnv(dataDir)` で data dir の中 (`<dataDir>/home` と `<dataDir>/claude-config`) に固定する。daemon は `$HOME/.claude*` と hello が告げる config dir の `projects/` を読むので、継承すると開発者のセッションの transcript を読み、テストの速さと結果が走らせる人の HOME の中身で変わる。`spawnDaemonProc` と `startTestDaemon` (`DaemonCtx.env` にも入る) はこれを入れる。CLI に daemon を起こさせるテストは、CLI に渡す env にこれを入れる (CLI が起こす daemon は CLI の env を継承する)。`.claude*` を置いた HOME を自分で作るテストは、その HOME を extraEnv で渡して上書きする。
- 同じプロセスに立てる daemon には、環境変数ではなく `DaemonHost.home` で HOME を渡す。daemon は HOME を OS に尋ねず (本番の組み立ての `startDaemon` だけが、`os.homedir()` を渡し、`resolvePaths()` で state / config / data dir を決める)、この home を使う。使う所は `.claude*` の config dir の探索、既定の state dir の daemon かどうかの判定、`CLAUDE_CONFIG_DIR` が無い時の既定の config dir (`<home>/.claude`)、config の `~/` の展開、fs の許可範囲の「HOME とその祖先は root にしない」、ping の `home` で、`$HOME` を扱うテストは `ctx.daemon.home` を使う。`startInProcessDaemon` は `testHomeEnv` の HOME を渡し、`stubDaemon` は存在しない base の下の dir を渡す (config dir は 1 つも見つからない)。テストのプロセスの `HOME` は使えない: bun の `os.homedir()` はプロセスの起動時の `HOME` を読み、`process.env.HOME` を後から書き換えても変わらない。同じプロセスの daemon に向けて起こす CLI・sidecar にも `testHomeEnv` を渡す (hello で告げる config dir が開発者のものにならないように)。
- 子プロセスに偽の HOME を渡す時は、OS が特別扱いしない実在する一時 dir にする (`/home/...` は macOS の autofs で、bun の子が秒の桁で遅くなる。`docs/findings/2026-11-11-macos-autofs-home-slows-bun-child.md`)。`XDG_CACHE_HOME` 等で遅さだけ消さない。
- テストが「生きている別のプロセス」の pid を要る時は、テストが起こした子の pid を `perTestLivePid()` (`packages/testkit/src/live-pid.ts`) で得る。`process.ppid`・`1`・固定の数値は起動のされ方や OS で生死が変わるので使わない (bun の親が先に終わると `process.ppid` は 1 になり、daemon は生きていないと見る。`docs/findings/2026-11-11-tests-fail-when-bun-parent-exits.md`)。
- テストが起こした daemon と `ccmsg sidecar` は、そのテストが止める (`stopTestDaemon` / `ccmsg daemon stop` / SIGTERM を `finally` で)。止め忘れても run より長くは生きない: preload が `CCMSG_TEST_LIFELINE` に UNIX socket を置き、daemon と sidecar はそこに繋いで、切れたら (run の終了・失敗・Ctrl-C・SIGKILL のどれでも) 去る (`packages/testkit/src/lifeline.ts`)。shell の pipe の先に起こした sidecar のように bun が知らない孫プロセスも同じ。最後のテストの後にまだ繋がっているものは、止めなかったテストのものとして run を落とす (daemon は state dir、sidecar は socket を並べる)。spawn する時の env は `...process.env` か `testProcessEnv()` を含め、`CCMSG_TEST_LIFELINE` を落とさない。bun test は `exit` / `beforeExit` を発火しないので、`process.on("exit")` での後始末は動かない。
- グローバル (`WebSocket` 等) の差し替えは `packages/webui/test/helpers.ts` の `stubGlobal` で行い、`afterEach` で戻す。bun test は全ファイルを 1 プロセスで走らせるので、戻し忘れは別ファイルのテストを壊す。
- bun の runtime に無い `localStorage` / `sessionStorage` は helpers.ts の `MemStorage` を `stubGlobal` で生やし、`afterEach` で戻す。代入で生やしたままにすると、テストが書いた値 (`ccmsg.sidebarOpen` 等) が後に走るファイルの初期状態に入る。
- DOM の prototype (`HTMLElement.prototype` の `clientHeight` 等) の差し替えは同じ helpers.ts の `stubProperty` で行い、元の記述子に戻す。happy-dom の class は `withDom` の登録をまたいで同じなので、`delete` で消すと happy-dom 自身の定義まで消え、後に走るファイルで値が `undefined` になる。ファイルの実行順は OS で違う (ubuntu と macOS で前後が入れ替わる) ので、戻し方の誤りは片方の OS でだけ落ちる。

## webui

- component / hook は DOM 基盤 (happy-dom) でマウントし、effect の配線まで含めて検証する。pure 関数に切り出してテストするのは補助で、マウントでの検証の代わりにはしない。
- DOM を使う test file は冒頭で `withDom()` (`packages/webui/test/dom.ts`) を 1 度呼ぶ。そのファイルの間だけ happy-dom の window / document が globalThis に載り、終わると元に戻る。マウントは preact の `render` を `act` (`preact/test-utils`) で包み、effect まで流してから DOM と render 回数を見る (例: `use-store-state.dom.test.ts`)。
- 配線の正しさは happy-dom でマウントして確かめ、実ブラウザでしか起きない振る舞いは `just e2e` の試験 (下の「実ブラウザの試験」) で固定し、見た目は playwright (`/verify`) で確かめる。
- custom hook は `packages/webui/test/render-hook.ts` の `renderHook` で 1 つだけマウントし、戻り値と DOM を見る。hook に渡す ref の DOM は `extra` で同じ component の中に描く。
- Timeline とその hook (`components/timeline/`) は `packages/webui/test/timeline-harness.ts` を使う。`FakeTranscriptWs` が transcript 系の要求 (read / subscribe / fork_origin) を記録し、応答はテストが任意の時点で返す。store は本物を使い、応答が reducer を通って描画に届くまでを検証する。

## 実ブラウザの試験 (`just e2e`)

happy-dom では再現しない振る舞い (実際の入力のイベントの順序、ブラウザの既定の動作、CSS の効き方) を、chromium と webkit で固定する。

- 置き場は `packages/webui/e2e/*.e2e.ts`、実行は `just e2e`。bun test の書式なので `bun:test` の describe / test / expect で書く。`just test` (引数なしの bun test) はこの名前を拾わないので、`just e2e` が file を名指しして走らせる。bunfig.toml の preload (run ごとの TMPDIR、lifeline、`CCMSG_*` の除去) は同じく効く。CI と push の gate には入っていない
- 共通の部品は `packages/webui/e2e/harness.ts`: 隔離 daemon (`startWebui`、`packages/daemon/test/helpers.ts` の test daemon に HTTP を ephemeral port で足したもの)、ブラウザの一覧 (`BROWSERS`)、一覧に出すセッションの注入 (`fixturePeers` と `routePeers`。daemon の `peers` の行に、ページへ届く途中で足す。daemon 自身はセッションを持たないので、実セッションに何も届かない)。`startWebui` は daemon の config (`config`。例: 偽物の起動コマンドを置いた `session_launcher`) を受け取り、daemon の socket (`sock`) と HOME (`home`) を返す。transcript を持つセッションが要る試験は、`home` の下の config dir に transcript を書き、`sock` に試験自身が session として hello する (`packages/webui/e2e/btw.e2e.ts`)
- UNIX socket のパス: daemon には run の一時 dir の下の state dir をそのまま渡し、daemon はそこに socket を bind する。パスが sun_path を超えても、Bun は bind も connect も自分で扱う ([findings](./findings/2026-10-18-unix-socket-long-path-bun.md)) ので、短くする仕組みは持たない。playwright 自身の socket (`PWTEST_SOCKETS_DIR`) は playwright が深い dir を断るので、`/tmp` 直下の短い dir (`shortTmpDir`) を向ける。起動したブラウザとは pipe で話すので、ふつうは作られない
- ブラウザ本体は依存の playwright の版のものを使う。無ければ `just e2e-install` で取る
- macOS の画面のロック中は、WebKit の e2e にクリックやドラッグが届かない (playwright は「`<html>` intercepts pointer events」で待ち続けて timeout する。ボタン 1 つだけのページでも同じ。2026-11-24 に、ロック中は落ち、ロックを解くと同じページのクリックが通ることを確かめた。画面が消えている時も同じ形で落ちる: [findings](./findings/2026-11-22-webkit-e2e-click-after-display-sleep.md))。`just e2e` は試験の前に 1 度だけ画面の状態を読み (`packages/webui/e2e/screen-check.ts`)、消えているかロック中なら webkit の describe を `describe.skipIf` で流さず、終了コード 0 のまま最後に理由と飛ばした組の数を 1 行出す。chromium は流す。macOS 以外や状態を読めない時は全部流す。macOS では試験全体を `caffeinate -d` の下で走らせ、流している間は画面を消さない (`-u` は使わないので、消えている画面を点けはしない)。手で掛けたロックは防げないので、流している途中でロックすると WebKit の試験は落ちうる。WebKit の分を確かめるには、画面を点けロックを解いてから流し直す
- 要素は role・見出しや label の文字で選び、class 名に頼らない (DOM の組み立てが変わっても、振る舞いが同じなら通るように)
- 1 つの test は `E2E_TIMEOUT_MS` まで待つ (ブラウザの起動と、daemon の serve-time build を含む最初の読み込みが、preload の既定の timeout を超えるため)

## 名前と記述

- テスト名は「何を保証するか」を仕様の語彙で書く。
- 出典は DR 番号か `docs/findings/` のパスで書く。チャットの room 番号や mid はリポの外で解けないので書かない。
- 過去の実装やバグの経緯はテストに書かない (commit log と DR に残す)。テストには現在の契約だけを書く。
- 非 ASCII の制御文字 (NUL 等) をテストファイルに生で書かない。`"\0"` のようにエスケープで書く (生で書くと VCS が binary 扱いして diff が読めない)。

## lint

- テストファイルも本番と同じ規則で lint する。`.oxlintrc.json` にテスト向けの緩め (overrides / ignorePatterns) を置かない。
- `any`・型の主張・非 null の主張は使わず、値は `defined` / `propsOf` / `jsonObjectOf` (各 package の `test/helpers.ts`) で読む。

## カバレッジ

- `just coverage` の package 別下限 (`justfile` の `coverage-thresholds`) を下回らない。
- 下限は上げる方向にだけ動かす。テストを足して実測が上がったら下限も上げる。
- 計測方法・基準値・daemon の数字の読み方は [テストカバレッジの基準値](findings/2026-10-14-test-coverage-baseline.md)。

## flaky

- 「flaky」「たまに落ちる」で調査を打ち切らない。扱いは test-integrity と flaky-accountability に従う。
- `just test` が 1 回目だけ 1 件 timeout した件は原因未特定で、[just test で 1 件が 5 秒 timeout した](issue/2026-10-10-just-test-one-timeout-unidentified.md) で追う。同じ現象を見たら test 名と条件をこの issue に足す。
