# DR-0060: webui の FAB から、セッションの会話に残さない横道の質問 (btw) をする

- Status: Accepted (2026-11-22、kawaz 裁定。裁定は末尾の「裁定」) — ✅ 実装済み (protocol の `btw.ts`、daemon の `btw.ts` (fork は起動コマンドの print の起動で起こす、[DR-0064](./DR-0064-btw-through-launch-command.md))、webui の `SessionInputComposer` の btw のチェックボックス・`timeline/BtwBubble.tsx`・`btw-slots.ts`・SESSIONS の `Non-interactive`)。組み込みの起動コマンドの print の起動を本物の claude で通した確認は [findings 2026-11-22-btw-print-launch-builtin-live](../findings/2026-11-22-btw-print-launch-builtin-live.md)
- Date: 2026-11-22

## Context

走っているセッションの文脈を踏まえた横道の質問をしたいが、その質問と答えを本体の会話 (transcript) には残したくない時がある。Claude Code の TUI には組み込みの `/btw` があるが、webui からは使えない。kawaz の指示 (2026-11-22) の要点:

> /btw モードを作りたい。FAB の入力フォームに [ ] btw なチェックボックスを置く。場所は effort の左で良い。

> btw は本体の機能だが、それに乗っかる必要はない。今のセッションを fork 指定して transcript 保存なしの -p で得た回答を、daemon がユーザ向けに中継して webui だけに出す。キャッシュも共有されるし同じことができる。

> cache が当たるのは既に知見としてある (調べなくてよい)。tool は気にしなくて良い。

> ドキュメント内の細かい記述を修正したい時に、メインコンテキストに無駄なコンテキストを足したくない、みたいなときに、btw で一発指示して修正させる使い方は普通にありそう。その場合も修正したことは (本体に) 伝える必要はなく、必要なら僕が伝える。

> (fork した -p のプロセスが) daemon に出ても構わない。interactive かどうかは区別がつくので、SESSIONS のリストに出たとしても上位に出てこないようにする等で良い。hook はどうでも良い (通常の claude -p の仕様で動くものは動く)。

> 質問したデバイスのみに表示されるのはもったいないので、セッション毎の保存をする ccmsg 内の場所に、そのセッション内のどことセットかを {ts, 直前の uuid, btw プロンプト, レスポンス} な感じで保存しておけば、それがセッションにあれば別デバイスにも配れて、webui 側でマージすれば良さそう。

### 読んで分かった前提

- daemon がセッションを起こす既存の経路は 2 つで、どちらも daemon が claude を直接起こさず、設定の command に JSON を標準入力で渡す: 起動コマンド ([DR-0018](./DR-0018-session-launcher.md) §3.1、組み込みは `default-launch-command.sh`。環境の掃除・`direnv exec .`・hyoui の中の対話の claude) と say コマンド ([say-command](../design/say-command.md))。どちらも config で差し替えられ、試験はそこを偽物にする
- 再起動・resume の model / effort は daemon が `sessionRunsAs` (module の facts の通しの上書き → セッション自身の値 → transcript の末尾) で埋める ([DR-0028](./DR-0028-session-kill.md)、`session-runs-as.ts`)。`--model` の無い `--resume` / `--fork-session` は元のセッションの model でなく settings の model で走り、cache を読まない ([findings 2026-11-15](../findings/2026-11-15-resume-model-without-flag.md))
- `claude --help` (2.1.330) の `--system-prompt-snapshot` は既定 on で、会話の最初の request で作った system prompt を記録し、以後の request と resume は記録をそのまま送る。resume の時に `--append-system-prompt` 等を渡しても使われない
- セッションの cwd・config dir は agents の行 (`sessions/<pid>.json` の `cwd`、daemon が付ける `config_dir`) にある
- FAB の effort の select は in effect / ⏱️ 単発 / 📌🏛️ 通しの 3 群 ([DR-0041](./DR-0041-request-model-effort-override.md) §6.3)。📌🏛️ は送信の時にセッションの通しの上書きを変える
- ccmsg の state dir の中でセッションごとに置く場所は `<stateDir>/sessions/` で、今は `ccmsg sidecar begin` (CLI) が `<sid>.json` (cwd・repo_root・branch) を begin のたびに丸ごと書き直している。同じ CLI が begin の時に、mtime が 30 日より古いファイルをこのディレクトリから拡張子を問わず消す (`pruneOldSessionFiles`)。daemon が webui のために持つ状態は `say-read.json` / `permit-state.json` / `bookmarks.json` (全セッションを 1 ファイル、一時ファイルに書いて rename) で、どれも中身が小さい
- 特定のセッションを見ている webui への push は `transcript_subscribe` の購読者への `ev:"transcript"` の前例がある
- TL に transcript の外のものを合流させる前例がある (worker の say を時刻の位置に、[DR-0050](./DR-0050-timeline-notification-badges.md) §10 の `slotsByTime`)

