# DR-0040: auto mode の classifier に止められたエージェントが人に許可を求める tool `permit`

- Status: Accepted (2026-10-25) — ✅ 実装済み (tool `permit`、`ccmsg sidecar permit`、op `permit_request` / `permit_request_read` / `permit_attachment_read`、TL の許可依頼バブル、Sessions 一覧の 🔐、skill の節、1 行のコマンドの「! で実行」(§11)、プロジェクトの `.claude/settings.local.json` の `permissions.allow` を 1 件ずつ足し引きする `project_permissions` (§12、op `permit_settings_read` / `permit_permission_apply`)、記録の永続化 `permit-requests.json` (§4))。§6 の音声を鳴らす場所 (daemon が依頼を記録した時) は [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §6 が定める
- Date: 2026-10-25

## Context

Claude Code の auto mode の classifier に止められた操作を再実行させるには、そのセッションの会話に人の許可の発話が要る。classifier はその会話の文脈しか見ないので、別のセッションへの伝言や subagent への許可は効かない。今はエージェントが rules の定型文 (「X が止められました。実行してよければ `… を実行して良い` と言ってください」) を本文に手で書き、人がその許可文を入力欄に打ち返している。この形には 3 つの弱みがある。

- 形がエージェントごと・回ごとにぶれる。人は毎回、何を許可するのかを本文から読み取り直す
- 許可文に具体 (コマンドの全文、コマンドが読むファイルの中身) を入れ忘れる。具体の無い許可は classifier が当該操作と結び付けられず、許可しても再び止められる
- コマンドが読むファイル (script・policy の JSON・patch) の中身を人に見せるには本文に貼るしかなく、エージェントの context を食う

kawaz 2026-10-25 の裁定: 構造化した許可依頼を webui に専用のバブルで出し、「許可する」ボタンで許可文をクリップボードに写せるようにする。許可したかどうかの状態は持たない。人がまだ手を付けていない依頼は say の 🔔 と同じ仕組みで Sessions 一覧に印を出す。添付の中身は依頼の時に読まず、人が開いた時に読む。

## Decision

### 1. 入力 (tool `permit`)

hooks module が `session.start` で 5 つ目の tool として登録する ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 の登録の形と「mods の tool の作り方」に従う)。description は `Ask the person for permission`、field の説明は付けない。model に見せる input schema は型だけ:

```
blocked:     string                                   # 止められた行動 (markdown、1〜2 文)
attachments: string[]                                 # コマンドが読むファイル (絶対パス)
intents:     string[]                                 # コマンドでない許可してほしいこと (markdown、各 1 文。Edit 等)
commands:    { command: string, description?: string }[]   # Bash に渡す内容そのまま (複数行可) と、何をするかの短い説明
project_permissions: { add?: string, remove?: string }[]  # プロジェクトの permissions.allow に足す / 消す rule (完全一致形を推奨、§12)
```

- 必須は `blocked` と、各コマンドの `command`。`intents`・`commands`・`project_permissions` の少なくとも 1 つに 1 つ以上の要素があること (field の組み合わせ) は handler が入口で読む valibot のスキーマが持つ。どの文字列も空白だけにしない
- `attachments` は絶対パス (`/` で始まる) で、同じパスを 2 度書かない。数は 16 まで (バブルと許可の文の 1 行ずつになるので、人が読み切れる数に抑える)
- 配列の field は要素の型ごと、object は field ごとに見せる (`{ type: "array", items: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"] } }`)。配列と object の型は中身の型までで 1 つの型なので、`toolInputSchemaOf` は `items` と `properties` / `required` を同じ規則 (型と enum だけ) で導く。長さや重複の決まりは見せない
- 合わない入力は「permit の入力が形に合わないので何もしていない: <理由>」で返す (DR-0039 §3)

### 2. 経路

module の handler → CLI の transport → daemon の op → 記録 → 全タブへの配送 → TL のバブル。

