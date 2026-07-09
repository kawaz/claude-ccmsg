# 2026-07 時点の TS lint / 型検査ツール動向 (claude-ccmsg 向け)

claude-ccmsg での TS lint / formatter / typecheck ツール選定にあたり、2026-07 時点の oxlint / oxfmt / Biome / TypeScript 7 (native port) の動向を調査した結果。

## 判明した事実

1. **oxlint に type-aware linting が alpha として搭載された** (2025-12-08 発表)。2026 前半で対応ルール数が拡充し、61 ルール中 59 ルールをサポートするに至った。実装は `tsgolint` (typescript-eslint/tsgolint プロトタイプを oxc org に移管) で、内部で `typescript-go` (= TypeScript 7 のコンパイラ) を呼び出す。
2. oxlint の type-aware 有効化は `.oxlintrc.json` に `"options": { "typeAware": true, "typeCheck": true }` を設定するか、CLI で `oxlint --type-aware` を渡す。type-aware は root config でのみ設定可能。
3. **oxfmt** は Prettier drop-in を目指す alpha のフォーマッタで、JS/TS/JSON/YAML/TOML/Markdown/CSS 等をサポートする。「Prettier と 100% 同一出力」は公式ドキュメント上も保証されていない。
4. oxlint / oxfmt の速度は、公式・第三者記事いずれも oxlint が ESLint の 50〜100倍、Biome の約 2倍、oxfmt が Prettier の 30倍、Biome format の約 2倍と記載している (2026-03 時点で oxlint 1.50.0+ / oxfmt 0.36.0+、以降も更新継続中であることまでは確認できたが、2026-07 時点の正確なバージョン番号は特定できていない)。
5. **Biome v2.4** (2026 年最初の minor リリース) は、TS コンパイラに依存しない独自の型推論による type-aware lint を提供する初の linter を自称している。v2.4 では推論精度・resolver 修正・crash 対策などが強化された。2026 年のロードマップは plugin system・embedded language・TS 型推論拡張が中心とされている。
6. **TypeScript 7.0** は 2026-04-21 に Beta、2026-06-18 に RC が発表された。**同日夕方の導入作業時に GA 済みであることを実機確認**: `bun pm view typescript dist-tags` で `latest: "7.0.2"` (リリース 2026-07-08)。当リポは 7.0.2 exact pin で導入済み、`tsc --noEmit` 実測 0.13 秒。
   - GA 版での実機発見: `tsconfig.json` の `baseUrl` が完全削除され (TS5102)、`paths` の非相対パスも禁止。`paths` を `./` 始まりの相対に書き換える必要があった (意味は不変)。
7. TS7 の native port バイナリとして別名で提供されていた `tsgo` / `@typescript/native-preview` は Beta/nightly 限定であり、RC 以降は `typescript@rc` パッケージの通常の `tsc` コマンドがそのまま Go-native 実装 (typescript-go) として動作する。
8. TS7 の速度は TS 6.0 比で概ね 10倍、型検査ロジックは 6.0 と構造的に同一 (methodical port) で意味論は変更されていないとされている。
9. `bun x tsc --noEmit` は OS ネイティブバイナリを呼ぶ形で `typescript@rc` でも動作し、既存 `tsconfig` をそのまま利用できるとされている。

## 実用的な示唆

- **linter**: **oxlint (type-aware 有効化) + oxfmt** の一本化を推奨。次点は Biome v2.4。ESLint + typescript-eslint は greenfield では選ばない。
- **typecheck**: `typescript@rc` の `tsc` (= TypeScript 7.0 RC) への移行を今すぐ検討できる段階。当リポの `bun x tsc --noEmit` はパッケージを `typescript@rc` に差し替えるだけで済む見込み。ただし RC 段階のため、GA 前の突然のバージョン更新で CI が落ちる余地があり、`^` 範囲指定を避けてピン止めするのが無難。
- **formatter**: linter を oxlint に倒すなら oxfmt で揃えるのが定石。当リポは現状 formatter 未導入のため、oxfmt 採用でも失うものが無く導入コストが最も低い。ただし oxfmt は alpha で Prettier 完全互換ではない点に留意する。
- 導入する場合の段階案: (1) `typescript@rc` へ差し替え → (2) oxlint を type-aware オフで導入し既存警告を掃除 → (3) type-aware オン → (4) oxfmt 導入 (初回全整形コミットが 1 度発生) → (5) GA 後に `typescript@^7` の patch 固定へ切替。
- 導入前に `npm view oxlint version` / `npm view oxfmt version` で 2026-07 時点の正確なバージョンを確認する (本調査では 2026-03 時点の 1.50.0 / 0.36.0 までしか特定できていない)。

