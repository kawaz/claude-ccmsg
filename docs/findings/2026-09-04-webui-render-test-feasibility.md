# webui コンポーネントの render/DOM テスト基盤の実現可能性調査

## 判明した事実

- 現行実行方法はルート `package.json` の `test: "bun test"`。`packages/webui/package.json` には test script も DOM test 依存も存在しない。
- `packages/webui/tsconfig.json` は `jsx: "react-jsx"`, `jsxImportSource: "preact"`, DOM lib 有り。`include` は `test/**/*.ts` のみで `.tsx` の test ファイルは含まれない。
- Web UI の既存 test suite は全 69 ファイルが `.ts`。`FileIcon.tsx` / `markdown-view.tsx` / `CodeBlock.tsx` 等の `.tsx` から pure 関数を import する test は既にあり、`.tsx` からの import 自体は可能。
- 全 Web UI suite の実行結果: 1924 pass / 0 fail、69 files。
- リポ外の scratch から `Timeline.tsx` を absolute import して `bun test` すると `Cannot find module 'react/jsx-dev-runtime'` で `0 pass / 1 fail / 1 error`。scratch に `tsconfig.json` (`jsx: react-jsx`, `jsxImportSource: preact`, `moduleResolution: bundler`) を置いて同じ test を実行すると `1 pass / 0 fail Ran 1 test across 1 file. [163.00ms]`。
  - この結果から、第一原因は DOM 不在でも import 連鎖の問題でもなく、**test の設定探索境界** (呼び出し側の JSX transform 設定が Web UI の tsconfig を採用しない) であることが判明した。Preact JSX 設定を適用すれば `Timeline` の import 連鎖全体が成功し、import 時には DOM global を参照しない。
- PoC A (`happy-dom` + `@testing-library/preact`): `preact@10.29.7`, `happy-dom@20.11.1`, `@testing-library/preact@3.2.4` を scratch に導入し、`happy-dom` の `Window` から `document`/`navigator`/`location`/`HTMLElement`/`Node` を `globalThis` に設定。stateful button を render → `fireEvent.click` → DOM 更新を検証した結果は `1 pass / 0 fail / 2 expect() calls`。interactive な DOM test が実際に動作した。
- PoC B (`preact-render-to-string`): `preact-render-to-string@6.6.6` で静的 HTML 化するテストは `1 pass / 0 fail`。
- PoC C (DOM shim なしの Preact client render, 対照実験): `ReferenceError: document is not defined` で `0 pass / 1 fail`。
- `happy-dom` はルート `node_modules` に transitive 依存として存在するが、`bun.lock` に直接 entry はなく manifest に未宣言。`@testing-library/preact` と `preact-render-to-string` はルート `node_modules` に存在しない。

## 実用的な示唆

- open-close / effect の回帰保護を目的とするなら PoC A (`happy-dom` + `@testing-library/preact`) が目的に適合する。PoC B (`preact-render-to-string`) は静的 HTML の snapshot 用途に限られ、click / focus / document listener / 再描画といった interactive な検証はできないため、issue が挙げる `SessionView` / `RoomComposerFab` / `OneOnOneComposer` / `Timeline` の open-close 遷移テストの主目的には不足する。
- 導入するなら変更範囲は概算で: `packages/webui` に devDependency 2 件 (`happy-dom`, `@testing-library/preact`) の追加、Bun preload/setup 用ファイル 1 個、`bunfig` か test invocation への設定追加 1 箇所、`tsconfig.json` の `include` を `test/**/*.tsx` まで拡張、初回の component test 追加。設定自体は 10〜25 行程度。
- `Timeline` は `AppContext` (Store + WsHandle)、`location`、`matchMedia`、`document` イベント、多数の props を要求するコンポーネントであり、実際の fixture/helper は 50〜150 行程度になる見込み。browser API shim の不足や cleanup / global isolation が懸念点になる。

## 検証の詳細

### Timeline import の再現

リポ外 scratch から absolute import して `bun test` (Web UI 設定の外):

```
error: Cannot find module 'react/jsx-dev-runtime' from '.../packages/webui/src/client/components/Timeline.tsx'
0 pass / 1 fail / 1 error
```

scratch に `tsconfig.json` (`jsx: react-jsx`, `jsxImportSource: preact`, `moduleResolution: bundler`) を置いて同じ test を再実行:

```
1 pass / 0 fail  Ran 1 test across 1 file. [163.00ms]
```

### PoC A. happy-dom + @testing-library/preact

`preact@10.29.7`, `happy-dom@20.11.1`, `@testing-library/preact@3.2.4` を scratch に導入。`happy-dom` の `Window` から `document` / `navigator` / `location` / `HTMLElement` / `Node` を `globalThis` へ設定し、stateful button を render → `fireEvent.click` → DOM 更新を検証:

```
1 pass / 0 fail / 2 expect() calls
```

interactive な DOM test が実動することを確認した。

### PoC B. preact-render-to-string

`preact-render-to-string@6.6.6` で静的 HTML 化:

```
1 pass / 0 fail
```

click / effect / focus / document listener / 再描画の検証はできず、issue の主目的には不足する。静的分岐・markup の test に用途が限られる。

### PoC C. DOM shim なしの Preact client render (対照)

```
ReferenceError: document is not defined
0 pass / 1 fail
```

### 根本原因の整理

1. `jsx-dev-runtime` エラーの直接原因は、リポ外 scratch test に Web UI の Preact JSX 設定が適用されないこと。
2. `packages/webui/test` 配下に置けば package の tsconfig が持つ Preact transform が適用される。
3. component の client render に進むと Bun は DOM を提供しないため `document is not defined` となる。`happy-dom` / `jsdom` 等の DOM shim が必要。
4. `Timeline` 固有の fixture complexity (`useApp()` の Provider、store/ws、location、matchMedia 等) は import 障害とは独立した課題。

## 未確認事項

- 実際の `Timeline` に `Provider` / `Store` / `WsHandle` の fixture を組んで mount を完走させること。
- `happy-dom` で `Timeline` が使用する全 API (`matchMedia`, layout/scroll measurement, `ResizeObserver` 等) を満たせるか。
- `jsdom` 案、および Playwright / vitest browser mode の実 PoC と CI 実行時間の比較。
- TypeScript 7 で新規 `.tsx` の test/setup ファイルの typecheck が完全に通るか。