- handler は入力を `PermitToolInputSchema` で読み、`ccmsg sidecar permit --sid <sid>` を `$.process.run` で起こして入力を標準入力に JSON で渡す (コマンドが長く、引数は `ps` で全員に見えるため、`send-message` と同じ)。待ちは 30 秒 (daemon を起こす時の接続の再試行の分)。音声は daemon が記録した時に鳴らす (§6)
- `ccmsg sidecar permit` は標準入力を `PermitInputSchema` (知らない field を断る。各コマンドの object も) で読み、session として daemon に op `permit_request` (`{ op, permit }`) を送る。daemon が記録したら daemon の応答を標準出力に出して exit 0。daemon が無ければ exit 3、断られたら断りを標準エラーに出して exit 1 (`send-message` / `launch` と同じ)
- op `permit_request` は session role だけが送れる。依頼するのは止められたエージェント自身なので、依頼はセッションを名指さず、送ったセッションの sid で記録する
- 応答は記録の id だけ。handler は「許可依頼を出した」とだけ返す。添付の中身を人が読めるかは人が開いた時に分かることで、model に返すものは無い
- handler は `next` を呼ばずに答えるので、`permit` 自体は permission の判定 (classifier を含む) を通らない (DR-0039 §3)。止められた直後でも呼べる。`permit` がするのは記録と表示と音声だけで、権限は何も変えない

### 3. 添付の読み取り

- 依頼の時には読まない。記録は添付のパスだけを持つ。依頼の配送が軽くなり、人が開かない添付は読まれない
- 人がバブルで添付を開いた時に、webui が op `permit_attachment_read` (`{ id, path }`、user role だけ) で daemon に読ませ、返った中身をその折り畳みに差し込む。読めた後は閉じて開き直しても読み直さない。daemon が答えなかった時は、次に開いた時に読み直す
- 読めるのは、その id の依頼が名指したパスだけ。依頼に無いパスや、持っていない id は断る。信頼の形は [DR-0024](./DR-0024-out-of-project-files.md) §3.2 の allowlist と同じで、「セッション自身が名指したパスを、名指された分だけ」読む。人 (user role) が任意のパスを読めるようにはならない
- パスはそのまま開く (symlink は辿る)。通常のファイルだけを読み、先頭の 64 KiB (`PERMIT_ATTACHMENT_MAX_BYTES`) までを返す。長いファイルは先頭だけを返し、全体のバイト数と切り詰めた印を添える。上限で切れた多バイト文字は捨てる
- 中身は UTF-8 のテキストとして読む。NUL を含む、または UTF-8 に無いバイト列を含むものは「テキストでない」として中身を返さない
- 読めない時は理由を返す: `missing` (無い)、`not_a_file` (ディレクトリ等)、`denied` (権限が無い)、`not_text`、`failed` (その他)。webui は同じ文言 (`PERMIT_ATTACHMENT_UNREADABLE_TEXT`) で出す

### 4. 記録

- 記録は `PermitRequestLog` に持つ
- 上限はセッションごとに最新 200 件 (`PERMIT_REQUESTS_PER_SESSION`) と、全体で 2,000 件 (`PERMIT_REQUESTS_TOTAL`)。セッションごとの上限を超えたらそのセッションの古いものから消え、別のセッションの記録は消さない (1 つのセッションが他のセッションの記録を押し出さない)。全体の上限は subscribe の全件がセッションの数に比例して増え続けないためで、超えたら全セッションの古いものから消える
- 期間の上限は置かず、そのセッションの transcript と同じだけ残す。daemon の起動の時に、記録のある各セッションの transcript を履歴の読みと同じ解決 (`resolveTranscript` の allowVirtual) で探し、見つからないセッションの記録を落とす (解決が答えられなかったセッションは残す)。落とした時は購読中のタブに全件を送り直す
- 記録は `{ id, sid, ts, blocked, attachments (パス), intents, commands, project_settings?, read }`。無い list は空の list で持つ。`project_settings` は `project_permissions` のある依頼だけが持つ (§12)。記録した後に変わるのは `read` と、`project_settings` の各変更の `applied_at` だけ。許可が来たかどうかの状態は持たない (エージェントが許可の文を受けて再実行する)。読み返せるよう、許可の後も記録は残す
- `read` は人がまだ手を付けていないかの印。op `permit_request_read` (`{ ids }`、user role だけ) が渡した id の記録を既読にし、二度目は何も変えない。持っていない id が 1 つでもあれば、どれも既読にせずに断る (上限で消えた依頼への既読もここに来る)

#### 永続化

