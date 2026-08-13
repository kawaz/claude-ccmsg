# 空 thinking と signature の調査

## 判明した事実

1. signature は thinking 全文の暗号化コピー。公式 docs (Thinking encryption 節) は
   "Full thinking content is encrypted and returned in the signature field" と明記しており、
   マルチターンでサーバが復号して思考コンテキストを復元するための持ち回り用データ。opaque と
   明言されており ("don't interpret or parse it")、クライアント側での解釈は想定されていない。
2. `thinking: ""` は `display: "omitted"` の正規仕様。Fable 5 / Mythos 5 / Opus 5 / Sonnet 5 /
   Opus 4.8 / 4.7 のデフォルト挙動で、「思考自体は行ったが本文を返さない」状態を表す。課金は
   本文の有無で変わらない ("Omitting reduces latency, not cost")。思考自体をスキップした場合は
   thinking ブロック自体が生成されない。summarized 設定でも生の chain-of-thought は返らない。
3. 実測 (直近 45 日分、624 セッションファイル、thinking ブロック 20,107 件):
   空 (`thinking: ""`) 804 件 / 非空 19,303 件 / `redacted_thinking` 0 件。
   signature の長さは thinking 本文の長さと相関 (r=0.802)。本文長のバケット別に signature 長の
   中央値を見ると 548 → 37,148 (最大 232KB) と単調に増加しており、signature が本文を内包して
   いることの実測的な裏付けになっている。
4. signature の中身: base64 デコード後のバイト列はエントロピー 7.44〜7.83 bits/byte で暗号化
   blob の特徴を示す。protobuf 風ヘッダにモデル名・`"thinking"` という文字列・UUID のみが平文で
   確認でき、可読な思考本文は含まれない (復号自体は未試行)。
5. 時系列: 2026-08-11 を境に空 thinking の出現率が急増している (それ以前は 0〜3%/日、以降は
   34〜40%/日)。同一セッション内で空/非空が混在するケースが 9 セッションあり、リクエスト単位で
   挙動が揺れていることを示す。ccmsg 側の実装起因ではなく、Claude Code の display 指定挙動か
   サーバ側の変更を示唆する。
6. `redacted_thinking` は `data` フィールドを持つ別型のブロックで、安全性の理由による墨消し用途。
   今回の調査対象 (空 thinking の急増) とは別現象であり、実測でも 0 件だった。

## 実用的な示唆 / ベストプラクティス

- タイムライン UI での表示: 空 thinking は単純に非表示にせず「思考あり・内容は非公開」を示す
  プレースホルダとして fold 表示するのが妥当。非表示にすると「思考せず即答した」と誤読される
  リスクがあるが、実際には思考は行われており課金も発生している。
- signature は opaque と明言され、かつ最大 232KB に達し得る大きさのため、UI 上には出さない
  (ログや debug 表示に出す場合も base64 のまま生の値を晒さない配慮が要る)。
- `type === "thinking"` のみでフィルタするパーサは `redacted_thinking` を無言で取りこぼす。
  型分岐にこのケースを明示的に含めておくとフィルタ漏れを予防できる。
- 思考量の代理指標として signature の長さを使わない。正規の指標は
  `usage.output_tokens_details.thinking_tokens`。

## 検証の詳細

### thinking 空/非空・redacted_thinking の集計

直近 45 日分、624 セッションファイルを対象に thinking ブロックを全件走査。

| 分類 | 件数 |
|---|---|
| thinking (空文字列) | 804 |
| thinking (非空) | 19,303 |
| redacted_thinking | 0 |
| 合計 | 20,107 |

### signature 長と thinking 本文長の相関

thinking 本文の文字数でバケット分割し、各バケットの signature 文字数 (base64) の中央値を比較。

| 本文長バケット | signature 長 中央値 |
|---|---|
| 最小バケット | 548 |
| 最大バケット | 37,148 (最大値 232KB 相当) |

全体相関係数 r = 0.802。本文が長いほど signature も長くなる傾向が明確で、
signature が thinking 全文を内包する暗号化コピーであるという公式 docs の記述と整合する。

### signature バイナリの構造確認

signature を base64 デコードし、エントロピーとヘッダ部分の可読性を確認。

- エントロピー: 7.44〜7.83 bits/byte (ランダムに近く暗号 blob の特徴)
- 先頭付近の protobuf 風ヘッダにモデル名・文字列 `"thinking"`・UUID のみ平文で観測
- それ以外の領域に可読テキストは見られない (復号自体は未実施、平文思考本文の直接確認はしていない)

### 空 thinking 出現率の時系列変化

日別に空/非空の比率を集計したところ、2026-08-11 を境に急増する変化点が見られた。

| 期間 | 空 thinking 出現率 |
|---|---|
| 2026-08-11 以前 | 0〜3%/日 |
| 2026-08-11 以降 | 34〜40%/日 |

同一セッション内で空/非空が混在するケースが 9 セッション確認され、セッション単位ではなく
リクエスト単位で display 挙動が変わっていることを示す。ccmsg 実装のバグではなく、
Claude Code 側の display 指定またはサーバ側挙動変更に起因すると考えられる。

出典: https://platform.claude.com/docs/en/build-with-claude/thinking (Thinking encryption 節)。
集計スクリプトはセッション限りの scratchpad に置いたため本リポには残していない。