### 実測 (2026-11-22、Claude Code 2.1.330、試験用に作った使い捨てのセッション)

空の一時ディレクトリを cwd にし、個人面の config dir で `claude -p --model haiku --effort low --name 🤖ccmsg-verify-btw` の 1 ターンのセッションを作り、それを `claude -p --resume <sid> --fork-session --no-session-persistence --model haiku --effort low --output-format stream-json --verbose` (プロンプトは標準入力) で 1 回聞いた。

- 答えは元のセッションの文脈を踏まえていた (前のターンで覚えさせた語を答えた)。cache は元のセッションの 60849 token を読んだ (作成 364)
- fork の新しい session id の transcript は作られず、元のセッションの transcript に fork の質問は書かれなかった
- **fork の `-p` も `sessions/<pid>.json` を書く**。`kind` は `"interactive"`、`entrypoint` は `"sdk-cli"`、`messagingSocketPath` もある。`kind` では区別できず、`entrypoint` で区別できる (対話の claude は `cli` / `claude-desktop` / `claude-vscode`、`launch-context.ts` の `SDK_ENTRYPOINTS` が既に `sdk-cli` / `sdk-ts` / `sdk-py` を対話でないものとして扱っている)
- fork の名前は元のセッションの名前を継ぐ (stream-json の最初の行が `system` / `session_title_changed` で元の名前)。SESSIONS には元のセッションと同じ名前の行として出うる
- ccmsg の hooks module も fork の中で動いた (state dir の `sessions/<fork の sid>.json` が書かれた)
- stream-json の行は `system/session_title_changed` → `system/init` (`session_id` が fork の sid、`model`、`permissionMode`) → `assistant` (`message.content` の text / tool_use、`parent_tool_use_id`) → `result` (`subtype`、`is_error`、`result`、`usage`) の順
- fork の `permissionMode` は settings の既定 (この面では `auto`) で、書き込みの tool も classifier が通せば走りうる
- 未検証: 元のセッションが応答の途中 (tool の実行中) の時に fork した場合の答え。試す操作が auto mode の classifier に止められたため確かめていない

## 目的

走っているセッションの文脈を踏まえた質問を webui から投げ、その答えを、そのセッションを見ているどの webui (別のデバイスも) でも、会話のどの時点で聞いたかが分かる位置で読める。質問と答えは本体の会話に入らず、本体の次の応答にも影響しない。

増やしたくないもの:

- セッションを起こす仕組みの種類 (起動コマンド・say コマンドと同じ「設定の command に JSON を渡す」形の外に、claude を起こす別の流儀を作らない)
- 本体のセッションの状態への作用 (btw は本体の transcript・通しの上書き・prompt の列のどれも変えない)
- SESSIONS の判定の材料 (対話でないかは Claude Code の `entrypoint` 1 つで決め、btw だけの印を別に持たない)
- TL の会話の行の種類 (btw は transcript の行でなく、TL の位置・ブックマーク・jsonl を持たない)

## Decision

### 1. 経路

webui (user role) → daemon の op `btw_ask` → daemon が btw コマンド (§2) を元のセッションの cwd で起こす → btw コマンドが `claude -p --resume <sid> --fork-session --no-session-persistence` を走らせ、stream-json を標準出力に書く → daemon が読んで btw の記録 (§4) を更新し、保存 (§9) して、そのセッションを見ている webui に配る (§5) → webui が TL のアンカーの位置に出す (§7)。

- 新しい経路は daemon と btw コマンドの間だけ。hooks module とサイドカーは使わない (fork の中で module が動くのは普通の `claude -p` と同じで、btw はそれに頼らない)
- 本体のセッションの module に何も送らないので、module の無いセッションでも btw は動く。module が無い時の別経路を作るのとは違い、btw の経路そのものが module を通らない

