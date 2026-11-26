---
title: "markdown の描画に、Lean 4 のシンタックスハイライトと svg のスクリプトの実行を入れる (dirview と揃える)"
status: resolved
category: request
created: 2026-11-25
origin: "kawaz の依頼 (dirview の統括のセッションからの取り次ぎ、2026-11-25)"
close_reason: implemented
close_ref: "v0.428.0、svg の実行は DR-0067"
---

# markdown の描画に、Lean 4 のシンタックスハイライトと svg のスクリプトの実行を入れる

dirview に入って release 済みの 2 つを、ccmsg の webui の markdown の描画にも入れる。正本は dirview のリポ (kawaz/dirview) の該当ファイルと `docs/DESIGN-ja.md`、findings。

## 1. Lean 4 のシンタックスハイライト

- 拡張子 `.lean` と、コードブロックの言語名 `lean` / `lean4` を Lean として色付けする
- dirview は highlight.js の言語定義 (`highlightjs-lean4`) を入れ、崩れる規則 2 つを差し替えている。ccmsg の色付けは shiki なので、その定義は使えない。shiki に同梱の Lean 4 の文法 (`shiki/langs/lean.mjs`) を使う。新しい依存は足さない
- dirview が差し替えた 2 つの場合 (`@[simp, inline]` のような属性、`structure X where` の後) が、shiki の文法で崩れないかを確かめる。確かめる入力は dirview の `test/hl-lean.test.ts` から取る

## 2. svg のスクリプトの実行

- svg のブロック / ファイルに「描画 | ソース | 実行」を付け、既定は描画、実行は覚えない。実行を選ぶと、外部にも ccmsg のサーバにも通信できない sandbox の中でスクリプトが動く
- 守ること: スクリプトは動く / 外部にも ccmsg のサーバにも要求が出ない / webui の DOM・localStorage・cookie に触れない / 受け皿の遷移で CSP の外に出られない
- dirview は、受け皿の html を sandbox の iframe で開き、その中の sandbox の srcdoc に svg を入れる 2 段の形 (1 段だと、svg のスクリプトが受け皿の frame を遷移させて CSP の外へ出られることを実測している。dirview の `docs/findings/2026-11-25-svg-script-runner.md`)
- ccmsg は sandbox origin ([DR-0030](../../decisions/DR-0030-sandbox-origin-serving.md)) を持つので、受け皿をそちらで配る形にするかを設計で決める
