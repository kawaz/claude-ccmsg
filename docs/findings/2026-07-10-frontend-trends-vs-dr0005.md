# 2026 フロントエンド動向と DR-0005 選定 (preact+TSX+reducer+Bun.build) の照合

kawaz の「流行っててモダンなのだと何がある？」(2026-07-10、DR-0004/0005 レビュー時) を受けた
web 調査 (3 観点並列、opus47-worker、出典 URL 付き) の要約。

## 判明した事実

### フレームワーク勢力図 (State of JS 2025 / npm)

- **React 19/19.2**: usage 83%・npm 50M/週で首位不変。Server Components stable、React Compiler が
  RC (手動 memo 化を自動化)。ただし satisfaction 62% で「使われてるが好かれてない」
- **Svelte 5 (runes)**: satisfaction 74% で最上位常連、usage 23% (+8pt YoY)、npm +45% YoY。
  「学習コスト無視で 2026 最先端を選ぶなら総合トップ」評価
- **Vue 3.6 Vapor Mode**: VDOM 廃止モードが beta (2025-12)、本番推奨はまだ
- **SolidJS 2.0**: 2026-03 に 2.0 Beta。伸び率は高いが少数派
- **preact**: 独立指標での存在感は薄まり気味だが、「React 互換 API + 小バンドル」のニッチは
  React 本体が軽くならない限り残り続ける
- **Qwik**: resumability は SSR/初期ロード特化。内部ツール SPA には利得なし

### 状態管理

- 「単一モノリシック state library」時代は終焉。client state = Zustand (DL 首位) /
  server state = TanStack Query の分離がデファクト。ただし数画面ツール UI では分離は過剰
- **signals は React 以外のほぼ全メジャーで勝った** (Solid 源流 → preact/Angular/Vue/Svelte runes)。
  TC39 Signals proposal は Stage 1 のまま (production 依拠は非推奨)
- **「WS サーバイベント + UI 操作を typed action に正規化 → 単一 reducer、effect 層隔離」
  (= DR-0005 §1 の設計) は 2026 でも real-time frontend の advanced pattern として現役**。
  event-driven frontend の推奨パイプライン (Transport → Normalization → Reduction) と合流。
  signals はこれを置き換えない (state transition 記述 vs view 更新細粒度化で直交)
- 「Redux は古い」の実態は「plain Redux boilerplate (action type 定数 + switch) が古い」。
  Elm 風 pure update 関数として書くなら問題なくモダン

### ビルドレス / Bun

- **Bun 1.3 (2025 後半) がフルスタック化**: HTML import + `Bun.serve({ routes })` で
  TSX/CSS を自動トランスパイル + バンドル。`development: false` で初回リクエスト lazy bundle +
  メモリキャッシュ、Cache-Control/ETag 自動付与。development モードは HMR (React Fast Refresh) +
  ブラウザ console のターミナル転送付き
- = **ccmsg が自作した「サーブ時 Bun.build + メモリキャッシュ」構成は Bun 公式機能でほぼ置換可能**。
  TSX を route に直接渡す形は未実装 (oven-sh/bun#20075 open、2026-07 時点)
- Vite 8 (2026-03 stable) は Rolldown + Oxc に統一 (build 10-30x 高速化)。oxc エコシステム
  (oxlint/oxfmt 採用済み) は 2026 年末までに parse/lint/format/minify/transform を単一 Rust runtime 化予定
- no-build 潮流: import maps 全ブラウザ対応完了、HTMX + islands が対抗軸として存在

## 実用的な示唆 (DR-0005 への評価)

1. **preact + TSX + Elm 風 reducer は 2026 でも堅実でモダン**。変更不要。
   注意点は 2 つだけ: (a) reducer を Redux 風 boilerplate で書かない (現行は typed action +
   pure reducer なので問題なし)、(b) preact signals を安易に混ぜない (中央 reducer と思想競合。
   使うなら view 購読の細粒度化に限定する hybrid が正)
2. **Bun 1.3 の fullstack 機能への乗り換えは検討価値あり** (自作のサーブ時トランスパイル +
   メモリキャッシュ経路を公式機能に置換、HMR が無償で付く)。ただし現行実装は動いており、
   置換は「dev 体験が必要になった時」で十分。issue 化候補
3. Svelte 5 は総合トップだが、専用コンパイラ前提でサーブ時トランスパイル方針 (DR-0005 §3) に
   乗らない点は当時の判断通り変わらず。乗り換え動機なし

## 検証の詳細

Workflow `frontend-trends-2026` (2026-07-10、3 並列 opus47-worker、計 280k tokens)。
各レポート全文 (出典 URL 付き) は workflow journal に記録。主要出典: State of JS 2025 /
react.dev / svelte.dev blog / TC39 proposal-signals / Bun docs (fullstack) / Vite 8 announce /
oxc 2026 Q1 plan。

未検証事項 (レポート自己申告): Bun 1.3 fullstack と自作 daemon 経路の挙動差は実機未検証。
bun#20075 の status は 2026-07-10 fetch 時点。
