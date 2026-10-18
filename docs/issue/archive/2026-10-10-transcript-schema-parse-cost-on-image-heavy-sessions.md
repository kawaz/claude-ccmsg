---
title: transcript-schema-parse-cost-on-image-heavy-sessions
status: resolved
category: bug
created: 2026-10-10T12:47:04+09:00
last_read: 2026-10-18T17:57:40+09:00
open_entered: 2026-10-10T12:47:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T18:02:02+09:00
discard_reason:
pending_reason:
close_reason: ["done:実測で画像は主因でなくJSON.parseが支配的、スキーマ分は検索1回の走査上限256MBで約0.18sに収まり実害小"]
blocked_by:
origin: 自リポ TODO
---

# transcript-schema-parse-cost-on-image-heavy-sessions

## 概要

transcript の行を valibot のスキーマで読む (DR-0038 §3、段 A・B) ようにした結果、13MB の transcript で JSON.parse 13ms に対しスキーマ 35ms、画像だらけの 218MB / 722 行では 240ms に対し 1.5s と約 6 倍 (段 B worker の計測 2026-10-10)。Session Search で固定文字列を含まない正規表現だと全行がスキーマに通るので差がそのまま効く。実運用の検索で体感に出るかを計測し、出るなら検索用の投影スキーマ (text ブロックだけ、image の source を読まない) や前段の文字列フィルタで絞る。

## 背景

DR-0038 §3 の段 A・B でスキーマ読みへ移行した副作用。画像ブロックの source (巨大な base64) までスキーマが走査することが差の主因と推測される (未検証)。

## 受け入れ条件

- [x] 実運用の Session Search で体感に出るか計測し結果を記録する
- [x] 出る場合、投影スキーマまたは前段の文字列フィルタで絞って再計測する (該当なし: 体感に出ないと判断したため)

(category: perf の指定だが enum に無いため bug を選択 — 要確認)

## 計測 (2026-10-18)

計測: protocol の `TranscriptRowSchema` / `TranscriptRowLineSchema` を使う一時スクリプトで、手元の実 transcript を対象に、行の分割、`JSON.parse`、parse 済みの値へのスキーマ (既知の行 / それ以外の行に分けて)、検索と同じ `parseWith(TranscriptRowLineSchema, line)` を測った (macOS arm64、Bun 1.4.2)。

| 対象 | 量 | 画像 block | 読み込み+分割 | JSON.parse | スキーマ (既知 / それ以外) | 行スキーマ (parse 込み) |
|---|---|---|---|---|---|---|
| 5 MB 超の transcript 173 本 | 1,749 MB / 585,262 行 | 912 | 1,232 ms | 2,280 ms | 672 / 569 ms | 3,571 ms |
| 画像 block 10 個以上の transcript 31 本 | 226 MB / 55,827 行 | 948 | 158 ms | 196 ms | 93 / 22 ms | 305 ms |
| 7 日以内に更新された transcript 202 本 | 213 MB / 50,082 行 | 22 | 175 ms | 331 ms | 120 / 29 ms | 463 ms |
| 単体: 217 MB / 722 行 (本文の「218 MB / 722 行」と同規模) | | | | 254 ms | 114 ms | 346 ms |

- 本文の「約 6 倍 (240 ms → 1.5 s)」は再現しない。同規模の 217 MB / 722 行で JSON.parse 254 ms に対し行スキーマ 346 ms (1.36 倍)
- 画像は主因でない。image の `source.data` は `v.string()` で、検査は型の判定だけで長さに比例しない。画像の多い 31 本のスキーマ/parse 比 (0.59) は全体 (0.54) とほぼ同じ
- 217 MB / 722 行の スキーマ 114 ms のうち 109 ms は `progress` 行 (既知でない種類の行、`OtherTranscriptRowSchema` で値を JsonValue として再帰的に読む。1 行あたり 1 万〜1.5 万ノード) だった
- 支配的なのは JSON.parse (parse + スキーマのうち 64%)。parse を飛ばす前段フィルタは行の型を文字列で決め打ちすることになり、保証を落とさずに削れる余地は見つからなかった
- 実害の大きさ: Session Search は 1 リクエストの走査を 256 MB (`REQUEST_SCAN_MAX_BYTES`) で打ち切る。上の 1,749 MB の比率で換算すると、固定文字列を含まない正規表現で上限まで読む最悪の検索でも JSON.parse 約 0.33 s、スキーマ約 0.18 s (うち既知でない行が約 0.08 s)。固定文字列を含む検索は前段フィルタで大半の行が parse 前に落ちる
- 残る改善の候補 (未実装): 検索は user / assistant 行しか使わないので、その 2 種と「それ以外は type だけ」の投影スキーマにすれば既知でない行の約 0.08 s / 256 MB は削れる。体感に出る量ではないので見送る
