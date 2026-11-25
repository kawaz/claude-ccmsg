# DR-0029: IO を伴うイベント / メッセージ処理は全て非同期化する (原則)

- Status: Accepted
- Date: 2026-07-31
- 発端: kawaz (thinking 翻訳の microbatch 集約への指摘から一般化)

## 決定

daemon / webui (UI) を問わず、**IO を伴うイベントやメッセージの処理はasync/await による非同期処理を原則とする**。

- 1 イベント = 1 単位で個別に処理し、個別に結果を返す。呼び出し側がまとめて待たされる形 (時間窓での集約、複数ジョブの運命共同体化) を勝手に入れない
- 所要時間がばらつくジョブを他のジョブと束ねると、短いジョブが長いジョブに巻き込まれる head-of-line blocking が起きる。総時間が多少増えても**小出しに返す方が UX として正** (kawaz: 「文章を読むのは 9 翻訳を同時に脳にぶち込んで同時に読むわけではない」)
- 同期 IO (同期 fs API、イベントループを塞ぐ重い同期処理) をイベントハンドラ / メッセージハンドラに置かない

## まとめ処理 (batching / 窓集約) を入れたい場合

kawaz の承認を得てから入れる。勝手に導入しない (翻訳 microbatch は未承認のまとめ処理の再導入で、既裁定とも矛盾していた)。

承認を求める際は「何が束ねられ、最悪ケースで何が何に巻き込まれるか」を明示する。参考として、既存で性質上問題になっていない集約はfs_stat_batch (均質・軽量なメタデータ確認の microtask 束ね) とstorage の fsync debounce (書き込み自体は即時、耐久性同期のみ集約) の2 つ (2026-07-31 時点の実査)。

## 追補 (2026-09-03): 相関 id 付き RPC を土台にし、接続ごとの FIFO を撤去

- 発端: kawaz (2026-09-03)「最初から 2 パターンどちらでも同じ感じでメッセージング処理できるような両端のインターフェースを作っておいて、rpc したら Promise で結果が返ってくるみたいな土台を 1 回作れば済む話では」

本 DR の「1 イベント = 1 単位で個別に処理し、個別に結果を返す」は、wire protocolに **相関 id が無い**ことで頭打ちになっていた。応答は到着順で request と pairingされていた (client 側は `pending.shift()`) ため、await を含む op が後続の応答を追い越せず、daemon 側は接続ごとの FIFO で直列化するしかなかった (= 同一接続内のhead-of-line blocking。実測は`docs/findings/2026-09-02-session-status-same-connection-latency.md`: 218MB transcript の cold scan 中、同一接続の `ping` が 1.15 秒待つ)。

### 決定

- **全 Request に `request_id` を必須化**する (client 生成、接続内で一意)。全Response は同じ `request_id` を返す。protocol の `RequestEnvelope` / `RequestInput` が正本
- daemon は同一接続の要求を**並行実行**する (FIFO 撤去)。応答への id 付与は`send()` 1 箇所 (request-scoped な AsyncLocalStorage) で行い、dispatch の各case は触らない
- client は `Map<request_id, resolver>` で pairing する。呼び出し側から見た形は従来どおり「rpc したら Promise で結果が返る」

### 遅い op も 1 応答の RPC

遅い op も他と同じく **1 つの相関応答**で答える。`session_launch` / `session_kill` / `session_rename` / `session_env` / `session_search` / `fork_origin` / `session_dump_file` / `translate` / `llm_usage` / `llm_stats` / `llm_status` は、await して結果を `send` するだけ。遅い op が他を待たせないのは並行 dispatch が担保するので、応答を分割する理由はない。

### 相関できない失敗

parse 不能な JSON と、`request_id` (空でない文字列) か `op` (文字列) が読めない行だけは、応答に id を載せられない (= どの要求への答えか名指しできない)。これらは `bad_request` を返すが、client は誰も settle できない — log するだけ。正常な client は必ず id を送る。

`request_id` と `op` が読めた依頼のうち、知らない op と field の型違いは `request_id` を付けて `invalid_args` で返す ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §6)。

### `request_id` を送らない client との互換は持たない

`request_id` の必須化は、[DR-0002](./DR-0002-daemon-supervision.md) §4 の「互換を切る場合は意図的な判断として DR に理由を書く」に当たる変更。`request_id` を送らない client の行は、上の「相関できない失敗」のとおり `bad_request` で断られ、その client を載せたセッションは起動し直しが要る。`request_id` の欠落を古い client として受け付ける互換経路は**設けない** (kawaz 裁定、今後も戻さない)。封筒の形を変える変更で protocol の版のどこを上げるかは、DR-0002 §4 の「protocol の版」の表が決める。

