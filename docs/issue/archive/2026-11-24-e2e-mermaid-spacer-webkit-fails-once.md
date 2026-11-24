---
title: "e2e: mermaid の切り替えの spacer の試験が webkit で 1 回だけ落ちた"
status: resolved
category: bug
created: 2026-11-24
origin: "自リポ TODO (worker の e2e の通しの副産物)"
close_reason: implemented
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

## 再現 (2026-11-24、M1 Max、bun 1.4.4、他の重い仕事なし)

`markdown-mermaid-prefs.e2e.ts` だけを `-t` で絞って繰り返した。

| 条件 | 回数 | 落ちた回 | 受け取った値 |
|---|---|---|---|
| webkit の describe 全体 (`-t "in webkit"`) | 30 | 2 | 8.03125、5.03125 |
| 時系列を取る計装を入れた写し、`switches` の両 engine (`-t "switches"`) | 30 | webkit 4、chromium 0 | 5.03125 (3 回)、6.03125 |
| webkit の describe 全体、忙しいループ 16 本を並べた負荷の下 | 10 | 0 | - |

- 落ちるのは webkit だけで、値は 4〜8px に固まる (issue の 4.03125 と同じ形)
- 負荷を掛けても増えなかった (10 回で 0)。負荷は落ちる条件ではない
- 計装の 1 回では、spacer の試験が落ちた後に同じ describe の「ダーク …」の試験も落ちた (切り替えの位置のずれ 2633)。spacer の試験が途中で抜けて、ソースに切り替えた状態と位置を残したことによる連鎖で、別の原因ではない

## 原因 (計装の時系列で確かめた)

計装は、押す前から毎 frame の rAF でスイッチの列の上端・spacer の高さ・scrollTop を記録し、click の event の時刻と、試験の測る `page.evaluate` が始まった時刻を残した。

1. 落ちた値は、補正した frame の位置ではなく、その次の frame の位置だった。補正した frame の後、spacer (高さ約 197px) は CSS の transition で縮み始め、次の frame ではもう 5〜6px 縮んでいる (192.3px、191.3px)。押した切り替えは同じだけ動いている
2. 試験は `click()` が返った後に別の `page.evaluate` を送り、その中で最初の frame から測っていた。製品の補正は click の後の最初の frame の rAF で行われる (`keepSwitch`)。`page.evaluate` がその frame より後に始まると、補正した frame を見逃し、縮み始めた次の frame を最初の位置として測る
3. 証拠: 計装の 30 回のうち、落ちた webkit の 4 回はどれも click と `page.evaluate` の開始の間に frame が 1 つ挟まっていた (例: click 1923ms → frame 1926ms → evaluate の開始 1931ms)。通った 56 回 (webkit 26、chromium 30) は 0 だった
4. 製品の振る舞いは通った回と落ちた回で同じ: 記録した位置の列 (補正の前の frame で +187px、補正の次の frame で +5〜6px、その後 +14、+32、+51 …) は両方で一致した。製品の側の 1 frame の遅れではない

## 直した内容

測り始めを、`click()` の後の `page.evaluate` から、押した click そのものに移した。押す前に `page.evaluateHandle` で document に click の listener を 1 度だけ付け、その listener が rAF で毎 frame の測りを始める。押した後はその結果を待つ。

- 測る出来事は「押した後の最初の frame の、補正が済んだ後」。document の click の listener はスイッチ自身の handler (`keepSwitch` が補正の rAF を頼む) より後に走るので、最初の frame では測りの callback が補正の callback の後に走る。`click()` と次の `page.evaluate` の間の往復の時間に左右されない
- 確かめる条件は前と同じ「押した後の最初の frame で、押した切り替えが押した時の位置に居る」。補正が 1 frame 遅れる製品の誤りも落ちる: `keepSwitch` の rAF を 2 重にした写し (`-t "switches"`、5 回) で、直した後の試験は chromium で 188.40625、webkit で 187.03125 を受けて 5 回とも両 engine で落ちた。直す前の試験は同じ写しで chromium は 5 回、webkit は 4 回だった (webkit で見逃した 1 回は、`page.evaluate` が最初の frame の後に始まったためと見ているが、その回の時系列は取っていない)
- assert と許容は変えていない
- 直した後: `-t "switches"` (両 engine) を 40 回流して 0 回、webkit の describe 全体を忙しいループ 16 本の負荷の下で 10 回流して 0 回

## 測る時の注意

macOS の画面が消えている間は、webkit の試験の click が「`<html>` が pointer の event を遮る」で 30 秒待って落ちる (この試験より前の切り替えの試験から落ち、試験も製品も main のままでも同じ)。2026-11-24 の測定では、画面が消えた 22:44:53 の後の回から全部この形になり、`caffeinate -u` で画面を点けると通った。この issue の 4〜8px の失敗とは別の形で、繰り返して測る時は `caffeinate -d` の下で流す。
