---
title: "e2e: mermaid の切り替えの spacer の試験が webkit で 1 回だけ落ちた"
status: open
category: bug
created: 2026-11-24
origin: "自リポ TODO (worker の e2e の通しの副産物)"
---

# e2e: mermaid の切り替えの spacer の試験が webkit で 1 回だけ落ちた

## 観測

`just e2e` の通しで、次の試験が 1 回落ちた (134 pass / 1 fail)。何も変えずに流し直した 2 回目は通った (135 pass / 0 fail)。

- ファイル: `packages/webui/e2e/markdown-mermaid-prefs.e2e.ts` の 364 行目の expect
- 名前: `shared mermaid choices in webkit > switches > at the end of the scroll range, a spacer holds the switch, then shrinks away to the end`
- 中身: 位置のずれの許容 1 に対して、受け取った値が 4.03125

落ちた回と通った回で、製品のコードは同じ (v0.395.0)。違いは e2e のファイルが 1 つ増えていたことだけで、その e2e は mermaid に触らない。

## 未特定

- 原因。試験が待つべき何か (レイアウトの確定、スクロールの確定) を待たずに測っているのか、製品の側で spacer の縮みが 1 フレーム遅れることがあるのか
- 頻度。観測は 1 回だけ
- chromium でも起きるか

## 特定に要る観測

- この試験だけを webkit で繰り返し流した時の落ちる割合と、落ちた時の値の分布 (4px 前後に固まるか)
- 落ちた時の spacer の高さと、スクロール位置の時系列
