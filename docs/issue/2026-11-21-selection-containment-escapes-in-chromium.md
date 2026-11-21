---
title: Chromium で、コードの塊から始めた drag が上の項目や右下の角まで動くと、選択が閉じ込めを越えて項目の外まで広がる
status: open
category: bug
created: 2026-11-21
---

# Chromium で、コードの塊から始めた drag が上の項目や右下の角まで動くと、選択が閉じ込めを越えて項目の外まで広がる

[DR-0010](../decisions/DR-0010-timeline-markdown-rendering.md) §9 は「コードの塊と inline code の中から始め、同じ行の左右、上下の行、サイドバーの上の 2 点、画面の右下の 7 か所で離して、選択はどれも始点のコードの中に収まる」(Chrome と WebKit) と書いているが、Chromium では収まらない場合がある。

## 観測 (2026-11-21、headless chromium と webkit、隔離 daemon と合成 fixture)

条件: 合成の SESSIONS の行 200 件と、合成の transcript (300 turn、assistant の本文に markdown のコードの塊 ```` ```ts ```` を含む) の Timeline を開いた画面。viewport 1600×1000。

assistant の本文の 6 つ目のコードの塊 (`.tl-text-assistant pre.md-code`、中身 `const x = 119;`) の左端から 6px・縦の中央で押し、次の 5 か所へ 1 歩 (`mouse.move` の steps 1) と 12 歩で動かして離した時の選択:

| 離した場所 | Chromium 1 歩 | Chromium 12 歩 | WebKit 1 歩 | WebKit 12 歩 |
|---|---|---|---|---|
| 同じ行の右端 (x = 1580) | コードの中 | コードの中 | コードの中 | コードの中 |
| 下の項目 (コードの 260px 下) | コードの中 | コードの中 | コードの中 | コードの中 |
| サイドバー (120, 300) | 空 (コードの中) | 空 (コードの中) | 空 (コードの中) | 空 (コードの中) |
| 右下の角 (1595, 995) | コードの中 | **外へ** (841 字、次の項目の `Prompt 120: …` から) | コードの中 | コードの中 |
| 上の項目 (コードの 200px 上) | **外へ** (206 字、`file0.txt … const x = 119; 2026-11-20 1…`) | **外へ** (同じ) | 空 (コードの中) | 空 (コードの中) |

- 「外へ」の 3 通りは、選択範囲の始点と終点のどちらかがコードの塊の外にある
- 同じ 5 か所 × 2 で、閉じ込めの入れどきを変える前 (vnwzpwxr、`selectstart` の時点で入れる) と変えた後 (qwwmrmvm、動いた最初の `pointermove` / 選択が広がった時に入れる) の答えはすべて同じだった。入れどきの変更で生じたものではない

## 再現手順

1. 隔離 daemon に合成のセッションを hello させ、markdown のコードの塊を含む transcript の Timeline を開く (verify skill の手順)
2. playwright の `page.mouse` で、コードの塊の左端の少し内側を `down` し、上の項目の位置 (コードの 200px 上) へ `move` (steps 1) して `up` する
3. `getSelection().getRangeAt(0)` の始点・終点がコードの塊の中かを見る

## 未確認 (同じ計測で出たもの)

- assistant の本文の 11 番目の段落 (`.tl-text-assistant p`) の左端から 2px で押し、サイドバー (120, 300) へ 1 歩と、右端 (x = 1580) の 300px 下へ 12 歩で動かした。Chromium は 2 通りとも項目の外まで選ばれ (サイドバーの行の文字、次の項目の日付と翻訳のタブの文字)、WebKit はサイドバーへの 1 通りが外まで選ばれ、もう 1 通りは空だった。前後のコードで同じ答え。押した位置が本文の字の外 (閉じ込め先の候補が立たない場所) だった可能性があり、測り方を含めて確かめていない
- Chromium でコードの中を drag で選んでから `document.execCommand("copy")` を呼び、`copy` の event の中で `getSelection().toString()` を読むと、前後のコードとも空文字だった (WebKit はコードの文字そのもの)。headless の Chromium の execCommand の扱いによるものか、選択が消えているのかは確かめていない
