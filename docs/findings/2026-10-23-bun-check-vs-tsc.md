# bun check と tsc / oxlint の型検査の比較

- Date: 2026-10-23

## 判明した事実

- 名前は `bun check` (サブコマンド)。Bun 1.4.3 (2026-10-10) で追加された。同じ検査器を `bun run --check` / `bun test --check` / `bun build --check` / `bun --check <file>` / `Bun.build({ check: true })` からも呼べる。typescript-go の port で、型検査だけを行う (JavaScript / `.d.ts` / `.tsbuildinfo` を書かない、language server は無い、tsconfig の `plugins` は無視)
- 手元の bun 1.4.2 では `bun check` は `Error: Script not found "check"` で exit 1 になる。`bun run --check` / `bun test --check` は**黙って無視され**、型エラーのあるファイルがそのまま実行されて exit 0 になる (1.4.4 では同じファイルが TS2322 で exit 1)
- bun 1.4.4 の `process.versions.typescript` は `7.0.2`。このリポの devDependencies の `typescript` も `7.0.2` (`bun x tsc --version` は `Version 7.0.2`)
- このリポでは、tsc と bun check (1.4.4) が読むファイルの集合は一致した (root の tsconfig で 519 件、`packages/webui` の tsconfig で 1151 件。違いは標準ライブラリの d.ts のパス表記 `bundled:///libs/...` だけ)
- わざと入れた 9 件の型エラー (7 種、下の表) に対して、`tsc --pretty false` と `bun check --no-pretty` の標準出力は**バイト単位で一致**した。bun 1.4.3 と 1.4.4 のどちらも一致。構文エラーがある時に型検査まで進まず TS1109 の 1 件だけを出す挙動も一致した
- `as` / `any` / `!` (DR-0038 で禁止しているもの) は tsc も bun check も検出しない (型エラーではない)。検出するのは oxlint の `typescript/consistent-type-assertions` / `no-explicit-any` / `no-non-null-assertion` だけ
- oxlint は `.oxlintrc.json` の `"typeCheck": true` により TypeScript の診断も出している。注入した 9 件の型エラーを oxlint も全部 (同じ TS コード・同じ位置で) 報告した。`just typecheck` は `lint` に依存しているので、今の構成では**同じ型エラーを oxlint と tsc が 2 回出している**。oxlint の `--help` はこの機能を「Enable experimental type checking (includes TypeScript compiler diagnostics)」と書いている
- 速度 (macOS、10 コア、他のセッションが動いていて load average 10〜35 の中での計測): tsc 2 本は 1.27 s、bun check 2 本は 0.34 s。`just typecheck` 全体は 5.68 s で、tsc の 2 行を bun check に差し替えると 4.84 s (差 0.85 s、15 %)。`just typecheck` の残り 4.5 s は `just lint` (oxlint だけで 1.8 s、そのうち typeCheck の分が 0.5 s)
- 1 回の呼び出しで両方の tsconfig を検査するには `bun check . packages/webui` (2 projects、508 files、9 件全部を報告)。`bun check .` だけだと root の tsconfig しか使わず、webui の client の型エラーは出ない
- 出力形式: パイプでは tsc と同じ 1 行 1 診断 (ANSI なし)。`CLAUDECODE=1` (Claude Code の Bash の中) では `<error file=... line=... code=...>` のタグ形式になる。`GITHUB_ACTIONS=true` では 1 行形式に加えて `::error file=...` の注釈を出す。要約行は stderr
- `.claude-plugin/types/` の claude-code の d.ts はどちらの tsconfig の include にも入っておらず、hooks は必要な型を自前で宣言している (`hooks/engine.ts`)。この d.ts は tsc でも bun check でも検査されないので、差は生じない
- package.json の scripts に `check` は無いので、`bun check` が script に shadow される問題 (1.4.4 で `--no-script` が追加された件) は当たらない

## 実用的な示唆 / ベストプラクティス

### 3 案の比較

| 軸 | (a) tsc のまま | (b) bun check に統一 | (c) 並行 |
|---|---|---|---|
| 検出 | 基準 | このリポでは tsc と一致 (9/9、バイト一致) | 一致するので増えない |
| 速度 (`just typecheck`) | 5.68 s | 4.84 s | tsc + bun check で (a) より 0.3 s 程度遅くなる (未計測、2 本の和からの見積もり) |
| 検査器の版 | `typescript` を bun.lock で 7.0.2 に固定。bun を上げても結果は変わらない | bun の版に連動。CI は `bun-version: latest` で固定されていない | 両方 |
| 手元 (bun 1.4.2) | 動く | `bun check` が exit 1 で動かない | 動かない |
| 依存 | `typescript` を使う | `typescript` は外せない (oxlint の type-aware が TypeScript 7 以上を要求し、エディタも使う)。依存は減らない | 同左 |
| 移行コスト | 0 | justfile 2 行、手元の bun を 1.4.3 以上に上げる | justfile 1〜2 行 |

