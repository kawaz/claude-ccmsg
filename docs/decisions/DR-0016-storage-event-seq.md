# DR-0016: StorageEvent 横断の per-room 連番 `seq` (subscribe 再接続 cursor の全 event 型拡張)

- **Status**: Accepted (2026-07-15、SEQ-Q1=a 裁定)
- **Date**: 2026-07-15
- **前提**: [DR-0003](./DR-0003-wire-protocol.md) §5 の BBS delta model (since cursor)。起点 issue: `docs/issue/2026-07-15-subscribe-reconnect-nonmsg-redelivery.md`

## 1. Context / 動機

subscribe の再接続 cursor (`since`) は per-room の「最後に受信した msg の mid」で、
非 msg StorageEvent (archive / title / kind / next / prev / member / leave) は
cursor に反映されない。room の log 末尾が非 msg イベントで終わっていると、
再接続のたびに daemon の `sendBacklog` の since-replay 分岐が
「sinceMid 以下の最後の msg の直後」= 同じ index から replay を始め、
末尾の非 msg イベントを毎回再配信する。

実観測 (issue 参照): 同一 archive イベントを 6 回 (kuu セッション、r13)、
10 回以上 (cache-warden セッション、r8) 受信。常駐 AI セッションの
ターン起床を無駄に発生させ、Monitor 通知チャネルを埋める実害。

根本原因は「全 event 型を横断する dedup 座標が存在しない」こと:

- `mid` は msg 専用 (per-room msg 連番)
- `ts` は同一 ms 衝突がありうる (kawaz r15 mid=19-20 で検討の上棄却)
- `MemberEvent.id` / `LeaveEvent.id` は member id で意味が別

## 2. Decision

### 2.1 `seq`: daemon 採番の per-room 通し番号

- 全 StorageEvent 型に **`seq?: number`** を追加 (SEQ-Q1=a、kawaz 裁定 2026-07-15)
- per-room で 1 起点の単調増加。**全 event 型を横断**して振る
  (= room jsonl の行番号と一致するのが正常形)
- 採番は storage.ts `appendEvent` (全 append の単一 choke point) が行う。
  呼び出し元は seq を渡さない (event 構築側 ~20 call site の変更ゼロ)
- appendEvent は **caller の event object を in-place で stamp** する —
  append 後に同じ object を `deliver` に渡す既存 call site が、コード変更なしで
  seq 付き配信になる。disk-first / memory-second の既存不変条件は維持
  (`room.lastSeq` の前進は write 成功後)
- 型上 optional (`seq?`) なのは旧 log 行 (§2.2) と event 構築時 (採番前) の
  ためで、**append 済み / 配信される event は常に seq を持つ**

### 2.2 旧 log 行の backfill (in-memory、disk は不変)

- v0.32 以前の jsonl 行には seq が無い → `loadRoom` (computeDerived) が
  **行順から in-memory 補完**する (1 起点連番)。disk は書き換えない
  (append-only 原則の維持)
- 混在 log (旧行 N 本 + 新行): 旧行は 1..N に補完、新行は persisted seq を採用。
  persisted seq は「前回 load 時の lastSeq + 1」で採番されているため、**正常形では**
  両者は連続する
- `Room` に `lastSeq: number` を追加、computeDerived / appendEvent が維持
- 既知の限界: 補完後 (= 過去に配信済み) の旧行が後から破損して load skip される
  と、以降の旧行の補完 seq がずれ、persisted seq の新行との間に gap / 重複が
  生じうる。破損 skip は error log される異常系で、影響は少数 event の重複配信
  or 欠落に留まるため許容。client cursor は単調 max (§2.4) なので、seq の重複・
  非単調はクラッシュせず「重複配信を 1 回受ける」側に安全に倒れる — この耐性
  (重複 seq を受けても cursor が壊れない) はテストで固定する

### 2.3 wire: `since_seq` (新 request field)

- `SubscribeRequest` に `since_seq?: Record<string, number>` を追加
- `sendBacklog` は since_seq があれば **seq cursor**
  (「seq <= since_seq の最後の event の直後」から replay)、無ければ従来の
  since (mid cursor) にフォールバック
