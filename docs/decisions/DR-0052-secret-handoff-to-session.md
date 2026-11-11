# DR-0052: webui から秘密の値をセッションに渡す (daemon がメモリに預かり、`ccmsg secret take <ID>` のパイプで取り出す)

- Status: Accepted (2026-11-12、kawaz 裁定)
- Date: 2026-11-12

## Context

kawaz は手元の秘密の値 (token、API key 等) をセッションのエージェントに渡したいことがある。ローカルの端末なら環境変数やファイルで渡せるが、リモートの webui からは、会話の本文に一度貼る (= transcript と API の request に残る) 以外の手軽な手段が無い (kawaz 2026-11-12「秘密情報をエージェントに渡すツールが欲しい。ローカルなら簡単なんだがリモートだと一度晒す形の手段以外は面倒なので。手軽なのが欲しい。」)。

起票は issue `2026-11-12-secret-handoff-to-session`。

## Decision

### 1. 目的

人が webui に貼った秘密の値を、その値を会話・記録に一度も載せずに、セッションのエージェントがコマンドの標準入力として使えるようにする。

増やしたくないもの:

- 値が残る場所 (会話、transcript、API の request、daemon.log、trace、ディスク上のファイル、webui の DOM・store・localStorage・URL・console、システムのクリップボード)
- 値を返す口 (tool の結果で値を返す口を作らない。取り出しは標準出力に値を書くコマンド 1 つだけ)
- 値を取り出すための作法 (セッションの同定、ID 以外の合言葉)

### 2. 経路

webui の受け口 → op `secret_put` (user role) → daemon がメモリに預かり ID を振る → daemon からそのセッションへの知らせ (ID と取り出し方) → エージェントが `ccmsg secret take <ID> | <コマンド>` → op `secret_take` → 値を標準出力に書く。

### 3. 受け口 (webui の Status タブ)

- セッションの Status タブに、貼り付けだけを受ける受け口を最初から置く (ボタンで開く形にしない。kawaz「貼り付け用 input を最初から置いてありゃいいか」)
- 打鍵では文字が入らない。貼り付けると、その値をすぐ `secret_put` で daemon に送り、受け口は空のまま残す。値は貼り付けの event handler の中で clipboard の event から読み、DOM の input の値・store・localStorage (下書き等)・URL に置かない
- 送った結果は受け口の下に 1 行で出す (受けた文字数、または送れなかった・知らせが届かなかった理由)

### 4. 預かり (daemon)

- daemon は値をメモリだけに持つ (ディスクに書かない)。daemon が止まれば消える
- 預かるたびに ID を振る (UUIDv4、`crypto.randomUUID()`)。秘密ごとに ID が付くので、複数を同時に預かれる
- 期限は預かってから 5 分。期限内は何回でも取り出せる。期限で消す (秘密ごとの timer、`unref`。polling しない)
- 値の長さの上限は 65536 (JavaScript の文字列の長さ)。空の値は断る

### 5. 知らせ

預かった時に、daemon がそのセッションの main thread へ知らせを送る。文面は次の 2 行 (1 行目は kawaz の指定どおり)。

```
ユーザからシークレットを受け取りました (5分有効) 。値は表示せずパイプで利用してください。
ccmsg secret take <ID> | <コマンド>
```

`<ID>` はその秘密の ID で、`<コマンド>` はそのままの文字列 (エージェントが自分のコマンドに置き換える)。

