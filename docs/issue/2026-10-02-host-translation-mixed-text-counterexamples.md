---
title: host 翻訳 (Translation.framework) が findings の「日英混在の日本語保持」「改行保持」と食い違う観測
status: open
category: bug
created: 2026-10-02T15:08:24+09:00
last_read:
open_entered: 2026-10-02T15:08:24+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: workboard-personal (incubator 枝 ideas/translate-bench/)
---

# host 翻訳 (Translation.framework) が findings の「日英混在の日本語保持」「改行保持」と食い違う観測

## 概要

host 翻訳 (Translation.framework、DR-0023) で、`findings/2026-07-17-macos-translation-poc.md` の「日英混在の日本語部分は保持」「改行は保持」と食い違う観測が出た。外部の比較 PoC (workboard-personal の incubator 枝 `ideas/translate-bench/`、helper と同じ `session.translations(from: [Request])` を 1 段落ずつ、macOS 26.5 / M1 Max、2026-10-02) での実測。

1. **同じ行の日本語の書き換え**: 入力 `Keep the output concise.検証済みの結果だけを述べる。If the test has not run, write `not measured` rather than claiming that the change is safe.` → `出力を簡潔に保ちます。検証済みの結果のみを述べます。…`。常体の日本語が敬体に変わっている。上流の検証例の日本語 (「ここから日本語です」) は元から敬体だったので、書き換えが起きても見えなかった可能性がある (推測、未検証)。
2. **インラインコードの翻訳**: 同じ入力のバッククォート内 `not measured` が「測定されていない」に訳される。上流の PoC ではインラインコードを検証していない。
3. **単一改行への空行挿入**: 1 行ずつ `\n` で区切った 3 行 (例 `First, send one paragraph to `ws.translate([text])`.\nThen await its response without blocking independent requests.\nFinally, render the successful results in their original order.`) の訳で、各行の間に空行が入る (`\n` が `\n\n` になる)。上流の PoC は空行区切り (`\n\n`) の段落だけを検証している。なお空行区切りの段落の中の日本語段落は今回も保持された。

再現データは incubator の `ideas/translate-bench/texts.jsonl` の id 06 / 07 / 10 と `out/translation.jsonl`。

## 背景

部外者からのフラグ。該当性の裏取りと、直すかどうか・どう直すか (日本語やインラインコードをプレースホルダに置き換えて送る、行単位で送る、等が考えられる) は担当セッションの判断に委ねる。裏取りしてから採否を決めること。

## 受け入れ条件

- [ ] 上記 3 点を実機で再現確認し、findings に反映 (または findings の記述を訂正)
- [ ] 対処する場合の方針を決める (プレースホルダ化 / 行単位送信 / 対処しない)
