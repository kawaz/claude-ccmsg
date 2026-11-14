---
title: older で読み切った Timeline では live tail の push ごとに重い
status: open
category: bug
created: 2026-11-05T17:40:00+09:00
origin: older-tab-freeze の調べ (2026-11-05)
---

# older で読み切った Timeline では live tail の push ごとに重い

## 概要

older で先頭まで読んだ Timeline を開いたまま turn が流れると、push 1 回ごとに 150 ms〜1.3 秒の long task が出る。17 MB の transcript で短い turn 3 回 (約 13 秒) の間に main thread が合計 17.7 秒ふさがった (初回の読み込みだけの状態では 0)。忙しいセッションを見ていると、タブがほぼ応答しなくなる。

計測: [findings](../findings/2026-11-05-older-tab-freeze.md) §2

## 分かっていること

- 内訳は layout (`useStickToBottom` の `scrollHeight` の読み、`ScrollHold.toBottom`) と markdown の parse のやり直しで、どちらも読んだ量に比例する
- `content-visibility: auto` を行に当てても減らなかった

## 残っていること

- 直し方の判断 (候補: 画面外の古い group を軽い placeholder に畳む仮想化、push のたびの scroll 計測と末尾寄せを新しい行の分に限る、markdown の parse を行ごとに使い回す)。DR-0009 / DR-0005 の該当節に反映
- push のたびに `MarkdownView` の parse が既存の行でもやり直されているのか (新しい行の分だけなのか)