### 2. btw コマンド

起動コマンド・say コマンドと同じ形の、config で差し替えられる command にする。

- config の `btw_command` (argv。`launch_command` / `say_command` と同じ読み方で、起動時に実行ファイルの絶対パスに固める)。無ければ組み込みの `default-btw-command.sh` (`zsh -f` で走らせる)
- daemon は標準入力に JSON を 1 つ渡す: `{ cwd, config_dir, resume, model?, effort?, prompt }`。`resume` は元のセッションの sid、`prompt` は §3 の前置きを付けた全文
- 標準出力は claude の `--output-format stream-json --verbose --include-partial-messages` の行そのもの (daemon が読む契約)。標準エラーは daemon が末尾だけを失敗の文に使う
- 組み込みのコマンドがすること:
  - 環境の掃除は組み込みの起動コマンドと同じ (`CLAUDECODE` と `(CLAUDE|ANTHROPIC|HYOUI|CCMSG)_*` を消し、`CLAUDE_CONFIG_DIR` は入力の `config_dir` にする)
  - `direnv` があれば `direnv exec .` を通す (cwd の `.envrc` の鍵・アカウントが tool に効くように。起動コマンドと同じ)
  - `exec claude -p --resume <resume> --fork-session --no-session-persistence --model <model> --effort <effort> --permission-prompts none --output-format stream-json --verbose --include-partial-messages` で、prompt は標準入力に渡す (argv と ps に出さない)
- daemon が `cwd` に渡すのはセッションの cwd (agents の行の `cwd`、無ければ peers の行の `cwd`)、`config_dir` は agents の行の `config_dir` (無ければ peers の行の transcript の在り処の config dir)。どちらも分からなければ `btw_ask` は断る (§6)
- `model`: セッションの main の会話が最後に答えた model の正式な id (transcript の、sidechain でも `<synthetic>` でもない最後の assistant の行の `message.model`。例 `claude-sonnet-5-5`) に、セッションが 1M の context で走っている時は `[1m]` を付けた綴りにする (`claude-sonnet-5-5[1m]`)。1M かは、セッション自身の綴り (module の facts の通しの上書き、無ければ自身の model。`sonnet[1m]` など) が `[1m]` で終わるか、module が測った context window が 1,000,000 以上かで決める
  - 別名 (`sonnet[1m]`) をそのまま `claude -p` に渡すと、stderr に `[claude-code:unrecognized_model]` が出て、fork の request から履歴の thinking が落ち、prompt cache がほぼ全部外れた (1 回およそ 0.44 USD)。同じ状態で `claude-sonnet-5-5[1m]` を渡すとほぼ全部読んだ (2.1.330 の実測、[findings 2026-11-22-dr62-btw-cache-and-prompt-concat](../findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md))
  - launch の語彙 (`sonnet`) に写すと `[1m]` が落ち、context が 200k を超えたセッションでは入らない
  - 別名を正式な id に写す表は持たない (Claude Code の版で変わる)。id は transcript から取る
  - transcript にそのセッションの family (`sonnet` 等) の答えが無い時 (まだ答えていない、最後の答えの後に `/model` や通しの上書きで別の model に移った) は、セッション自身の綴りをそのまま渡す
- `effort`: FAB で選んだ値 (§8)、選んでいなければセッションが今走っている値 (通しの上書きの effort、無ければ module が言うセッション自身の effort、無ければ transcript の最後の答えの effort。単発の上書きは入れない)
  - module はセッション自身の effort を、main の turn の最初の request (`turn.step` の `index` が 0) からだけ取る。単発の上書き (`max` 等) で最初の request を変えた turn の 2 つ目以降の request は、engine がその turn に持った effort (haiku のセッションで `max` を頼んだ turn では `xhigh`) を名乗り、それをセッション自身の effort と取り違えて btw に `xhigh` を渡した (findings の B-d)
- tool の集合を変える引数 (`--tools`、`--disallowedTools`、`--restricted`、`--bare`、`--safe-mode`、`--strict-mcp-config`) は付けない。request の tools が元のセッションと変わると、cache の前方一致がそこで切れる
- `--permission-prompts none` は人に聞く場面を自動で断る (聞く相手の居ない `-p` で止まらないように)。tool の集合も system prompt も変えない
- daemon は btw コマンドを自分の process group で起こし (`detached`、起動コマンドと同じ)、取り消し・daemon の停止で group ごと止める

