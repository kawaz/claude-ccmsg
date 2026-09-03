# session_status 同一接続内レイテンシ

> 本計測が捉えた同一接続内の待ちは、相関 id 付き RPC の導入 (DR-0029 追補、
> 2026-09-03) で解消済み。同じ計測を再実行すると cold scan 中の `ping` は
> 0.5〜0.7 ms で返り、scan 自体の所要時間は変わらない (max 標本で 1,124〜
> 1,162 ms)。以下は撤去前の観測記録。

## 判明した事実

- 実環境にある 13,517 本の非空 transcript から、小（最小）、中央値、大（90 percentile）、最大の 4 本をコピーし、隔離 daemon で各 3 回計測した。
- 同一 user 接続へ `session_status_subscribe` と `ping` を続けて送ると、全 12 cold 試行で status 応答の後に ping 応答が返った。ping の応答時刻は status 応答から 0.04〜0.12 ms 後であり、後続 op は cold scan の完了まで同一接続の FIFO で待つ。
- 117 B、104,668 B、839,583 B の標本では、cold 時の ping 応答時間の中央値はそれぞれ 6.11 ms、7.73 ms、11.43 ms だった。最大 218,279,265 B の標本では 1,147.25 ms（範囲 1,113.75〜1,153.47 ms）だった。
- 同じ daemon 上で live fold を再利用する warm 時の ping 応答時間の中央値は、4 標本とも 0.51 ms 以下だった。
- WebUI の SESSIONS 一覧は `session_status` を要求しない。選択中セッションの Files、Status、Timeline のいずれかを開いた場合だけ、同一接続で `session_status_subscribe` を 1 本発行する。一覧を開くだけなら cold scan による待ちは 0 ms である。
- 最大標本のセッションで Files、Status、Timeline のいずれかを初めて開く場合、同じ WebSocket 接続上の後続操作が約 1.11〜1.15 秒待つ条件が実在する。通常的な中央値・90 percentile 標本では、今回の計測上は数百 ms の UI 停止に達しなかった。

## 実用的な示唆 / ベストプラクティス

- 2-phase 化の判断では、SESSIONS 一覧全体への fan-out 対策ではなく、極端に大きい transcript を選択して Files、Status、Timeline を初めて開く時の約 1.15 秒を対象に評価すればよい。
- 推奨: 発生条件は限定的だが 1 秒超の実害は確認できたため、protocol 拡張コストと比較する判断材料として 2-phase 化を検討対象に残す。

## 検証の詳細

### 対象と方法

計測日は 2026-09-02。`~/.claude-personal/projects/**/*.jsonl` の原本は読み取り専用とし、選んだ 4 本を `/private/tmp/ccmsg-session-status-latency/samples/` へコピーした。findings には transcript の内容・原本パス・固有名詞を記録しない。

標本は非空ファイルを byte size の昇順に並べて選んだ。

| ラベル | 選択位置 | サイズ |
|---|---:|---:|
| 小 | 最小（rank 0 / 13,517） | 117 B |
| 中央値 | rank 6,758 / 13,517 | 104,668 B |
| 大 | 90 percentile（rank 12,164 / 13,517） | 839,583 B |
| 最大 | rank 13,516 / 13,517 | 218,279,265 B |

各標本について次を 3 回繰り返した。

1. `startTestDaemon()` で一時 state/config/data directory、`CCMSG_HTTP_BIND=off`、`CCMSG_NETWORK_WATCH=off` の隔離 daemon を起動する。
2. コピーした transcript を session-role 接続の `transcript_path` として登録する。
3. 1 本の user-role 接続へ `session_status_subscribe` と `ping` を待たずに連続送信し、送信開始から各応答までを `performance.now()` で計る。これを cold とする。
4. 同じ daemon・同じ session へ `session_status` と `ping` を連続送信する。subscribe が構築した live fold を再利用するため、これを warm とする。
5. daemon の `shutdown` op で停止する。

計測スクリプトと生結果はリポ外の scratchpad に置いた。

```sh
(direnv exec . bun /private/tmp/ccmsg-session-status-latency/measure.ts)
```

### 計測マトリクス

値は送信開始から応答受信までの ms。各セルは 3 回の `中央値 [最小–最大]`。

| transcript | 状態 | session_status 所要時間 | 後続 ping 待ち時間 |
|---|---|---:|---:|
| 小（117 B） | cold | 5.99 [5.85–6.74] | 6.11 [5.94–6.86] |
| 小（117 B） | warm | 0.36 [0.29–0.47] | 0.37 [0.30–0.49] |
| 中央値（104,668 B） | cold | 7.68 [7.35–9.69] | 7.73 [7.42–9.75] |
| 中央値（104,668 B） | warm | 0.31 [0.26–0.31] | 0.33 [0.27–0.33] |
| 大（839,583 B） | cold | 11.36 [10.01–29.03] | 11.43 [10.06–29.08] |
| 大（839,583 B） | warm | 0.50 [0.37–0.99] | 0.51 [0.38–1.03] |
| 最大（218,279,265 B） | cold | 1,147.18 [1,113.72–1,153.43] | 1,147.25 [1,113.75–1,153.47] |
| 最大（218,279,265 B） | warm | 0.38 [0.37–0.42] | 0.39 [0.37–0.42] |

全試行の応答順は `session_status` → `ping` だった。ping 単体の処理時間を差し引いた値ではなく、利用者が後続 op の応答を受け取るまでの実時間を「後続 ping 待ち時間」とした。

### WebUI の発行本数

`SessionView` は選択中かつ active な 1 セッションに対してのみ effect を有効にし、Files、Status、Timeline の需要を 1 つの `needsStatus` に集約している（`packages/webui/src/client/components/SessionView.tsx:181-212`）。タブ間を切り替えても購読を重複させず、session 切替・Rooms 切替・unmount 時に unsubscribe する（`packages/webui/src/client/components/SessionView.tsx:235-240`）。サイドバーのミニバッジは既存 snapshot を読むだけで、一覧中の全 peer を購読しない（`packages/webui/src/client/components/SessionView.tsx:194-199`）。

したがって SESSIONS 一覧を開いた時の発行本数は 0 本、選択中セッションで対象タブを開いた時は 1 本である。現行 UI に「一覧内の複数 session_status が同一接続で直列に並び、合計待ち時間が増える」経路はない。最悪待ち時間の推定は、一覧だけなら 0 ms、最大 transcript の対象タブ初回表示なら実測上限 1,153.47 ms である。
