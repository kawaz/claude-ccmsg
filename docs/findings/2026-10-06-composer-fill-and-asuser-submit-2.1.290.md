# composer への fill + Enter と `$.prompt.submit({ asUser: true })` の実機検証

- 日付: 2026-10-06
- 対象: Claude Code 2.1.290 (隔離 config home + Haiku の対話セッション、hooks module を inline 読み込み)
- 目的: v1 daemon は webui の人の msg を peer socket に `<cross-session-message>` 封筒で注入しており、受け手の harness が peer の枠を付けるため、model にユーザの指示として信用されない。kawaz/ccmsg の `docs/decisions/DR-0016` §2.2 の「hooks module で composer に fill し hyoui で Enter」を v1 に持ち込む前に実機で成立を確認する。あわせて 2.1.290 で見つかった `$.prompt.submit({ text, asUser: true })` を fill + Enter と比較する
- 方法: 隔離環境で hooks module (`register.ts`) とサイドカー (Python の Unix socket server) を動かし、外部スクリプトから JSONL 要求を送って fill / submit / read / dialog を実行。hook ログと transcript JSONL と画面を突き合わせた

## 判明した事実

判定表 (項目 1 から 7)。「実測」は hook ログ・transcript・画面で観測した内容。

| # | 期待 | 実測 | 判定 |
|---|---|---|---|
| 1 | 外部指示を read / 退避 / fill し、Enter で composer 経由送信、書きかけを復元 | 空欄と書きかけの両方で `filled.isFilled:true`。`prompt.submit` は `origin:{kind:"composer"}`、`next.origin` は `{plugin:"engine",tier:"core"}`。書きかけ `half-typed draft 書きかけ` は submit 後の `restore.fill` で `isFilled:true`、画面にも残った | 成立 |
| 2 | 実行中 (busy) に fill + Enter した入力が queue に入り処理される | `Bash(sleep 20)` の実行中に fill 成功。Enter 時の `prompt.submit` は `origin:{kind:"composer"}`、`turnId` あり。画面に `Press up to edit queued messages`、transcript に `queued_command`、model が `BUSY-FILL-RECEIVED` と応答 | 成立。進行中 turn への queue 配送であり、独立した即時 turn とは限らない |
| 3 | 日本語を含む 3 行が Enter 1 回で単一 prompt になる | 全文が単一の `prompt.submit` と単一の transcript user 行になり、model も 3 行を出力 | 成立 |
| 4 | 手入力・通常注入・busy queue の transcript 比較 | 手入力と fill + Enter は共に `type:"user"`, `origin:{kind:"human"}`, `promptSource:"typed"`。`isMeta` と `attachment` のキーは無い (null ではなくキー無し)。busy は別に `type:"attachment"`, `attachment.type:"queued_command"`, `attachment.origin:{kind:"human"}`, `humanTurn:true` | 成立。hook 上の `composer` と保存行の `human` は別表記 |
| 5 | session.start で process.spawn、子が Unix socket を listen、stdout を for await で読んで fill、process.run で結果を返す | `sidecar.ready`、外部 JSONL が `request.result` に到達、`process.run.result.exitCode:0`、結果ファイルへの書き出しを確認 | 成立 (使い捨て PoC。再 spawn 等の耐障害性は未検証) |
| 6 | ダイアログ表示中の fill は拒否される | `$.ui.ask` のダイアログ表示中、`filled:{isFilled:false, refusal:"dialog", text:"", cursor:0}`。Enter は送っていない | 成立 |
| 7 | `asUser:true` を fill + Enter / 省略時 submit と比較 | 下記 7a から 7f | b から e は成立、a の hook 実測と f の gate 挙動は未確認 |

項目 7 の内訳:

- 7a (他 plugin の `prompt.submit` hook から見た `e.origin`): 未確認。同じ plugin が発した `$.prompt.submit` はその plugin 自身の `prompt.submit` hook を通らないため、自 plugin のログでは取れない
- 7b (model への見え方): `asUser:true` では枠無しの本文が届く。省略時は plugin 名付きの枠 (`The <name> plugin sent a message:` で始まる文面) が付き、model も枠を認識した
- 7c (provenance): `asUser:true` でも戻り値・transcript の origin は `{kind:"plugin", name, asUser:true}`、`promptSource:"system"` のまま。`composer` / `human` にはならない
- 7d (書きかけ): 省略時・`asUser:true` のどちらでも composer の書きかけは維持された
- 7e (busy / dialog): busy 時は先行 turn の完了後に独立 turn として走る (queue 行ではなく plugin origin の `type:"user"`)。ダイアログ表示中でも fill は拒否される一方、`asUser:true` の submit は即座に独立 turn が走り、画面はダイアログを描画したまま
- 7f (provenance gate の実際の権限判定): 未確認。型定義に gate の記述はあるが、どの permission / auto-mode 判断を指すかは実測していない

### 追加検証 (実験 A、Claude Code 2.1.291): busy 時の受付 event

型定義は 2.1.290 のまま、実測は 2.1.291 (Haiku 4.5、隔離 config home、hyoui 内の対話セッション。注入用と観測用の処理を同じ plugin の mod に同居)。時系列は「検証の詳細」の 8。

- busy 中の fill + Enter でも、`prompt.submit` と `classic.UserPromptSubmit` は Enter 直後に発火する。`prompt.submit.turnId` には実行中の turn id が入り、`next(e)` も直後に resolve する。idle 時は `turnId` が無い
- busy 中の prompt は、Bash の tool 結果の後に `queued_command` として進行中の同じ turn に届く。新しい `turn.start` は起きず、続く `turn.step` / `turn.complete` は元の turn id
- transcript: idle の user 行は Enter 時の timestamp を持ち、`session.append` と UUID が一致する。busy の `queued_command` 行も timestamp は Enter 時だが、行がファイルに追記されるのは tool 結果の後の配送時 (この例では Enter の約 90 秒後)。`session.append` (`door=delivery`, `name=queued_command`) でこの追記を mod から観測できる
- 受付の判定には `classic.UserPromptSubmit` (fill した文との一致) が使える。ただし idle・busy とも `source` キーは無かった (型定義 2.1.290 には `source?: 'user' | ...` があり「Payloads may omit it while the field rolls out」とある)。transcript / `session.append` は model に届いた時点で現れるので受付の判定には使えない
- `session.append` は 2.1.284 時点の reference の event 一覧に無く、2.1.290 の型定義にある event

### 追加検証 (実験 B、Claude Code 2.1.291): module 自身による Enter とダイアログ中の fill

実測は 2.1.291 (Haiku 4.5、隔離 workspace・隔離 config home の 1 セッション、hyoui 内)。時系列は「検証の詳細」の 9。

- mod の `$.env.get` は `HYOUI_SESSION_ID` と `HYOUI_NAMESPACE` を返した (hyoui の中で起動したセッション)。`claude plugin validate` もこの 2 名を env の読み取り対象として列挙する
- mod 自身による Enter が成立した。fill 成功後、宛先が自セッションであることを照合してから `$.process.run(["hyoui","input","--namespace=<ns>","<id>","key:Enter"])` を実行し、終了コード 0。`prompt.submit` は `origin:{kind:"composer"}`、`classic.UserPromptSubmit` が発火、transcript は `origin:{kind:"human"}`, `promptSource:"typed"`。fill 結果から `classic.UserPromptSubmit` まで 55 ms。外部スクリプトを介さず mod だけで fill から Enter まで完結する
- permission ダイアログ (Bash の Yes/No) 表示中の fill は `{"isFilled":false,"refusal":"dialog","text":"","cursor":0}`。`$.ui.ask` のダイアログ (項目 6) と同じ拒否が permission ダイアログでも起きる
- 「ダイアログが閉じた」ことを専用に知らせる event は今回の観測では見当たらなかった (不存在の証明ではない)。`classic.PermissionRequest` はダイアログ表示前に発火し、その `next` も表示前に resolve した。No を選んだ後、`tool.call` の `next` が `isError:true` で resolve し、`turn.complete`、`ui.render` (component `AbovePrompt`) が続き、直後の fill 再試行は成功した。この並びは閉じた後の再試行の契機の候補
- 実験上の注意: permission ダイアログを確実に出すため、実験 mod の `tool.check` で Bash の判定を `ask` に変えた。`classic.UserPromptSubmit` のキーに `source` は無かった (実験 A と同じ)

