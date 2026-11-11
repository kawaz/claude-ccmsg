# DR-0040: auto mode の classifier に止められたエージェントが人に許可を求める tool `permit`

- Status: Accepted (2026-10-25) — ✅ 実装済み (tool `permit`、`ccmsg sidecar permit`、op `permit_request` / `permit_read` / `permit_attachment_read`、TL の許可依頼バブル、Sessions 一覧の 🔐、skill の節、1 行のコマンドの「! で実行」と、その実行中・実行済みの表示 (§11、`ev:"bash_command_ended"`)、プロジェクトの `.claude/settings.local.json` の `permissions.allow` を 1 件ずつ足し引きする `project_permissions` (§12、op `permit_settings_read` / `permit_permission_apply`)、表示の正本を transcript の `permit` の行にし daemon は人の状態だけを `permit-state.json` に持つ形 (§4、kawaz 2026-11-08))。§6 の音声を鳴らす場所 (daemon が `permit_request` を受けた時) は [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §6 が定める
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
voice:       string                                   # 読み上げる 1 文 (日本語、§6)
```

- 必須は `blocked` と `voice` と、各コマンドの `command`。`intents`・`commands`・`project_permissions` の少なくとも 1 つに 1 つ以上の要素があること (field の組み合わせ) は handler が入口で読む valibot のスキーマが持つ。どの文字列も空白だけにしない
- `attachments` は絶対パス (`/` で始まる) で、同じパスを 2 度書かない。数は 16 まで (バブルと許可の文の 1 行ずつになるので、人が読み切れる数に抑える)
- 配列の field は要素の型ごと、object は field ごとに見せる (`{ type: "array", items: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"] } }`)。配列と object の型は中身の型までで 1 つの型なので、`toolInputSchemaOf` は `items` と `properties` / `required` を同じ規則 (型と enum だけ) で導く。長さや重複の決まりは見せない
- 合わない入力は「permit の入力が形に合わないので何もしていない: <理由>」で返す (DR-0039 §3)

### 2. 経路

module の handler → CLI の transport → daemon の op (音声) → handler の結果 → transcript の `permit` の行と結果の行 → daemon と webui がその行を読む → TL のバブル。

- handler は入力を `PermitToolInputSchema` で読み、`ccmsg sidecar permit --sid <sid>` を `$.process.run` で起こして入力を標準入力に JSON で渡す (コマンドが長く、引数は `ps` で全員に見えるため、`send-message` と同じ)。待ちは 30 秒 (daemon を起こす時の接続の再試行の分)
- `ccmsg sidecar permit` は標準入力を `PermitInputSchema` (知らない field を断る。各コマンドの object も) で読み、session として daemon に op `permit_request` (`{ op, permit }`) を送る。daemon が受けたら daemon の応答を標準出力に出して exit 0。daemon が無ければ exit 3、断られたら断りを標準エラーに出して exit 1 (`send-message` / `launch` と同じ)
- op `permit_request` は session role だけが送れる。daemon がするのは §6 の音声だけで、依頼の中身は持たない。応答は `{ ok: true }`
- handler は daemon が受けた時だけ、結果を `PERMIT_REQUESTED_TEXT` (「許可依頼を出した」、protocol の定数) にする。この結果の行が、その呼び出しが依頼であることの印になる (§4)。添付の中身を人が読めるかは人が開いた時に分かることで、model に返すものは無い
- handler は `next` を呼ばずに答えるので、`permit` 自体は permission の判定 (classifier を含む) を通らない (DR-0039 §3)。止められた直後でも呼べる。`permit` がするのは表示と音声だけで、権限は何も変えない

### 3. 添付の読み取り

- 依頼の時には読まない。依頼 (transcript の行) は添付のパスだけを持つ。人が開かない添付は読まれない
- 人がバブルで添付を開いた時に、webui が op `permit_attachment_read` (`{ sid, tool_use_id, path }`、user role だけ) で daemon に読ませ、返った中身をその折り畳みに差し込む。読めた後は閉じて開き直しても読み直さない。daemon が答えなかった時は、次に開いた時に読み直す
- 読めるのは、そのセッションのその `permit` の呼び出し (§4 の依頼) が名指したパスだけ。依頼に無いパスや、依頼でない呼び出し・知らない id は断る。daemon がまだそのセッションの依頼を読んでいなければ、その場で transcript を読んで探す (§4 の全走査)。信頼の形は [DR-0024](./DR-0024-out-of-project-files.md) §3.2 の allowlist と同じで、「セッション自身が名指したパスを、名指された分だけ」読む。人 (user role) が任意のパスを読めるようにはならない
- パスはそのまま開く (symlink は辿る)。通常のファイルだけを読み、先頭の 64 KiB (`PERMIT_ATTACHMENT_MAX_BYTES`) までを返す。長いファイルは先頭だけを返し、全体のバイト数と切り詰めた印を添える。上限で切れた多バイト文字は捨てる
- 中身は UTF-8 のテキストとして読む。NUL を含む、または UTF-8 に無いバイト列を含むものは「テキストでない」として中身を返さない
- 読めない時は理由を返す: `missing` (無い)、`not_a_file` (ディレクトリ等)、`denied` (権限が無い)、`not_text`、`failed` (その他)。webui は同じ文言 (`PERMIT_ATTACHMENT_UNREADABLE_TEXT`) で出す

### 4. 依頼の正本と人の状態

kawaz 2026-11-08 の裁定: 依頼の中身を daemon に貯めない (ゴミが貯まる)。say ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §7) と同じく、**表示の正本は transcript の `permit` の tool_use の行**で、daemon は人の状態だけを持つ。

**依頼**: セッションの transcript の assistant 行の tool_use `mcp__ccmsg-v1__permit` のうち、その tool_result が `PERMIT_REQUESTED_TEXT` (エラーでない) のもの。

- 依頼の中身は tool_use の `input` (blocked / attachments / intents / commands / project_permissions)。無い list は空として読み、`voice` は読まない (音声だけのもの)。入力は形を緩く読む (結果の行が handler の検査を通ったことを示すので、版の違う入力も読める)
- 結果が別の文の呼び出しは依頼でない: subagent / teammate の呼び出し (§9 で module が断る)、形の合わない入力、daemon が無い・断った時。結果の行がまだ無い呼び出しも、結果が書かれるまで依頼でない
- 依頼は tool_use の id (`tool_use_id`) で指す。transcript にあるぶん全部が依頼で、daemon の再起動と無関係に過去の分も出る
- main の transcript の sidechain の行は main の依頼でない。subagent / teammate の transcript (`<sid>/subagents/agent-*.jsonl`、workflow の agent) の呼び出しも同じ規則で読む (§9 により結果は断りなので、依頼にはならない)
- 結果の文の照合は protocol の純関数 (`ccmsgPermitCall`、`permitRequested`) に置き、daemon と webui が同じものを使う

**daemon が依頼を見つける経路** (say と同じ、DR-0045 §7 / [DR-0050](./DR-0050-timeline-notification-badges.md) §5):

- live のセッション: relay の fold (追いつきと push の読み) が main の行を読み、呼び出しを結果の行まで持ってから依頼にする
- live でないセッション: TL を開いた時の status の一回読みで同じく読む。live になると fold が引き継ぐ (二重に数えない)
- 全走査: op `notification_list` (§5) を初めて聞かれたセッションは、main と agent の transcript を頭から読む (say と同じ 1 回の読みで両方を拾う)。以後は fold の行で増え、読み直さない
- 見つけた依頼はメモリに持つ (fold はセッションが live の間、全走査の分は daemon が止まるまで)。ファイルには書かない

**daemon が持つ人の状態** (`<state dir>/permit-state.json`、`{ since, read, granted, applied }`。`read` / `granted` は依頼を持つセッションの sid ごとの id、`applied` の各要素も `sid` を持つ):

- `read`: 人が手を付けた依頼の `tool_use_id`。`granted`: 人が「許可する」で許可の文を写した依頼の `tool_use_id` (`read` にも入る)。op `permit_read` (`{ ids, granted? }`、user role だけ) が渡した id を既読にし、`granted` があれば許可済みにもする (既読の依頼にも後から立てる)。daemon の知らない id が 1 つでもあれば、どれも既読にせずに断る。二度目は何も変えない。どちらも一度立てたら戻さない
- `since`: これより前の依頼は手を付けたものとみなす。ファイルが無い・読めない時は今から始める (古い依頼で 🔐 が溢れない)
- `applied`: 人が適用した `project_permissions` (`{ tool_use_id, permission: { add } | { remove }, applied_at }`、§12)。適用はその依頼の既読も立てる
- 未読の依頼 = daemon が見つけた依頼のうち、`read` に無く `since` 以後のもの。同じ id は 1 件
- 書き込みは変わるたびに隣の一時ファイルに書いて rename で置き換える (mode 0600)。書き込みは直列で、`permit_read` / `permit_permission_apply` はファイルに書いてから答える。daemon の終了は書き終わるのを待ってから lock を放す。書けなかった時は daemon.log に 1 行書き、状態はメモリに持ったまま答える
- `read`・`granted`・`applied` は依頼の数だけ増える (1 件数十 byte)。daemon の起動の時に、live でないセッション (`claude agents --json` の一覧にプロセスが居ない sid) の分を落とす。一覧が 1 件も返さない時は何も落とさない (DR-0045 §7 の `say-read.json` と同じ)。依頼を daemon に記録していた頃の `<state dir>/permit-requests.json` は、起動の時に消す (kawaz 2026-11-08)
- 永続化は [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 の「v1 だけの永続状態を増やさない」の例外で、`say-read.json` (DR-0045 §7) と同じ理由 (依頼は再起動を越える transcript から描くので、状態をメモリだけに持つと再起動のたびに過去の依頼が全部未読に戻り、適用済みが消える)。依頼の中身は持たない

### 5. 配送と一覧

- 人の状態は user role の subscriber だけに `ev:"permit_state"` `{ unread: [{ session_id, tool_use_id, ts }], granted: [tool_use_id], applied: [...] }` で送る。subscribe の時に全件 (空でも。再起動した daemon に繋ぎ直したタブが古い状態を捨てられるように)、変わるたびに全件。session には送らない (依頼したセッションは依頼したことを知っており、他のセッションの context を使う理由が無い)。daemon の終了の途中では送らない (fold を閉じて空になった未読を配らない)
- 依頼の中身は送らない。webui は窓の中の依頼を transcript の行から描く (§7)
- op `notification_list { sid }` (user role だけ、DR-0050 §5) はそのセッションの全 say と全依頼 (既読も含む) を時刻順に返す。依頼は `{ tool_use_id, ts, cwd, permit, agent_id? }` (`cwd` は呼び出しの行の cwd、`permit` は読める形に整えた入力)

### 6. 音声

daemon は `permit_request` を受けた時に、say と同じ発声の関数 ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §6) で固定の文「許可を求めています」を読み上げる。許可待ちはエージェントが止まっている状態なので、人が気づく価値がある。

tool の入力の `voice` (例: 「bucket policy の変更の許可をお願いします。」) は必須で、固定の文の代わりにそれを読み上げる。voice が無いと「許可を求めています」が連続して鬱陶しいので、依頼ごとに内容の分かる 1 文を読ませる。無い入力は `voice (読み上げる 1 文、日本語) が要る` の形で tool が断る (kawaz 2026-11-08)。`ccmsg sidecar permit` と daemon は voice の無い依頼も受け、その時は固定の文を読むフォールバックとする。`voice` は日本語で書く (セッションの応答言語が英語でも)。input schema の `voice` に `description: "日本語"` を付けて model に伝える (kawaz 2026-11-06)。`voice` は依頼の一部として `ccmsg sidecar permit` から daemon まで届くが、音声だけのもので webui のバブルには出さない。

- 読み上げるのは依頼があることだけで、`blocked` やコマンドは読まない。中身は markdown やコマンドで、読み上げに向かず、webui で読むもの
- 音声が鳴らせなくても (コマンドが起動できない、失敗した) 依頼は TL に出るので、daemon.log に 1 行書くだけで返事は変えない
- daemon が依頼を受けなかった時 (daemon が無い、断られた) は鳴らさない。その呼び出しの結果は依頼の印にならず (§4)、見に行っても何も無いため

### 7. webui のバブル

そのセッションの Timeline に、依頼の `permit` の呼び出しの行の位置で境界のバブルとして出す (say のバブルと同じ。行の uuid で選べる)。呼び出しの行が窓にあり、その結果の行が依頼の印になった時に出る (live では結果の行が届いた時)。読み込み済みの範囲 (窓) の外の依頼は、🔐 のフィルタの間だけ `notification_list` の答えから時刻の位置に合流させて出す (位置を持たず、フィルタを外すと消える。DR-0050 §5)。subagent の Timeline の呼び出しは §9 で断られているので出ない。外枠 (角丸・余白・送り手の行・時刻の行) は TL の他の吹き出しと同じ部品 (`.tl-bubble` / `.tl-bubble-body` / `.tl-bubble-from` / `.tl-bubble-footer` / `.tl-bubble-time`) をそのまま使い、専用にするのは中身 (止められた行動 / 添付 / 許可してほしいこと / 「許可する」) と見た目だけにする。エージェント間の msg (色の付いた面だけ) とも say (琥珀の札) とも色相でなく明度と形で分ける: 送り手の行を本文の幅いっぱいの帯にして墨 (文字色より 1 段明るい `--gray-11`。依頼が何件も並んでも帯と枠が「許可する」より重くならない明度) で塗り、TL の地より明るい面・同じ墨の枠 2px・影で浮かせ、「許可する」を accent の塗りにする。未読と既読で見た目は変えず、帯のアイコン (未読 🔐 / 既読 🔓) で見分ける。既読になってもバブルは消えない。

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
  [! で実行] / [実行中…] / [実行済み]   ← command が 1 行の時だけ (§11)

`.claude/settings.local.json` の修正許可   (project_permissions が無ければ節ごと出さない、§12)
▸ `{settings.local.json のパス}`  ← 既定で閉じた <details>。開いた時に読む (無ければ「(無し)」)
  + {add の rule}                 ← 1 件ずつ diff の色の行
  [✅ 許可する] / [適用済み HH:MM]

                 [既読] [✅ 許可する]  ← 本文の最後の行の右端 (吹き出しの中)

{時刻}                            ← 足元の行は他の吹き出しと同じく時刻だけ
```

- 見出しや文言は UI の他の文言と揃えて日本語にする
- 言語は拡張子をコードブロックの言語名として渡し、既存のコードブロックの言語表 (`highlight.ts`) で引く。拡張子の無いファイルは素のテキスト
- 「✅ 許可する」は §8 の文をクリップボードに写す (`useClipboardCopy`、既存のコピーボタンと同じ成功の見え方の時間)。写せたらボタンの文字を「コピーしました」に短く替える。2 つの文字を同じ升目に重ねて幅を広い方に固定し、押した時にボタンの幅が動かないようにする。写せなかった時 (安全でない文脈、権限の拒否) は「コピーできませんでした」と添える
- 写せたら、その依頼がまだ許可済みでなければ `permit_read` (`granted`) で許可済み (既読でもある) にする (非楽観。daemon が新しい `ev:"permit_state"` を全タブに送る)。写せなかった時は人がまだ何もできていないので変えない
- 全体の「許可する」と「既読」の見た目で、依頼が今どの状態かを一目で分ける (kawaz 2026-11-08)。状態は daemon の状態 (§4、`ev:"permit_state"`) から描くので、読み直したタブ・別のタブでも同じ

  | 状態 | daemon の状態 | 「既読」 | 全体の「許可する」 |
  |---|---|---|---|
  | 未操作 | 未読 | 「既読」、押せる | accent の塗りの「✅ 許可する」 |
  | 既読 (無視) | `read`、`granted` に無い | 「既読済み」、押せない | 塗りの「✅ 許可する」のまま押せる (押すと許可済み) |
  | 許可済み | `granted` | 「既読済み」、押せない | 塗りを外した枠だけの「許可済み」。押せばもう一度写す (状態は変わらない) |

  `project_permissions` の「許可する」(§12) での適用は `read` だけを立てるので、既読 (無視) と同じ見た目になる (全体の許可の文はまだ写していない)。「許可する」の 3 つの文字 (許可する / 許可済み / コピーしました) は同じ升目に重ね、ボタンの幅を一番広いものに固定する
- 依頼全体の「許可する」は本文の最後の行の右端に置く。個別のボタン (「! で実行」(§11)、`project_permissions` の「許可する」(§12)) は左に並ぶので、一番下の個別のボタンを押そうとして全体の「許可する」を押し違えない位置にする (kawaz 2026-11-08)
- 全体の「許可する」の左に「既読」を置く。許可の文を写さず、入力欄も開かずに、`permit_read` で依頼を既読にする (非楽観)。許可はしないが Sessions 一覧の 🔐 の数から外したい (人が依頼に手を付けた) 時のため。枠だけのボタンにして、全体の「許可する」の塗りより弱く見せる。既読の依頼では押せない。既読にできなかった・写せなかった理由はボタンの左に出す (kawaz 2026-11-08)
- 🔐 のフィルタ ([DR-0050](./DR-0050-timeline-notification-badges.md) §4) の末尾の「全て既読」は、そのフィルタに出ている未読の依頼 (窓の外から合流させた依頼も含む) を、`permit_read` に id の列を渡して全部既読にする。`granted` は付けない (許可はしない。各依頼は既読 (無視) の見た目になる)。非楽観で、daemon が新しい `ev:"permit_state"` を全タブに送る。未読の依頼が 1 件も無い時は出さない。既読にできなかった理由は TL の既読の失敗の 1 行 (`tl-say-error`) に出し、次に成功するまで残す (kawaz 2026-11-11)
- 写せたら、そのセッションの入力欄 (FAB のパネル) も開き、textarea にフォーカスする (FAB を押した時と同じ開き方)。写せなかった時は開かない (kawaz 2026-10-28)
- 開く時、textarea が空 (FAB が下書き無しとみなす、空白だけの入力を含む) なら写した文と同じ文を入れる (人の編集と同じく下書きとして保存する)。そのまま送れるようにするため。空でなければ書きかけの入力を変えない (人は写した文を好きな位置に貼る) (kawaz 2026-11-06)
- 未読かどうかは `ev:"permit_state"` の `unread` に居るか。Sessions 一覧の各行には、未読の許可依頼があれば say の 🔔 の隣 (アイコンと repo 名の間) に 🔐 と件数 (2 件以上の時) を出す。ピン留めした行にも出す

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
- 押してからコマンドが終わるまで「実行中…」で押せない (kawaz 2026-11-08)。`<bash-input>` と出力の行はコマンドが終わってから会話に入るので、長いコマンドでは TL に何も出ない間があり、その間の二度押しを防ぐ
- 終わりは、依頼したセッションの module が push する `<bash-input>{command}</bash-input>` の user 行 (DR-0045 §2) で知る。daemon は push で受けた新しい行 (追いつきで読んだ行の再 push と、subagent / teammate の行を除く) のコマンドを、user role の購読者に `ev:"bash_command_ended" { sid, command }` で送る。webui はそのセッションで実行中の「! で実行」のうち、コマンドが行のコマンドと同じもの (Claude Code が落とす末尾の空白だけを除いて一致) を「実行済み」にする
- 成功か失敗かは出さない (kawaz 2026-11-08): 2.1.319 の bash mode の行 (`<bash-input>` の行と `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` の行) は終了コードを持たず、`false`・`exit 3`・`sh -c 'exit 3'` の行は成功したコマンドの行と同じ形だった ([findings](../findings/2026-11-06-permit-bang-run.md) の 2026-11-08 の節)。`<bash-stderr>` の中身は終了コードの代わりにしない (成功しても stderr に書くコマンド、失敗しても何も書かないコマンドがある)。出力は会話に入った行が TL に流れる
- 「実行済み」を押すと「! で実行」に戻り、もう一度押せばまた実行する (失敗したコマンドをやり直す時のため。kawaz 2026-11-08)。戻すのはそのボタンの表示だけで、store の実行済みは消さない。バブルが描き直された時 (TL の作り直し、タブの移動) は「実行済み」に戻る
- 受け付けられなかった・確かめられなかった時は「! で実行」に戻し、入力欄と同じ注記 (`sessionInputNotice`) を出す。返事より先に行が届いた時 (短いコマンド) は「実行済み」にし、後の返事では戻さない (同じコマンドが終わった行がある)。戻した後に届いた行では実行済みにしない
- 実行中・実行済みは webui のタブの store に、依頼 (`permit` の呼び出しの tool_use の id) とコマンドの位置ごとに持つ。バブルが描き直されても残る。daemon には持たないので、別のタブと読み直したタブでは「! で実行」に戻る
- 行はどの押下のものかを持たないので、同じセッションで同じ文字列のコマンドを並べて実行中にした時 (同じ依頼の中でも別の依頼でも)、1 つの行で全部が「実行済み」になる。人が composer で同じコマンドを `!` で打った時も、実行中のボタンは「実行済み」になる
- 行が来なければ「実行中…」のまま: 実行中に端末で Escape で止めた時 (コマンドは composer に戻り、`<bash-input>` の行は書かれない)、push が daemon に届かなかった時。タブを読み直すと戻る
- ボタンの文字は CSS の `content` で出し、DOM のテキストにしない (コードブロックのコピーボタンと同じ)。コマンドの並びの中にあり、文字を置くと選んでコピーした文字列と Timeline の検索に混ざる。読み上げる名前は `aria-label` が持つ

### 12. プロジェクトの `permissions.allow` を足し引きする (`project_permissions`)

kawaz 2026-11-08 の裁定: 同じ操作がセッションのたびに classifier に止められる時、プロジェクトの `.claude/settings.local.json` の `permissions.allow` に rule を足せるようにする。完全一致形を推奨する (完全一致形の allow は classifier を通らない。classifier-notes の方針)。足すのは人がバブルで 1 件ずつ押した時だけで、エージェントは求めるだけ。

**入力**: `project_permissions?: ({ add: string } | { remove: string })[]`。値は `permissions.allow` の rule の文字列 (`Bash(llm-gateway daemon reload unstable)`、`Edit(/abs/path/file.toml)`)。

- 1 要素は `add` か `remove` のどちらか 1 つ。両方・どちらも無い要素は断る
- rule が完全一致形かは機械的に判定しない。`*` を含んでも通す: `find -name \*.json` のようにコマンドの文字列に `*` を含む完全一致形があり、ワイルドカードの意図かは形から分からない。判断は人がバブルで rule を見てする (kawaz 2026-11-08)
- `Edit` / `Read` / `Write` の rule の path が `~/` で始まるもの (`/^(Edit|Read|Write)\(~\//`) は断る。`permissions.allow` は `~` を展開せず効かないため。tool は「`~/` は permissions.allow では効かない。絶対パスで書く (例 `Edit(/abs/path/foo/bar.toml)`)」を返し、依頼は出さない。同じ検査を daemon の `permit_permission_apply` の入力も通る (protocol の rule のスキーマ 1 つ。`Bash(ls ~/x)` のようなコマンドの中の `~/` は対象外) (kawaz 2026-11-08)
- 空白だけの rule、同じ rule を 2 度名指す依頼 (add と remove に分けても) は断る (1 つの rule にボタンは 1 つ)
- `project_permissions` だけの依頼も受ける (毎回止められる操作の allow を足すことだけを求める依頼)。`intents`・`commands`・`project_permissions` のどれも無い依頼は断る。拒否の文は「ask for at least one of intents and commands, or project_permissions」
- model に見せる input schema は `items` を `{ add: string, remove: string }` の 1 つの object で見せ、required を付けない。object の union は `toolInputSchemaOf` が各候補の field を並べた 1 つの object に畳む (anyOf を見せない。組み合わせは handler のスキーマの細則)。field の説明は `完全一致形を推奨 (完全一致形の allow は classifier を通らない)`

**設定ファイル**: 依頼の `permit` の呼び出しの行の `cwd` の `.claude/settings.local.json`。行は transcript にあって変わらないので、人に見せるファイルと書くファイルは、daemon の再起動やセッションが live でなくなった後も同じになる。webui は `<cwd>/.claude/settings.local.json` を折り畳みの見出しに出す。

**読み取り**: op `permit_settings_read { sid, tool_use_id }` (user role だけ)。依頼の設定ファイルを添付と同じ読み方 (§3、先頭 64 KiB、テキストだけ) で読み、添付と同じ形で返す。webui は無いファイル (`missing`) を「(無し)」と出す。webui の折り畳みは開いている間、開くたびと、その依頼の適用 (`ev:"permit_state"` の `applied`) が変わった時に読み直す (人もセッションも書き換えるファイルなので、添付と違い読んだものを持ち続けない)。

**書き込み**: op `permit_permission_apply { sid, tool_use_id, permission: { add } | { remove } }` (user role だけ)。

- 書けるのは、その依頼の行の `project_permissions` にある変更 (add / remove の別と rule が一致するもの) だけを、その依頼の設定ファイルにだけ。行に無い rule、add と remove の取り違え、依頼でない呼び出し・知らない id は `invalid_args` で断る。任意の文字列を書く口にしない
- ファイルを JSON の object として読む (無ければ `{}`)。`permissions` が object でない、`permissions.allow` が文字列の配列でない、JSON でないものは `settings_unreadable` で断り、書かない
- add は無ければ足し、remove はその rule を消す。どちらも変わらない (既にある add、無い remove) なら書かない (無いファイルも作らない)
- 書き戻しは `permissions.allow` を文字列順 (`Array.prototype.sort` の既定) に並べ、`JSON.stringify(settings, null, 2)` と末尾の改行 1 つ。他のキーは値も位置も保つ (`permissions` の中の `deny` 等も)。無い `permissions` / `allow` は末尾に足す。`.claude/` が無ければ作る
- 書き込みは隣の一時ファイルに書いて rename で置き換える (読み直すセッションに書きかけを見せない)。設定ファイルが symlink なら辿った先を置き換え、symlink は残す
- 同じファイルへの適用は daemon の中で 1 つずつ行う (並んだ 2 件の書き込みが互いを消さない)。daemon の外 (人やセッションの手) の書き込みとの競合は扱わない
- 読み書きの失敗は `settings_write_failed`。成功したらその変更の適用 (§4 の `applied`) と依頼の既読を立てて (適用は人が依頼に手を付けたこと。「許可する」と同じ印) ファイルに書き、§5 の `ev:"permit_state"` を全タブに送る。応答は `{ ok, changed, applied_at }`

**通知**: 書き込みが変えた時、そのセッションへ daemon からの知らせ (`from="ccmsg:daemon"`、DR-0039 §9 の `sendNotice`) で `.claude/settings.local.json` の unified diff (文脈 3 行) を送る。5 秒の debounce で、連続した適用は最後の適用から 5 秒後に 1 通にまとめ、diff は最初の適用前 → 最後の適用後。最初と最後が同じ (足して消した) なら送らない。daemon が止まる時は待っている知らせを捨てる。文は固定の英文 1 文 `.claude/settings.local.json was updated; it takes effect immediately.` と、その下の ```diff のコードブロック (kawaz 2026-11-08)。ファイルは diff の見出し (`---` / `+++`) でプロジェクトのディレクトリ (セッションの cwd) からの相対で書き、スマホの幅で読める長さにする。

**反映**: 起動中の Claude Code のセッションは `.claude/settings.local.json` の変更を再起動なしで拾う (2.1.319、対話のセッション、`--permission-mode dontAsk`。起動時に `.claude/` が無い状態から作った時、allow を `[]` に戻した時、rename で置き換えた時のどれも、1〜5 秒後の次の tool 呼び出しから効いた。ccmsg の経路 (tool → バブル → 押す → 書き込み → 同じコマンドの再実行) でも通った。[findings](../findings/2026-11-08-settings-local-reload.md))。auto mode で classifier の前に allow が効くことは同じ設定の読み直しに乗るが、auto mode では観測していない。

**webui**: §7 のバブルの「許可してほしいこと」の後、本文の最後の「許可する」の前に「`.claude/settings.local.json` の修正許可」の節を置く。設定ファイルのパスの折り畳みと、変更 1 件ごとにファイル差分と同じ色 (`.tl-diff-add` / `.tl-diff-delete`) の `+ <rule>` / `- <rule>` の行と、その 1 件だけを書く「✅ 許可する」(枠だけのボタン。依頼全体の「許可する」の塗りより軽くして形で分ける)。押している間は「書き込み中…」で押せない。非楽観で、daemon が送る `ev:"permit_state"` の `applied` にその変更が載るとボタンを無効にして「適用済み HH:MM」にする。断られたら理由を横に出し、ボタンは押せるまま。この節の「許可する」は §8 の許可の文を写さず、入力欄も開かない (既読は daemon が適用と一緒に立てる)。`intents` と `commands` の無い依頼 (`project_permissions` だけ) では「許可してほしいこと」の節と本文の最後の「許可する」を出さない (写す操作が無い)。本文の最後の行には「既読」だけを出す (どの rule も足さずに依頼を既読にできる)。

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| 「! で実行」を `$.prompt.fill` に `! <command>` ごと入れて Enter で起こす | bash mode にならず、通常の prompt として model に送られる (2.1.319 実測) |
| 「! で実行」を module の `$.process.run` で走らせる | 結果が transcript に入らず、人の `!` と同じにならない |
| 「! で実行」の成功 / 失敗を `<bash-stderr>` の有無で出す | 終了コードではない。成功しても stderr に書くコマンド、失敗しても何も書かないコマンド (`false`) がある |
| 「! で実行」の終わりを、webui が開いている TL の行 (transcript の購読) で知る | 行が届く時にそのセッションの TL を購読していないタブ (別のセッションを見ている) は終わりを知れない。daemon は push で全セッションの行を受けている |
| 「! で実行」の実行済みを daemon の状態 (各コマンドの `ran_at`) に持つ | `user_prompt` はどの依頼のどのコマンドかを持たず、結び付けるには送信を別の op にすることになる (下の行)。得られるのは読み直したタブでの持続だけ |
| 「! で実行」の送信を別の op にする | 書きかけの退避・Enter・受け付けの待ち・戻しが人の入力と同じで、違うのは composer への入れ方と受け付けの印だけ。`user_prompt` / `prompt.send` の入力の区別で足りる (DR-0035 §3) |
| rules の定型文を手で書く今の形だけにする | Context の 3 つの弱み (形のぶれ、具体の入れ忘れ、ファイルの中身を貼ると context を食う) が残る |
| ファイルの中身をエージェントが本文に貼る | 中身がエージェントの context に載り、長いファイルほど高くつく。本文の中で許可の対象と説明の境目も曖昧になる |
| 添付を依頼の時に daemon が読んで持つ | 依頼の配送が添付の中身 (最大 16 × 64 KiB) を運ぶことになり、人が開かない添付まで読む。中身を人が見るのは開いた時で、その時に読めば足りる |
| 添付の結果 (読めたか、切り詰めたか) を tool の結果で model に返す | 人が開くまで読まないので、依頼の時点で返せるものが無い。model に要るのは依頼が出たことだけ |
| say の未読に許可依頼を混ぜる (同じ既読の集合・同じ event) | 既読の意味 (say は読んだ、依頼は手を付けた) と、依頼だけが持つ状態 (適用) が違う。say の未読の数 (Sessions の 🔔) に許可依頼が混ざる。見つける経路 (fold / 一回読み / 全走査) と全走査の 1 回の読みは共有する |
| daemon が依頼の記録 (中身・既読・適用) を `permit-requests.json` に永続化し、記録から描く | 依頼の中身は transcript にもあり、二重に持つ記録が貯まり続ける (上限と刈り込みの規則が要る)。上限で消えた依頼は transcript にあっても出なくなる。transcript の `permit` の行と tool_use の id で、表示と既読と適用の照合は足りる (kawaz 2026-11-08) |
| 依頼の記録を daemon のメモリだけに持つ | daemon は版の更新のたびに再起動し、依頼のバブル・🔐・「許可する」がそのたびに消える |
| 依頼かどうかを tool_use の有無だけで決める (結果を見ない) | subagent の呼び出し (module が断る) と、形が合わない・daemon が無い呼び出しも依頼として出る。許可を受けて再実行できない、または人に何も知らされていない呼び出しがバブルになる |
| `permit_request` に tool_use の id を載せ、daemon がその id を依頼として記録する | 依頼かどうかを daemon の記録が決めることになり、記録を持たない経路 (live でないセッション、再起動の後、webui の窓の中の行) と規則が分かれる。結果の行を印にすれば、daemon と webui が transcript だけから同じ規則で決められる |
| 設定ファイルを依頼の時のセッションの登録の cwd から決めて daemon が持つ | 依頼ごとの状態を daemon に持つことになり、live でないセッション・再起動の後に分からなくなる。行の `cwd` は transcript にあって変わらない |
| webui から任意のパスを読む口 (既存の fs 系 op を広げる) で添付を読む | 読める範囲が依頼の名指しから外れる。DR-0024 の allowlist は transcript から集めた集合で、依頼の添付を足すには集め方を変える必要がある。依頼を照合する専用の op の方が範囲が狭く明確 |
| 許可が届いたかを daemon が持つ | 許可の正は人の発話とエージェントの再実行で、webui のボタンを押したことではない (写した文を送らないこともある)。`granted` は「許可する」で写したことの印に留め、届いたことは示さない |
| 許可済みをタブのメモリだけに持つ | 読み直すと未操作と見分けがつかなくなる。既読と同じく daemon の状態に持てば、どのタブでも同じ状態が出る |
| 許可の文に、人が開いて読めた添付だけを並べ、未確認の数をボタンの横に添える | 中身を見るまでもないファイル (読み慣れた script 等) が、開かなかったというだけで許可の文から落ちる。確認したかは送る前に人が判断することで、開いたかで文を変えるとその判断を UI が決めることになる |
| 未確認の添付が残っている間は「許可する」を押せなくする | 中身を見るまでもないファイルでも全部開かせることになる |
| 許可依頼専用の外枠 (角丸・余白・時刻行) を組む | TL の他の吹き出しと形がずれる。違うのは中身と面の色だけで、外枠は共通の部品で足りる |
| 依頼全体の「許可する」を本文の最後の行の左端に置く | 個別のボタン (「! で実行」、`project_permissions` の「許可する」) も左に並び、一番下の個別のボタンを押そうとして全体の「許可する」を押し違える |
| 既読を「許可する」を押すことだけにする | 許可はしないが 🔐 の数から外したい依頼 (別の手段で片付いた、許可しないと決めた) を既読にする手段が無い |
| subagent の依頼もバブルに出す | 許可を受けて再実行できるのは本体だけで、subagent は止まったまま残る (§9) |
| `project_permissions` をエージェント自身が書く (Edit で settings.local.json を直す) | 許可の範囲を広げる書き込みを、止められた側が自分で行うことになる。人が rule を 1 件ずつ見て押す形にする |
| webui から任意の rule を書ける op にする | 書ける範囲が依頼の名指しから外れる。§3 の添付と同じく、依頼の行にある変更だけを照合して書く |
| `*` を含む rule を断る | `find -name \*.json` のようにコマンドの文字列に `*` を含む完全一致形があり、ワイルドカードの意図かは形から分からない。判断は人がバブルで見てする |
| `project_permissions` だけの依頼を断る | 毎回止められる操作の allow を足すことだけを求める依頼は正当で、その時に再実行する操作が無いこともある |
| 適用のたびにすぐ知らせる | 続けて押した数だけセッションに知らせが入り、context を食う。5 秒まとめて最初と最後の差分を 1 通にする |
| 依頼全体の「許可する」で rule もまとめて書く | 許可の文を写すことと設定を書き換えることは別の判断で、rule は 1 件ずつ見て決める |

## Consequences

- 依頼は transcript にあるぶん全部が出る。daemon は依頼の中身を持たず、`permit-state.json` は既読と適用の id だけで増え、daemon の起動の時に live でないセッションの分は落ちる。その後に resume したセッションの依頼は、`since` 以後のものが未読に戻る
- 🔐 の未読の数は、daemon がそのセッションの transcript を読んだ後に入る: live のセッションは追いつきの後、live でないセッションは TL を開いた時 (一回読み) か 🔐 / 🔔 のフィルタに入った時 (全走査)。読む前は数えない
- 窓の外の依頼は 🔐 のフィルタの間だけ出る。フィルタの無い TL では、過去分を読み込んで窓に入れると行の位置に出る
- `permit-state.json` の無い初回の daemon は、その時より前の依頼を手を付けたものとみなす
- 旧版の module のまま動いているセッションは、`permit_request` の応答 (`{ ok }`) を旧い形で読めず、依頼が出なかったと model に返す。その呼び出しの結果は依頼の印にならないのでバブルに出ない (音声は鳴る)。PROTOCOL_VERSION の minor の違いでセッションに印が付き、セッションを起動し直すと直る
- 依頼の行の `cwd` は、セッションが worktree に入った後 (EnterWorktree) は worktree を指す。その時に Claude Code が読む `.claude/settings.local.json` が worktree のものかは未検証
- 添付は人が開いた時点の中身で、依頼の時点や実行の時点の中身とは限らない。許可の文はパスを名指すだけで、人が読んだ後にファイルが変わっても示さない。classifier も中身を確かめない
- daemon は依頼したセッションが名指したファイルを、webui を開ける人が開いた時に読んで見せる。同じ uid のエージェントは元からそのファイルを読めて transcript に出せるので、見える範囲は広がらない
- `permit` は permission の判定を通らない tool なので、エージェントはいつでも呼べる。呼んでも権限は変わらず、許可は人の発話でしか生まれない
- TL のバブルの「添付」等の文字と「許可する」「許可済み」「コピーしました」「既読」「既読済み」は DOM にあるので、Timeline の検索に当たる (say の「既読」と同じ)
- 「許可する」を押して文を写しても送らなかった場合も許可済み (既読) になり、🔐 は消える。許可済みは「人が許可の文を写した」の印で、許可が届いたことは示さない
- rules の定型文 (classifier に止められた時の尋ね方) は、この tool に合わせて rules 側で追従させる
- `project_permissions` の「許可する」は、人が押した 1 件だけを依頼の行の cwd の `.claude/settings.local.json` に書く。書いた rule は以後のこのプロジェクトの全セッションで classifier を通らずに通る。消すのは人の手か、`remove` の依頼
- `ev:"bash_command_ended"` は、人が composer で打った `!` を含む全セッションの bash mode のコマンドを user role の購読者に送る。webui を開ける人は元から transcript を読めるので、見える範囲は広がらない
- 「! で実行」は人の `! <command>` と同じで、auto mode の classifier を通らずにそのセッションの環境で実行される。コマンドを書いたのはエージェントで、押す前にコマンドを読んで判断するのは人である。会話に入るのはコマンドとその出力で、許可の文は入らない

## 関連

- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 — typed tool の登録の形、handler の流儀、`say` の記録と配送
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 — v1 だけの永続状態を増やさない (§4 の人の状態の永続化はその例外)
- [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §7 — say を transcript の行から描き、既読だけを daemon が持つ形 (§4 はこれに揃える)
- [DR-0050](./DR-0050-timeline-notification-badges.md) §5 — 🔐 のフィルタ、`notification_list`
- [DR-0024](./DR-0024-out-of-project-files.md) §3.2 — セッションが名指したパスだけを読む信頼の形
- [DR-0038](./DR-0038-json-is-parsed-by-schema.md) — 入力と状態のファイルをスキーマで読む