Design rationale: daemon が claude を直接起こせば command と script が要らないが、cwd の `.envrc` の環境 (アカウントごとの鍵等) を載せる方法と、試験で claude を偽物にする方法を、起動コマンドと別に作ることになる。同じ形の command にすれば、環境の決め方は起動コマンドと揃い、人が自分の環境に合わせて差し替えられ、e2e は config で偽物を指せる。

### 3. プロンプトの前置き

質問の前に次の前置きを付ける (protocol の定数 `BTW_PROMPT_PREFIX`)。system prompt は resume の記録がそのまま使われる (Context) ので、指示は user の文に入れる。

```
<btw>
これは btw (本体の会話の横道) です。ここまでの会話の文脈を踏まえて、下の質問・依頼に応えてください。このやりとりは本体の会話には残らず、結果は人が webui で読みます。
- 下の質問・依頼に応えることだけをする。依頼に無い本体の作業の続きはしない
- 既定では say / PushNotification / ccmsg の send などで人や他のセッションに知らせず、結果は本文に書く。下の質問・依頼に知らせ方の指示があればそれに従う
</btw>

<質問・依頼>
```

- `<質問・依頼>` は FAB に書いた文 (添付の `[FILE<N>]` は送信と同じく置き換えた後) をそのまま置く
- 前置きの 2 行は既定で、下の質問・依頼の文が優先する。知らせ方は依頼に指示があればそれに従い (「XX をやっといて、終わったら say で教えて」、kawaz 2026-11-22)、本体の作業も依頼に書かれた分はする。止めるのは依頼に無いことを fork が自分から始めること
- ファイルの書き込みは止めない。本体の文脈を増やさずに細かい修正を一発で頼む使い方を含む (kawaz 2026-11-22)。fork が書き換えたことは本体の会話に足さない (伝えるかは人が決める)
- tool の集合を変えない理由は §2 (cache)

### 4. btw の記録

1 つの btw を 1 つの記録で表す。protocol の `BtwRecordSchema` (valibot) が形を持ち、daemon の保存 (§9)・push (§5)・webui の store が同じスキーマで読む。

| field | 中身 |
|---|---|
| `id` | daemon が振る UUIDv4 |
| `session_id` | 元のセッションの sid |
| `ts` | daemon が `btw_ask` を受けた時刻 (ISO) |
| `after_uuid` | アンカー。`btw_ask` を受けた時点で、元のセッションの transcript に書かれていた最後の行 (uuid を持ち、sidechain でない行) の uuid。transcript に uuid を持つ行がまだ無い時は無い |
| `prompt` | FAB に書いた文 (前置きの無いもの) |
| `response` | 答えの文 (下) |
| `status` | `running` / `done` / `failed` / `canceled` |
| `model` / `effort` | btw コマンドに渡した値 (渡さなかった field は無い) |
| `tool` | `running` の間、今走っている tool の名前 (無ければ無い。保存しない) |
| `ended_at` | `running` でなくなった時刻 |
| `error` | `failed` / `canceled` の理由の文 |

- アンカーは daemon が元のセッションの transcript の末尾を読んで決める (`readSessionLaunchContext` と同じく末尾から読む)。module の push には頼らない。transcript を読んでから fork が読むまでの間に書かれた行は、fork の文脈には入るがアンカーより後になる (アンカーは「少なくともこの行までは見て答えた」位置)
- `response` は main の会話 (`parent_tool_use_id` が null) の assistant の text のブロックを順に繋いだもの (ブロックの間は空行)。`--include-partial-messages` の `stream_event` の text の差分で伸ばし、`assistant` の行が来たらそのブロックの確定した文で置き換える。thinking と tool の入出力は記録しない (`tool` に今の tool の名前だけ)
- 終わりは `result` の行で決める: `is_error` が false なら `done`、true なら `failed` (`error` に `result` の文か `subtype`)。`result` の前に command が終わったら `failed` (`error` に終了コードと標準エラーの末尾 2 行)。stream-json の行は `type` で分けたスキーマで parse し、知らない `type` と読めない行は読み捨てる
- 取り消し: op `btw_cancel` (§6) で btw コマンドの process group に SIGTERM を送り、`canceled` にする (`error` は「取り消した」)