### 追加検証 (実装した module での e2e、Claude Code 2.1.293)

DR-0035 段 1 の実装 (claude-ccmsg plugin の hooks module) を、隔離 config・隔離 workspace・隔離 daemon、hyoui 0.14.0 の中で動かした実測。plugin は `--plugin-dir` で読み込み。時系列は「検証の詳細」の 10。

- 2.1.293 では `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` を付けなくても hooks module が読まれた (debug に "not turned on" の行が出ない)
- `-p` (`claude -p "reply exactly P-OK"`) でも module は読まれ、`classic.SessionStart` が `session.start` より先に決着した。`$.session.surfaces()` は `[]` を返した (debug `nothing attached draws; []`)。`-p` の判定は `session.start` の `isInteractive` / `surface` だけでは間に合わず、`classic.SessionStart` の時点で `$.session.surfaces()` が空かを見る必要がある
- `/clear` の後は `session.end` (reason clear) → `classic.SessionStart` の順で起き、間は約 150ms。/clear の Enter 直後に旧 sid 宛の入力を投げると、module は世代を進めた後に旧サイドカー宛の依頼を fill せず捨てた。旧 sid 宛の文はどの transcript にも入らず、新しいセッションの composer も空だった。新 sid への依頼は受け付けられた (202ms)。旧サイドカーの `$.process.spawn` は abort で停止し、新しい sid で sidecar が bind された
- 人の打鍵との競合の実例: `/clear` を打っただけで Enter を送る前に依頼が届いた回は、module が依頼の文を送り、打ちかけの `/clear` を書きかけとして戻した
- `classic.UserPromptSubmit` の `prompt` と transcript の文は、末尾の空白が削られる。削られた文字はどれも JS の `trimEnd` が削る範囲に入る。fill した文との照合は「完全一致、または fill した文の `trimEnd()` と一致」にすると受け付けを判定できる (完全一致だけだと末尾に改行がある文が受け付けを確認できない)
- `$.process.spawn` の子の親プロセスは claude 本体の pid
- engine が `--plugin-dir` の plugin dir に `.claude-plugin/types/` (中に `.gitignore *`) を書く
- hyoui 0.14.0 では `--namespace` / `HYOUI_NAMESPACE` が廃止 (警告して無視、2026-11 に削除予告)、session id は UUID 必須で `--session` は廃止 (`--session-id UUID` と `--tag`)、端末の無い起動元からの起動には `--pty-stdin` が要る

## 実用的な示唆

