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

## 計測の結果と直したこと (2026-11-15)

数値と方法の正本は [findings 2026-11-15-timeline-base-cost](../findings/2026-11-15-timeline-base-cost.md) と、[findings 2026-11-12-in-view-search-range-cost](../findings/2026-11-12-in-view-search-range-cost.md) の「TL の基準の重さ」の節。

- 計測 (headless、過去分を読み切った普段の形の長い TL、要素約 4.7 万)。開いた直後 (要素約 3,300) は 30〜50ms で問題なし。v0.256.0 でも同じ値で、最近の悪化ではない

| 操作 | Chromium (直す前 → 後) | WebKit (直す前 → 後) |
|---|---|---|
| push 1 回 | 5,577 → 約 235ms | 1,234 → 約 330ms |
| fold の開閉 | 5,398 → 約 50ms | 1,020 → 約 93ms |
| TL の中の 1 か所の変更 | 3,533 → 約 32ms | 981 → 約 41ms |

- 原因はブラウザごとに別の CSS だった
  - Chromium: 吹き出しごとの ☰ が全部同じ `anchor-name` を持ち、同じ名前の anchor が増えると layout が超線形に伸びる。v0.267.0 で、包む要素に `anchor-scope` を足して直した (☰ のメニューが最後の ☰ の下に開く不具合も同じ原因で直った)
  - WebKit: 縦並びの flex の行の列 (`.tl-lines`) の中に、それ自体 flex で絶対配置の子孫を持つ行が並ぶと、layout が行数の 2 乗で伸びる。v0.269.0 で `.tl-lines` を grid にして直した (全状態で矩形の差 0・画素の差 0)
- 上の「候補」の扱い
  - 画面外の group を畳む仮想化: 要らなくなった (`content-visibility: auto` は試したが、末尾への追従が壊れるので採らない)
  - push のたびの scroll の計測を新しい行の分に限る: trace では強制 layout は大きく出ておらず、効果は小さい見込み
  - markdown の parse の使い回し: 未検証
- 残り
  - push に残る 200〜300ms は WebSocket の onmessage の script の時間 (DOM の変更は 2 ノードだけ)。内訳は未計測で、次に削るならここ
  - エンジンの中でなぜ超線形・2 乗になるかは未特定
  - 実機の Safari と、画面を出した Chrome での値は未確認
- この issue は、残りの script の時間を追うかどうかを決めたら close する

## 計測の結果と直したこと (2026-11-19)

数値と方法の正本は [findings 2026-11-19-timeline-push-script-cost](../findings/2026-11-19-timeline-push-script-cost.md)。

- push に残っていた script のほとんどは、既存の吹き出し全部の markdown の parse と描画のやり直しだった (上の「push のたびに `MarkdownView` の parse が既存の行でもやり直されているか」の答えは「全部」)
  - `LinkedMarkdownView` が linker を描画のたびに新しく作り、`MarkdownView` の memo が毎回外れていた
  - 吹き出しが memo されておらず、push で全部描き直されていた
- 同じ「全部 parse し直し」が push の task の外にも 2 つあった: 約 5 秒後の peers の push (ctx を peer の行の identity で memo していた) と、新しい吹き出しのパスの存在の確認の答え (cache の通知が全部の吹き出しに届いていた)
- 直したこと: linker と ctx を値で memo、cache の通知に答えたパスを載せて自分のパスの答えでだけ描き直す、`Timeline` の ctx を値で memo、ユーザ発話と assistant の吹き出しを memo。テストで固定した

| ブラウザ (状態 B 相当) | push の sync (前 → 後) | push の settle (前 → 後) | 約 5 秒後の長いフレーム (前 → 後) |
|---|---|---|---|
| Chromium | 284 → 25ms | 407 → 174ms (パスを含む push は 619 → 171ms) | 250ms → なし |
| WebKit | 401 → 107ms | 537 → 232ms (パスを含む push は 804 → 230ms) | 337ms → なし |

- 「候補」のうち「markdown の parse を行ごとに使い回す」は、行ごとの memo (`MarkdownView` の `useMemo`) が効くように直して実現した
- 残り
  - 画面内検索の飾り付けの effect が push のたびに全部の単位をやり直す (両エンジンで約 19ms、描画の後の別の task)。検索語の既定値で検索が常に生きているため
  - `useTranscriptModel` の窓全体の pass (Chromium で約 8ms)
  - WebKit の commit の後、次の task までの約 67ms (layout / 描画と見ている、未分離)
  - session_status の push の時の描き直しと、ccmsg の吹き出しの多い TL での値は未計測。実機の Safari と画面を出した Chrome も未確認
