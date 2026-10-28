# DR-0045: say は tool が発声するだけにし、表示は transcript の tool_use から描き、既読は daemon が持つ

- Status: Accepted (2026-10-28、kawaz 裁定。§5 の未読の数え方は裁定待ち) — ⬜ 未実装
- Date: 2026-10-28

## Context

エージェントが人に知らせる口は mods の tool `say` ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3)。今の経路は次のとおり:

- tool の handler は `<root>/bin/ccmsg say <text>` を起こす。CLI は daemon に op `say` で「どのセッションが喋ったか」を記録させてから `/usr/bin/say` を起こし、発声の直前に読み上げ辞書で語を読みに置き換える
- daemon は記録を最大 200 件メモリに持ち、変わるたびに全件を `ev:"says"` で全タブに送る。webui は記録を時刻で TL に差し込み (say-merge.ts)、Sessions 一覧に未読の 🔔 を出す
- daemon を再起動すると記録と未読が消える

しかし say の tool_use は transcript に `{"type":"tool_use","id":"toolu_…","name":"mcp__ccmsg-v1__say","input":{"text":"…"}}` の形で残っている (実 transcript で確認)。喋った事実の正本はすでに transcript にあり、daemon の記録はその写しになっている。PushNotification の 🔔 はすでに transcript の tool_use から描いている。

kawaz 2026-10-28 の裁定: say を「発声」と「表示」に分ける。tool の hook は `/usr/bin/say` を直接起こすだけにし、daemon への記録は廃止する。表示は transcript の tool_use から描き、既読の状態だけを daemon が持つ。CLI の `ccmsg say` は削る。

## Decision

### 1. 発声は tool の handler が `/usr/bin/say` を直接起こす

- handler は入力を `SayToolInputSchema` で読み、`[<say>, "--", <置き換えた本文>]` を `$.process.run` で起こして発声の終わりを待つ。`<say>` は `/usr/bin/say` (試験では `CCMSG_SAY_BIN`、`$.env.get` で読む)。待ちは 120 秒のまま
- `--` を必ず置く。`-` で始まる本文が say のオプションとして読まれないため (実測: `say -o <file> "-v テスト"` は本文を読まずに exit 0、`say -o <file> -- "-v テスト"` は発声した)
- daemon には何も送らない。daemon が居なくても、session id が無くても発声する
- tool の結果は発声の成否を言う。失敗は exit と標準エラーの 1 行目、起こせなかった・待ちを過ぎた時はその理由

### 2. 読み上げ辞書は module が発声の直前に当てる

置き換えの規則とファイルの形は次のとおり。

- **一致**: 大文字小文字を無視する。語の両側を `(?<![A-Za-z0-9])word(?![A-Za-z0-9])` で区切る (下線・空白・記号・日本語・文字列の端は区切り。`_daemon_` と `の daemon で` には当たり、`daemonize` / `mydaemon` / `daemon2` には当たらない)。同じ位置に複数の語が当たる時は長い方。語の中の正規表現の記号は文字どおり (`C++`)。辞書に無い語はそのまま
- **ファイル**: `<config dir>/say-dictionary.tsv` (既定は `${XDG_CONFIG_HOME:-~/.config}/ccmsg/say-dictionary.tsv`、`CCMSG_CONFIG_DIR` があればその下)。1 行に `word<TAB>読み`。`#` で始まる行はコメント、空白だけの行は無視、CRLF の `\r` は改行の一部。語は空白を含まない 1 語、読みはタブと改行を含まず空白だけでない。規則に合わない行はその行だけ飛ばす。同じ語 (大文字小文字を無視) は後の行が勝つ。行の形はスキーマで読む ([DR-0038](./DR-0038-json-is-parsed-by-schema.md))
- **同梱の辞書**: リポに同梱する初期辞書の後にファイルの行を読んだものとして扱う (同じ語はファイルが勝つ)。ファイルが無ければ同梱の語だけ。同梱の語を読ませたくない時はファイルでその語の読みを書き換える。初期値:

```
1Password	ワンパスワード
daemon	デーモン
sidecar	サイドカー
plugin	プラグイン
OTP	オーティーピー
URL	ユーアールエル
API	エーピーアイ
CI	シーアイ
PR	ピーアール
jj	ジェイジェイ
Kyell	ケイエール
```

- **置き場**: 辞書の行の読み、同梱とファイルの重ね合わせ、置き換え、config dir の決め方は protocol の純関数 (`packages/protocol/src/say-dictionary.ts`)。同梱の辞書も protocol に置き、hooks の bundle に焼き込む。module は `$.env.get` で `CCMSG_CONFIG_DIR` / `XDG_CONFIG_HOME` / `HOME` を読んでパスを決め、`$.fs.read` でファイルを読む。CLI は辞書を持たない (§3)
- **反映**: 発声のたびにファイルを読む。編集は次の発声から効き、監視や cache は持たない
- **読めない行・ファイル**: 飛ばした行は `<file>:<line>: <理由>` の形で tool の結果の末尾に足し、`$.ui.log` (debug) にも出す。辞書を直すのはエージェント自身なので、結果に載せれば次の手で直せる。ファイルそのものが読めない時 (権限・ディレクトリ等) も同じく 1 行足し、同梱の辞書だけで話す。発声は止めない
- **書かれた内容との関係**: TL の 🔔 は transcript の入力のまま (辞書は聞こえ方の補正で、書かれた内容ではない)
- **編集**: ファイルの直編集だけ。パスと書式は README の say の節と skill に書く。skill の say の節は「英単語や略語はそのまま書く。読みの崩れる語に気づいたら辞書に 1 行足す」とする

### 3. 許可依頼の音声も module が鳴らす

- `permit` の handler は `ccmsg sidecar permit` が依頼の記録を返した後に、§1 と同じ発声の関数で固定の文「許可を求めています」を鳴らす。CLI の `sidecar permit` は記録して応答を返すだけにする
- 発声と辞書は module の 1 か所になり、CLI は発声も辞書の読みも `CCMSG_SAY_BIN` も持たない
- 音声が鳴らせなくても依頼は記録されて TL に出ているので、tool の結果は「許可依頼を出した」のまま、鳴らなかった理由を添える

### 4. 表示は transcript の say の tool_use から描く

