---
title: Timeline のメッセージバブル hover ツールバー設計
status: open
category: design
created: 2026-08-20T17:31:59+09:00
last_read:
open_entered: 2026-08-20T17:31:59+09:00
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

# Timeline のメッセージバブル hover ツールバー設計

## 概要

resume/compact 後に応答が英語に流れる問題 (r135m30-35 で hook 側は対応済み) の残る緩和策として、応答バブルにも thinking と同じ翻訳タブを付けたい、という提案から UI 再構成の議論に発展した (kawaz r135m48-57 議論まとめ)。決定した設計のうち「1. メッセージ単位の hover ツールバー」は v0.110.0 で実装済み。「2. セッション設定パネル」「3. TL 全体ツールバー再構成」は未着手。

## 背景

resume/compact 後に応答が英語に流れる問題への残る緩和策の検討が起点。

## 決定した設計 (実装未着手)

### 1. メッセージ単位の hover ツールバー (v0.110.0 で実装済み)

対象: assistant 応答バブル (AssistantBubble、Timeline.tsx 2198行付近)。

- **常時非表示、hover で出現** (JSON文字列コピーボタン・SessionSearchPanel の resume/pin ボタンと同じ思想) — 実装済み。タッチ端末は hover が無いため常時薄表示 (opacity 0.45) で到達可
- 軽い操作 (即座に効く) — 実装済み:
  - **翻訳タブ**: original / ja(host) / ja(browser)。ThinkingSegment (Timeline.tsx 1071行〜) の翻訳インフラ (`translateThinkingTextOnHost`/`translateThinkingTextInBrowser`、`ThinkingTab` type) を再利用。**thinking と違い自動選択しない** (既定は常に original — kawaz r135m50)
  - **md/source 切替**: レンダリング済み markdown 表示 と 生の markdown テキスト (コピペ用) の 2 状態切替ボタン
- 重い操作 (誤操作防止のため hover だけでは発火しない、ツールバー内の ☰ ハンバーガーメニューでもう一段階の操作を要求) — 実装済み:
  - 現在 TL 右サイドの float パネル (ForkAction/DumpFileAction、Timeline.tsx 4400行台) にあった fork・dump をここに統合。`currentPosition` 紐付けは維持し、ハンバーガーを開く操作は明示選択として扱う

### 2. セッション設定パネル (次回レイヤ、未着手)

auto-open (Timeline.tsx の自動オープン設定 fieldset) は「メッセージ単位のアクション」ではなく「セッション表示の恒常設定」であり、float パネルに同居しているのは元々置き場所が無かったための暫定 (kawaz r135m54: 「それはアクション作ったときに適切な置き場がないからとりあえずで置いたせい」)。独立したセッション設定パネル (TL ヘッダー付近の歯車アイコン等) に切り出すべき、位置は未決。

### 3. TL 全体ツールバー再構成 (次回レイヤ、未着手、まだ要望段階)

- 検索系 UI (SearchBar、👤 user-nav) は普段使わないので既定で隠しても良いのでは (kawaz r135m56)
- 検索ワード入力欄が狭い → 大きなフォームで検索したい
- 検索ワードごとに個別ジャンプしたい (現在は全体の [N/M] 送り一本)

## 実装時の注意点 (今回の議論で出た懸念)

- fork/dump は `currentPosition` (URL 選択状態) に紐づく操作。誤操作防止のため不可逆・重い操作は明示選択のままとし、hover だけで発火させない方針で実装済み
- タッチ端末は hover が無いため、常時薄表示 (opacity 0.45) でハンバーガー/重い操作への到達経路を確保済み
- 翻訳判定ロジック (段落の日本語比率、r135m21-23 で 0.1 閾値に確定済み) は再利用可能
- 翻訳対象からのコードブロック除外は不要 (kawaz 裁定: 誤って翻訳されても original に戻せば済むため、対応しない)

## 受け入れ条件

- [x] メッセージ単位 hover ツールバー (翻訳タブ・md/source 切替・重い操作へのハンバーガー導線) が実装される (v0.110.0)
- [ ] セッション設定パネルが独立した置き場に切り出される (次回レイヤ)
- [ ] TL 全体ツールバーが再構成される (次回レイヤ)

## 関連

- r135 room (ccmsg) mid=16-57 に一連の議論ログあり
- 翻訳の日本語判定ロジック: packages/webui/src/client/translate.ts
- 参考実装 (hover ツールバーの前例): packages/webui/src/client/json-string-token.ts, useJsonStringCopy.tsx (v0.106.0 で実装済み)
- fork/dump の float パネル現状: packages/webui/src/client/components/Timeline.tsx の ForkAction/DumpFileAction 実装 (4400行台)