- v1 の「webui の人の msg を人の発言として届ける」用途には、fill + Enter (`origin:{kind:"composer"}`、保存行は `human` / `typed`) が provenance 上もっとも素直。`asUser:true` は model には枠無しで届くが、hook・transcript では plugin 由来と区別でき、dialog を無視して turn が走る
- fill と Enter の間に人の打鍵があると連結される。実験中、`key:C-u` 後に残った書きかけと手入力が連結されて送信される事象があった。実装時は fill から Enter までの排他 (人の入力中は fill しない等) を設計に含める
- 書きかけの退避・復元は `prompt.submit` hook で `e.origin.kind === 'composer'` かつ fill した本文と一致した時に行う方式で動いた
- busy 時の fill + Enter は queue 配送になるため、即時性が要る用途では 7e の `asUser:true` の挙動 (turn 終了後の独立 turn) と比較して選ぶ
- 受付 (人の msg を harness が受け取った) の確認は `classic.UserPromptSubmit` で Enter 直後に取れる。busy でも遅れない。model への到達は `session.append` の配送側 (`door=delivery`) まで待つ必要がある
- サイドカーの socket は `srw-------` (0600) で作ること
- Enter は mod 自身が `hyoui input --namespace=<ns> <id> key:Enter` を `$.process.run` で実行すればよい。`<id>` と `<ns>` は `$.env.get` で `HYOUI_SESSION_ID` / `HYOUI_NAMESPACE` から取る。fill 成功後、宛先が自セッションであることを照合してから送る
- ダイアログ中は fill が拒否される (`refusal:"dialog"`) ので、msg を保留して再試行する設計にする。再試行の契機は専用 event が見当たらないため、`tool.call` の `next` resolve から `turn.complete`、`ui.render` (`AbovePrompt`) の並びを候補に、fill を再試行する
- 隔離 claude の認証は、起動コマンドの `--settings` に `apiKeyHelper` と `env.ANTHROPIC_BASE_URL` をセットで渡す形が通った (ヘルパの鍵は llm-gateway 用なので BASE_URL も同じ gateway を指す必要がある)。隔離 config の settings.json には何も書かない。env を名前で引き継ぐ形や lab-setup の手順 (認証値を隔離 settings に写す) よりこの形を推奨する

## 一次資料との差分

- reference `claude-mods/prompt-injection` と kawaz/ccmsg の `docs/decisions/DR-0016` §3 は `$.prompt.submit` を一律に「plugin 枠付き」としているが、2.1.290 は `asUser:true` で model に枠無し本文を渡せる。ただし hook / transcript の provenance は `plugin` (`promptSource:"system"`) のままで `composer` にはならない。dialog を無視して turn が走る
- 2.1.290 の plugin-authoring skill 同梱の `types/claude-code.d.ts` の該当箇所: 行 2869 から 2881 (自 plugin の hook を通過しない記述)、8547 から 8553 (origin の意味)、8650 から 8668 (`plugin/asUser` と `provenance gate`)、8696 から 8714 (`asUser?:true` の仕様と「transcript still names the plugin」)、8758 から 8774 (`turnId` / `wait`)、8786 から 8791 (queued 時の resolve)
- 同じ plugin が発した `$.prompt.submit` はその plugin 自身の `prompt.submit` hook を通らない

## 未確認事項

- 7a: 他 plugin の `prompt.submit` hook から見た `e.origin` (自 plugin のログでは直接取れない)
- 7f: provenance gate が実際に何を判定するか (permission / auto-mode との関係)。型定義の記述のみで実測なし
- `classic.UserPromptSubmit.source`: 2.1.291 では idle・busy・mod 自身の Enter のいずれでも無かった。型定義の `source?: 'user' | ...` が実際に付く条件は未確認
- ダイアログが閉じたことを知らせる専用 event の有無: 今回の観測では見当たらなかったが不存在の証明ではない。`tool.call` の `next` resolve、`turn.complete`、`ui.render` (`AbovePrompt`) の並びを再試行の契機とする案は、No 選択 1 例のみの観測 (Yes 選択、`$.ui.ask` 等の別種ダイアログ、複数回連続は未検証)
- サイドカーの再 spawn 耐性: `/clear` では旧サイドカーが abort で停止し新 sid で再 bind されることを 2.1.293 で確認済み (詳細 10)。session 再開・module reload・子プロセス異常終了時の挙動は未検証

## 検証の詳細

### 構成