各案の長所の由来:

- (a) の長所 (結果が bun の版から独立) は「型検査を lockfile で固定した tsc で行う」ことから来る
- (b) の長所 (速度) は「tsc を走らせない」ことから来る
- 2 つは同じ事柄 (tsc を走らせるか) の表と裏で排他。(c) は tsc を残すので速度の長所が消え、bun の版に連動する検査が増えるので (b) の短所は残る。(c) で得られるのは「2 つの実装の食い違いの検出」だけで、bun は「差があれば Bun の bug」と言っており、それを見つけるのはこのリポの品質の役に立たない

### 推奨: (a) tsc のまま

根拠 (実測):

- 検出に差が無い。9 件の型エラーで出力がバイト一致し、読むファイルの集合も一致した。bun check に替えて新しく捕まるものは無い
- 得は `just typecheck` 1 回あたり 0.85 s。`just test` (約 170 s、docs/findings/2026-10-14-test-coverage-baseline.md) と比べると 0.5 % で、CI の所要時間はほぼ変わらない
- 代わりに型検査の結果が bun の版に連動する。bun 1.4.4 の release notes だけで bun check の誤検知・見逃しの修正が 20 件前後あり、TS2321 については「follows TypeScript 7.1」として 7.0.2 と違う判定に変わった。CI の bun は `latest` なので、bun の更新だけで型検査の合否が変わりうる。1.4.4 で coverage の数字が変わった前例 (docs/findings/2026-10-14-test-coverage-baseline.md) と同じ形のリスク
- 手元の bun 1.4.2 では動かない

(b) を選び直す条件: 手元の bun が 1.4.3 以上になり、かつ CI の bun の版を固定する (または bun の更新で型検査の結果が変わることを受け入れる) と決めた時。その時は (b) の短所のうち 2 つ (手元で動かない、版が非固定) が消え、速度とエージェント向けの出力形式が残る。移す時は `bun check . packages/webui` の 1 行にできる。

### 付随して分かったこと (統括の判断材料)

- 型検査の重複は tsc と bun check の間ではなく、**tsc と oxlint の `typeCheck` の間に既にある**。どちらかを外せば重複は消える。oxlint 側は experimental と明記されているので、tsc を外して oxlint に寄せるかは別の判断 (本 findings では評価していない)
- CI は `Lint` step で `just lint` を、`Typecheck` step で `just typecheck` (= `lint` を依存として再実行してから tsc) を走らせているので、lint が 2 回走っている (justfile と `.github/workflows/ci.yml` を読んだ観測。時間にして 1 回あたり約 4.5 s)
- `bun run --check` / `bun test --check` を使う場合、1.4.3 未満の bun では黙って無視されて green になる。使うなら bun の版の下限を固定するか、`bun check` (古い版では exit 1 で落ちる) の方を使う

## 検証の詳細

### 計測条件

| 項目 | 値 |
|---|---|
| 手元の bun | 1.4.2 (`bun check` なし) |
| 比較に使った bun | 1.4.3 / 1.4.4 (npm の `bun` パッケージを一時ディレクトリに入れたもの) |
| tsc | 7.0.2 (`node_modules` の `typescript`) |
| oxlint / oxlint-tsgolint | 1.73.0 / 0.24.0 |
| OS / CPU | macOS (Darwin 25.5.0)、10 コア |
| 対象 | `b1e0876c` の tree の複製 (注入は複製にだけ行った) |
| ubuntu (CI) | 未検証 |

### 一次資料

