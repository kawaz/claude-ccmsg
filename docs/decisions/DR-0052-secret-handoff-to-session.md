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

- 値が残る場所 (会話、transcript、API の request、daemon.log、trace、ディスク上のファイル、webui の store・localStorage・URL・console、システムのクリップボード。webui の DOM には手で打った文字だけが入る、§8)
- 値を返す口 (tool の結果で値を返す口を作らない。取り出しは標準出力に値を書くコマンド 1 つだけ)
- 値を取り出すための作法 (セッションの同定、ID 以外の合言葉)

### 2. 経路

webui の受け口 → op `secret_put` (user role) → daemon がメモリに預かり ID を振る → daemon からそのセッションへの知らせ (ID と取り出し方) → エージェントが `ccmsg secret take <ID> | <コマンド>` → op `secret_take` → 値を標準出力に書く。

### 3. 受け口 (webui の Status タブ)

セッションの Status タブに、1 行の入力欄と送信ボタンと削除ボタンを 1 行に並べて最初から置く (ボタンで開く形にしない)。入力欄と送信ボタンの対は送る前の値を扱い、削除ボタンは daemon が預かっている値を扱う。2 つの対象は独立していて、一方の操作が他方に触れない。

**入力欄の 2 つのモード** (入力欄の値の有無で決まる):

- **貼り付けモード** (入力欄が空): placeholder は「貼り付けモード (通常入力もできます)」。空の入力欄への貼り付けは、paste の event を `preventDefault` / `stopPropagation` で止めて入力欄に入れず、値を component の state にだけ持つ。受けたら placeholder を「入力済み: N 文字」(N は貼られたとおりの値の Unicode の code point の数) にし、複数行なら「入力済み: N 文字 (M 行)」にする。M は、値の末尾の改行 1 つ (`/(\r\n|\n|\r)$/`) だけを除いた残りの改行 (`\r\n`・`\n`・`\r` をそれぞれ 1 つ) の数と 1 で、M が 2 以上の時を複数行とする (`a\n` は 1 行、`a\nb\n`・`\na`・`a\rb`・`a\n\n` は 2 行。頭の空行も行として数える)。この数えは表示だけに使い、送る値は貼られたとおり (改行・空白を削らない) なので、PEM のような複数行の値も渡せる。値を持っている時にもう一度貼ると置き換える
- **テキストモード** (1 文字でも打った時): 打ち始めた時点で、貼り付けモードで持っていた値は捨てる。打った文字は入力欄にそのまま入り、伏せ字で出す (`type="text"` に CSS の `-webkit-text-security: disc`。`type="password"` にしないのは、パスワードマネージャが保存を勧めないようにするため)。入力欄の内側の右端の目のボタンで伏せ字を外し、もう一度押すと戻る。このモードの貼り付けは普通の入力欄と同じく打った文字に挿入される (`stopPropagation` だけで、`preventDefault` しない)。入力欄を空にすると貼り付けモードに戻る (OTP のような短い値を手で打つ道)
- 貼り付けを受けたら (空の貼り付けの時も) 入力欄の focus を外す (blur だけで、ほかの要素には移さない)。タッチの端末でソフトウェアキーボードが出たままになるため

**送信**: 送る前の値がある時だけ送信ボタンが押せる。送信ボタン、Enter、⌘Enter (Ctrl+Enter) で送る。IME の変換を確定する Enter (`isComposing`) では送らない。

- 知らせが届いた (`delivered`) か確かめられなかった (`unconfirmed`) なら、送る前の値を消して入力欄を空 (貼り付けモード) に戻す
- 送れなかった (`not_delivered`、op の失敗) なら、送る前の値は残して出し直せるようにする
- 結果の枠は §7

**削除ボタン**: 1 セッションに 1 つ。daemon がそのセッションの値を預かっている間は「削除 (N秒)」(N は期限までの残りの秒で、1 秒ごとに減る、§7) で押せ、押すと daemon からそのセッションの値を消す (op `secret_discard { session_id }`、user role)。預かっていなければ「削除」で押せない。送る前の値には触らない。

