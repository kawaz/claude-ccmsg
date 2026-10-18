---
title: webui の JS bundle が大きい (shiki 言語文法が約半分)
status: open
category: bug
created: 2026-10-10T21:06:27+09:00
last_read: 2026-10-18T17:50:43+09:00
open_entered: 2026-10-10T21:06:27+09:00
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

# webui の JS bundle が大きい (shiki 言語文法が約半分)

## 概要

webui の JS bundle は minify 後 1.48 MB (br 251 KB)。内訳の上位は @shikijs/langs の 15 言語文法 715 KB (48%、tsx 176 KB・javascript 175 KB が最大)、webui 自身 415 KB (28%)、@shikijs/vscode-textmate 43 KB、micromark 34 KB、@ccmsg/protocol 28 KB (2026-10-10 計測)。shiki の言語文法を最初の描画に含めず、必要になった言語だけ遅延読み込みにする等で初回の転送量を下げる。

## 背景

iPhone の tailnet 経路は 1〜10 KB/s しか出ない観測があり、br 251 KB でも数十秒かかる。

## 受け入れ条件

- [ ] 初回描画に含まれる JS の転送量が下がっている
- [ ] コードブロックの言語が必要になった時点で文法が読み込まれ、ハイライトされる
