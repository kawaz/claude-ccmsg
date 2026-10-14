# テストカバレッジの基準値 (bun test --coverage)

- Date: 2026-10-14

## 判明した事実

- Bun 1.4.2 の `bun test --coverage` は text の要約と lcov (`coverage/lcov.info`) を出せる。設定は `bunfig.toml` の `[test]` に置く (`coverageReporter` / `coverageDir` / `coverageSkipTestFiles` / `coveragePathIgnorePatterns` / `coverageThreshold`)。`--coverage` を付けない `bun test` は計測しないので、設定を置いても `just test` の挙動は変わらない
- `coverageThreshold` は**ファイル単位**で判定される。集計行 (`All files`) が閾値を上回っていても、1 ファイルでも下回れば exit 1 になる。下回ったファイル名や理由は出力されない (exit code だけが変わる)
- text 要約の `All files` 行はファイルごとの % の単純平均で、行数で重み付けした合計ではない (同じ計測で `All files` は lines 85.40% / functions 86.83%、lcov の合計は lines 73.47% / functions 84.72%)
- 計測対象はテストのプロセス内で import されたファイルだけ。テストが子プロセスとして起動する daemon (`daemon run`) と CLI の実行経路は計測されない。そのため `packages/daemon/src/server.ts` / `http.ts` は低く出て、`packages/cli/src/index.ts` は一覧に現れない
- `bunfig.toml` に `coverageDir` があると、CLI の `--coverage-dir` を渡しても `coverageDir` 側に出力された
- `just coverage` (lint・typecheck 込み) は 182 秒、`just test` は 169 秒。テスト本体はどちらも約 170 秒で、計測によるテスト時間の増加は誤差の範囲

## 実用的な示唆 / ベストプラクティス

- package 単位で「下がったら落とす」には `coverageThreshold` は使えない (今の時点で 0% のファイルがあり、ファイル単位の閾値は 0 にするしかない)。そこで `just coverage` が `coverage/lcov.info` を package 別に合計し (LH/LF・FNH/FNF)、justfile の `coverage-thresholds` と比べる (`_coverage-check`)
- 下限は実測値から 2 ポイント引いて切り捨てた値にした。テストを足して実測が上がったら下限も上げる
- daemon の数字はサブプロセス経由で検証されている部分を含まない。daemon の low coverage ファイルの中には、統合テストで実際には通っているものがある (server.ts など)。in-process で叩けるように切り出すか、子プロセス側も計測する仕組みを作るまで、daemon の % は「in-process の単体テストが届く範囲」と読む
- 下限は macOS の実測から決めたので、CI では macOS の job だけ `just coverage` を走らせ、ubuntu の job は従来どおり `just test` にしている

## 検証の詳細

### 計測条件

| 項目 | 値 |
|---|---|
| bun | 1.4.2 |
| OS | macOS (Darwin 25.5.0) |
| 対象 commit | `ebc62771` のスナップショット (作業中の別変更を含まない状態) に今回の bunfig.toml / justfile を載せたもの |
| テスト結果 | 4002 pass / 2 skip / 0 fail (183 files)。skip 2 件は translate-helper の実バイナリ (`packages/translate-helper/.build/`、git 管理外) が無い時に飛ぶテスト |
| 計測から除外 | テストファイル (`coverageSkipTestFiles`)、`packages/*/test/**` (テストの helper)、`packages/testkit/**`、`hooks/*.bundle.js` (bundle 生成物)、`../**` (テストが一時ディレクトリに書いて import する config ファイル) |

### package 別 (lcov の合計)

| package | ファイル数 | lines | lines % | functions | functions % | 下限 lines / functions |
|---|---|---|---|---|---|---|
| protocol | 39 | 2800 / 2807 | 99.75 | 117 / 117 | 100.00 | 97 / 98 |
| daemon | 56 | 7347 / 12214 | 60.15 | 773 / 996 | 77.61 | 58 / 75 |
| cli | 3 | 355 / 410 | 86.59 | 50 / 57 | 87.72 | 84 / 85 |
| webui | 77 → 101 | 7768 / 9514 → 72.04% | 81.65 → 72.04 | 1026 / 1154 → 81.59% | 88.91 → 81.59 | 70 / 79 |
| hooks | 4 | 488 / 588 | 82.99 | 86 / 98 | 87.76 | 80 / 85 |