- 記録 (依頼の中身、`read`、`project_settings` の `applied_at`) を `<state dir>/permit-requests.json` (`{ requests: [...] }`、古い順) に持ち、daemon の起動の時に読む。daemon の再起動は版の更新のたびに起き、メモリだけに持つと、許可を待っているセッションの依頼のバブル・🔐・「許可する」が再起動で消える (kawaz 2026-11-08)
- 書き込みは記録・既読・適用で変わるたびに、隣の一時ファイルに書いて rename で置き換える (mode 0600。エージェントが実行を求めたコマンドを含む)。書き込みは直列で、最後の変化が最後に着く。`permit_request` / `permit_request_read` / `permit_permission_apply` はファイルに書いてから答え、daemon の終了は書き終わるのを待ってから lock を放す (次の daemon が読む前に着く)
- ファイルが無ければ空から始める。読めない (JSON でない、記録の形でない) ファイルは空から始めて daemon.log に 1 行書く。書けなかった時も daemon.log に 1 行書き、記録はメモリに持ったまま答える
- 読み戻した記録にも上限を当てる。id は記録の時の daemon の系列 (`<instance id>/<n>`) のままで、次の daemon は新しい系列から振るので重ならない
- 永続化は [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 の「v1 だけの永続状態を増やさない」の例外で、`say-read.json` ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §7) と同じ置き場と書き方

### 5. 配送

- user role の subscriber だけに送る。session には送らない (依頼したセッションは依頼したことを知っており、他のセッションの context を使う理由が無い)
- subscribe の時に全件を `ev:"permit_requests"` で送る (空でも送る。再起動した daemon に繋ぎ直したタブが古い依頼を捨てられるように)。記録した時と既読にした時に、その 1 件だけを `ev:"permit_request"` で送る
- 許可依頼で変わるのは `read` と変更の `applied_at` だけなので、変わった 1 件だけで足りる。webui は全件で置き換え、1 件は同じ id のものと差し替える (無ければ足す)

### 6. 音声

daemon は `permit_request` を記録した時に、say と同じ発声の関数 ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §6) で固定の文「許可を求めています」を読み上げる。許可待ちはエージェントが止まっている状態なので、人が気づく価値がある。

入力に `voice` (例: 「bucket policy の変更の許可をお願いします。」) があれば、固定の文の代わりにそれを読み上げる。何の許可を待っているかを聞いて分かるようにするため。`voice` は日本語で書く (セッションの応答言語が英語でも)。input schema の `voice` に `description: "日本語"` を付けて model に伝える (kawaz 2026-11-06)。`voice` は依頼の一部として `ccmsg sidecar permit` から daemon の記録まで届くが、音声だけのもので webui のバブルには出さない。

- 読み上げるのは依頼があることだけで、`blocked` やコマンドは読まない。中身は markdown やコマンドで、読み上げに向かず、webui で読むもの
- 音声が鳴らせなくても (コマンドが起動できない、失敗した) 依頼は記録されて TL に出ているので、daemon.log に 1 行書くだけで返事は変えない
- daemon が依頼を記録しなかった時 (daemon が無い、断られた) は鳴らさない。見に行っても何も無いため

### 7. webui のバブル

そのセッションの Timeline に、記録の時刻で合流させて出す (読み込み済みの行の間の、その時刻の位置に差し込む)。subagent の Timeline には出さない。外枠 (角丸・余白・送り手の行・時刻の行) は TL の他の吹き出しと同じ部品 (`.tl-bubble` / `.tl-bubble-body` / `.tl-bubble-from` / `.tl-bubble-footer` / `.tl-bubble-time`) をそのまま使い、専用にするのは中身 (止められた行動 / 添付 / 許可してほしいこと / 「許可する」) と見た目だけにする。エージェント間の msg (色の付いた面だけ) とも say (琥珀の札) とも色相でなく明度と形で分ける: 送り手の行を本文の幅いっぱいの帯にして墨 (文字色より 1 段明るい `--gray-11`。依頼が何件も並んでも帯と枠が「許可する」より重くならない明度) で塗り、TL の地より明るい面・同じ墨の枠 2px・影で浮かせ、「許可する」を accent の塗りにする。未読と既読で見た目は変えず、帯のアイコン (未読 🔐 / 既読 🔓) で見分ける。既読になってもバブルは消えない。

