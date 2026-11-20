---
title: Files の編集の打鍵の重さを直す未取り込みの枝 (1 行 1 block の contenteditable、DR-0055 案) を取り込むか決める
status: open
category: task
created: 2026-11-20
---

# Files の編集の打鍵の重さを直す未取り込みの枝 (1 行 1 block の contenteditable、DR-0055 案) を取り込むか決める

## 何があるか

2026-11-17 の別のセッションが作り、main に取り込まれないまま残った枝。土台は v0.273.0 (`wzvwspwp`)。jj の commit は消さずに残してある (どの bookmark にも載っていない head)。

| change id | 中身 |
|---|---|
| `wvpquuvy` | findings `2026-11-17-file-edit-keystroke-cost.md` (今の実装と 2 通りの組み方の 1 打鍵の重さを実ブラウザで測り、本文の扱いの 30 シナリオを textarea と比べた) |
| `xwwyqopt` | 実装: Files の編集領域を、閲覧と同じ 1 行 1 block に閲覧側の着色済みの span を置いた contenteditable にし、編集中の着色し直し (増分トークン化と Custom Highlight の登録) をやめた。16 ファイル、+971 / -1318 |
| `tpzzowvv` | docs: DR-0055 (上の形) を書き、DR-0051 を archive に移した。findings に 1 行 1 block の計測・本文の読み方・IME の結果を足した |
| `kyzmlkvu` | `CodeEditor.tsx` の冒頭のコメント 2 行 (行番号ガターの数え直しの説明) の書きかけ |

## なぜ要るか (findings の要点)

今の実装 (DR-0051、CSS Custom Highlight API) は WebKit で重い。4800 行の tsx で 1 文字の入力から描画まで 48〜78ms、連続入力では 1 文字 105〜371ms に積み上がる。重さはトークン化の JS ではなく、その後の描画。Chromium は 4800 行で 1 文字 20〜33ms。

## 取り込むなら

- v0.273.0 から main まで 28 版ぶん離れているので、今の main に載せ直して (rebase と衝突の解消)、findings の計測を今の main で取り直す
- DR-0051 を置き換える設計の変更なので、DR-0055 の決定は kawaz の裁定を取ってから land する
- 取り込まないなら、枝の commit を abandon して閉じる
