---
title: webui コンポーネントの render/DOM 挙動テスト基盤の導入検討
status: idea
category: task
created: 2026-07-14T23:33:04+09:00
last_read:
open_entered:
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# webui コンポーネントの render/DOM 挙動テスト基盤の導入検討

## 概要

現行 `webui/test` は pure helper 関数 + reducer 型の単体テストのみをカバーしており、
fab (floating action button) / panel の open-close 遷移や、Preact の effect が発火する
DOM 挙動を単体テスト化できる基盤が無い。tlr-impl / unif-impl 両 worker から
「この種のテストが追加不能」という報告が上がっている。

## 背景

- 現状のテストは純粋関数・reducer のロジックのみを検証しており、
  実際にレンダリングされた DOM の状態遷移 (開閉・表示/非表示・フォーカス移動等) や
  `useEffect` 由来の副作用は検証できていない
- fix 対象として想定している UI: `SessionView` / `RoomComposerFab` / `OneOnOneComposer` /
  `Timeline` 系 (open-close 遷移・入力→送信フロー等の回帰保護が主目的)
- 導入候補 (優劣未検討、いずれも要調査):
  - (a) `@testing-library/preact` + `happy-dom` or `jsdom` — コンポーネント単体の
    DOM 挙動テストとして最有力候補、ただし bun test との統合方法は未確認
  - (b) `preact-render-to-string` による snapshot テスト — 導入は軽いが
    interactive な状態遷移 (クリック→再レンダー) の検証には弱い
  - (c) Playwright / vitest browser mode による E2E — 実ブラウザ環境で最も信頼度が
    高いが実行コスト・CI 統合コストが重い
- 優先度は現時点で低 (idea 止まり)。dogfood 運用の中で
  「テスト無しで書いた fab UI がバグった」という具体的な観測が出た時点で
  status を open に上げて着手する想定

## 受け入れ条件

- [ ] (a)/(b)/(c) それぞれの bun test との統合可否・導入コスト・検証できる範囲を比較調査する
- [ ] 比較結果に基づき採用方式を決定する (DR 化を検討)
- [ ] `SessionView` / `RoomComposerFab` / `OneOnOneComposer` / `Timeline` の
  open-close 遷移・effect 由来の DOM 挙動に対する回帰テストを追加する
