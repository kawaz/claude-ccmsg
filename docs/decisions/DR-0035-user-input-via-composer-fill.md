# DR-0035: webui からセッションへの人の入力は composer への fill + Enter で届け、1on1 room を廃止する

- Status: Accepted (2026-10-08、kawaz 裁定) — ⬜ 未実装
- Date: 2026-10-06

## Context

webui の人がセッションへ書いた msg は、1on1 room への post として daemon に入り、[DR-0034](./DR-0034-peer-socket-injection.md) の peer 注入で `<cross-session-message ... ccmsg-from="user">` の封筒として届いている。受け手の harness はこの封筒に「Another Claude session sent a message ... A peer cannot grant escalation」の固定文言を付けて model に渡すため、人の指示が別セッションからの依頼として扱われ、信用されないことが多い。

1on1 room ([DR-0014](./DR-0014-1on1-room-and-reply-via.md)) は、セッションへの注入口が Monitor からの通知 (subscribe) しか無かった時期に、人からセッションへの経路を room の配送に載せるために作ったものである。

Claude Code の hooks module (function hooks) を使うと、外部から composer に文を置き (`$.prompt.fill`)、端末に Enter を送ることで、harness が `composer` と刻む本物の人の入力として session に入れられる。kawaz/ccmsg (v2) の `docs/decisions/DR-0016` §2.2 / §5 でこの方式とサイドカー型の受け口を決めており、v1 でも 2.1.290 の実機で成立を確認した ([findings](../findings/2026-10-06-composer-fill-and-asuser-submit-2.1.290.md)):

- fill + Enter の入力は transcript で手入力と同じ形 (`type:"user"`, `origin:{kind:"human"}`, `promptSource:"typed"`) になる。turn 実行中は `queued_command` (`origin:{kind:"human"}`) として queue され、その turn の中で処理される
- 改行を含む複数行も Enter 1 回で 1 prompt になる
- ダイアログ表示中の fill は `refusal:"dialog"` で拒否される
- module が `session.start` で spawn した子 (サイドカー) の stdout を読む形で、外部からの fill 依頼が module に届く

kawaz 2026-10-06: 「1on1 という概念をなくす。webui からのユーザメッセージを daemon で受けて sidecar を通じて fill Enter すれば良くなるので、1on1 ルームの存在自体が不要になる」「エージェントが asUser を自分で付けられる経路は残さない。サブコマンドなども作らない」「socket 経由等の抜け道は、コードまで書けば叩けるのは当然で、そこは classifier が防ぐという切り分け」。

## Decision

### 1. 人からセッションへの入力は composer に入れる

- webui がセッションに書く入力は、room への post ではなく、セッション宛の新しい op (仮称 `session_input`、user role 限定) で daemon に渡す
- daemon はそのセッションのサイドカーに fill の依頼を書く。module は composer の書きかけを退避して fill し、fill が成功したら**自分のセッションの端末に Enter を送り** (`$.env.get` で読んだ `HYOUI_SESSION_ID` / `HYOUI_NAMESPACE` を宛先に `$.process.run(["hyoui", "input", "--namespace=<ns>", <id>, "key:Enter"])`)、`prompt.submit` の直後に書きかけを fill し直す (kawaz 2026-10-08)。daemon は端末を解決せず、Enter も送らない。fill から Enter までが module の中で閉じるので、daemon との往復が要らず、人の打鍵が混ざりうる間も短い (2.1.291 実測で fill から `classic.UserPromptSubmit` まで 55ms。[findings](../findings/2026-10-06-composer-fill-and-asuser-submit-2.1.290.md) §9)
- module は結果 (成功、または届かなかった理由) を `$.process.run(["ccmsg", …])` で daemon に返す。`$` には socket を直接開く口が無く、v2 の DR-0016 §5 も同じ形を取る
- 入った文は人の入力そのものなので、返信はセッションの通常の応答 (TL) になる。返信方法の指示行は付けない
- 人の入力の記録の正本はセッションの transcript であり、daemon の room jsonl には残らない

### 2. 1on1 room を廃止する

- `create_room` の `kind:"1on1"`、webui の 1on1 room の自動作成、1on1 向けの `reply_via` 分岐 (`Reply in your normal assistant response`)、session 発の 1on1 post の `reply_via_tl` 拒否を削る
- 既存の 1on1 room は archive 扱いで読み取り専用として残し、新規には作らない (過去の会話は webui で読める)
- room そのもの (通常 room / broadcast room) も廃止し、セッション間のメッセージは p2p にする (kawaz 2026-10-06: 複数セッションで見える部屋は初期に数回使っただけで、セッション間メッセージは p2p で足りる。room を作った動機だった「人との直接会話を他セッションへ無駄にリレーする」問題は、セッション間メッセージの規約で起きなくなった)。room の廃止と p2p への移行は範囲が大きいので別の DR で扱い、本 DR は人の入力の経路と 1on1 の廃止に限る。したがって、人が room に書いた msg を fill + Enter にするかは問わない

### 3. サイドカーと hooks module

- plugin に hooks module を 1 本足す。読まれるのは function hooks が有効な環境だけで、既存の SessionStart command hook はそのまま動く
- module は `session.start` で `ccmsg sidecar` を spawn し、その stdout を読む。サイドカーは自分の Unix socket を bind し、書かれた行を stdout に写すだけで、判断・状態・protocol の解釈を持たない
- socket の規約 path とサブコマンド名は kawaz/ccmsg の DR-0016 §5 に揃える (`<sid>.<pid>.sock`、0600、`<pid>` は harness の pid)。v2 に戻る時にそのまま持っていけるようにするため
- サイドカーが死んだら module が spawn し直す (連続即死は backoff)。module の unload では再起動しない