- hooks module `hooks/register.ts` (`hooks.json` は `{"modules":["./register.ts"]}`) を inline 読み込み。debug ログに `hooks module ccmsg-fill-poc@inline loaded ... events: session.start,prompt.submit,...`
- `session.start` で `$.process.spawn` により Python サイドカーを起動し、`for await (const chunk of child)` で stdout を改行区切りに分割して JSON 要求を `execute` に渡す
- サイドカーは Unix socket を bind して 0600 にし、`{"ready": path}` を stdout に出したのち、accept した接続の行をそのまま stdout へ流す (抜粋)

```python
s = socket.socket(socket.AF_UNIX)
s.bind(path); os.chmod(path, 0o600); s.listen(8)
print(json.dumps({'ready': path}), flush=True)
while True:
    connection, _ = s.accept()
    # recv した行を sys.stdout.buffer に書き出して flush
```

- 外部から要求を送るスクリプトは `{"id","op","text","asUser"}` の 1 行 JSON を socket に書くだけ。ログ記録は `$.process.run` で追記専用スクリプトを呼ぶ (hook 内でファイル書き込みを直接しない)
- `execute` の要点

```ts
if (op === 'fill') {
  const box = await $.prompt.read()
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (filled.isFilled) { if (box.text !== '') stash = box.text; pendingComposer = text }
  result = { box, filled, stash }
} else if (op === 'submit') {
  // prompt.submit は idle で turn が始められる時に resolve するので await しない
  void $.prompt.submit({ text, ...(request.asUser ? { asUser: true } : {}) })
    .then(v => log('submit.settled', { id, value: v }))
} else if (op === 'read') result = await $.prompt.read()
else if (op === 'dialog') void $.ui.ask('PoC dialog: choose an answer?', ['One', 'Two'])
```

- `prompt.submit` hook: origin と `next.origin` をログし、`e.origin.kind === 'composer' && pendingComposer === e.text` なら退避した書きかけを `$.prompt.fill` で復元する
- 観測は `prompt.submit` / `turn.start` / `turn.complete` / `ui.render` (`UserMessage`) の各 hook ログ、transcript JSONL、画面の 3 系統

### 1 書きかけ復元

```
{"box":{"text":"half-typed draft 書きかけ","cursor":21},"filled":{"isFilled":true,"text":"LAB-DRAFT: reply with ping","cursor":26}}
{"text":"LAB-DRAFT: reply with ping","wait":false,"origin":{"kind":"composer"},"nextOrigin":{"plugin":"engine","tier":"core"}}
{"original":"half-typed draft 書きかけ","filled":{"isFilled":true,"text":"half-typed draft 書きかけ","cursor":21}}
```

画面は `LAB-DRAFT: reply with ping` の送信、応答 `ping`、その後 composer に `half-typed draft 書きかけ` が戻った状態。

### 2 busy

`Bash(sleep 20)` 実行中の fill は `{"isFilled":true,...}`、submit は `{"origin":{"kind":"composer"},"turnId":"...","wait":false}`。transcript は次の attachment 行で、top-level の `origin` / `promptSource` / `isMeta` は無い。`turn.complete.answer` は `BUSY-FILL-RECEIVED`。

```
{"type":"attachment","attachment":{"type":"queued_command","prompt":"LAB-BUSY-FILL: reply exactly BUSY-FILL-RECEIVED","source_uuid":"...","delivery_id":"...","commandMode":"prompt","origin":{"kind":"human"},"humanTurn":true}}
```

### 3 複数行

`prompt.submit.data.text` と transcript の `message.content` はともに `"LAB-MULTI: 三行を確認\n二行目 日本語 alpha\n三行目 おしまい"`。

### 4 transcript 比較

手入力と通常注入 (fill + Enter) はどちらも次の形で、`isMeta` / `attachment` のキーは存在しない。

```
{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"..."}}
```

### 5 サイドカー

socket は `srw-------`。外部スクリプトが書いた `{"op":"read"}` に対し mod が `{"result":{"text":"","cursor":0}}` を記録し、`$.process.run` の結果は exitCode 0。

### 6 dialog

