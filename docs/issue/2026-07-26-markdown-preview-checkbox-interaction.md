---
title: markdown プレビューでチェックボックス操作に対応できないか (裁定待ちファイルの回答 UX)
status: open
category: request
created: 2026-07-26T17:40:49+09:00
last_read:
open_entered: 2026-07-26T17:40:49+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: claude-rules-personal
---

# markdown プレビューでチェックボックス操作に対応できないか (裁定待ちファイルの回答 UX)

## 概要

ccmsg の markdown プレビュー機能に、チェックボックスの**操作** (クリックでチェックを付け外しできる) を追加できないか検討してほしい。現状レンダリング専用か、既にインタラクション機構があるかは未確認。

## 背景

### 発端 (利用側からのフラグ)

claude-rules-personal 側で運用している「裁定・確認待ちファイル」(`docs/QUESTIONS.md`) の記法を、kawaz の実運用所見をもとに `- [ ] a: <選択肢/確認項目>` 形式 (チェックボックス + ラベル) に統一した (claude-rules-personal の commit `f4112f56`、rules-personal plugin v0.2.2)。

統一の背景: 確認待ち項目は 1 機能の確認でも項目数が多くなりがちで、素の箇条書きだと回答しづらいという実運用の課題があった。

### 提案されている機能 (kawaz 発案)

markdown プレビューでチェックボックスをクリック操作できるようにすると、裁定・確認の回答が「チェックを付けて『チェックしたよ』と一言送る」だけで済むようになる。

想定する運用: 複数の質問/確認項目を通しで読みながらチェックしていき、最後にまとめて一言返す。個別に「XX-Q1a」とラベルを書かなくてよくなる。

### 現状の代替経路

チェックせずに「XX-Q1a」とラベルを言葉で返す経路は既に機能している (記法統一時にこちらも残す判断をした)。よってこの機能追加は**必須ではなく UX 改善**。

### 部外者からの起票としての注記

- こちらは ccmsg の markdown プレビュー機能の現状 (レンダリング専用か、インタラクション機構が既にあるか) を確認していない。実装コストの見積もりはしていない
- チェック状態をどこに永続化するか (ファイルを書き換えるのか、プレビュー内の一時状態か)、対象ファイルが別リポにある場合の書き込み権限をどう扱うか等、設計判断が必要な点が複数ある。これらは当事者側で検討してほしい
- そもそも ccmsg の責務範囲に入るかの判断も含めて委ねる (プレビューは表示に徹してファイル編集はしない、という設計方針があるなら却下で構わない)

### 参考: 統一後の記法

```markdown
### 👺XX-Q1: <質問要旨>

- [ ] a (推奨): …
- [ ] b: …

### 👺XX-C1: <確認要旨>

- [ ] a: <確認項目>
- [ ] b: <確認項目>
```

正本は claude-rules-personal の `skills/questions-registry/QUESTIONS.template.md` (rules-personal plugin 同梱)。

## 受け入れ条件

- [ ] ccmsg 側で「該当する / しない」の判断がされている (該当しない場合は却下で close)
