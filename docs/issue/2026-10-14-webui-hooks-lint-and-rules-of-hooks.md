---
title: webui の hooks lint 導入と rules-of-hooks 違反の解消
status: open
category: bug
created: 2026-10-14T13:50:57+09:00
last_read:
open_entered: 2026-10-14T13:50:57+09:00
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

# webui の hooks lint 導入と rules-of-hooks 違反の解消

## 概要

oxlint に react plugin (`react/rules-of-hooks`、`react/exhaustive-deps`) が無い。そのため次の違反が検出されずに残っている。

- Timeline.tsx:4548 の early return の後に useMemo が 3 つあり、rules-of-hooks に違反している。status が loaded から idle に戻る経路で hook 数が変動する。
- deps を意図的に欠いた effect が多数ある (Timeline 3433/3464/3506/3964/4329/4381/4423、SessionView 287、SessionInputComposer 139)。

react plugin を有効化し、rules-of-hooks は error、exhaustive-deps は warn から始める。違反は react.dev の作法 (effect を分ける / latest ref / key 付きコンポーネント化) で直す。

## 背景

根拠は docs/findings/2026-10-14-webui-client-review-fresh-eyes.md の high 1・3。最初に直すべき 3 つの 1 番目。

## 受け入れ条件

- [ ] oxlint で react plugin が有効で、rules-of-hooks が error、exhaustive-deps が warn になっている
- [ ] Timeline.tsx の early return 後の useMemo がなくなり、hook 数が render 間で変動しない
- [ ] deps を欠いた effect が react.dev の作法で解消されている (exhaustive-deps の warn が 0、または理由付きの抑制のみ)