- 経路は daemon 自身が出す知らせの経路 ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §9 の `sendNotice`、封筒の `from="ccmsg:daemon"`)。回線復帰の wake、[DR-0040](./DR-0040-permit-request-tool.md) §12 の設定の差分、[DR-0018](./DR-0018-session-launcher.md) §3.7 の起動の結果と同じく、daemon が 1 つのセッションに入れる文だから。`from` が `ccmsg:daemon` なので、エージェントは別のセッションからの文と取り違えず、skill の「`ccmsg:daemon` は ccmsg 自身の知らせで、返信しない」がそのまま当たる。結果の語彙 (`delivered` / `unconfirmed` / `not_delivered`) も §9 のもので、webui が届かなかったことを出せる
- `not_delivered` (module が無い、セッションが終わっている等) の時は、預かった値をその場で消す。ID を知っている者がいないので、取り出せる者がいない。`secret_put` の応答は届かなかったこと (理由) を返し、webui はそれを受け口の下に出す
- `unconfirmed` (届いたか確かめられなかった) の時は預かったままにする。届いているかもしれない

### 6. 取り出し (`ccmsg secret take <ID>`)

- `ccmsg secret take <ID>` (ID はコマンドの引数) は値をそのまま標準出力に書く (貼られたとおり。改行を足さない・削らない)。exit 0
- 取り出す側のセッションは確かめない。ID を知っていることが権限 (知らせを受けたセッションだけが ID を知っている)
- 期限切れ・破棄済み・知らない ID・ID の無い呼び出しは、標準出力に何も書かず、標準エラーに理由を書いて exit 1。daemon が動いていない時も同じ (daemon が止まれば値は消えているので、daemon を起こさない。版の新しい CLI が古い daemon を止めて起こし直す経路 (DR-0002 §4) も通らない)
- CLI は `ccmsg agents` / `ccmsg stop` と同じく user role で hello する (セッションの中で呼んでもセッションの identity を使わない)。op `secret_take` は user role だけが送れる。session role の経路 (hooks module の `POST /op`、[DR-0046](./DR-0046-module-op-over-http.md)) の応答は tool の結果として会話に入るので、そこに値を返す op を置かない

### 7. webui の表示と破棄

- Status タブに、そのセッションに預かり中の物を 1 件 1 行で出す: 文字数 (Unicode の code point の数)、預かった時刻、残り時間 (秒の単位で減る)、破棄のボタン。値は出さない
- 破棄 (op `secret_discard`、user role) で daemon から消える
- 一覧は daemon が `ev:"secrets"` で全タブに配る (全セッションの預かり中の物、預かり・取り出しの期限切れ・破棄で変わるたびに全体を送る。購読を始めたタブにも空でも送る)
- 一覧と破棄は、ID と別の UUIDv4 (`key`) で 1 件を指す。ID は webui にも一覧にも出さない。user role の接続は UDS でも誰でも hello できるので、ID を一覧で配ると、知らせを受けたセッション以外が取り出せる。`key` で出来るのは破棄だけ

### 8. 記録に残さない

値を daemon.log、request の記録、trace、エラー文、webui の log・console に書かない。仕組みで保証し、テストで固定する。

- **daemon の中の値の型**: daemon が受けた値はすぐ `SecretValue` に包み、預かりの store は `SecretValue` だけを持つ。`SecretValue` を文字列にする口 (`String()` / テンプレート文字列 / `JSON.stringify` / `Bun.inspect` / `console.log`) はどれも `[secret]` になる。値の文字列を取り出すのは `secret_take` の応答を組む 1 か所 (`reveal()`) だけ
- **断りの文**: 受けた request の形が違う時、daemon は断りの理由 (schema の失敗の要約) を daemon.log と応答に書く。値の欄の schema の失敗の文は固定の文にし (valibot の既定の文は受けた値を引用する)、値を含まない。`secret_take` の応答を読む CLI 側の schema も同じ
- **知らせと log**: 知らせの文と daemon.log の行には ID と文字数だけが出て、値は出ない (ID は知らせの文として transcript に残る。§9)
- **webui**: 値は貼り付けの event handler の局所変数から `secret_put` の request の JSON にだけ渡る。応答・一覧の push に値は無い
- **テスト**: 隔離した daemon で、預け・取り出し・破棄・期限切れ・形の違う request (値の欄が長すぎる等) を通した後、daemon.log・trace・state dir の全ファイルの全文から値の文字列を探して 0 件であること。`SecretValue` を文字列にする各口が `[secret]` になること。webui の受け口が値を DOM・localStorage に残さないこと

