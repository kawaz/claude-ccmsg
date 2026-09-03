# DR-0029: IO を伴うイベント / メッセージ処理は全て非同期化する (原則)

- Status: Accepted
- Date: 2026-07-31
- 発端: kawaz r99m3〜m5 (thinking 翻訳の microbatch 集約への指摘から一般化)

## 決定

daemon / webui (UI) を問わず、**IO を伴うイベントやメッセージの処理は
async/await による非同期処理を原則とする**。

- 1 イベント = 1 単位で個別に処理し、個別に結果を返す。呼び出し側が
  まとめて待たされる形 (時間窓での集約、複数ジョブの運命共同体化) を
  勝手に入れない
- 所要時間がばらつくジョブを他のジョブと束ねると、短いジョブが長い
  ジョブに巻き込まれる head-of-line blocking が起きる。総時間が多少
  増えても**小出しに返す方が UX として正** (kawaz r99m3: 「文章を読む
  のは 9 翻訳を同時に脳にぶち込んで同時に読むわけではない」)
- 同期 IO (同期 fs API、イベントループを塞ぐ重い同期処理) をイベント
  ハンドラ / メッセージハンドラに置かない

## まとめ処理 (batching / 窓集約) を入れたい場合

kawaz の承認を得てから入れる。勝手に導入しない (r99m4: 翻訳 microbatch
は未承認のまとめ処理の再導入で、既裁定 r34m11 とも矛盾していた)。

承認を求める際は「何が束ねられ、最悪ケースで何が何に巻き込まれるか」を
明示する。参考として、既存で性質上問題になっていない集約は
fs_stat_batch (均質・軽量なメタデータ確認の microtask 束ね) と
storage の fsync debounce (書き込み自体は即時、耐久性同期のみ集約) の
2 つ (2026-07-31 時点の実査)。

## 追補 (2026-09-03): 相関 id 付き RPC を土台にし、接続ごとの FIFO を撤去

- 発端: kawaz r259m25「最初から 2 パターンどちらでも同じ感じでメッセージング
  処理できるような両端のインターフェースを作っておいて、rpc したら Promise で
  結果が返ってくるみたいな土台を 1 回作れば済む話では」

本 DR の「1 イベント = 1 単位で個別に処理し、個別に結果を返す」は、wire protocol
に **相関 id が無い**ことで頭打ちになっていた。応答は到着順で request と pairing
されていた (client 側は `pending.shift()`) ため、await を含む op が後続の応答を
追い越せず、daemon 側は接続ごとの FIFO で直列化するしかなかった (= 同一接続内の
head-of-line blocking。実測は
`docs/findings/2026-09-02-session-status-same-connection-latency.md`: 218MB
transcript の cold scan 中、同一接続の `ping` が 1.15 秒待つ)。

### 決定

- **全 Request に `request_id` を必須化**する (client 生成、接続内で一意)。全
  Response は同じ `request_id` を返す。protocol の `RequestEnvelope` /
  `RequestInput` が正本
- daemon は同一接続の要求を**並行実行**する (FIFO 撤去)。応答への id 付与は
  `send()` 1 箇所 (request-scoped な AsyncLocalStorage) で行い、dispatch の各
  case は触らない
- client は `Map<request_id, resolver>` で pairing する。呼び出し側から見た形は
  従来どおり「rpc したら Promise で結果が返る」

### 2-phase op の位置づけ

`acceptTwoPhase` の 2-phase 応答 (即時 ack + `ev:"*_result"`) は **「長い Promise
の RPC」に吸収された**。遅い op が他を待たせないための仕組みとしては不要になり、
既存 op は互換のためそのまま残す (client は result event で settle する)。
op ごとに単一応答へ寄せてよい。

### 相関できない失敗

parse 不能な JSON / `op` 欠落 / `request_id` 欠落の 3 つだけは、応答に id を載せ
られない (= どの要求への答えか名指しできない)。これらは `bad_request` を返すが、
client は誰も settle できない — log するだけ。正常な client は必ず id を送る。

## 影響

- thinking 翻訳の microbatch 集約は撤去し、1 op = 1 段落の個別直列処理
  に戻す (本 DR と同時に実施)
- kawaz は現在も UI / daemon の各所で「詰まり」を体感している。同期 IO
  やイベントループ阻害の洗い出しは issue
  `2026-07-31-audit-blocking-io-paths` で追跡する