- `sendBacklog` の cursor 優先順位: 同一 room に有効な since_seq があれば
  seq cursor、無ければ (未指定 or §2.5 で無効) since (mid) cursor、両方
  無ければ join snapshot。両 cursor を送る client は存在しない (旧 client
  は since のみ、新 client は since_seq のみ) ので優先順位が効くのは
  防御的ケースだけ
- 既存 `since` (mid) は**旧 client 互換のためサーバ側処理を残す**
- cursor 値の流用は双方向とも禁止:
  - mid 値を since_seq に渡す (旧 cursor の流用) — seq >= mid が常に成り立つ
    ため過小申告になり、既読 event の重複再配信を再生産する (安全側だが
    本 DR が潰す症状そのもの)
  - seq 値を since (mid) として旧 daemon に渡す — 過大申告になり未読 msg を
    **取りこぼす**。新 client が旧 daemon に対して since を一切送らない
    (§4 の new-client × old-daemon が full replay になる) のはこれを避ける
    ため

### 2.4 client cursor の更新規則 (CLI / webui 共通)

- 受信した**全 StorageEvent 配信** (`r` + `seq` を持つ行) で per-room max seq を
  更新する (従来は `type:"msg"` のみ)。ephemeral stream event (`ev:"notify"` 等)
  は対象外
- 再接続 subscribe には `since_seq` を渡す
- CLI `--since` オプションの値も since_seq として送る (help 文言を
  「per-room last-seen seq」に更新)
- webui: localStorage key を `ccmsg.since` → `ccmsg.since_seq` に変更。
  旧 key に残る mid 値を seq と誤解釈しないため (§2.3 の禁止事項と同根)。
  切替直後の 1 回だけ full replay になるが、これは fresh reload と同じ経路で
  UI 上は無害

### 2.5 since_seq の入力検証 (daemon 側)

- room ごとの値が **有限の非負 number でなければその room の cursor を無視**
  (= 指定なし扱い → full backlog replay。安全側 = 重複配信side に倒す)。
  負値・NaN・Infinity・非 number (JSON 経由でも生 socket 書き込みで到達しうる)
  が対象
- 巨大値 (lastSeq 超) は「全て配信済み」として replay ゼロ — cursor 走査は
  既存 sendBacklog と同じ O(room.events) の単一 pass で、DoS ベクタにならない

## 3. 却下案

- **案 B: `ts` で dedup** — 同一 ms に複数 event が入ると衝突する。ISO 文字列
  比較は順序こそ正しいが「同 ts の event 列の途中まで配信済み」を表現できない
- **案 C: 非 msg backfill を初回接続のみ配信、再接続時 skip** — 「再接続の
  合間に発生した非 msg event を取りこぼす」逆 bug を作る (archive 通知が
  届かないのは重複より悪い)
- **内容 hash での dedup** — archive true→false→true のような正当な同内容
  再発 event を誤って dedup する

## 4. 互換性 (version skew)

| client \ daemon | 旧 daemon (mid since のみ) | 新 daemon (seq 対応) |
|---|---|---|
| 旧 client | 現状のまま (本 bug 込み) | `since` (mid) フォールバックで現状挙動維持 (退行なし) |
| 新 client | since_seq は無視され、新 client は since (mid) を送らない (§2.3 の流用禁止) → 再接続ごとに join snapshot の full 再配信。従来 bug より重複は広いが取りこぼしは無く、daemon の newer-wins 自己更新で数分内に解消する一時状態 | **本 DR の対象、bug 解消** |

## 5. 受け入れ条件

- [ ] 全 event 型の live 配信 / backlog 配信が seq を持つ
- [ ] log 末尾が非 msg event の room に対し、since_seq 再接続で再配信ゼロ
      (issue の bug repro)
- [ ] since_seq が msg までしか進んでいない場合、後続の非 msg event は
      1 回だけ配信される
- [ ] 旧 jsonl (seq 無し行) の load で seq 補完 + 新規 append が連番を継続
      (disk 上の persisted seq を確認)
- [ ] 旧 client 互換: `since` (mid) subscribe の挙動が退行しない