### 未カバー行数の多いファイル上位 10

| ファイル | lines % | 未カバー行 | functions % |
|---|---|---|---|
| packages/daemon/src/server.ts | 19.86 | 2018 | 33.33 |
| packages/daemon/src/fs-access.ts | 26.45 | 648 | 59.38 |
| packages/daemon/src/transcript.ts | 26.55 | 343 | 36.67 |
| packages/webui/src/client/markdown-view.tsx | 71.63 | 335 | 91.53 |
| packages/daemon/src/session-status.ts | 74.60 | 334 | 82.11 |
| packages/daemon/src/http.ts | 3.25 | 238 | 0.00 |
| packages/webui/src/client/useDraggable.ts | 15.38 | 209 | 57.14 |
| packages/daemon/src/agents.ts | 20.67 | 165 | 26.67 |
| packages/webui/src/client/rendered-text-search.ts | 28.07 | 164 | 48.00 |
| packages/webui/src/client/navigation.ts | 43.22 | 155 | 65.52 |

### lines % の低いファイル上位 10

| ファイル | lines % | lines | functions % |
|---|---|---|---|
| packages/daemon/src/session-rename.ts | 0.00 | 0 / 133 | 66.67 |
| packages/webui/src/client/useJsonStringCopy.tsx | 2.52 | 3 / 119 | 0.00 |
| packages/daemon/src/http.ts | 3.25 | 8 / 246 | 0.00 |
| packages/daemon/src/fs-find.ts | 5.03 | 8 / 159 | 0.00 |
| packages/webui/src/client/components/CodeBlock.tsx | 5.45 | 3 / 55 | 0.00 |
| packages/webui/src/client/useFabPopup.ts | 6.50 | 8 / 123 | 50.00 |
| packages/webui/src/client/components/CopyButton.tsx | 7.58 | 5 / 66 | 50.00 |
| packages/webui/src/client/components/ImageLightbox.tsx | 8.89 | 4 / 45 | 0.00 |
| hooks/deadline.ts | 10.00 | 1 / 10 | 0.00 |
| packages/webui/src/client/useDraggable.ts | 15.38 | 38 / 247 | 57.14 |

考察: 下位はおおむね 2 種類に分かれる。daemon の server.ts / http.ts / fs-find.ts は子プロセスの daemon 経由でしか通らない経路、webui の hook / component (useDraggable・useFabPopup・CopyButton 等) は DOM のイベントに依存する部分で、今のテストは純関数を切り出した部分を中心に検証している。

### coverageThreshold がファイル単位であることの確認

`hooks/` のテストだけを `--coverage` で走らせ (集計行: functions 58.26% / lines 78.81%、最小ファイルは lines 2.63%)、閾値を変えて exit code を見た。

| coverageThreshold | exit |
|---|---|
| lines 0.0 / functions 0.0 | 0 |
| lines 0.02 / functions 0.0 | 0 |
| lines 0.03 / functions 0.0 | 1 |
| lines 0.3 / functions 0.0 | 1 |
| lines 0.0 / functions 0.55 | 1 |

考察: 集計行の lines 78.81% より遥かに低い 0.03 で落ち、最小ファイルの 2.63% を境に合否が変わる。判定はファイルごとの最小値に対して行われている。

### 実行時間

| コマンド | 時間 | 内訳 |
|---|---|---|
| `just test` | 169.3 秒 | テスト本体 164.9 秒 |
| `just coverage` | 182.1 秒 | テスト本体 171.8 秒 |

## webui の下限の見直し (2026-10-14、v0.168.0)

happy-dom のマウントテスト (use-store-state / file-tree-favorites / room-view-draft) を足した結果、それまで計測対象に入っていなかった component (ErrorView / SearchBar / FileSearchPanel / CodeBlock / CopyButton / ImageLightbox / avatar / ComposerAttachments / FileViewer 等) が import されて分母に入り、webui の計測対象が 77 → 101 ファイル、lines が 81.65 → 72.04% になった。テストが減ったのではなく分母が増えた。下限を 70 / 79 に置き直す。マウントテストが増えるほど分母が先に増えるので、webui の下限は当面「下がったら上げ直す」でなく「分母の変化を見て置き直す」運用。