### 5. 配り方

そのセッションを見ている全ての webui (`transcript_subscribe` でそのセッションの本体の transcript の購読を頼んだ接続。別のデバイス・別のタブも同じ) に配る。transcript の購読が断られた接続 (走っていないセッション) にも配る。`transcript_unsubscribe` と接続の終わりで配るのをやめる。

- `ev:"btws" { session_id, btws: <記録の列、ts の古い順> }`: そのセッションの購読の始まりに、保存されている記録と走っている記録の全部を送る (空でも送る。daemon の再起動の後に繋ぎ直したタブが古い分を捨てられるように)
- `ev:"btw" { btw: <記録の全体> }`: 記録が変わるたびに 1 つ送る (`btw_ask` で始まった時、答えが伸びた時、終わった時)。webui は `id` で置き換える。どのタブから聞いたかで区別しないので、聞いたタブも別のデバイスも同じ ev で描く
- 答えの差分は 1 つの btw につき 100ms に 1 回までにまとめて送る (token ごとに全体を送ると、答えの長さの 2 乗の量になるため)。`status` が変わった時はまとめずにすぐ送る
- 購読していない webui には送らない。開いた時に `ev:"btws"` で揃う

### 6. op (どれも user role だけ)

- `btw_ask { session_id, prompt, effort? }` → `{ ok: true, btw: <記録> }` (btw コマンドを起こした時点で返す。答えは待たない)
  - `bad_request`: user role でない。session role のエージェントが他のセッションの文脈で質問を走らせる口にしない
  - `invalid_args`: `prompt` が空、`effort` が語彙 (`LaunchEffortSchema`) の外
  - `session_not_found`: daemon がその sid の cwd か config dir を知らない
  - `btw_busy`: 走っている btw が上限 (`BTW_MAX_CONCURRENCY` = 4、daemon 全体) に達している
  - `btw_command_unavailable`: btw コマンドを起こせなかった (spawn の失敗)
- `btw_cancel { id }` → `{ ok: true }`。終わった btw への取り消しは何もせず ok。`not_found`: その id の記録が無い
- 記録を読む op は持たない。読むのは購読の始まりの `ev:"btws"` (§5)
- daemon.log に 1 行ずつ: `btw_ask: session_id=<sid> id=<id> model=<..> effort=<..> prompt_bytes=<n>` と、終わりの `btw_end: id=<id> status=<..> exit_code=<..> response_bytes=<n> input_tokens=<n> cache_read_input_tokens=<n> cache_creation_input_tokens=<n> output_tokens=<n>`。質問と答えの文は書かない
  - `*_tokens` は stream-json の `result` の行の `usage` の数で、fork が元のセッションの prompt cache を読めたか (`cache_read_input_tokens`) を実機で測るためのもの。`usage` に無い field は出さず、`usage` が無い・読めない (スキーマに合わない)・`result` が来なかった時は 1 つも出さない。`usage` が読めなくても終わり方 (done / failed) の読みは変わらない

### 7. TL に出す (アンカーの直後にマージ)

- 元のセッションの本体の TL (agent の TL でなく) に、記録 1 つを 1 項目 (`BtwBubble`) として出す。webui だけのもので、本体の transcript には無い
- 位置:
  - アンカー (`after_uuid`) の行が読み込んだ範囲 (窓) にあれば、その行を含む項目 (fold group は 1 項目) の直後に置く。アンカーの行が項目として描かれない行なら、それより前で最後に描かれる項目の直後に置く
  - 同じ位置に入る btw が複数あれば `ts` の古い順
  - アンカーが無い記録 (聞いた時に transcript に行が無かった) と、`ts` が窓の範囲の中なのにアンカーの行が窓に無い記録 (compact・巻き戻し等で transcript から消えた) は、`ts` の時刻の位置に置く (`slotsByTime`、worker の say と同じ並び)
  - `ts` が窓の先頭より古い記録は、過去分を読み込んでアンカーか `ts` の位置が窓に入るまで出さない (窓の外の行と同じ扱い)
  - 窓に新しい行が来て並びが変わっても、同じ記録は同じ要素のまま描く (key は `id`。DR-0050 §10 の時刻で合流させるバブルと同じ)