```
{"op":"fill","result":{"box":{"text":"","cursor":0},"filled":{"isFilled":false,"refusal":"dialog","text":"","cursor":0}}}
```

### 7 asUser

- 省略時: origin `{"kind":"plugin","name":"ccmsg-fill-poc"}`。transcript は `type:"user"`, `promptSource:"system"` で、本文は `The ccmsg-fill-poc plugin sent a message:\nLAB-PLUGIN-FALSE: ...\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`。model 回答は `Yes, a plugin sender header preceded it (ccmsg-fill-poc).`
- `asUser:true`: origin `{"kind":"plugin","name":"ccmsg-fill-poc","asUser":true}`。transcript の本文は `LAB-PLUGIN-TRUE: Quote this received message exactly ...` のみで、model 回答は `No plugin sender header preceded it.`。どちらの plugin submit 中も composer の書きかけ `KEEP THIS DRAFT 書きかけ` が残った
- busy + `asUser:true` の時系列 (同日 00:43 から 00:44 台、先行が busy turn、後続が asUser submit): 先行 `turn.start` 00:43:42.245、後続 `request.result` 00:43:42.270、先行 `turn.complete` 00:44:05.312、後続 `submit.settled` 00:44:05.327、後続 `turn.start` 00:44:05.334、`turn.complete.answer:"BUSY-TRUE-SECOND"` 00:44:06.972。後続は plugin origin の `type:"user"` で `queued_command` 行ではない
- dialog + `asUser:true`: fill は拒否された一方、asUser の `turn.start` と `submit.settled` が 00:44:32.710、`turn.complete.answer:"DIALOG-AFTER"` が 00:44:34.109。画面は応答後もダイアログ (`PoC dialog: choose an answer?` / `❯ 1. One`) を描画したまま

### 8 busy 時の受付 event の時系列 (2.1.291)

2026-10-06 UTC。注入用と観測用の処理を同じ plugin の mod に同居させ、idle と busy (`Bash(sleep 90)` 実行中) で同じ fill + Enter を行った。

```
IDLE
04:42:14.230-.294 hyoui Enter 送出
04:42:14.317 transcript user 行の行内 timestamp
04:42:14.319 prompt.submit (origin composer, turnId なし)
04:42:14.321 classic.UserPromptSubmit (fill 文と一致, source なし)
04:42:14.351 session.append (door=prompt, UUID 05f23b13-…) / .353 next resolved
04:42:14.392 turn.start (turn 84f35e3e-…)
04:42:14.400 prompt.submit next resolved
04:42:14.443 turn.step
04:42:14.477 fswatch が transcript の user 行を検出 (UUID 一致)
04:42:16.038 turn.complete (回答 IDLE-RECEIVED)
BUSY
04:44:26.136 turn.start (turn 48bdda74-…)
04:44:27.902 tool.call Bash(sleep 90)
04:44:27.998 fill isFilled:true
04:44:28.187-.224 hyoui Enter 送出 (画面に Press up to edit queued messages)
04:44:28.216 queued_command 行の行内 timestamp (Enter 時)
04:44:28.217 prompt.submit (origin composer, turnId=48bdda74-…)
04:44:28.224 classic.UserPromptSubmit (fill 文と一致, source なし) とその next resolved
04:44:28.225 prompt.submit next resolved
04:45:57.967 classic.PostToolUse
04:45:57.981 session.append (Bash 結果)
04:45:58.016 session.append (door=delivery, name=queued_command, UUID 33a84bd8-…) / .022 next resolved
04:45:58.069 turn.step (元の turn 48bdda74-… のまま)
04:45:58.129 fswatch が transcript の attachment.queued_command 行を検出 (UUID 一致)
04:45:59.565 turn.complete (元の turn, 回答 QUEUED-INSIDE-TURN)
```

- 最初の `sleep 25` の試行は fill 後 Enter 前に Bash が終わり別 turn で処理されたため不採用とし、`sleep 90` でやり直した
- fswatch の検出時刻は追記の厳密な瞬間ではない

