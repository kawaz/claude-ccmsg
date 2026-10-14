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
- JSON を文字列のまま assert しない。行はスキーマか `jsonObjectOf` で読んでから比較する。
- transcript / room の行は `packages/protocol/test/transcript-rows.ts` のビルダーで作る。テストごとに行の形を手書きしない。
- 送信されたフレームは op で引く。何番目か・何件目かで固定しない。
- 1 テスト 1 daemon (子プロセス起動) は統合テストにだけ使う。op の挙動は in-process (`packages/daemon/test/drive-request.ts` の `stubDaemon`) で書く。

## 決定性

- 「起きないこと」は sleep で待って主張しない。marker の round-trip (`readEventUntil` 等) で順序づけた後に、溜まったイベントやファイルを読んで主張する。
- 時間に依存するコードは clock を注入する (`hooks/composer-fill.ts` の `Engine.clock` と同型)。テストは実時間を待たない。実時間の待ちは外部プロセスの観測だけに使い、deadline 付きの retry にする。
- ポートは `0` で取る。固定ポートを書かない。
- 一時ディレクトリは `mkdtemp` で作り、テストの後で消す。
- テストが起動する daemon の `CCMSG_*` は全部テスト側で固定し、開発者の shell から継承しない。
- グローバル (`WebSocket` 等) の差し替えは `packages/webui/test/helpers.ts` の `stubGlobal` で行い、`afterEach` で戻す。bun test は全ファイルを 1 プロセスで走らせるので、戻し忘れは別ファイルのテストを壊す。
- bun の runtime に無い `localStorage` / `sessionStorage` は helpers.ts の `MemStorage` を `stubGlobal` で生やし、`afterEach` で戻す。代入で生やしたままにすると、テストが書いた値 (`ccmsg.sidebarOpen` 等) が後に走るファイルの初期状態に入る。
- DOM の prototype (`HTMLElement.prototype` の `clientHeight` 等) の差し替えは同じ helpers.ts の `stubProperty` で行い、元の記述子に戻す。happy-dom の class は `withDom` の登録をまたいで同じなので、`delete` で消すと happy-dom 自身の定義まで消え、後に走るファイルで値が `undefined` になる。ファイルの実行順は OS で違う (ubuntu と macOS で前後が入れ替わる) ので、戻し方の誤りは片方の OS でだけ落ちる。

## webui

- component / hook は DOM 基盤 (happy-dom) でマウントし、effect の配線まで含めて検証する。pure 関数に切り出してテストするのは補助で、マウントでの検証の代わりにはしない。
- DOM を使う test file は冒頭で `withDom()` (`packages/webui/test/dom.ts`) を 1 度呼ぶ。そのファイルの間だけ happy-dom の window / document が globalThis に載り、終わると元に戻る。マウントは preact の `render` を `act` (`preact/test-utils`) で包み、effect まで流してから DOM と render 回数を見る (例: `use-store-state.dom.test.ts`)。
- 配線の正しさは happy-dom でマウントして確かめ、見た目と実ブラウザでの振る舞いは playwright (`/verify`) で確かめる。
- custom hook は `packages/webui/test/render-hook.ts` の `renderHook` で 1 つだけマウントし、戻り値と DOM を見る。hook に渡す ref の DOM は `extra` で同じ component の中に描く。
- Timeline とその hook (`components/timeline/`) は `packages/webui/test/timeline-harness.ts` を使う。`FakeTranscriptWs` が transcript 系の要求 (read / subscribe / fork_origin) を記録し、応答はテストが任意の時点で返す。store は本物を使い、応答が reducer を通って描画に届くまでを検証する。

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
