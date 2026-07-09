# DR-0005: webui フロントエンドアーキテクチャ (workspace 化を見込んだ器)

- **Status**: Proposed (2026-07-09、kawaz の vision 表明を受けて実装先行。明示レビュー待ち)
- **Date**: 2026-07-09
- **Author**: AI agent
- **一次資料**: [docs/research/2026-07-09-kawaz-webui-vision-statement.md](../research/2026-07-09-kawaz-webui-vision-statement.md)
- **関係 DR**: DR-0004 §4 のクライアント実装方式 (vanilla ESM 直書き) を supersede する。DR-0004 のそれ以外 (§1-3, §5-6: daemon 内蔵 / WS 同一プロトコル / identity pinning / bind / ロケータ) は不変

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz]** = 一次資料に逐語あり / **[提案]** = エージェント由来 / **[保留]** = 意図的に未決。

## Context

kawaz の長期 vision [kawaz]: webui はメッセージング UI にとどまらず、最終的に「セッション一覧 / セッション jsonl のリッチビューア / room 一覧 / プロジェクトのファイルツリー + ファイルビューア」を備えた **基本的な作業が全てできる workspace UI** に育てたい。一気に最終形は目指さないが、器はそこまで見込んだ設計であってほしい。構成の好みとして「雑にペラ1の詰め込み HTML+JS にせず、コンポーネント化 + 各種アクション/メッセージの形式化 + reducer で処理する構成」が明示された。

DR-0004 §4 の vanilla ESM 直書きは「メッセージング MVP のスコープなら素の DOM で足りる」という判断で、この vision を知らない前提だった。手続き的 DOM 操作は画面種別が増えると状態管理が破綻するため、小さいうちに器を移行する。

## Decision

### 1. 状態管理: 中央 store + typed action + reducer [kawaz 要求]

- アプリ状態は単一の store に集約し、変更は**型付けされた action の dispatch → reducer** のみで行う (Elm/Flux アーキテクチャ)
- WS で届く protocol イベント (msg / member / restarting / …) も action に正規化して同じ reducer 経路で処理する (= サーバイベントと UI 操作が同じ形式化に乗る)
- 副作用 (WS 送信 / 再接続) は store の外 (effect 層) に隔離し、reducer は純粋に保つ

### 2. コンポーネント: preact + TSX [提案]

- UI は preact の関数コンポーネントに分割する。TSX により client コードもリポの strict TypeScript の型検査に入る (vanilla JS は tsc の対象外だった)
- preact 選定理由: 小さい (数KB) / 成熟 / React 互換の component model で将来の画面追加 (session viewer / file tree) に耐える。React は同じ利点でサイズと依存が重い

### 3. 配信: Bun.build によるサーブ時トランスパイル、ビルド成果物を持たない [提案]

- リポに bundler 設定・dist を持たない方針 (DR-0004 §4) は維持する。daemon が `/assets/app.js` の初回リクエスト時に `Bun.build` (target: browser) で TSX をトランスパイル + バンドルし、メモリキャッシュする
- 成立根拠: 配布は `bin/ccmsg` → `bun run` 前提で bun runtime が必ずある。外部依存 (hono) が plugin cache に node_modules 実体なしで bun auto-install により解決されることは v0.1.0 の配布物で実機確認済み (preact も同経路)
- ビルド失敗はページ表示時にエラーとして可視化する (500 + メッセージ)。silent fallback はしない

### 4. 段階導入: 今やるのは器の移行のみ [提案]

- Phase 1 (本 DR の実装範囲): 既存機能 (room 一覧 / room view / post / peers / ロケータ) を新アーキテクチャに等価移行する。機能追加はしない
- workspace 化の機能群 (セッション一覧 / jsonl ビューア / ファイルツリー + ビューア) は roadmap issue として管理し、必要になった時点で設計する (daemon 側 API の拡張を伴うため、着手時に DR 追補)
- 過剰設計の禁止: ルーティング/store は現画面数で必要な最小形にとどめ、将来機能のための未使用抽象を先行导入しない

## Alternatives considered

- **vanilla ESM 継続 (DR-0004 §4)**: 不採用。workspace 化 vision の下では手続き的 DOM 操作の状態管理が先に破綻する。「雑にペラ1」の明示否定 [kawaz]
- **React**: 不採用。preact で component model は同等、サイズ・依存が重いだけ
- **htm (タグ付きテンプレート、無トランスパイル)**: 次点。ビルド完全不要だが TSX の型検査が効かない。リポ全体が strict TS である価値を client にも通す方を取った
- **Svelte / Solid**: 不採用。専用コンパイラ前提でサーブ時トランスパイル (Bun.build) に乗らない
- **リポ内ビルド (vite 等) + dist コミット/リリース時生成**: 不採用。配布形態 (source を bun run) を複雑化し、dist は .gitignore 済み方針とも衝突

## Consequences

- client コードが型検査・lint の対象に入る (品質ゲートが server と揃う)
- 画面追加 = コンポーネント + action/reducer の追加という定型作業になる
- 初回アクセス時にトランスパイルの latency (数百 ms 想定) が乗る。メモリキャッシュで 2 回目以降は無視できる
- preact への依存が増える (bun auto-install で配布は不変)

## Next steps

1. packages/webui client を preact + TSX + store/reducer に等価移行 (機能不変、既存テスト green 維持)
2. workspace 化 roadmap issue の起票 (session viewer / file tree は着手時に DR 追補)
3. dogfood 後、Phase 2 の優先順を kawaz と決める