- 形: 上に質問 (ユーザの発言の吹き出しと同じ右寄せの形で、頭に `btw` の札)、下に答え (応答の吹き出しと同じ markdown の描画)。全体を 1 つの枠で囲み、枠は点線にして本体の会話でないことを示す。footer に model / effort と経過時間
- `running` の間は答えの下に `btw 応答中… 12s` と、`tool` があれば `(Read)` を出し、横に `取り消し` ボタン (押すと `btw_cancel`、押した後は disabled)。`failed` / `canceled` は答えの下に `error` を warn の色で出す
- 位置・ブックマーク・jsonl のトグル・既読は持たない。🔔 / 🔐 / ⭐ / 👤 のフィルタの間は出さない。画面内検索は描画された文字なので当たる
- 新しい btw が来た時、TL が末尾を追従していれば末尾追従の既存の規則のまま追う (アンカーは直前の行なので、走っているセッションでは末尾の近くに入る)

### 8. FAB のチェックボックス

- 送信の行の effort の select の左に `<label><input type="checkbox"> btw</label>` を置く。宛先が subagent の時は出さない (`user_message` の送信に effort が無いのと同じく、btw は main の文脈で聞くもの)
- 入れている間の見た目と文言:
  - textarea の placeholder を `btw で聞く... (本体の会話に残らない、⌘+Enter で送信)` にする
  - 送信ボタンの文字を `btw で聞く` にする
  - effort の select は in effect と ⏱️ の群だけにする。⏱️ はこの btw の effort。📌🏛️ は本体の通しを変える操作なので、btw の送信には付けない
- 送信 (ボタン / ⌘+Enter) は `user_prompt` でなく `btw_ask` を送る。`{ ok }` なら、下書きを消し、パネルを閉じ、チェックボックスを外し、effort の選択を in effect に戻す (本体への次の送信を btw と取り違えないため)。断られた時は文・選択・チェックボックスを残し、理由を FAB の注記に出す
- btw の送信は `session-input-store.ts` の送信の記録 (未確認の送信) に入れない。返事は 1 往復で、届いたか分からない状態が無い
- チェックボックスの状態は component の state だけに持ち、保存しない (リロード・パネルの開け閉めで外れる)

### 9. 保存

- 置き場は ccmsg の state dir のセッションごとの場所 `<stateDir>/sessions/` の `<sid>.btw.jsonl`。1 行が記録 1 つの全体で、daemon だけが追記する
- 書くのは 2 回: `btw_ask` で始めた時 (`running`、`response` は空) と、終わった時 (最後の記録)。走っている間の答えの伸びは書かない (§5 の push だけ)。読む時は同じ `id` の後の行が前の行に勝つ
- daemon の起動の後に読んだ記録が `running` のまま終わっていれば、`failed` (`error` は「daemon が止まった」) として扱い、その行を追記する。daemon が止まる時は走っている btw の process group を止める
- 読むのはそのセッションの購読の始まり (§5) で、ファイルごとメモリに持ち、以後は追記の分を足す

Design rationale: `<sid>.json` の中に入れない。あのファイルは `ccmsg sidecar begin` (別のプロセス) が begin のたびに丸ごと書き直すもので、daemon が同じファイルに書くとプロセスをまたいだ読み書きの順序を揃える仕組みが要り、begin が btw の記録を消す。`bookmarks.json` 等の全セッション 1 ファイルの形にもしない。答えの文は長く (数 KB)、1 件足すたびに全セッション分を書き直すことになる。セッションごとの追記のファイルなら、書くのは 1 行で、読むのはそのセッションを開いた時だけになる。

### 10. 同時・本体の状態との関係

- **同時に複数**: 許す。各 btw は独立した fork のプロセスで、互いに影響しない。上限は daemon 全体で `BTW_MAX_CONCURRENCY` (§6)
- **本体が応答中**: 許す。fork はその時点で transcript に書かれている所までを文脈にする (応答の途中の行も含む)。アンカーはその時点の最後の行で、TL では応答の途中の項目の直後に入る。本体の応答は止めない・待たない。途中の行 (結果の無い tool_use) で終わる transcript からの fork が答えられるかは未検証 (Context)
- **btw の途中で本体が終わる・再起動する・`/clear` する**: btw は止めない。答えは元の sid の記録に残り、その sid の TL を開けば出る。`/clear` の後の新しい sid の TL には出ない
- **本体が既に終わっているセッション**: daemon が cwd と config dir を知っていれば (peers の行が残っている間) 聞ける。transcript が読めなければ claude が失敗し、記録が `failed` になる