### 9. ID が transcript に残ること

ID は知らせの文と、エージェントが実行する Bash の tool の入力 (`ccmsg secret take <ID> | ...`) として transcript と API の request に残る。値は残らない。ID は期限の 5 分で使えなくなる (破棄すればすぐ)。守りは期限に置く。

### 10. DR-0039 §4 の例外

[DR-0039](./DR-0039-all-mods-and-typed-tools.md) §4 は、エージェントが使う口を typed tool にし、CLI を人の口と module の transport に縮める。`ccmsg secret take` はエージェントが呼ぶ CLI だが、その例外として置く。値を tool の結果で返すと会話に入るので、値をパイプで次のコマンドの標準入力に渡すコマンドでなければ、§1 の目的が成り立たない。

## Alternatives Considered

- 案: daemon が受けた値を `pbcopy` でシステムのクリップボードに流し、エージェントが `pbpaste` で使う
  - 不採用理由: クリップボードの履歴ツールに残る。ユニバーサルクリップボードで別の機械に渡りうる。ホストの全セッション・全アプリが読める
- 案: ID を引数でなく標準入力で `ccmsg secret take` に渡す
  - 不採用理由: `ps` には出なくなるが、ID は知らせの文と Bash の tool の入力として transcript に残るので、`ps` だけを守っても半端。守りは期限の 5 分に置く (kawaz 2026-11-12「中途半端だから引数のままで良いや」)
- 案: 値を typed tool の結果で返す
  - 不採用理由: tool の結果は会話に入り、transcript と以後の API の request に残る
- 案: 1 回取り出したら消す
  - 不採用理由: 後ろのコマンドの打ち間違いで、人が貼り直すことになる。ID を知っているのは知らせを受けたセッションだけなので、期限内の再取り出しの危険は小さい
- 案: 取り出すセッションを確かめる (知らせを送ったセッションの identity でだけ取り出せる)
  - 不採用理由: CLI がどのセッションから呼ばれたかの同定が要る (subagent・teammate・worktree の別プロセスから呼ぶこともある)。ID を知っていることで足りる

## Consequences

- protocol は op が 3 つ (`secret_put` / `secret_take` / `secret_discard`、どれも user role) と、push が 1 つ (`ev:"secrets"`) 増える
- CLI に `ccmsg secret take <ID>` が増える (DR-0039 §4 の例外)
- 預かっている値は daemon のメモリにあり、daemon の再起動 (plugin の更新による版の入れ替わりを含む) で消える。消えた後の `take` は「知らない ID」と同じに断られる
- iOS の Safari で、打鍵を受けない受け口に貼り付けのメニューが出て中身を取れるかは実機で確かめる (issue の「確かめること」)
- 「持たない」ことを壊す変更を止める試験の観点:
  - 値の文字列が daemon.log・trace・state dir のファイルに現れない
  - `SecretValue` を文字列にする口が値を出さない
  - 形の違う `secret_put` の断りの文に値が出ない
  - user role 以外の `secret_put` / `secret_take` / `secret_discard` は `bad_request`
  - 知らせが `not_delivered` なら値を預かったままにしない
  - 期限を過ぎた ID の `take` は値を返さない
  - `ev:"secrets"` に ID と値が無い
  - 受け口に打鍵で文字が入らず、貼り付けた値が DOM・localStorage に残らない

## 関連

- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §4 (CLI の 2 面、本 DR はその例外) / §9 (daemon からセッションへの知らせ)
- [DR-0040](./DR-0040-permit-request-tool.md) §12 — webui の操作から daemon がセッションへ知らせを入れる前例
- [DR-0020](./DR-0020-session-status-tab.md) — Status タブ
- [DR-0046](./DR-0046-module-op-over-http.md) — session role の `POST /op`