**Status タブの出入り**: Status タブが表に出た時 (最初に Status で開いた時を含む) と離れた時に、送る前の値 (貼った値・打った文字・伏せ字の開閉・結果の枠) を空に戻す。離れた時にも消すのは、別のタブを見ている間に値を component に残さないため。Status タブの panel は隠れても mount されたままなので、mount ではなく表に出たかどうか (`SessionView` の tab が `status` で、そのセッションの view が表に出ている) を契機にする。

### 4. 預かり (daemon)

- daemon は値をメモリだけに持つ (ディスクに書かない)。daemon が止まれば消える
- 1 セッションに 1 つの座を持つ。預かるたびに ID を振る (UUIDv4、`crypto.randomUUID()`)
- `secret_put` を受けた時点で、そのセッションの前の値をすぐ消し (前の ID はその時点で使えない)、新しい値を座に置く。期限は新しく 300 秒。新しい値はその時点から取り出せる (知らせが届いてすぐ取り出されても断らない)
- 知らせの結果が `not_delivered` なら新しい値も消し、座は空になる (前の値は戻さない)。`unconfirmed` / `delivered` なら新しい値はそのまま (§5)
- 期限は預かってから 5 分。期限内は何回でも取り出せる。期限で消す (値ごとの timer、`unref`。polling しない)
- 値の長さの上限は 65536 (JavaScript の文字列の長さ)。空の値は断る
- あるセッションの預かりの有無は `secret_status { session_id }` (user role) で問い合わせる。応答は `{ ok, held?: { ttl_ms, chars } }` で、`ttl_ms` は答えた時点の残りのミリ秒。預かっていなければ `held` は無い。ID と値は載せない
- `secret_put` の応答は、預かった時 (`not_delivered` でない時) に新しい値の `ttl_ms` を持つ

### 5. 知らせ

預かった時に、daemon がそのセッションの main thread へ知らせを送る。文面は次の 2 行 (1 行目は kawaz の指定どおり)。

```
ユーザからシークレットを受け取りました (5分有効) 。値は表示せずパイプで利用してください。
ccmsg secret take <ID> | <コマンド>
```

`<ID>` はその秘密の ID で、`<コマンド>` はそのままの文字列 (エージェントが自分のコマンドに置き換える)。

- 経路は daemon 自身が出す知らせの経路 ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §9 の `sendNotice`、封筒の `from="ccmsg:daemon"`)。回線復帰の wake、[DR-0040](./DR-0040-permit-request-tool.md) §12 の設定の差分、[DR-0018](./DR-0018-session-launcher.md) §3.7 の起動の結果と同じく、daemon が 1 つのセッションに入れる文だから。`from` が `ccmsg:daemon` なので、エージェントは別のセッションからの文と取り違えず、skill の「`ccmsg:daemon` は ccmsg 自身の知らせで、返信しない」がそのまま当たる。結果の語彙 (`delivered` / `unconfirmed` / `not_delivered`) も §9 のもので、webui が届かなかったことを出せる
- `not_delivered` (module が無い、セッションが終わっている等) の時は、新しい値も消す (その ID を知っている者がいないので、取り出せる者がいない)。前の値は送った時点で消えているので、座は空になる。`secret_put` の応答は届かなかったこと (理由) を返し、webui は §7 の枠に出す
- `unconfirmed` (届いたか確かめられなかった) の時は預かる。届いているかもしれない

### 6. 取り出し (`ccmsg secret take <ID>`)

- `ccmsg secret take <ID>` (ID はコマンドの引数) は値をそのまま標準出力に書く (貼られたとおり。改行を足さない・削らない)。exit 0
- 取り出す側のセッションは確かめない。ID を知っていることが権限 (知らせを受けたセッションだけが ID を知っている)
- 期限切れ・知らない ID・ID の無い呼び出しは、標準出力に何も書かず、標準エラーに理由を書いて exit 1。daemon が動いていない時も同じ (daemon が止まれば値は消えているので、daemon を起こさない。版の新しい CLI が古い daemon を止めて起こし直す経路 (DR-0002 §4) も通らない)
- CLI は `ccmsg agents` / `ccmsg stop` と同じく user role で hello する (セッションの中で呼んでもセッションの identity を使わない)。op `secret_take` は user role だけが送れる。session role の経路 (hooks module の `POST /op`、[DR-0046](./DR-0046-module-op-over-http.md)) の応答は tool の結果として会話に入るので、そこに値を返す op を置かない