## 追補 (2026-11-20): 長い走査は時間で譲る

- 発端: issue `2026-11-12-catch-up-refold-holds-event-loop` (daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 100ms 以上塞がる) への kawaz 裁定 (2026-11-20): 譲る刻みをバイトから時間にし、同時に走る読み直しの数も絞る
- 計測: `docs/findings/2026-11-20-catch-up-yield-by-time.md`

### 決定

1. **ファイルの全体やディレクトリの木を歩く走査は、event loop を `TURN_SLICE_MS` (8ms) 握ったら `setImmediate` で 1 周譲る。** 経過は行・エントリを 1 つ処理するごとに確かめる (`packages/daemon/src/event-loop.ts` の `turnSlice`)。対象は transcript の読み直しと一度読み (`scanTranscriptLines`: relay の追いつき、session_status、transcript の facts)、Session Search の行の走査、fork_origin の uuid の走査、fs_find の木の walk
2. **live のセッションの fold の追いつき (読み直し) は、同時に `CATCH_UP_LIMIT` (2) 本まで走らせる。** 待つ読み直しは、読むバイトの少ない順に走らせる (同じなら頼まれた順)。1 度に頼まれた分 (一緒に live になったセッション) は、どれかが走り出す前に全体で並べる
3. 置き換えられた読み直し (後から別の読み直しが頼まれた、セッションが live でなくなった) は、次の読み・次の行の前で止まり、枠を空ける

### 理由

- **刻みをバイトや件数にしない**: 1 行の重さが桁で違う。同じ 68MB でも、短い行の合成は読み直しに約 1.1 秒、実物の transcript は約 0.56 秒かかった。バイトの刻み (4MB) では、刻み 1 つの間に握る時間が行の形で決まり、上限にならない。時間なら行の形に依らずに上限になる
- **譲った走査のターンは続けて回る**: `setImmediate` で譲った走査は、次の周の check phase に並んで続けて走る。走査が N 本あると、ほかの op (webui への配送、hello、POST /op) は N × 刻みだけ待つ。刻みを時間にしただけで本数を絞らないと、9 本の読み直しで ping の往復は最大 88〜96ms (刻み 8ms) になった。本数の上限は刻みと対で効く
- **刻み 8ms、上限 2**: ほかの op が待つのは名目で 2 × 8 = 16ms で、60Hz の 1 フレーム (16.7ms) に収まる。計測では ping の往復の中央値 10〜16ms、最大 25〜34ms (直す前は最大 235〜541ms)。刻みを 2ms / 4ms にしても読み直しの総時間は run 間のばらつきの内で変わらず、待ちはさらに減ったが、既に 1 フレームの内で、細かくする利点が見当たらない
- **上限を 1 にしない**: 1 本だと、走り出した大きな transcript (218MB の例がある、`docs/findings/2026-09-02-session-status-same-connection-latency.md`) の読み直しが終わるまで、後から live になった小さいセッションが全部待つ。2 本目の枠がそれを避ける。読み直しは 1 本のスレッドの CPU 仕事なので、本数を増やしても全体は早く終わらない (上限 1 / 2 / 9 の総時間はばらつきの内)
- **小さい順**: どの読み直しも先に走るものの後に着地するので、短いものを先にすれば短いものが長いものの後ろで待たない (本 DR の head-of-line blocking を避ける)。順が効くのは、セッションごとに着地を待つもの (transcript_push の行への反応 = say の発声や `!` の終わりの知らせ、Status) で、webui の `peers` / `session_errors` は全部の着地を待つので順に依らない。読み直しを頼むのは、セッションが live になった時、transcript が置き換わった時、hello で分類の根が変わった時に限られるので、大きいものが小さいものに追い越され続けることはない
- 総時間の代償: 隔離 daemon での読み直しの総時間は直す前より 8〜15% 長い。行ごとの経過の確かめだけ (譲らず、本数も絞らない) では総時間は変わらなかった。何に掛かっているかは特定していない

## 影響

- thinking 翻訳の microbatch 集約は撤去し、1 op = 1 段落の個別直列処理に戻す (本 DR と同時に実施)
- kawaz は現在も UI / daemon の各所で「詰まり」を体感している。同期 IOやイベントループ阻害の洗い出しは issue `2026-07-31-audit-blocking-io-paths` で追跡する