```
🔐 許可依頼                       ← 帯 (既読は 🔓)

止められた行動
{blocked を markdown で}

添付                              (無ければ節ごと出さない)
▸ `{path}`                        ← 既定で閉じた <details>。開いた時に §3 で読んで中身を差し込む
    {先頭の 64 KiB だけ (全体 N バイト) / 読めなかった理由}
    {中身を拡張子から推定した言語のコードブロックで}

許可してほしいこと
- {intents の各要素を markdown で}
- 以下コマンドの実行（{description}）
  {command をコードブロック (sh) で}
  [! で実行]                      ← command が 1 行の時だけ (§11)

`.claude/settings.local.json` の修正許可   (project_permissions が無ければ節ごと出さない、§12)
▸ `{settings.local.json のパス}`  ← 既定で閉じた <details>。開いた時に読む (無ければ「(無し)」)
  + {add の rule}                 ← 1 件ずつ diff の色の行
  [✅ 許可する] / [適用済み HH:MM]

[✅ 許可する]                     ← 本文の最後 (吹き出しの中)

{時刻}                            ← 足元の行は他の吹き出しと同じく時刻だけ
```

- 見出しや文言は UI の他の文言と揃えて日本語にする
- 言語は拡張子をコードブロックの言語名として渡し、既存のコードブロックの言語表 (`highlight.ts`) で引く。拡張子の無いファイルは素のテキスト
- 「✅ 許可する」は §8 の文をクリップボードに写す (`useClipboardCopy`、既存のコピーボタンと同じ成功の見え方の時間)。写せたらボタンの文字を「コピーしました」に短く替える。2 つの文字を同じ升目に重ねて幅を広い方に固定し、押した時にボタンの幅が動かないようにする。写せなかった時 (安全でない文脈、権限の拒否) は「コピーできませんでした」と添える
- 写せたら、その依頼が未読なら `permit_request_read` で既読にする (非楽観。daemon が変えた記録を全タブに送る)。写せなかった時は人がまだ何もできていないので未読のまま。既読の専用のボタンは置かない (「許可する」を押すことが、人が依頼に手を付けたことになる)
- 写せたら、そのセッションの入力欄 (FAB のパネル) も開き、textarea にフォーカスする (FAB を押した時と同じ開き方)。写せなかった時は開かない (kawaz 2026-10-28)
- 開く時、textarea が空 (FAB が下書き無しとみなす、空白だけの入力を含む) なら写した文と同じ文を入れる (人の編集と同じく下書きとして保存する)。そのまま送れるようにするため。空でなければ書きかけの入力を変えない (人は写した文を好きな位置に貼る) (kawaz 2026-11-06)
- Sessions 一覧の各行には、未読の許可依頼があれば say の 🔔 の隣 (アイコンと repo 名の間) に 🔐 と件数 (2 件以上の時) を出す。ピン留めした行にも出す

### 8. ボタンが写す文

````
以下ファイルの内容を確認しました。問題無し。
- {path}

以下の操作を許可します。
- {intents の各要素}
- 以下コマンドの実行（{description}）
```
{command}
```
````