### 7. webui の結果の表示

- **削除ボタンの残りの秒**: Status タブが表に出た時に `secret_status` を 1 回問い合わせ、送った時は `secret_put` の応答を使う。応答を受けた時刻と `ttl_ms` から webui の時計で数え下げる (daemon の時刻を使わないので、端末と daemon の時計のずれが出ない)。数え下げが 0 になったら押せない「削除」に戻し、数え下げの時計 (1 秒ごとの描き直し) も止める (時計を回すのは値がある間だけ)。問い合わせが失敗した時は押せない「削除」のまま (枠は出さない)。削除の応答が `not_found` の時 (期限、ほかのタブ・端末からの削除や置き換えで先に消えていた) は、枠を出さずに押せない「削除」に戻す
- 知らせが届いた (`delivered`) 時は枠を出さない。削除ボタンが「削除 (300秒)」に変わることで分かる
- 確かめられなかった時と送れなかった時は、受け口の節の下に、Status タブの起動・再起動の結果と同じ枠 (`.status-op-result`、`data-tone` で左の線の色が変わる) で出す。文字数 (Unicode の code point の数) は出すが値は出さない
  - 届いたか確かめられなかった (`unconfirmed`): `data-tone="running"`、見出し「送信した (未確認)」、本文「N 文字を受けた。知らせが届いたかは確かめられなかった。最長 5 分で消える」
  - 届かなかった (`not_delivered`): `data-tone="error"`、見出し「送れなかった」、本文「セッションに知らせが届かなかった (理由) ので、預からなかった」
  - op が断られた・送れなかった: `data-tone="error"`、見出し「送れなかった」、本文はその理由
- 枠は次に送る・送る前の値を変えるまで残る (時間では消さない)
- webui への応答には ID も値も載らない (ID を知っているのは知らせを受けたセッションだけにする。user role の接続は UDS でも誰でも hello できる)。預かりの有無を全タブに配る push は持たない

### 8. 記録に残さない

値を daemon.log、request の記録、trace、エラー文、webui の log・console に書かない。仕組みで保証し、テストで固定する。

- **daemon の中の値の型**: daemon が受けた値はすぐ `SecretValue` に包み、預かりの store は `SecretValue` だけを持つ。`SecretValue` を文字列にする口 (`String()` / テンプレート文字列 / `JSON.stringify` / `Bun.inspect` / `console.log`) はどれも `[secret]` になる。値の文字列を取り出すのは `secret_take` の応答を組む 1 か所 (`reveal()`) だけ
- **断りの文**: 受けた request の形が違う時、daemon は断りの理由 (schema の失敗の要約) を daemon.log と応答に書く。値の欄の schema の失敗の文は固定の文にし (valibot の既定の文は受けた値を引用する)、値を含まない。`secret_take` の応答を読む CLI 側の schema も同じ
- **知らせと log**: 知らせの文と daemon.log の行には ID と文字数だけが出て、値は出ない (ID は知らせの文として transcript に残る。§9)
- **webui の送る前の値の置き場**: 貼り付けモードの値は component の state だけに置き、入力欄の DOM・store・localStorage (下書き等)・URL に置かない。テキストモードの値は打つ以上入力欄の DOM に入り (伏せ字で出す)、同じく component の state に写す。どちらも送って届いた・確かめられなかった時、入力欄を空にした時、Status タブが表に出た時と離れた時、別のセッションに移った時、component が消える時に消す。値は `secret_put` の request の JSON にだけ渡り、`secret_put` の応答は知らせの結果と文字数だけで、ID と値は無い
- **貼り付けの event**: 受け口の paste は `stopPropagation` で止め、受け口の外 (周りの要素と document の paste の listener、composer の貼り付け・添付の取り込み等) に値を渡さない。貼り付けモードでは `preventDefault` もして入力欄に入れない
- **frame の記録**: daemon にも webui にも WebSocket の frame をそのまま記録・dump する経路は無い (daemon の trace は transcript の byte 範囲だけ、webui の console は wire の schema に合わない frame の失敗の要約だけ)。daemon が webui へ送る応答に ID と値は無い
- **テスト**: 隔離した daemon で、預け・取り出し・形の違う request (値の欄が長すぎる等) を通した後、daemon.log・trace・state dir の全ファイルの全文から値の文字列を探して 0 件であること。`SecretValue` を文字列にする各口が `[secret]` になること。期限で消えることは時計を差し替えた store の単体テストで確かめる。webui への応答 (`secret_put` / `secret_status`) と push に ID と値が無いこと。webui の貼り付けモードの値が DOM・store・localStorage・console に残らず、貼り付けの event が受け口の外の listener に届かないこと

