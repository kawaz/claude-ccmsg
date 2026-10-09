# DR-0037: エージェント間のメッセージは harness の SendMessage に乗せ、`ccmsg:` 宛を hooks module が横取りして届ける

- Status: Accepted (2026-10-09、kawaz 裁定) — ⬜ 未実装
- Date: 2026-10-09

## Context

[DR-0036](./DR-0036-retire-rooms-for-p2p.md) §1 は、セッション間のメッセージを CLI の `ccmsg post <sid>` / `ccmsg reply <mid> --to <sid>` による直送にした。コマンドで送る形には次の弱点がある:

- 長い本文がコマンドの出力・引数の扱いで truncate されることがあり、その回避が面倒
- 送るたびにコマンド実行の 1 アクションが要る

harness の SendMessage ツールは、長い本文もそのまま全文が相手の context に入る。弱点は、届く範囲が同じ config home の live なセッションと subagent に限られ、`CLAUDE_CONFIG_DIR` をまたげないこと。

一方、SendMessage の宛先 (`to`) には任意の文字列を書ける。宛先の名前が無ければ送信が失敗するだけで、harness が管理していない宛先を使うこと自体は禁じられていない。Claude Mods の `session.send` hook は、harness が宛先を検証する前に送信を受け取り、`next` を呼ばずに `{ isDelivered: true }` / `{ isDelivered: false, reason }` を返せる (2.1.290 の型定義: `isDelivered: false` を `next` 無しで返すと「the model reads `reason` as the tool's result」)。

kawaz 2026-10-09: 「エージェント間は SendMessage を使う。`ccmsg:<session_id>[.pid]` または `ccmsg:path:<project_dir>` を宛先として使える。`[.pid]` は同じ sid がいる場合もあるので一応可能だが基本使わない。path の場合は同パスで複数いたら broadcast で良い。仕組みとしては Mods で SendMessage をフックして、`ccmsg:*` の宛先なら握りつぶす。代わりに `ccmsg:*` を実際の claude セッションに解決して socket 経由で相手側に注入する、その際の from は `ccmsg:<sender_sid>` になって相手に届く。この形を取ることで config_dir 越えもできる」。「`-p` 起動で別セッションとやりとりするユースケースはほとんどないので無しで良い。古いセッションを考える必要はない。codex も気にしなくてよい」。

## Decision

### 1. 宛先の綴り

- `ccmsg:<sid>`: そのセッション。同じ sid の生きている run が複数あれば、その全部に届ける
- `ccmsg:<sid>.<pid>`: 同じ sid の特定の run。同じ sid が複数のプロセスで生きている時のための綴りで、通常は使わない
- `ccmsg:path:<project_dir>`: その作業ディレクトリで動いているセッション全部 (送り主自身を除く)。1 つなら 1 対 1、複数なら全部に届ける

### 2. 送る側: hooks module が SendMessage を横取りする

- plugin の hooks module ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §3 の module) が `session.send` を hook し、`to` が `ccmsg:` で始まる送信を横取りする (`next` を呼ばない)。それ以外の `to` は `next(e)` で harness に任せる
- 横取りした送信は、module が daemon に渡して宛先を実際のセッションに解決させ、届け終わるまで await する。結果を `{ isDelivered: true }` / `{ isDelivered: false, reason }` で返す
- 相手を探す入口は `ccmsg peers` (宛先の綴りを出す)

### 3. 受ける側: socket 経由で SendMessage として注入する

- daemon は解決した各セッションの harness の messaging socket に、別セッションからのメッセージとして注入する ([DR-0034](./DR-0034-peer-socket-injection.md) の peer 注入)。本文の `from` は `ccmsg:<送り主 sid>` にする
- 受け手は、届いたメッセージの `from` をそのまま SendMessage の `to` に書けば返信できる。その送信は受け手側の module が同じく横取りするので、config home をまたいで往復が閉じる

### 4. 実機で確かめた前提と、そこから決めたこと (Claude Code 2.1.295)