- ファイルの段落には、添付のパスを全部、依頼に書かれた順に並べる。人がバブルで開いたか、読めたか (無い、テキストでない等) は問わない。バブルは開いたかを追わない: この文は人が自分の発話として送るもので、中身を確認したかは送る前に人が判断する。添付が無ければ段落ごと書かない
- コマンドは数だけ「- 以下コマンドの実行（{description}）」とコードブロックの組を並べる。`description` が無ければ「- 以下コマンドの実行」だけにする
- classifier が許可を当該操作と結び付けられるように、コマンドは全文をコードブロックに入れる (行末の `\` や here document もそのまま)。フェンスはコマンドの中の最も長いバッククォートの並びより 1 つ長く (最低 3) し、閉じられないようにする

### 9. subagent からの呼び出しは断る

handler は `tool.call` の `agentId` があれば何もせず「permit は subagent からは使えない。止められた操作は委譲元に報告して止まる (委譲元が自分で実行し、止められたら委譲元が permit で許可を求める)」を返す。人の許可は人がセッションに書く発話で、classifier はそれが書かれた会話 (本体) の操作しか通さない。subagent が依頼を出しても、許可を受けて再実行できるのは本体なので、止められた操作は委譲元に渡し、委譲元が自分で実行して止められたら委譲元が依頼する。

### 10. skill

plugin の skill (`skills/ccmsg/SKILL.md`) に `mcp__ccmsg-v1__permit` の節を足す: いつ使うか (classifier に止められた直後、止められた操作を書き換えずに再実行するため)、入力の定型、許可の文を受けたら許可されたコマンドを 1 つずつそのまま実行すること、subagent からは使わないこと。

### 11. 「! で実行」

kawaz 2026-11-06 の裁定: `commands` のうち `command` が 1 行 (改行を含まない) のものに、そのコードブロックの直下に小さいボタン「! で実行」を置く。押すと、依頼したセッションで、人が composer に `! <command>` と打って Enter したのと同じ結果になる (Claude Code の bash mode。コマンドが実行され、出力が会話に入る)。

- 経路は人の入力と同じ op `user_prompt` に `mode: "bash"` を付けたもの ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §3)。module が composer を空にし、自分の端末に `!` を打って bash mode に切り替わるのを待ち、コマンドを入れて Enter を送る。送る先は依頼の `sid`
- bash mode を知らない前の版 (0.217.0 より前) の module のまま動いているセッションでは、module が `mode` を落とし、コマンドは通常の prompt として入る。前の版向けの分岐は置かず、plugin を更新したらセッションを起動し直す ([findings](../findings/2026-11-06-permit-bang-run.md) の 2026-11-08 の節)
- 複数行の command には出さない。kawaz の裁定による UI の範囲で、bash mode が 1 行に限られるからではない (2.1.319 では複数行も実行された。[findings](../findings/2026-11-06-permit-bang-run.md))
- 「許可する」とは独立: 押しても許可の文は写さず、既読にもせず、入力欄も開かない
- 送っている間は押せない (送信中…)。結果の表示は入力欄の送信と同じ語彙: 受け付けられたら押した時刻と「出力はコマンドが終わると Timeline に出ます」を横に添える (`<bash-input>` と出力の行はコマンドが終わってから会話に入るので、長いコマンドでは TL に何も出ない間がある。二度押しの判断材料)。届かなかった・確かめられなかった時は入力欄と同じ注記 (`sessionInputNotice`) を出す
- 実行の結果は webui で別に出さない。会話に入った行が TL に流れる
- ボタンの文字は CSS の `content` で出し、DOM のテキストにしない (コードブロックのコピーボタンと同じ)。コマンドの並びの中にあり、文字を置くと選んでコピーした文字列と Timeline の検索に混ざる。読み上げる名前は `aria-label` が持つ

### 12. プロジェクトの `permissions.allow` を足し引きする (`project_permissions`)

kawaz 2026-11-08 の裁定: 同じ操作がセッションのたびに classifier に止められる時、プロジェクトの `.claude/settings.local.json` の `permissions.allow` に rule を足せるようにする。完全一致形を推奨する (完全一致形の allow は classifier を通らない。classifier-notes の方針)。足すのは人がバブルで 1 件ずつ押した時だけで、エージェントは求めるだけ。

**入力**: `project_permissions?: ({ add: string } | { remove: string })[]`。値は `permissions.allow` の rule の文字列 (`Bash(llm-gateway daemon reload unstable)`、`Edit(/abs/path/file.toml)`)。

- 1 要素は `add` か `remove` のどちらか 1 つ。両方・どちらも無い要素は断る
- rule が完全一致形かは機械的に判定しない。`*` を含んでも通す: `find -name \*.json` のようにコマンドの文字列に `*` を含む完全一致形があり、ワイルドカードの意図かは形から分からない。判断は人がバブルで rule を見てする (kawaz 2026-11-08)
- 空白だけの rule、同じ rule を 2 度名指す依頼 (add と remove に分けても) は断る (1 つの rule にボタンは 1 つ)
- `project_permissions` だけの依頼も受ける (毎回止められる操作の allow を足すことだけを求める依頼)。`intents`・`commands`・`project_permissions` のどれも無い依頼は断る。拒否の文は「ask for at least one of intents and commands, or project_permissions」
- model に見せる input schema は `items` を `{ add: string, remove: string }` の 1 つの object で見せ、required を付けない。object の union は `toolInputSchemaOf` が各候補の field を並べた 1 つの object に畳む (anyOf を見せない。組み合わせは handler のスキーマの細則)。field の説明は `完全一致形を推奨 (完全一致形の allow は classifier を通らない)`

**記録**: daemon は `permit_request` を受けた時に、依頼したセッションの登録の cwd (sidecar begin が名乗る `$.session.root()`、realpath) から `<cwd>/.claude/settings.local.json` を決め、`project_settings: { path, permissions: [{ add | remove, applied_at? }] }` として記録に固定する。人に見せるファイルと書くファイルが同じであるように、後の hello で cwd が変わっても動かさない。セッションの cwd が分からない時は、`project_permissions` のある依頼を `invalid_args` で断る。

**読み取り**: op `permit_settings_read { id }` (user role だけ)。記録が名指すファイルを添付と同じ読み方 (§3、先頭 64 KiB、テキストだけ) で読み、添付と同じ形で返す。webui は無いファイル (`missing`) を「(無し)」と出す。webui の折り畳みは開いている間、開くたびと、記録の `applied_at` が変わった時に読み直す (人もセッションも書き換えるファイルなので、添付と違い読んだものを持ち続けない)。

**書き込み**: op `permit_permission_apply { id, permission: { add } | { remove } }` (user role だけ)。

- 書けるのは、その id の記録にある変更 (add / remove の別と rule が一致するもの) だけを、記録が名指すファイルにだけ。記録に無い rule、add と remove の取り違え、持っていない id は `invalid_args` で断る。任意の文字列を書く口にしない
- ファイルを JSON の object として読む (無ければ `{}`)。`permissions` が object でない、`permissions.allow` が文字列の配列でない、JSON でないものは `settings_unreadable` で断り、書かない
- add は無ければ足し、remove はその rule を消す。どちらも変わらない (既にある add、無い remove) なら書かない (無いファイルも作らない)
- 書き戻しは `permissions.allow` を文字列順 (`Array.prototype.sort` の既定) に並べ、`JSON.stringify(settings, null, 2)` と末尾の改行 1 つ。他のキーは値も位置も保つ (`permissions` の中の `deny` 等も)。無い `permissions` / `allow` は末尾に足す。`.claude/` が無ければ作る
- 書き込みは隣の一時ファイルに書いて rename で置き換える (読み直すセッションに書きかけを見せない)。設定ファイルが symlink なら辿った先を置き換え、symlink は残す
- 同じファイルへの適用は daemon の中で 1 つずつ行う (並んだ 2 件の書き込みが互いを消さない)。daemon の外 (人やセッションの手) の書き込みとの競合は扱わない
- 読み書きの失敗は `settings_write_failed`。成功したら記録のその変更に `applied_at` を付けて記録を既読にし (適用は人が依頼に手を付けたこと。「許可する」と同じ印)、§5 と同じく変わった 1 件を全タブに送る。応答は `{ ok, changed, applied_at }`

**通知**: 書き込みが変えた時、そのセッションへ daemon からの知らせ (`from="ccmsg:daemon"`、DR-0039 §9 の `sendNotice`) で `.claude/settings.local.json` の unified diff (文脈 3 行) を送る。5 秒の debounce で、連続した適用は最後の適用から 5 秒後に 1 通にまとめ、diff は最初の適用前 → 最後の適用後。最初と最後が同じ (足して消した) なら送らない。daemon が止まる時は待っている知らせを捨てる。文は「人が許可依頼の「許可する」で `.claude/settings.local.json` の permissions.allow を書き換えた。すぐ効く (再起動は要らない)。」と ```diff のコードブロック。ファイルは文でも diff の見出し (`---` / `+++`) でもプロジェクトのディレクトリ (セッションの cwd) からの相対で書き、スマホの幅で読める長さにする。

**反映**: 起動中の Claude Code のセッションは `.claude/settings.local.json` の変更を再起動なしで拾う (2.1.319、対話のセッション、`--permission-mode dontAsk`。起動時に `.claude/` が無い状態から作った時、allow を `[]` に戻した時、rename で置き換えた時のどれも、1〜5 秒後の次の tool 呼び出しから効いた。ccmsg の経路 (tool → バブル → 押す → 書き込み → 同じコマンドの再実行) でも通った。[findings](../findings/2026-11-08-settings-local-reload.md))。auto mode で classifier の前に allow が効くことは同じ設定の読み直しに乗るが、auto mode では観測していない。

**webui**: §7 のバブルの「許可してほしいこと」の後、本文の最後の「許可する」の前に「`.claude/settings.local.json` の修正許可」の節を置く。設定ファイルのパスの折り畳みと、変更 1 件ごとにファイル差分と同じ色 (`.tl-diff-add` / `.tl-diff-delete`) の `+ <rule>` / `- <rule>` の行と、その 1 件だけを書く「✅ 許可する」(枠だけのボタン。依頼全体の「許可する」の塗りより軽くして形で分ける)。押している間は「書き込み中…」で押せない。非楽観で、daemon が送り直す記録に `applied_at` が付くとボタンを無効にして「適用済み HH:MM」にする。断られたら理由を横に出し、ボタンは押せるまま。この節の「許可する」は §8 の許可の文を写さず、入力欄も開かない (既読は daemon が適用と一緒に立てる)。`intents` と `commands` の無い依頼 (`project_permissions` だけ) では「許可してほしいこと」の節と本文の最後の「許可する」を出さない (写す操作が無い)。

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| 「! で実行」を `$.prompt.fill` に `! <command>` ごと入れて Enter で起こす | bash mode にならず、通常の prompt として model に送られる (2.1.319 実測) |
| 「! で実行」を module の `$.process.run` で走らせる | 結果が transcript に入らず、人の `!` と同じにならない |
| 「! で実行」の送信を別の op にする | 書きかけの退避・Enter・受け付けの待ち・戻しが人の入力と同じで、違うのは composer への入れ方と受け付けの印だけ。`user_prompt` / `prompt.send` の入力の区別で足りる (DR-0035 §3) |
| rules の定型文を手で書く今の形だけにする | Context の 3 つの弱み (形のぶれ、具体の入れ忘れ、ファイルの中身を貼ると context を食う) が残る |
| ファイルの中身をエージェントが本文に貼る | 中身がエージェントの context に載り、長いファイルほど高くつく。本文の中で許可の対象と説明の境目も曖昧になる |
| 添付を依頼の時に daemon が読んで記録に写す | 依頼の記録と配送が添付の中身 (最大 16 × 64 KiB) を運ぶことになり、人が開かない添付まで読む。中身を人が見るのは開いた時で、その時に読めば足りる |
| 添付の結果 (読めたか、切り詰めたか) を tool の結果で model に返す | 人が開くまで読まないので、依頼の時点で返せるものが無い。model に要るのは依頼が出たことだけ |
| say の記録に許可依頼を混ぜる | 形 (添付・intents・commands、既読の意味) と上限の根拠が違う。say の未読の数 (Sessions の 🔔) に許可依頼が混ざる |
| 記録を daemon のメモリだけに持つ | daemon は版の更新のたびに再起動し、許可を待っているセッションの依頼のバブル・🔐・「許可する」がそのたびに消える。transcript の `permit` の tool_use からは「許可する」と添付の読み取りに要る記録の id が戻らない (§4 の永続化) |
| 上限を全体で数える (例: 全セッションで 50 件) | 許可を求め続ける 1 つのセッション (実例で 52 件) が、他のセッションの記録を押し出す |
| 記録が変わるたびに全件を送る (say と同じ) | 変わるのは `read` だけで、変わった 1 件で足りる |
| バブルを transcript の `permit` の tool_use から描く | 既読と添付の読み取りに daemon の記録 (id) が要り、transcript と突き合わせる経路が増える。say と同じ時刻の合流で足りる |
| webui から任意のパスを読む口 (既存の fs 系 op を広げる) で添付を読む | 読める範囲が依頼の名指しから外れる。DR-0024 の allowlist は transcript から集めた集合で、依頼の添付を足すには集め方を変える必要がある。依頼の記録を照合する専用の op の方が範囲が狭く明確 |
| 許可したかどうかを記録する | 許可の正は人の発話とエージェントの再実行で、webui のボタンを押したことではない (写した文を送らないこともある)。ボタンで立てる `read` は手を付けたかの印に留める |
| 許可の文に、人が開いて読めた添付だけを並べ、未確認の数をボタンの横に添える | 中身を見るまでもないファイル (読み慣れた script 等) が、開かなかったというだけで許可の文から落ちる。確認したかは送る前に人が判断することで、開いたかで文を変えるとその判断を UI が決めることになる |
| 未確認の添付が残っている間は「許可する」を押せなくする | 中身を見るまでもないファイルでも全部開かせることになる |
| 許可依頼専用の外枠 (角丸・余白・時刻行) を組む | TL の他の吹き出しと形がずれる。違うのは中身と面の色だけで、外枠は共通の部品で足りる |
| say と同じ専用の既読ボタンを置く | 「許可する」を押すことが手を付けたことそのもので、ボタンが 2 つあると押す順を迷わせる |
| subagent の依頼もバブルに出す | 許可を受けて再実行できるのは本体だけで、subagent は止まったまま残る (§9) |
| `project_permissions` をエージェント自身が書く (Edit で settings.local.json を直す) | 許可の範囲を広げる書き込みを、止められた側が自分で行うことになる。人が rule を 1 件ずつ見て押す形にする |
| webui から任意の rule を書ける op にする | 書ける範囲が依頼の名指しから外れる。§3 の添付と同じく、記録にある変更だけを照合して書く |
| `*` を含む rule を断る | `find -name \*.json` のようにコマンドの文字列に `*` を含む完全一致形があり、ワイルドカードの意図かは形から分からない。判断は人がバブルで見てする |
| `project_permissions` だけの依頼を断る | 毎回止められる操作の allow を足すことだけを求める依頼は正当で、その時に再実行する操作が無いこともある |
| 適用のたびにすぐ知らせる | 続けて押した数だけセッションに知らせが入り、context を食う。5 秒まとめて最初と最後の差分を 1 通にする |
| 依頼全体の「許可する」で rule もまとめて書く | 許可の文を写すことと設定を書き換えることは別の判断で、rule は 1 件ずつ見て決める |

## Consequences

- 記録は daemon の再起動を越えて残る。`permit-requests.json` と subscribe の全件 (`ev:"permit_requests"`) は全体の上限 (2,000 件) まで大きくなりうる。上限を超えて消えた依頼は transcript の `permit` の tool_use (汎用の tool の行) でしか読めない
- 添付は人が開いた時点の中身で、依頼の時点や実行の時点の中身とは限らない。許可の文はパスを名指すだけで、人が読んだ後にファイルが変わっても示さない。classifier も中身を確かめない
- daemon は依頼したセッションが名指したファイルを、webui を開ける人が開いた時に読んで見せる。同じ uid のエージェントは元からそのファイルを読めて transcript に出せるので、見える範囲は広がらない
- `permit` は permission の判定を通らない tool なので、エージェントはいつでも呼べる。呼んでも権限は変わらず、許可は人の発話でしか生まれない
- TL のバブルの「添付」等の文字と「許可する」「コピーしました」は DOM にあるので、Timeline の検索に当たる (say の「既読」と同じ)
- 「許可する」を押して文を写しても送らなかった場合も既読になり、🔐 は消える。既読は「人が依頼に手を付けた」の印で、許可が届いたことは示さない
- rules の定型文 (classifier に止められた時の尋ね方) は、この tool に合わせて rules 側で追従させる
- `project_permissions` の「許可する」は、人が押した 1 件だけをセッションのプロジェクトの `.claude/settings.local.json` に書く。書いた rule は以後のこのプロジェクトの全セッションで classifier を通らずに通る。消すのは人の手か、`remove` の依頼
- 記録が名指す設定ファイルは、依頼の時に daemon が持つセッションの cwd (起動・`/clear`・`/resume` の時に module が名乗る `$.session.root()`) で決まる。セッションの中の `/cd` は名乗り直さないので追わない (未検証: `/cd` の後に Claude Code が読む設定ファイルがどれか)
- 「! で実行」は人の `! <command>` と同じで、auto mode の classifier を通らずにそのセッションの環境で実行される。コマンドを書いたのはエージェントで、押す前にコマンドを読んで判断するのは人である。会話に入るのはコマンドとその出力で、許可の文は入らない

## 関連

- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 — typed tool の登録の形、handler の流儀、`say` の記録と配送
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 — v1 だけの永続状態を増やさない (§4 の永続化はその例外)
- [DR-0024](./DR-0024-out-of-project-files.md) §3.2 — セッションが名指したパスだけを読む信頼の形
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — 入力と記録をスキーマで読む