### 9. ID が transcript に残ること

ID は知らせの文と、エージェントが実行する Bash の tool の入力 (`ccmsg secret take <ID> | ...`) として transcript と API の request に残る。値は残らない。ID は期限の 5 分で使えなくなる。守りは期限に置く。

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
- 案: 貼り付けた瞬間に送る (打鍵を受けない受け口)
  - 不採用理由: 送る前に確かめる間が無く、貼っただけで送られて驚く。OTP のような短い値を手で打つ道が無い
- 案: 1 セッションに複数の値を預かり、預かり中の物を一覧と破棄のボタンで出す
  - 不採用理由: 1 セッションに 1 つで足りる。期限まで出続ける一覧の行が、1 つの機能の行に見えて邪魔になる
- 案: 削除ボタンに送る前の値のクリアも持たせる
  - 不採用理由: 1 つのボタンに 2 つの対象 (送る前の値と daemon の値) を持たせると、押した時に何が消えるかが状態で変わる。送る前の値は入力欄を空にすれば消える
- 案: 各セッションの預かりの有無を user role の全タブに push で配る
  - 不採用理由: 削除ボタンの残りの秒が要るのは Status タブを開いている時だけで、表に出た時の問い合わせ 1 回で足りる。預かりの一覧を全タブに配らない

## Consequences

- protocol は op が 4 つ (`secret_put` / `secret_take` / `secret_discard` / `secret_status`、どれも user role) 増える。push は増えない
- CLI に `ccmsg secret take <ID>` が増える (DR-0039 §4 の例外)
- 預かっている値は daemon のメモリにあり、daemon の再起動 (plugin の更新による版の入れ替わりを含む) で消える。消えた後の `take` は「知らない ID」と同じに断られる
- テキストモードで打った値は、送るまで入力欄の DOM にある (伏せ字で出す)
- 「持たない」ことを壊す変更を止める試験の観点:
  - 値の文字列が daemon.log・trace・state dir のファイルに現れない
  - `SecretValue` を文字列にする口が値を出さない
  - 形の違う `secret_put` の断りの文に値が出ない
  - user role 以外の `secret_put` / `secret_take` / `secret_discard` / `secret_status` は `bad_request`
  - 知らせが `not_delivered` なら新しい値も消え、座は空になる (前の値は戻らない)
  - 新しい値を送った時点で前の ID は使えなくなり、新しい ID は知らせの結果の前から取り出せる
  - 期限を過ぎた ID の `take` は値を返さない
  - webui への `secret_put` / `secret_status` の応答に ID と値が無い
  - モードの切り替わり (空 → 貼る → 打つ → 空) と placeholder の文 (末尾の改行 1 つを除いて数える行の数)
  - 送信ボタンは送る前の値がある時だけ押せ、Enter / ⌘Enter で送り、IME の確定の Enter では送らない
  - 届いた・確かめられなかった時は送る前の値が消え、送れなかった時は残る
  - 削除ボタンは daemon の値がある時だけ押せ、送る前の値に触らない。`not_found` と残り 0 秒で押せない「削除」に戻り、0 秒で数え下げの時計が止まる
  - Status タブが表に出た時に 1 回だけ問い合わせ、表に出た時と離れた時に送る前の値が消える
  - 貼り付けモードの値が DOM・store・localStorage に残らない
  - 受け口の貼り付けの event が受け口の外 (周りの要素・document) の paste の listener に届かない

## 関連

- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §4 (CLI の 2 面、本 DR はその例外) / §9 (daemon からセッションへの知らせ)
- [DR-0040](./DR-0040-permit-request-tool.md) §12 — webui の操作から daemon がセッションへ知らせを入れる前例
- [DR-0020](./DR-0020-session-status-tab.md) — Status タブ
- [DR-0046](./DR-0046-module-op-over-http.md) — session role の `POST /op`