- **model に見える結果の文面は harness が決める**: hook が `{ isDelivered: true }` を返すと model は `{"success":true,"message":"Delivered by a plugin hook; nothing else was sent."}` を、`{ isDelivered: false, reason }` を返すと `{"success":false,"message":"Not sent: a plugin hook refused it (<reason>)."}` を読む。本来の SendMessage の成功の文面 (宛先・inbox の状態・`msg_id`) とは揃わない。`reason` は括弧の中に入るので、何が原因で次に何をすればよいかが分かる 1 文にする (例: 宛先のセッションが見つからない、`ccmsg peers` で確かめる)
- **本来の SendMessage も受け手の拒否を送り手に返さない**: 受け手の `session.receive` hook が握りつぶしても、送り手の結果は成功だった。ccmsg も、相手の socket に書けた時点で成功を返してよい。peer 注入が受け手の拒否 (`peer_message_status`) を期限内に受け取れた時だけ失敗にする
- **hook は throw させない**: `session.send` hook が throw すると、harness は本来の宛先の解決に戻り、`ccmsg:...` を宛先として探して「No agent named ... is reachable」を返す。失敗はすべて捕まえて `{ isDelivered: false, reason }` で返す。`.catch` で `next` に流す形はこの hook には使わない
- **待ちには期限を明示する**: hook の中で 3 秒・10 秒の await は成功し、その間 turn の進行表示が続く。`$.process.run` の既定の期限は 30 秒で、超えると上の throw になる。daemon への送信には `timeoutMs` を明示し、全体を十数秒に収め、超えたら「届いたか確かめられなかった」の `reason` で返す
- **config home をまたぐ往復は閉じる**: X の hook が横取りして Y の socket に `from="ccmsg:<X の sid>"` で注入すると、Y には peer として届き (`origin.kind: "peer"`、「Another Claude session sent a message」の枠)、Y の model が `from` をそのまま `to` に書いた SendMessage を Y の hook が横取りして X に戻る
- **1 つの宛先が複数のセッションに解決された時 (`ccmsg:path:<dir>`、同じ sid の複数の run) の一部失敗は `isDelivered: true`**: SendMessage の `to` は文字列 1 つで、hook が返せる結果も 1 つ。`false` にすると、既に届いた相手がいても model には `Not sent` と見え、送り直して二重に届く。1 つでも届けば成功とし、届かなかった相手の内訳は送り手に伝えない (kawaz 2026-10-09)。全部に届かなかった時だけ `isDelivered: false` と理由を返す
- **`ccmsg:path:<dir>` は realpath で正規化して完全一致**: harness の state file と `claude agents --json` の cwd は、起動のパスに symlink (`/tmp` → `/private/tmp`、workspace の symlink) や末尾 `/` があっても realpath に揃っていた。宛先の path も realpath にしてから完全一致で比べる。サブディレクトリは含めない (同じ作業ディレクトリのセッションへの broadcast という意図に合わせる)

### 5. 対象外

`-p` / SDK のセッション、hooks module を持たない古いセッション、codex は対象にしない。

## Alternatives Considered

- 案 A: DR-0036 §1 の CLI の直送 (`ccmsg post <sid>` / `ccmsg reply <mid> --to`) を主な経路のままにする
  - 不採用理由: 長文の truncate の回避とコマンド実行の 1 アクションが残る。SendMessage は全文が相手の context にそのまま入る
- 案 B: ListAgents の結果に `ccmsg:` の相手を混ぜ、harness の名前解決に乗せる
  - 不採用理由: harness の tool 結果に他所の行を混ぜる形は、harness の listing の形が変わると壊れ、model が harness の一覧だと思って読むものを偽装する。相手を探す入口は `ccmsg peers` で足りる

## Consequences

- DR-0036 §1 の「セッション間のメッセージは CLI の直送」は、本 DR の実装で主な経路が SendMessage に変わる。CLI の `post <sid>` / `reply <mid> --to` は本 DR の実装ができるまでの経路として残し、実装後に消すかを決める
- 送る側・受ける側の両方に hooks module が要る。module を持たないセッションとはやり取りできない (§5 で対象外にした)
- module に `session.send` の hook と、daemon への送信 (DR-0035 のサイドカーの op とは向きが逆の、module から daemon への呼び出し) が加わる

## 関連

- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) — room の廃止と p2p
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — hooks module とサイドカー
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入