### 9 module 自身による Enter とダイアログ中の fill (2.1.291)

2026-10-06 UTC。実験 mod が session と namespace を env から取得し、fill 後に mod 自身が hyoui で Enter を送った。続けて permission ダイアログを出して fill を試し、No を選んで閉じた後に fill を再試行した。

```
04:53:37.294 experiment.session.start (session と namespace を env から取得)
04:54:07.927 request.result(env): session / namespace を返す
04:54:07.976 fill.result: isFilled=true
04:54:07.989 self-enter.start: hyoui input --namespace=<ns> <id> key:Enter
04:54:08.018 prompt.submit: origin={"kind":"composer"}
04:54:08.030 self-enter.result: exitCode=0
04:54:08.031 classic.UserPromptSubmit
04:54:35.641 classic.PermissionRequest: tool_name=Bash
04:54:35.642 classic.PermissionRequest.next.resolved
04:54:49.298 fill.result(dialog 中): isFilled=false, refusal="dialog"
04:55:01.437 tool.call.next.resolved: isError=true (No を選択)
04:55:01.479 turn.complete
04:55:01.494 ui.render: component="AbovePrompt"
04:55:01.506 fill.result(閉じた後): isFilled=true
```

- transcript の行: `{"timestamp":"2026-10-06T04:54:08.016Z","origin":{"kind":"human"},"promptSource":"typed","content":"EXP-B-SELF: answer exactly B2-RECEIVED"}`
- fill 結果 (04:54:07.976) から `classic.UserPromptSubmit` (04:54:08.031) まで 55 ms
- permission ダイアログを確実に出すため、実験 mod の `tool.check` で Bash の判定を `ask` に変えた
- 認証: 隔離 claude には起動元の環境変数を名前で `env -i` に引き継いで渡し、隔離 config の settings.json には認証の値を書かなかった。それで認証が通った

### 10 実装した module での e2e (2.1.293)

2026-10-08 UTC。Claude Code 2.1.293、隔離 config・隔離 workspace・隔離 daemon、hyoui 0.14.0 の中。plugin は claude-ccmsg を `--plugin-dir` で読み込み、認証は起動コマンドの `--settings` に `apiKeyHelper` と `env.ANTHROPIC_BASE_URL` をセットで渡した (隔離 config の settings.json は空)。

`-p` (`claude -p "reply exactly P-OK"`):

```
09:43:46.931Z hooks module claude-ccmsg@inline loaded (worker, environment 1, tier user); events: session.start,session.end,classic.SessionStart,…
09:43:47.160Z $.session.surfaces (claude-ccmsg): nothing attached draws; []
09:43:47.161Z hooks module claude-ccmsg@inline classic.SessionStart settled in 166.2ms
09:43:47.177Z hooks module claude-ccmsg@inline session.start settled in 7.2ms
```

`/clear` (Enter 直後に旧 sid 宛の入力を投げた):

```
09:43:10.648 (直前) /clear の Enter を送出
09:43:10.726Z session.end settled (module が世代を進める)
09:43:10.746Z module: 旧サイドカーに届いた依頼を fill せずに捨てた (the session changed its id)
09:43:10.874Z classic.SessionStart settled
09:43:10.875Z 旧サイドカーの $.process.spawn が abort で停止
09:43:10.967Z 新しい sid で sidecar が bind (ready)
```

末尾空白の実測 (7 種。`classic.UserPromptSubmit` の `prompt` と transcript の文):

| 送った文 | UserPromptSubmit / transcript に届いた文 |
|---|---|
| 末尾に改行 | 改行が削られた |
| 末尾にスペース 3 つ | 削られた |
| 末尾に全角空白 U+3000 | 削られた |
| 末尾にタブ | 削られた |
| 先頭にスペース 3 つ | そのまま |
| 途中に空行 | そのまま |
| 途中にタブ | そのまま |
