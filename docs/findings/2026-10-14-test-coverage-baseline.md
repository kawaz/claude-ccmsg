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
- 実測は計測した bun の版に依存する (1.4.4 で await / 短絡 / 子プロセスの行の過大計上が直り、同じコードで cli は 90 → 84.67 に下がった)。下限を見直す時は CI と同じ bun の版で測る (CI は `bun-version: latest`)

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

## room の書き込みを削った後の下限 (2026-10-15)

DR-0036 §2 で room の書き込み・配送 (daemon の `storage.ts` と server.ts の room 系、webui の room の操作 UI) を削り、読み手 (`room-reader.ts`) と閲覧のテストを足した後の実測 (`just coverage`):

| package | lines % (前 → 後) | functions % (前 → 後) | 下限 (前 → 後) |
|---|---|---|---|
| protocol | 99.71 → 99.73 | 99.22 → 99.22 | 97 / 98 (据え置き) |
| daemon | 60.69 → 64.37 | 78.13 → 81.13 | 58 / 75 → 62 / 79 |
| cli | 89.17 → 89.82 | 86.75 → 86.75 | 84 / 85 → 87 / 85 |
| webui | 77.03 → 77.47 | 82.17 → 83.87 | 74 / 80 → 75 / 81 |
| hooks | 92.22 → 92.22 | 95.30 → 95.30 | 80 / 85 (据え置き) |

daemon の上がり幅の大半は、子プロセスの daemon 経由でしか通らなかった room 系のコードが分母から消えたことによる。下限は実測から 2 を引いて切り捨てた値にし、実測 − 2 が今の下限を下回る値 (protocol / cli の functions) は据え置いた。

## 同じプロセスの daemon と SessionView のマウントテストを足した後の下限 (2026-10-18)

wire 越しに op を確かめるテスト (fs-access / fs-find / transcript / session-status 等 13 ファイル) を、子プロセスの daemon から同じプロセスに立てた daemon (`startInProcessDaemon`) に移し、webui に SessionView をマウントするテストを足した後の実測 (`just coverage`):

| package | lines % (前 → 後) | functions % (前 → 後) | 下限 (前 → 後) |
|---|---|---|---|
| protocol | 99.72 → 99.72 | 99.18 → 99.18 | 97 / 98 (据え置き) |
| daemon | 64.79 → 82.00 | 81.67 → 89.70 | 62 / 79 → 80 / 87 |
| cli | 89.82 → 89.82 | 86.75 → 86.75 | 87 / 85 (据え置き) |
| webui | 77.47 → 74.18 | 83.87 → 81.19 | 75 / 81 → 72 / 79 |
| hooks | 92.27 → 92.27 | 95.30 → 95.30 | 80 / 85 (据え置き) |

daemon の上がり幅は、同じプロセスの daemon を通る `server.ts` の op の処理が計測に入ったことによる (子プロセスの daemon は計測されない)。webui は SessionView の import で StatusPanel / Timeline / FilesPanes 等が分母に入り、lines が 15856 → 17515 行に増えた (通った行も 12284 → 12993 に増えている)。webui は上の「分母の変化を見て置き直す」運用に従って実測 − 2 に置き直した。

## 直送の順序・hello だけの登録の忘却・config の構文エラー表示を足した後の下限 (2026-10-18)

`serial.ts` とその利用、`forgetUnlistedHellos`、config の構文エラーの読み取りと、それぞれのテストを足した後の実測 (`just coverage`):

| package | lines % | functions % | 下限 (前 → 後) |
|---|---|---|---|
| protocol | 99.72 | 99.19 | 97 / 98 (据え置き) |
| daemon | 82.09 | 90.10 | 80 / 87 → 80 / 88 |
| cli | 89.98 | 87.36 | 87 / 85 (据え置き) |
| webui | 75.55 | 82.24 | 73 / 80 (据え置き) |
| hooks | 92.31 | 95.30 | 80 / 85 (据え置き) |

実測 − 2 を切り捨てた値が今の下限を上回ったのは daemon の functions だけ。

hooks の下限は、上の規則どおり実測 (2026-10-18 の `just coverage` で lines 92.30 / functions 95.30) − 2 を切り捨てた 90 / 93 に上げた。

## bun 1.4.4 での現在値 (2026-10-23)

bun 1.4.4 の `bun test --coverage` は、実行されなかった行を covered と数えていたものを数えなくなった (await / yield の後で再開しなかった関数の後続行、`||` `&&` `??` `?:` の飛ばした側)。CI の bun が 1.4.3 → 1.4.4 に上がっただけで、cli の lines は 89.98 → 84.67 に下がり下限 87 を割った (コードは同じ)。落ちた行は、e2e が起動する子プロセスの CLI の中でしか走らない daemon を起こさない接続の分岐だった。それらの拒否・切断の分岐をテストプロセスの中で叩くテスト (`packages/cli/test/client-no-spawn.test.ts`) を足した後の、CI と同じ bun 1.4.4 (38afee6c8)、macOS での実測:

| package | lines % | functions % | 下限 |
|---|---|---|---|
| protocol | 99.61 | 99.07 | 97 / 98 |
| daemon | 82.53 | 88.56 | 80 / 88 |
| cli | 91.95 | 90.28 | 87 / 85 |
| webui | 78.40 | 83.19 | 74 / 80 |
| hooks | 92.35 | 95.60 | 90 / 93 |

同じテストを bun 1.4.2 で測ると cli は 96.59 / 91.01 で、版の差は cli で約 5 ポイントある。下限は据え置き。