### 11. SESSIONS での fork の扱い

- 対話でないセッション (`entrypoint` が `sdk-cli` / `sdk-ts` / `sdk-py`、`SDK_ENTRYPOINTS` を protocol に移して daemon と webui で共有する) は、owner の木 ([DR-0043](./DR-0043-sidebar-folds-and-globals.md) §10) と Errors / Waiting (§12) に入れず、`others` の下の一番下の fold `Non-interactive (n)` にまとめる。既定で閉じ、開閉は他の fold と同じく `ccmsg.sessionList.folds` の `non-interactive` の鍵で覚える
- btw の fork だけでなく、人や script が `claude -p` / SDK で起こしたセッションも同じ扱いになる (kawaz: interactive かどうかは区別がつく)
- `entrypoint` は agents の行 (`AgentInfo.entrypoint`) から読む。agents の poll は config dir の `sessions/` の変化で回る (fs.watch) ので、fork が `sessions/<pid>.json` を書けば agents の行はすぐ届く。agents の行の無い行 (peers だけの行、`entrypoint` を書かない古い Claude Code) は対話として扱う
- btw の記録や fork の sid を SESSIONS の判定に使わない (判定の材料を `entrypoint` 1 つにする)

### 12. やらないこと

- 答えを本体のセッションに送る・本体の transcript に書く・本体の会話に引き継ぐ操作
- btw の続きの質問 (btw の会話の継続)。`--no-session-persistence` の fork は resume できない。続けて聞く時は新しい btw を送る (本体の文脈から聞き直す)
- subagent / teammate の文脈での btw
- FAB での model の選択 (DR-0041 §6.3 と同じ)
- tool の集合・permission mode を btw のために変えること (§2、§3)
- fork が書き換えたファイルを本体のセッションに知らせること (§3)
- TUI・CLI・エージェントの tool からの btw

## 裁定 (kawaz 2026-11-22)

1. **btw コマンドは config の command にする** (§2)。daemon が PATH の `claude` を直接起こす形は採らない
2. **逐次表示は token の差分を 100ms ごとにまとめて送る** (§5)
3. **対話でないセッション全般を一番下の閉じた fold `Non-interactive` にまとめる** (§11)。btw の fork だけを消す形は採らない
4. **記録の寿命は `<stateDir>/sessions/` の掃除に従う** (§9)。`ccmsg sidecar begin` が mtime 30 日超のファイルを消すので、`<sid>.btw.jsonl` は最後の btw から 30 日で消える。消す操作は持たない
5. **fork の中の副作用は前置きの指示だけで扱う** (§3)。前置きは既定として「知らせない」と書き、依頼の文に知らせ方の指示があればそちらに従わせる。daemon は fork の sid の行の say の発声・許可依頼の音を止めない
6. **文言は §7、§8、§11 のとおり** (`btw`、`btw で聞く`、placeholder、`btw 応答中…`、`Non-interactive`)
7. **前置きは §3 のとおり**。ファイルの書き込みを止める行は付けない

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| 本体のセッションの組み込みの `/btw` を module の `$.command.run` で走らせ、答えを拾う | kawaz の指示 (本体の機能に乗っからない)。TUI の画面にしか出ない答えを webui に運ぶ口が無い |
| 本体のセッションに質問を送り、答えの後に transcript から消す | transcript は Claude Code のもので、ccmsg が書き換えない。本体の次の request の文脈も変わる |
| `--append-system-prompt` で btw の指示を渡す | resume は記録した system prompt をそのまま送り、渡した文は使われない (Context の `--system-prompt-snapshot`) |
| `--disallowedTools Edit,Write,…` や `--permission-mode plan` で書き込みを止める | tools の列や mode の reminder が変わり、cache の前方一致が切れる (§2)。btw で細かい修正を頼む使い方も止まる (kawaz 2026-11-22) |
| 答えを最後に一度だけ出す | 長い答え・tool を使う答えで、終わるまで何も見えない |
| 答えを聞いたタブだけに持つ (ブラウザの storage / メモリ) | kawaz の裁定。別のデバイスで同じセッションを見た時に出ない |
| TL の位置を `ts` だけで決める | 本体の行の時刻と btw の時刻は別の時計で付き、応答の途中で聞いた btw がどの行の後か決まらない。アンカーの uuid なら「どこまで見て答えたか」がそのまま位置になる |
| 保存を `<sid>.json` の中 / `bookmarks.json` と同じ全セッション 1 ファイルにする | §9 の Design rationale |
| hooks module の push (`session.append`) から答えを拾う | fork の中の module に頼ることになり、module の無い面では動かない。stream-json は claude 自身の出力で、btw コマンドの標準出力にそのまま来る |
| fork の名前を `--name` で変えて SESSIONS で見分ける | 名前で判定すると人の付けた名前と混ざる。`entrypoint` で判定できる |

