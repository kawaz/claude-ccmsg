---
title: "e2e: 貼り付けのボタンの ⌘Z の試験が webkit の 390 幅で 1 回落ちた"
status: resolved
category: bug
created: 2026-11-25
origin: "自リポ TODO (worker の e2e の通しの副産物)"
close_reason: implemented
---

# e2e: 貼り付けのボタンの ⌘Z の試験が webkit の 390 幅で 1 回落ちた

## 観測

`just e2e` の通しで、次の試験が 1 回落ちた (203 pass / 1 fail)。

- ファイル: `packages/webui/e2e/paste-button.e2e.ts` の 277 行目の expect
- 名前: `the paste button, 390 wide, in webkit > a text in the FAB's box: five ways over 📋 within the panel, quote goes in at the caret, ⌘Z takes it back as the browser's paste`
- 中身: ⌘Z の後の textarea の中身が `""` のはずが `"ab"` だった
- このファイルだけを続けて 2 回流すと、2 回とも 20 pass / 0 fail だった
- 落ちた回の変更は Files の編集と tl-panels の e2e で、右下の入力欄と貼り付けには触っていない

## 未特定

- 原因。この試験は「ブラウザ自身の貼り付けと同じに戻るか」を比べる作りで、WebKit は打った文字と貼り付けをまとめて戻す。⌘Z が効く前に測っているのか、WebKit の undo のまとめ方が場合で変わるのか
- 頻度。観測は 1 回だけ。通しの中でだけ起きるのか

## 特定に要る観測

- この試験だけを webkit で繰り返し流した時と、通しで繰り返し流した時の、落ちる割合
- 落ちた回の、⌘Z を押した時刻・`input` の event・textarea の中身の時系列

## 結果 (2026-11-25)

原因は、Playwright の WebKit で 1 回の ⌘Z が戻す段の数が揺れること (直前の編集だけでなく、その前の編集までまとめて戻すことがある)。試験は ⌘Z の後の最後の値を比べていたので、ブラウザ自身の貼り付けと貼り付けのボタンで段の数が違う回に落ちた。試験を、⌘Z の最初の 1 段 (最初の `historyUndo` の input の値) で比べる形に直した。観測は [findings 2026-11-25-paste-html-clipboard](../../findings/2026-11-25-paste-html-clipboard.md)、決まりは [DR-0065](../../decisions/DR-0065-paste-html-as-markdown.md) §3・§8。同じ性質に依っていた `files-edit-preview.e2e.ts` も、段の並びを両エンジンで比べる形に直した。段の数を決めているものは未特定。