## 検証の詳細

本調査は実機検証ではなく、公式ブログ・公式ドキュメント・第三者記事の記述に基づく文献調査。

### 比較表

| 項目 | oxlint + oxfmt | Biome v2.4 | ESLint + typescript-eslint |
|---|---|---|---|
| 最新版 (2026-03 時点で判明した値) | oxlint 1.50.0+ / oxfmt 0.36.0+ (以降も更新継続中) | v2.4 (2026 年最初の minor) | 継続メンテ、v9系 |
| 速度 (lint) | ESLint の 50〜100倍、Biome の約 2倍 | ESLint の数十倍、oxlint の約 1/2 | 基準 (最遅) |
| type-aware lint | alpha (tsgolint 経由、typescript-go = TS7 コンパイラを内蔵)。61 ルール中 59 サポート | 独自型推論 (TSC 非依存)。完全な型システムではない | 最も成熟 (基準) |
| formatter | oxfmt (alpha)、Prettier比 30倍、Biome比 2倍 | biome format 同梱 (安定) | 別途 Prettier |
| 設定単一ファイル | `.oxlintrc.json` 1個で monorepo 全体 | `biome.json` 1個 | flat config が package ごとに広がりがち |
| bun 相性 | Rust バイナリ、bun 依存なし、`bunx` で実行可 | 同上 | 同上 |

### oxlint / oxfmt / tsgolint

- type-aware linting alpha 発表: 2025-12-08。以降 2026 前半で 40 ルール → 59/61 ルールまで対応拡充。
- `tsgolint` は typescript-eslint/tsgolint プロトタイプを oxc org に移管したもので、内部で typescript-go (TS7 のコンパイラ) を呼ぶ。
- turborepo / nx / renovate 等でも oxlint 前提のプリセットが 2026 半ばに整備されている。

### Biome v2 (v2.4)

- TS コンパイラに依存しない独自型推論で type-aware lint を提供する初の linter を自称。
- 2026 年ロードマップは plugin system・embedded language・TS 型推論拡張が中心。
- 型推論は「軽い代わりに完全ではない」という位置づけ。

### TypeScript 7 (native port)

- 2026-04-21 Beta、2026-06-18 RC。RC から約1か月で GA という公式アナウンスあり (2026-07 中〜下旬見込み)。
- `tsgo` という別バイナリは Beta/nightly のみ。RC 以降は `typescript@rc` の通常の `tsc` がそのまま Go-native 実装。`@typescript/native-preview` は役目を終えたとされている。
- 速度は TS 6.0 比で概ね 10倍。型検査ロジックは構造的に同一 (methodical port)。
- 既知の制約: RC 段階の edge case、GA 前のバージョン更新で CI が落ちる余地。

## 事実と推測の区別

- 「TS7 GA が 2026-07 中〜下旬」「oxlint type-aware が 59/61 ルール」「oxlint が ESLint の 50〜100倍」「oxfmt が Prettier の 30倍」「Biome v2.4 が 2026 年最初の minor」は、いずれも出典記事・公式ブログの記述であり、当方で実機再現検証したものではない。
- 「当リポで oxlint + oxfmt + typescript@rc の組み合わせが最適」という導入手順案は、上記事実からの推測であり実測は未取得。
- oxlint / oxfmt の 2026-07 時点の正確なバージョンは、2026-03 時点の 1.50.0 / 0.36.0 までしか特定できておらず、導入時に `npm view` で再確認する必要がある。

## 出典

- https://voidzero.dev/posts/announcing-oxlint-type-aware-linting-alpha
- https://oxc.rs/docs/guide/usage/linter/type-aware.html
- https://github.com/oxc-project/tsgolint
- https://oxc.rs/docs/guide/usage/formatter.html
- https://oxc.rs/docs/guide/usage/linter/config.html
- https://biomejs.dev/blog/biome-v2/
- https://biomejs.dev/blog/roadmap-2026/
- https://medium.com/@onix_react/whats-new-in-biome-v2-4-00890baad13b
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/
- https://github.com/microsoft/typescript-go
- https://www.pkgpulse.com/guides/biome-vs-oxc-2026
- https://www.solberg.is/fast-type-aware-linting
- https://turborepo.dev/docs/guides/tools/oxc
- https://www.npmjs.com/package/oxlint-tsgolint