## Consequences

- protocol: op `btw_ask` / `btw_cancel`、`ev:"btws"` / `ev:"btw"`、`BtwRecordSchema`、ErrorCode `btw_busy` / `btw_command_unavailable`、`SDK_ENTRYPOINTS`、`BTW_PROMPT_PREFIX`。webui ↔ daemon の契約だけの変更 (module と tool の schema は変わらない)
- daemon: config の `btw_command`、組み込みの `default-btw-command.sh`、btw の process の管理と stream-json の読み、`<stateDir>/sessions/<sid>.btw.jsonl`、transcript の購読の始まりの `ev:"btws"`。設計文書 `docs/design/btw-command.md` (標準入力と標準出力の契約)
- webui: FAB のチェックボックス、TL の `BtwBubble` とアンカーの位置へのマージ、store の btw の記録、SESSIONS の `Non-interactive` の fold
- btw 1 回ごとに model の request が 1 回以上走り、費用がかかる (cache は元のセッションのものを読む)
- fork は元のセッションの名前を継ぐので、`claude agents` や他の道具からは、元のセッションと同じ名前の別の session id に見える
- fork はファイルを書き換えうる (permission mode は settings の既定のまま)。書き換えは本体の会話に載らないので、本体は次に読むまで知らない
- 記録は最後の btw から 30 日で消える (§9、裁定 4)
- 「持たない」ことを壊す変更を止める試験の観点:
  - user role 以外の `btw_ask` は `bad_request` で、btw コマンドを起こさない
  - `btw_ask` は本体のセッションの module に何も送らず、通しの上書きを変えない
  - btw コマンドの入力の `model` は、別名で起動したセッションでも正式な id で、1M のセッションでは `[1m]` を落とさない
  - 選ばれていない effort は、単発の上書きで走った最後の答えの effort でなく、セッションの今の値
  - FAB でチェックボックスを入れた送信は `user_prompt` も `request_override` も送らない。送信が受け付けられたらチェックボックスが外れる
  - 宛先が subagent の時、チェックボックスは出ない
  - `result` の前に command が終わった btw は `failed` になり、`running` のまま残らない
  - 別の接続 (別のデバイス) でそのセッションを購読しているタブにも `ev:"btw"` が届き、購読の始まりに `ev:"btws"` で保存された記録が届く
  - アンカーの行が窓にあれば btw はその項目の直後に、アンカーの行が消えた記録は `ts` の位置に出る
  - `entrypoint` が `sdk-cli` の行は owner の木にも Errors / Waiting にも出ない

## 関連

- [DR-0018](./DR-0018-session-launcher.md) — 起動コマンド (同じ形の command の前例)
- [DR-0028](./DR-0028-session-kill.md) — 再起動の model / effort の埋め方
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — `ccmsg sidecar begin` が書く state file (`<stateDir>/sessions/<sid>.json`)
- [DR-0041](./DR-0041-request-model-effort-override.md) §6.3 — FAB の effort の select
- [DR-0043](./DR-0043-sidebar-folds-and-globals.md) §10、§12 — SESSIONS の木と Errors / Waiting
- [DR-0046](./DR-0046-module-op-over-http.md) — `POST /op` の頼み手の確かめ方
- [DR-0050](./DR-0050-timeline-notification-badges.md) §10 — transcript の外のものを TL に合流させる前例