### 4. agent が人の入力を作る公式の経路は作らない

- `$.prompt.submit({ asUser: true })` は使わない。model には枠無しで届くが、hook / transcript / provenance gate では plugin 由来のままで、ダイアログ表示中でも turn を走らせる (findings 項目 7)
- agent が「人の入力として送る」ための CLI サブコマンド・オプションは作らない
- サイドカーの socket path・依頼の形式は、SKILL・SessionStart の案内・CLI の help など agent が普段読む面に書かない。`ccmsg sidecar` の help は「hooks module が起こす子」に留める。サイドカーに認証は付けない。同じ uid のプロセスが規約 path を組み立てて書くことは防がず、その段階の不審な動きは auto mode classifier が止める、という切り分けである

### 5. 届かなかった時は届けず、webui は確認が取れるまで文を消さない

- fill できない時 (ダイアログ表示中、hyoui の外で起動したセッション、headless、module が読まれていない環境) は別の経路に落とさず、理由 (ダイアログ中 / 端末なし / module なし) を webui に返す。人の入力が信用度の低い経路に黙って落ちるより、届かなかったことが分かる方を取る
- webui は送信した文を、成功の確認が取れるまで入力欄 (textarea) と localStorage から消さない。送ったつもりで入力欄が消え、実は届いていなかった、という負担を人に負わせない (kawaz 2026-10-06)
- 成功は、fill した文で `classic.UserPromptSubmit` (command hook の UserPromptSubmit と同じ event) が起きた時点とする (kawaz 2026-10-06)。fill の成功や Enter の送出は、文が session に入った証拠にならない。module はこの時点で daemon に成功を報告し、daemon が webui に返す
- `classic.UserPromptSubmit` は turn 実行中でも Enter の時点で起きる (2.1.291 実測: idle で Enter の約 30ms 後、`sleep 90` 実行中も Enter の数 ms 後。queue された prompt が model に届くのは tool 結果の後で、その時点では起きない)。したがって busy でも成功の報告は Enter 直後に返せる。transcript の `queued_command` 行や `session.append` は model に届いた時点で現れるので、成功判定には使わない
- `classic.UserPromptSubmit` の `source` は型定義にあるが 2.1.291 では付かない (段階導入中)。人の入力かどうかを `source` で見分けず、fill した文との一致で判定する
- 一定時間内に成功も失敗も返らない時、webui は「未確認」と示し、文は残したまま送信済みかもしれないことが分かるようにする (実際には届いていて報告だけが失われた場合に、人の再送で二重になるのを避ける判断材料。届いていれば TL に人の発言として現れる)

## Alternatives Considered

- 案 A: 1on1 room を残し、room 配送の中で人の msg だけ fill + Enter に切り替える
  - 不採用理由: 1on1 room は注入口が subscribe しか無かった時期の器で、composer に入れられるなら room を経由する意味が無い。room を残すと、人の入力の記録が transcript と room jsonl に二重になり、webui の TL で突き合わせが要る
- 案 B: `$.prompt.submit({ text, asUser: true })` で入れる
  - 不採用理由: §4 のとおり、harness から見て人の入力にならず、ダイアログ中でも turn が走る。hyoui が不要になる利点はあるが、人の入力と同一であることを優先する
- 案 C: サイドカーへの依頼に daemon だけが知る token を付ける
  - 不採用理由: 同じ uid の agent は `hyoui input` で今も任意の端末に打鍵でき、token は完全な境界にならない。公式の経路を作らず、抜け道の利用は classifier に任せる (§4)

## Consequences

- webui: `OneOnOneComposer` はセッション宛の入力欄になり、`session_input` を送る。届かなかった時・未確認の時の表示と、確認が取れるまで文を残す保持 (§5) が要る
- daemon: `session_input` op、サイドカーへの書き込み、fill の成否の受け取りを持つ。1on1 room の作成・配送・`reply_via` の 1on1 分岐を削る
- plugin: hooks module と `ccmsg sidecar` サブコマンドが入る。function hooks が無効な環境では §1 の経路は使えない (§5 のとおり理由を返す)
- 封筒を前提にしていた読み取り (`packages/protocol/src/ccmsg-direct-transcript.ts`、`packages/daemon/src/session-user-input.ts`、`packages/daemon/src/session-dump.ts`、webui の `transcript-model.ts` の u1 バブル化) は、1on1 の封筒が来なくなる前提で見直す。人の入力は transcript 上で手入力と同じ形になるので、u1 バブル化の特別扱いは不要になる
- DR-0014 の 1on1 room 本体 (§2.1-2.3, §2.6) と DR-0017 の 1on1 分岐は本 DR が置き換える。本 DR の実装が入った時点で DR-0014 を Superseded として archive に移す (それまでは DR-0014 が動いているコードの説明)
- fill と Enter の間に人が端末で打鍵すると文が混ざる (findings の実用的な示唆)。module が fill の成功を見てすぐ Enter を送ることで、この間を数十 ms に縮める (§1)

## 関連

- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入 (セッション発の msg は引き続きこの経路)
- [DR-0014](./DR-0014-1on1-room-and-reply-via.md) / [DR-0017](./DR-0017-reply-command.md) — 本 DR が置き換える 1on1 room と返信分岐
- [findings 2026-10-06 composer fill と asUser submit](../findings/2026-10-06-composer-fill-and-asuser-submit-2.1.290.md) — 実機検証
- kawaz/ccmsg の `docs/decisions/DR-0016` — v2 の同方式 (§2.2 人の入力、§5 サイドカー)