- bun 1.4.3 release notes (https://bun.com/blog/bun-v1.4.3): 「bun check is an incredibly fast TypeScript type checker that passes 100% of TypeScript 7.0.2's conformance test suite.」「It's a port of typescript-go.」「It reads your `tsconfig.json`, reports the same errors as `tsc`, and uses every CPU core.」「there's no language server, so your editor keeps using TypeScript.」
- bun 1.4.4 release notes (https://bun.com/blog/bun-v1.4.4): 「`bun check` follows TypeScript 7.1 and no longer reports TS2321.」のほか、誤検知 (TS18046 / TS7006 / TS2589 / TS2615 / TS2344 など) と見逃し (TS2322 / TS2367 / TS2502 / TS2540 など) の修正が並ぶ。「`bun check --no-script` runs the type checker even if `package.json` has a `check` script.」
- docs (https://bun.com/docs/runtime/check): 「`bun check` exits with code `1` if it finds an error and `0` if it finds none. It never writes files.」「`bun check` ignores the `plugins` compiler option.」「If there's nothing to check, `bun check` exits with code `1`.」project references は `-b` で `tsc -b` 相当
- oxlint の type-aware の docs (https://oxc.rs/docs/guide/usage/linter/type-aware): 「This mode can replace a separate `tsc --noEmit` step in CI」「TypeScript **7.0+** is required」

`bun check --help` (1.4.4) の実出力の冒頭:

```
Usage: bun check [flags] [...files or directories]
  Type check a TypeScript project.

  Uses the nearest tsconfig.json and reports the same errors as tsc, using all CPU cores.
  Pass files or directories to check only those and their imports.
  Project references are followed, like tsc -b, and nothing has to be built first.
```

### 注入した型エラーと検出

複製の tree に追記し、`tsc --noEmit --pretty false -p <tsconfig>` と `bun check --no-pretty -p <tsconfig>` と `oxlint` を走らせた。

| # | 種類 | 場所 | 診断 | tsc | bun check 1.4.3 / 1.4.4 | oxlint |
|---|---|---|---|---|---|---|
| E1 | 単純な代入の型違い | packages/cli | TS2322 | 検出 | 検出 | 検出 |
| E2 | `noUncheckedIndexedAccess` (`a[0]` を `string` で返す) | packages/cli | TS2322 | 検出 | 検出 | 検出 |
| E3 | workspace の package 間参照 (`@ccmsg/protocol/address` の関数に数値を渡す、`paths` 経由) | packages/cli | TS2345 | 検出 | 検出 | 検出 |
| E4 | valibot の `v.InferOutput` (picklist の外の文字列) | packages/webui client | TS2322 | 検出 | 検出 | 検出 |
| E5 | Preact の JSX (`<Avatar seed={42} size="big" />`) | packages/webui client | TS2322 × 2 | 検出 | 検出 | 検出 |
| E6 | hooks の自前の型 (`SpawnEnd` の `code` に文字列) | hooks | TS2322 | 検出 | 検出 | 検出 |
| E7 | `noUnusedLocals` | packages/cli | TS6133 | 検出 | 検出 | 検出 (+ `no-unused-vars`) |
| E8 | `as` / `any` / `!` | packages/cli | (型エラーではない) | 検出しない | 検出しない | 検出 (4 規則 + `no-unsafe-return`) |
| E9 | 解決できない import | packages/daemon | TS2307 | 検出 | 検出 | 検出 |
| E10 | 構文エラー | packages/protocol | TS1109 のみ (他の型エラーは出さない) | 検出 | 検出 | 未検証 |

tsc と bun check の標準出力は E10 を入れた状態・外した状態の両方で `cmp` が一致した。

### 速度

hyperfine で計測。他のセッションが同時に動いていて load average が 10〜35 だったので、絶対値には揺れがある。同じ回の中での比較として読む。

| コマンド | 平均 ± σ |
|---|---|
| `bun x tsc --noEmit` | 787 ms ± 29 ms |
| `bun check` (root) | 174 ms ± 43 ms |
| `bun x tsc --noEmit -p packages/webui` | 850 ms ± 44 ms |
| `bun check -p packages/webui` | 150 ms ± 33 ms |
| tsc 2 本 (justfile と同じ組) | 1.265 s ± 0.045 s |
| bun check 2 本 | 0.343 s ± 0.103 s |
| `oxlint` (`typeCheck: true`、今の設定) | 1.804 s ± 0.058 s |
| `oxlint` (`typeCheck: false` にした設定) | 1.304 s ± 0.032 s |
| `just lint` | 4.530 s ± 0.054 s |
| `just typecheck` (今の justfile) | 5.684 s ± 0.093 s |
| `just typecheck` (tsc の 2 行を bun check に差し替え) | 4.839 s ± 0.088 s |

`bun check --timing` の内訳 (root): 519 files を 38.8 ms で読み込み、256 files を 108.8 ms で検査。

### 出力に ANSI の色が混ざる条件

| 条件 | bun check | tsc |
|---|---|---|
| パイプ | なし | なし |
| パイプ + `FORCE_COLOR=1` | なし | あり |
| 端末 (`script` で模した) | あり | あり |
| `CLAUDECODE=1` | なし (タグ形式) | (該当なし) |