- TL は main thread の assistant 行の tool_use `{name:"mcp__ccmsg-v1__say", input:{text}}` を、PushNotification と同じ境界行の 🔔 バブルとして描く。時刻と位置はその行のもの。照合は PushNotification と同じく `packages/protocol/src/ccmsg-direct-transcript.ts` に置く
- バブルの見た目・既読ボタンの規則は [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6.3 のまま (未読が複数ある時の最新の未読のボタンだけ「N 件すべて既読」、ほかは「既読」。押した時に TL に出ていたものだけを既読にする)
- 既読の印は daemon の未読の集合 (§5) が持つ。集合にある say は 🔔 と既読ボタン、無い say は 🔕。PushNotification は既読を持たず 🔔 のまま
- subagent / teammate の say はその transcript (`subagents/*.jsonl`) にあり、その agent の TL に出る。未読の集合の対象は main thread の say だけなので、agent の TL の say は 🔕 で出る
- 許可依頼のバブル ([DR-0040](./DR-0040-permit-request-tool.md) §7) は daemon の記録を時刻で差し込む形のまま。say と時刻を突き合わせる処理は無くなる

### 5. 既読の状態と Sessions 一覧の未読の数 (未読の数え方は裁定待ち)

既読の状態の持ち方 (案 A・案 B 共通):

- キーは say の tool_use の id (`toolu_…`)
- daemon は user role の購読者に未読の集合を `ev:"say_unread"` `{ says: [{ session_id, tool_use_id, ts }] }` で送る。購読した時に全件 (空でも送る。再起動した daemon に繋ぎ直したタブが古い集合を捨てられるように)、変わるたびに全件。session には送らない
- op `say_read` `{ ids }` (user role だけ) は tool_use の id の列を受け、全部を既読にする。未読の集合に無い id が 1 つでもあれば、どれも既読にせずに `invalid_args` で断る (既読にできたと見えて数が減らない状態を作らない)
- Sessions 一覧の各行の 🔔 と件数は、未読の集合をセッションごとに数えたもの

未読の集合の作り方 (推し: 案 A):

| | 案 A: daemon が transcript の say を数える | 案 B: module が daemon に tool_use の id を知らせる |
|---|---|---|
| 未読の元 | 接続中の各セッションの main の transcript の say の tool_use から、既読の集合にあるものを除く | handler が発声と並べて `ccmsg sidecar` 系の新しいコマンドを起こし、daemon に `{ tool_use_id }` (subagent なら `agentId` も) を送る。daemon はそれを未読として持つ |
| 新しい読み | 無い。daemon は webui のタブが開いている間、接続中の全セッションの transcript を既に共有の tail で読んでいる (session-errors.ts / session-user-input.ts)。同じ tail に 3 つ目の listener を足す | 無い |
| 足すコスト | tail を始める時 (タブを開いた時・セッションが繋がった時・ファイルが置き換わった時) に transcript を頭から 1 回読む。実測で、今のライブの 9 セッション (47.4 MB、14,168 行) を 1 行ずつ部分文字列で絞って読むと 73〜81 ms (2 回、page cache が温まった状態)。追記された行ごとに部分文字列の検査 1 回 | say 1 回ごとに bun のプロセスを 1 つ起こす (facts と同じ形)。session role の op が 1 つ増える |
| 永続化するもの | 既読にした id の集合と、集合を作った時刻 (それより前の say は既読とみなす)。刈り込まない。見積りは say の観測頻度 (全 config dir の main の transcript に 54 件) から年に数千件・数十 KB | 未読の集合 (既読で消える。数は未読の数で抑えられる) |
| 拾えない say | subagent / teammate の say (main の transcript に無い)。実測で subagent の transcript に say の tool_use は 0 件 | daemon に繋がらなかった時の say。旧版の plugin のセッションの say (旧版は op `say` を送るが、それは無くなる) |
| 正本 | transcript 1 つ | 表示は transcript、未読は module の知らせで、2 つが食い違いうる (知らせが届かなかった say は見ていないのに 🔕) |

推しの理由: transcript が say の唯一の正本になり、session から daemon への書き込みが 1 本も増えない。足すのは既存の tail の listener 1 つと、タブを開いた時の 1 回の読み (今のライブの全セッションで 0.1 秒未満) で、daemon が新たに常時 tail するファイルは無い。daemon の再起動、daemon が居なかった間の say、旧版の plugin の say もそのまま拾える。案 B の利点は subagent の say を数えられることだけで、観測では 0 件。

案 A の永続化:

- 置き場は `<state dir>/say-read.json` (`{ since, read: [id…] }`)。`since` はこのファイルを作った時刻。ファイルが無い・スキーマに合わない時は、その時刻を `since` として作り直す (それより前の say を全部既読とみなし、古い say で 🔔 が溢れないようにする。合わなかった時は daemon.log に 1 行書く)
- 書き込みは `say_read` を受けるたびに一時ファイルへ書いて rename する。応答はその後に返す
- 永続化は [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 の「v1 だけの永続状態を増やさない」の例外になる。say を transcript から読む以上、既読をメモリだけに持つと再起動のたびに過去の say が全部未読に戻る (メモリだけの記録なら「消える」で済んでいたものが「溢れる」に変わる)。持つのは既読の印だけで、say の中身は transcript にある

### 6. 削るもの

- CLI の `ccmsg say` (dispatch、`printSayHelp`、`recordSayEvent`、引数のうち本文を探す `speechTextOf`、help と README / README-ja / skill の記述)
- protocol の op `say`、`SayRecord`、`ev:"says"`。daemon の `say-log.ts` と `case "say"`、`broadcastSays`
- webui の `useSayBubbles.ts`、say の時刻の差し込み、store の `says`
- 旧版の plugin のセッションは自分の root の `bin/ccmsg say` を起こすので、旧版の CLI のまま話す。旧版の CLI は新しい daemon に op `say` を送って断られるが、記録の失敗は握って発声に進む (`recordSayEvent`、待ちは 1.5 秒まで) ので、音は鳴る。tool の名前は同じなので、案 A ならその say も TL と Sessions 一覧に出る
- PATH に置いた `say` の shim (`exec ccmsg say "$@"`) は、PATH の `ccmsg` が `say` を持たない版を指した時点で発声できなくなる。shim の copy は消す

## Alternatives Considered

- 案 X: 発声を CLI に残す (handler が CLI の「辞書を引いて発声する」だけの内部コマンドを起こす)
  - 不採用理由: say 1 回ごとに bun のプロセスを起こし、発声のために CLI と module の 2 段を通る。辞書は protocol の純関数と `$.env.get` / `$.fs.read` で module から読める。`$.fs.read` が config dir の絶対パスを読めることは未検証で、読めなければこの案に戻す
- 案 Y: `$.audio.speak` で話す
  - 不採用理由: 声・速さを選べず、試験で発声の引数を観測する口 (`CCMSG_SAY_BIN`) が無い。発声の終わりを待てるかも分からない
- 案 Z: 許可依頼の音声を CLI に残し、辞書の読みを protocol の共有関数で CLI と module の両方から行う
  - 不採用理由: 置き換えのコードは 1 つでも、ファイルを読む口・警告の出し先・発声の binary の選び方が 2 か所に残る。許可依頼の handler は `ccmsg sidecar permit` の応答を待っているので、その後に鳴らせば同じ時機になる
- 既読をメモリだけに持つ ([DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 のまま)
  - 不採用理由: §5 の「案 A の永続化」のとおり、再起動のたびに過去の say が未読に戻る。daemon の起動時刻より前の say を既読とみなせば溢れないが、再起動で未読が全部消える
- say の記録 (中身付き) を daemon に残し、ファイルに持つ
  - 不採用理由: transcript の写しを持つことになり、2 つの正本が食い違いうる

## Consequences

- 触る範囲: hooks (`tools.ts` の `sayTool` / `permitTool`)、protocol (辞書・config dir の純関数、同梱の辞書、`ccmsg-direct-transcript.ts` の say の照合、op / ev の差し替え)、daemon (未読の集合、既読のファイル、op `say` の削除)、webui (transcript-model の境界行、TL のバブル、Sessions 一覧の数、store)、CLI (`ccmsg say` と `sidecar permit` の音声の削除)、README / README-ja / skill
- tool の結果の文が変わる (「伝えた (音声)」と、飛ばした辞書の行)
- 発声は Claude Code のプロセスの環境で起きる。`CCMSG_SAY_BIN` / `CCMSG_CONFIG_DIR` / `XDG_CONFIG_HOME` はそのセッションの環境の値が効く
- TL の say のバブルは transcript を読み込んだ範囲にだけ出る。older を読むまで古い say は TL に無いが、Sessions 一覧の数には入る (案 A は daemon が全体を読む)

## 関連

- [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6.3 — 🔔 バブルの見た目と既読ボタンの規則
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 — 人への経路、v1 だけの永続状態
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 — typed tool の登録と handler の流儀
- [DR-0040](./DR-0040-permit-request-tool.md) — 許可依頼 (音声、時刻の差し込み)
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — 外から来るデータはスキーマで読む
