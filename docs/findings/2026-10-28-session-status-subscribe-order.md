# webui の session_status 購読が読み込み直後に切れる不具合を再現し、購読の順序を client で持つ修正を確かめた

- Date: 2026-10-28
- 対象: issue `2026-10-26-session-status-subscribe-dropped-on-load`
- 環境: 隔離 daemon (`HOME` / `CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `XDG_*` / `TMPDIR` を一時ディレクトリに向け、HTTP は `127.0.0.1:18642`)。daemon は main の commit から切った jj workspace で動かし、修正前は手を入れない tree、修正後はその tree に修正の 4 ファイルだけを写した。webui の bundle は daemon の process ごとに作られるので、修正前後で daemon を起動し直した
- 受け手のセッション: 本物の claude は使わず、試験用に生成した sid で unix socket から `hello` (role session、`transcript_path` は一時ディレクトリの jsonl) を送って繋ぎっぱなしにする script。status の変化は、その jsonl に TaskCreate の行の組を追記して起こした (daemon の fold が変わり `ev:"session_status"` を push する)
- ブラウザ: playwright-cli。`page.routeWebSocket` で `/ws` を中継し、両方向のフレームを接続ごとに記録した

## 再現の作り方

SessionView の購読の effect は deps に `statusSource` (peer の `transcript_path` と repo_root / cwd) を持つ。peer が来る前に `hasTranscript` が真になっている (この記録ではピン留めの `file`、issue の元の観測では恐らく agents の行。後者は未検証) と、effect は `statusSource = null` で 1 回走り、peers の応答で文字列に変わって張り直される。

隔離 daemon の loopback では peers の応答が最初の effect より先に届き、張り直しが起きなかった。そこで中継で daemon の peers の応答だけを 300 ms 遅らせ、ピン留め (localStorage の `ccmsg.pinnedSessions`) を入れた状態で `/s/<sid>/timeline/head` を読み込んだ。

1 回の試行:

1. 読み込み (peers の応答を 300 ms 保留)
2. app の接続だけが購読している状態で jsonl に追記し、5 秒間 app の接続に `ev:"session_status"` が来るか見る
3. 同じページから別の WebSocket を開いて hello (user) → `session_status_subscribe`、もう一度追記し、両方の接続に来るか見る

## 修正前 (8 回)

送信列はどの回も `subscribe` (1 回目の effect) → `subscribe` (張り直し) → `unsubscribe` (1 回目の後始末)。1 回目の応答が届いた後でも、後始末の unsubscribe は `subscribed.then(...)` の後に回るので、張り直しの subscribe より後に書かれる。

| 回 | app の送信列 (session_status) | 2. app に push | 3. app に push | 3. 別接続に push |
|---|---|---|---|---|
| 1 | subscribe q6 → subscribe q9 → unsubscribe q10 | 1 | 1 | 1 |
| 2 | subscribe q5 → subscribe q9 → unsubscribe q10 | 1 | 1 | 1 |
| 3 | subscribe q7 → subscribe q9 → unsubscribe q10 | 0 | 0 | 1 |
| 4 | subscribe q5 → subscribe q9 → unsubscribe q10 | 0 | 0 | 1 |
| 5 | subscribe q6 → subscribe q9 → unsubscribe q10 | 0 | 0 | 1 |
| 6 | subscribe q5 → subscribe q9 → unsubscribe q10 | 1 | 1 | 1 |
| 7 | subscribe q6 → subscribe q9 → unsubscribe q10 | 1 | 1 | 1 |
| 8 | subscribe q7 → subscribe q9 → unsubscribe q10 | 0 | 0 | 1 |

- 8 回中 4 回、app の接続にはその後 `ev:"session_status"` が 1 件も来なかった。同じ回に別接続には来ている (daemon は push している)
- 送信列は毎回同じで、切れるかどうかは daemon が 2 つの要求を処理する順で決まる。daemon は接続の要求を並行に処理し、`session_status_subscribe` は IO を待ってから接続を購読者に加え、`session_status_unsubscribe` は待たずにその接続を外す。unsubscribe が subscribe の追加より先に処理されれば、購読者 0 で fold が捨てられた後に subscribe が作り直して残り、後なら追加済みの接続が外されて切れる

## 修正

`packages/webui/src/client/subscription-order.ts` を足し、ws.ts の `sessionStatusSubscribe` / `sessionStatusUnsubscribe` をそれ経由にした。

- 同じ sid の要求は、前の要求の応答 (または失敗) の後に書く
- まだ書いていない unsubscribe は、同じ sid の subscribe が呼ばれたら書かない (unsubscribe → subscribe と subscribe だけは、接続が sid を購読している点で同じ結果になる。両方書くと daemon は購読者 0 の時点で fold を捨て、transcript を全量走査し直す)

SessionView の後始末は subscribe の Promise を待たず unsubscribe を呼ぶだけになった (順序は ws.ts が持つ)。

## 修正後 (8 回)

| 回 | app の送信列 (session_status) | 2. app に push | 3. app に push | 3. 別接続に push |
|---|---|---|---|---|
| 1 | subscribe q6 → subscribe q9 | 1 | 1 | 1 |
| 2 | subscribe q6 → subscribe q9 | 1 | 1 | 1 |
| 3 | subscribe q7 → subscribe q9 | 1 | 1 | 1 |
| 4 | subscribe q6 → subscribe q9 | 1 | 1 | 1 |
| 5 | subscribe q5 → subscribe q9 | 1 | 1 | 1 |
| 6 | subscribe q7 → subscribe q12 | 1 | 1 | 1 |
| 7 | subscribe q5 → subscribe q9 | 1 | 1 | 1 |
| 8 | subscribe q7 → subscribe q9 | 1 | 1 | 1 |

- 張り直しの後始末の unsubscribe は書かれず、8 回とも app の接続に push が届いた

## 修正後: 購読を外すべき時に外れるか

同じページで続けて確かめた。

| 操作 | app の送信 | 追記後 3 秒の app への push |
|---|---|---|
| セッションの view から `/` へ (SPA 内の遷移) | `transcript_unsubscribe`、`session_status_unsubscribe` | 0 |
| `/` から同じセッションの Timeline へ戻る | `transcript_subscribe`、`session_status_subscribe` | 1 |
| Status タブを開いて追記 | (なし) | 1、サイドバーのバッジが `todo:0/56` → `todo:0/57` に変わった |

## この記録で確かめていないこと

- issue の元の観測の契機 (恐らく agents の行が peers より先に届く場合)。隔離 daemon には agents の行が無いので、ピン留めと peers の遅延で同じ effect の経路 (`statusSource` が null から文字列に変わる張り直し) を作った
- Timeline の live tail (`useLiveTailSubscription.ts` の transcript_subscribe) も後始末を `subscribed.then(...)` で遅らせており、deps (`agentActive` 等) の変化で同じ sid に張り直すと同じ送信順になる。daemon の transcript の購読者も接続の集合で持つ。この記録の範囲外で、実機での再現はしていない
