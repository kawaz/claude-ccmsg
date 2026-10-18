---
title: webui の JS bundle が大きい (shiki 言語文法が約半分)
status: resolved
category: bug
created: 2026-10-10T21:06:27+09:00
last_read: 2026-10-18T17:50:43+09:00
open_entered: 2026-10-10T21:06:27+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T18:00:08+09:00
discard_reason:
pending_reason:
close_reason: ["implemented"]
blocked_by:
origin: 自リポ TODO
---

# webui の JS bundle が大きい (shiki 言語文法が約半分)

## 概要

webui の JS bundle は minify 後 1.48 MB (br 251 KB)。内訳の上位は @shikijs/langs の 15 言語文法 715 KB (48%、tsx 176 KB・javascript 175 KB が最大)、webui 自身 415 KB (28%)、@shikijs/vscode-textmate 43 KB、micromark 34 KB、@ccmsg/protocol 28 KB (2026-10-10 計測)。shiki の言語文法を最初の描画に含めず、必要になった言語だけ遅延読み込みにする等で初回の転送量を下げる。

## 背景

iPhone の tailnet 経路は 1〜10 KB/s しか出ない観測があり、br 251 KB でも数十秒かかる。

## 受け入れ条件

- [x] 初回描画に含まれる JS の転送量が下がっている
- [x] コードブロックの言語が必要になった時点で文法が読み込まれ、ハイライトされる

## 対応 (2026-10-18)

shiki の highlighter と言語文法を dynamic import + Bun.build splitting で chunk 化した (commit rprmvsts)。

- 初回に読む entry (minify 後): raw 1,487,550 → 587,552 B / gzip 317,868 → 175,704 B / br 253,358 → 146,822 B (br で −42%)
- 遅延 chunk は合計 raw 853 KB / br 116 KB。最初のコードブロック (ts) で追加に読むのは core 29.9 KB + engine-javascript 18.6 KB + テーマ 2 本 4.3 KB + tsx 文法 11.9 KB = br 約 65 KB。他の言語の文法はその言語が出た時に 1 本ずつ読む (json 0.7 KB、python 7.6 KB、html (javascript / css 文法を含む) 22.2 KB 等)
- 文法が届くまでは CodeBlock / FileViewer は従来どおりプレーン表示で、届いたら着色に差し替わる。読み込み失敗時はプレーンのまま、次の表示で読み直す
- chunk は Bun の内容ハッシュ名 (`[name]-[hash].js`) で `/assets/` に immutable 配信。chunk が entry を名前で import するので entry も Bun の `app.[hash].js` 命名にした
- /verify (隔離 daemon + playwright) で /catalog を開き、entry → core / engine / theme → tsx 文法の順に取得され、ts のコードブロックに `.shiki-tok` が付くことを確認 (他の文法 chunk は取得されない)
- 残り: entry の 587 KB の大半は webui 自身と micromark 等。これ以上は別課題
