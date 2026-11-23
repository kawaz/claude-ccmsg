# DR-0060: webui から、セッションの会話に残さない横道の質問 (btw) を、セッションの会話を継いだ fork に聞く

- Status: Accepted (2026-11-22・2026-11-23、kawaz 裁定。裁定は末尾の「裁定」) — ✅ 実装済み (module の `hooks/fork-ask.ts` と sidecar の op `fork.ask` / `fork.stop`、`hooks/tools.ts` の `comment_reply` の断り、`hooks/subagents.ts`、daemon の `btw-fork.ts`・`btw.ts`・`session-status.ts` の agent の木、protocol の `btw.ts` (前置き)・`entrypoint.ts`、webui の SESSIONS の `Non-interactive`。btw の記録・保存・配り方・画面は [DR-0062](./DR-0062-comments.md) §14)
- Date: 2026-11-22

## Context

走っているセッションの文脈を踏まえた横道の質問をしたいが、その質問と答えを本体の会話 (model に送る文脈) には残したくない時がある。Claude Code の TUI には組み込みの `/btw` があるが、webui からは使えない。kawaz の指示 (2026-11-22) の要点:

> /btw モードを作りたい。FAB の入力フォームに [ ] btw なチェックボックスを置く。

> ドキュメント内の細かい記述を修正したい時に、メインコンテキストに無駄なコンテキストを足したくない、みたいなときに、btw で一発指示して修正させる使い方は普通にありそう。その場合も修正したことは (本体に) 伝える必要はなく、必要なら僕が伝える。

> 質問したデバイスのみに表示されるのはもったいないので、セッション毎の保存をする ccmsg 内の場所に、そのセッション内のどことセットかを {ts, 直前の uuid, btw プロンプト, レスポンス} な感じで保存しておけば、それがセッションにあれば別デバイスにも配れて、webui 側でマージすれば良さそう。

kawaz の案 (2026-11-23): mod が本体の会話を引き継いだ fork の subagent (tool あり) を起こし、終わりの知らせが本体の会話に入る前に mod が握りつぶし、答えの文を daemon に送る。

### 読んで分かった前提 (Claude Code 2.1.330 の実測、[findings 2026-11-23-btw-via-agent-fork](../findings/2026-11-23-btw-via-agent-fork.md))

- hooks module の `$.agent.spawn({ subagentType: "fork", prompt, description })` は、本体の会話を継いだ background の subagent を起こす。fork は本体の tool・permission mode (auto mode の classifier を含む)・model・effort を継ぎ、ファイルを読み書きできる。`model` を渡しても無視され、effort の欄は無い
- fork の最初の request は本体が最後に送った request の後ろに、合成の `Agent` の tool_use と指示を足したもので、本体の prompt cache を全部読む (作るのは 600〜1,250 token)。fork が走っても本体の次の request の cache は外れない
- plugin が起こした fork の終わりの知らせは本体の会話に入らない。`agent.report` の hook で `{ consumed }` を返せば、版で扱いが変わっても入らず、`/compact` の後に `task_status` も残らない
- 答えは fork の `turn.complete` の `answer` と `agent.report` の `text` に全文で来る。`turn.complete` の `usage` は fork の全 request の合計。token 単位の逐次は無い
- `$.agent.call({ tool: "TaskStop", input: { task_id } })` で止まる
- 本体の turn の途中でもすぐ走り、本体の turn は止まらない。fork は本体の書きかけの応答を見ない
- `/compact` と `/clear` の直後 (本体が次の request を送る前) の fork は、指示の後ろに instructions 等の attachment が付き、cache を作り直し、3 件中 1 件は指示を見失った
- fork が tool を使うと、本体の transcript に `type: "tools-used"` の行 (tool の名前の一覧) が残る。TUI の下の行には agent の一覧が出る
- `$.agent.limits()` は `{ concurrent: 20, … }`
- 別プロセスの `claude -p --resume <sid> --fork-session` は transcript から会話を組み直すので、長いセッションでは本体の送った会話と途中から違い、prompt cache が外れた ([findings 2026-11-22-btw-fork-cache-miss-opus-session](../findings/2026-11-22-btw-fork-cache-miss-opus-session.md))。`$.model.fork` は cache を全部読むが tool を使えない ([findings 2026-11-22-native-btw-from-module](../findings/2026-11-22-native-btw-from-module.md) §4)

## 目的

走っているセッションの文脈を踏まえた質問・依頼を webui から投げ、その答えを、そのセッションを見ているどの webui (別のデバイスも) でも、会話のどの時点で聞いたかが分かる位置で読める。質問と答えは本体の会話に入らず、本体の次の応答にも影響しない。

増やしたくないもの:

- 本体の会話への作用 (btw は本体の会話・通しの上書き・prompt の列のどれも変えない)
- claude のプロセス (btw のために claude を起こさない。走っているセッションの中で fork する)
- SESSIONS の判定の材料 (対話でないかは Claude Code の `entrypoint` 1 つで決め、btw だけの印を別に持たない)

## Decision

### 1. 経路

webui (user role) が btw のコメントを足す (`comment_add` の `btw: true`、[DR-0062](./DR-0062-comments.md) §14) → daemon がそのセッションの hooks module に sidecar の op `fork.ask { key, prompt }` を頼む → module が fork を起こし (§2)、答えを受け取って (§4) `fork.ask` の結果で返す → daemon が答えの記録にする。

- daemon が頼むのは、そのセッションの走っている run の module のうち、`describe` で `fork.ask` を持つと答えた最初の 1 つ。他の経路は無い。走っている run が無ければ `no_module` (セッションが別の id に移っていれば `session_changed`)、`fork.ask` を知らない module だけなら `old_module` (再起動を促す)、`describe` に 5 秒の内に答えなければ `no_answer` で、どれも答えの記録が `failed` になり、理由と次にすることを文で持つ
- btw の記録・保存・配り方・TL と FAB の見せ方・取り消しと聞き直しの op・アンカー (聞いた時点の transcript の最後の行) は [DR-0062](./DR-0062-comments.md) §14 が正本

### 2. fork の起こし方 (module)

- `$.agent.spawn({ subagentType: "fork", prompt: <前置き + 質問>, description: "ccmsg btw" })`。fork は本体の会話・tool・権限 (auto mode なら classifier が fork の tool を判定する) を継ぎ、ファイルの書き込みも止めない
- `$.session.version()` が 2.1.330 より前なら起こさず `old_engine` (版を添える)。spawn が断られたら `denied`
- **`/compact` と `/clear` の直後**: `session.compact` (本体のもの。precompute・skip・agentId 付きは除く) と `command.run` の `clear` の後、本体の `turn.step` (agentId の無いもの) が来るまで `fork.ask` は `not_ready` で、答えの記録は「本体が次に応答した後にもう一度」の文で `failed` になる。その間の fork は指示を見失いうるため (Context)
- **module の読み込み直し**: 前の読み込みが起こした fork は、`$.agent.list()` に `type: "fork"`・`description: "ccmsg btw"`・`spawnedBy` ありで載るものとして見分け、その `agent.report` を取り (§4)、`comment_reply` を断る (§4)。`/compact` と `/clear` の直後の状態は読み込み直しで消える
- **subagent の一覧と agent の木に出さない**: module が facts で送る subagent の一覧 (`hooks/subagents.ts`) と、daemon が transcript の `subagents/*.meta.json` から作る agent の木 (`agentType: "fork"`・`description: "ccmsg btw"`・`pluginSteered: true`) から btw の fork を外す。本体の transcript の `tools-used` の行は webui の TL が描かない。TUI の agent の一覧は Claude Code のもので、消さない

Design rationale: fork を別プロセス (`claude -p --resume --fork-session`) で起こすと、長いセッションで prompt cache が外れる (Context)。`$.model.fork` は cache を全部読むが tool を使えず、btw で細かい修正を頼む使い方 (kawaz) ができない。走っているセッションの中の fork の subagent は、本体の request をそのまま継ぐので cache を読み、tool も使える。

### 3. プロンプトの前置き

質問の前に次の前置きを付ける (protocol の定数 `BTW_PROMPT_PREFIX`)。fork の指示は Claude Code の fork の決まり文句 (報告の体裁で返す、最初に課題を言い直す 1 行を書く、等) の後に置かれ、指示で上書きできる。

```
<btw>
これは btw (本体の会話の横道) です。ここまでの会話の文脈を踏まえて、下の質問・依頼に答えてください。このやりとりは本体の会話には残らず、答えは人が webui で直接読みます。
- 下の質問・依頼に頼まれたことだけをする。依頼に無い本体の作業の続きはしない
- 答えは親のエージェントへの報告でなく、質問した人が直接読む答えとして、質問した人の言語で書く (課題の言い直しの行や報告の見出しを付けない)
- 本体は止まっていない。本体は独立に作業を続けていて、turn の途中ならまだ作業している (書きかけの分はここに見えない)
- 既定では say / PushNotification / ccmsg の send・comment_reply 等で人や他のセッションに知らせず、結果は答えの本文に書く (依頼に知らせ方の指示があればそれに従う)
</btw>

<質問・依頼>
```

- `<質問・依頼>` は btw のコメントのブロック ([DR-0062](./DR-0062-comments.md) §4。添付は `[FILE<N>:<name>](<path>)` に置き換えた後)
- 「親のエージェントへの報告でなく … 課題の言い直しの行や報告の見出しを付けない」: 無いと fork は英語の報告の体裁や言い直しの行で答えた (findings 2026-11-23 §5)
- 「本体は止まっていない」: 組み込みの `/btw` の前置きと同じ趣旨。fork は本体がいま答えている人の発言の後ろに質問が並び、この文が無いと本体の作業を続けかけ、「本体はいま何をしているか」に待機中と答えた (findings 2026-11-22-native-btw-from-module §4)
- ファイルの書き込みを止める行は付けない (裁定 3)

### 4. 答えの受け取り方

- module は起こした fork の agentId ごとに待ち合わせる。`agent.report` の hook は自分の起こした fork (と、§2 の読み込み直しで見分けたもの) の知らせだけを `{ consumed }` で取り、他の知らせは `next(e)` に流す。`turn.complete` の hook (agentId がその fork のもの) で usage を取る
- 順はどちらが先でもよい。`agent.report` が先なら `turn.complete` を 2 秒だけ待ち、来なければ usage なしで返す。spawn の戻りより先に来た event は、spawn が飛んでいる間なら戻りを待ってから判断する
- 答えの文は `agent.report` の `text`。`completed` で文があれば `answered { text, usage?, effort? }`、文が無ければ `empty`、`failed` / `stopped` はその語の `not_answered`
- `usage` は fork の全 request の合計 (tool を使えば request の数だけ cache を読んだ分が足される)。`effort` は fork の最初の request の level
- daemon は終わりを daemon.log の `comment_btw_end` の行 (`elapsed_ms`、`ran_effort`、usage の 4 つの token 数、失敗の `reason`) に書く。usage で cache を書いた量が読んだ量より多い時 (本体の cache を読まずに会話の分を書き直した時) は warn の行 `comment_btw_cache_miss` (session_id、答えの cid、4 つの token 数) を足す。質問と答えの文は書かない
- **`comment_reply` を module で断る**: fork は本体の tool を継ぐので `comment_reply` を呼べるが、module の tool の handler は btw の fork の agentId からの呼び出しを daemon に送らず、この横道からは使えないので答えは応答の本文に書く (本文がそのまま btw の答えになる) 旨の文を返す。他の subagent / teammate からの呼び出しは [DR-0062](./DR-0062-comments.md) P6 のとおり断る

### 5. 取り消しと期限

- 人が取り消す (`comment_btw_cancel`) と、daemon はその btw の答えを `canceled` にし、同じ run の module に `fork.stop { key }` を送る。module は `$.agent.call({ tool: "TaskStop", input: { task_id } })` で fork を止める。spawn の途中に来た stop は、起きた直後に止める。`fork.stop` の結果は `stopped` / `not_running` / `refused`
- daemon は fork の答えを 30 分待ち、過ぎたら `fork.stop` を送って答えを `failed` にする (tool を何度も使う依頼は長くかかりうる。値は見積もり)。module の `describe` と `fork.stop` の答えは 5 秒待つ
- daemon が止まる時は走っている btw の答えを `canceled` (「daemon が止まった」) にし、`fork.stop` を送る (届くのを待たない)
- daemon.log に `btw_fork_stop` の行 (session_id、key、`why=canceled|timeout`、結果)

### 6. model と effort

- fork は本体の model と effort で走り、btw で選べない (spawn は model を無視し、effort の欄を持たない)。FAB で btw を入れている間は effort を選べない ([DR-0062](./DR-0062-comments.md) §14)
- 答えの記録の `model` は、セッションの main の会話が最後に答えた model の正式な id (transcript の、sidechain でも `<synthetic>` でもない最後の assistant の行の `message.model`) に、セッションが 1M の context で走っている時は `[1m]` を付けた綴り (セッション自身の綴りが `[1m]` で終わるか、module が測った context window が 1,000,000 以上)。transcript にそのセッションの family の答えが無い時はセッション自身の綴り
- 答えの記録の `effort` は、module が返した fork の最初の request の level。返らなければセッションが今走っている値 (通しの上書きの effort、無ければ module が言うセッション自身の effort、無ければ transcript の最後の答えの effort。単発の上書きは入れない)

### 7. 同時・本体の状態との関係

- **同時に複数**: 許す。btw は送ったらすぐ fork を起こし、空きを待つ列を持たない。同時に走る数の上限は Claude Code の側 (`$.agent.limits().concurrent`) で、ccmsg は数えない
- **本体が応答中**: 許す。fork は本体が最後に送った request までを文脈にし、本体の書きかけの応答は見ない。本体の応答は止めない・待たない
- **本体の `/compact` と `/clear` の直後**: §2 の `not_ready`
- **本体が終わったセッション**: 走っている run の module が無いので聞けない (§1 の `no_module`)
- **resume の直後** (本体がまだ request を送っていない): 答える。fork は終了前の本体の最後の request を読む

### 8. SESSIONS の対話でないセッション

- 対話でないセッション (`entrypoint` が `sdk-cli` / `sdk-ts` / `sdk-py`、protocol の `SDK_ENTRYPOINTS`) は、owner の木 ([DR-0043](./DR-0043-sidebar-folds-and-globals.md) §10) と Errors / Waiting (§12) に入れず、`others` の下の一番下の fold `Non-interactive (n)` にまとめる。既定で閉じ、開閉は他の fold と同じく `ccmsg.sessionList.folds` の `non-interactive` のキーで覚える (裁定 1)
- `entrypoint` は agents の行 (`AgentInfo.entrypoint`) から読む。agents の行の無い行 (peers だけの行、`entrypoint` を書かない古い Claude Code) は対話として扱う

## 裁定

kawaz 2026-11-22:

1. **対話でないセッション全般を一番下の閉じた fold `Non-interactive` にまとめる** (§8)
2. **fork の中の副作用は前置きの指示だけで扱う** (§3)。前置きは既定として「知らせない」と書き、依頼の文に知らせ方の指示があればそちらに従わせる
3. **前置きは §3 のとおり**。ファイルの書き込みを止める行は付けない

kawaz 2026-11-23:

4. **btw の fork は、mod が本体の会話を継いだ fork の subagent (tool あり) として起こし、終わりの知らせは mod が握りつぶし、答えの文を daemon に送る** (§2、§4)

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| 本体のセッションの組み込みの `/btw` を module の `$.command.run` で走らせ、答えを拾う | TUI の画面にしか出ない答えを webui に運ぶ口が無い (findings 2026-11-22-native-btw-from-module) |
| 別プロセスの `claude -p --resume <sid> --fork-session --no-session-persistence` で fork する | transcript から組み直した会話が本体の送った会話と途中から違い、長いセッションで prompt cache が外れる (Context)。claude のプロセスと、それを起こす command も要る |
| `$.model.fork` で答えを得る | tool を使えず、btw で細かい修正を頼む使い方ができない |
| 本体のセッションに質問を送り、答えの後に transcript から消す | transcript は Claude Code のもので、ccmsg が書き換えない。本体の次の request の文脈も変わる |
| 終わりの知らせを `prompt.submit` の hook で `{ drop }` する | transcript と画面に「Prompt dropped by a hook」の行が残り、task も終わっていない扱いで残る (findings 2026-11-23 §3) |
| `/compact` と `/clear` の直後も fork を起こす | 指示の後ろに attachment が付いて指示を見失うことがあり、cache も作り直す (Context) |
| fork の中の `comment_reply` を settings の `permissions.deny` で止める | fork は本体の権限を継ぎ、本体からは使える tool なので、本体の側でも止まる |
| 答えを聞いたタブだけに持つ (ブラウザの storage / メモリ) | kawaz の指示。別のデバイスで同じセッションを見た時に出ない |

## Consequences

- protocol: sidecar の op `fork.ask` / `fork.stop` とその結果、`FORK_DESCRIPTION`、`BTW_PROMPT_PREFIX` / `btwPrompt`、`SDK_ENTRYPOINTS` / `isInteractiveEntrypoint`。btw の記録と op は [DR-0062](./DR-0062-comments.md) の Consequences
- module: `fork-ask.ts` の待ち合わせと `agent.report` / `turn.complete` / `turn.step` / `session.compact` / `command.run` の hook、`comment_reply` の断り、subagent の一覧から外すこと
- daemon: `btw-fork.ts` (頼む run の選び方、`fork.stop`、期限、失敗の文)、`btw.ts` (答えの記録の model / effort、アンカー、終わりの記録と log の行)、agent の木から外すこと
- webui: SESSIONS の `Non-interactive` の fold。TL の `tools-used` の行を描かない
- btw 1 回ごとに model の request が 1 回以上走り、費用がかかる (cache は本体のものを読む)
- fork はファイルを書き換えうる (本体の権限のまま)。書き換えは本体の会話に載らないので、本体は次に読むまで知らない
- btw の fork には Claude Code 2.1.330 以降が要る (`$.agent.spawn` の fork と `agent.report`)。それより古い版では、`agent.report` を hook する ccmsg の module ごと読み込まれない (2.1.321・2.1.325〜2.1.328 の `claude plugin test` で `hooks module did not load: "agent.report" is not an event`、2026-11-23)。plugin の `engines` は足さない (効くのは git の url からの install だけ)
- 自前の起動コマンドが `print` 等の claude の print のオプションの field を受ける形になっていても、daemon はそれらを起動の入力に入れないので害は無い
- 「持たない」ことを壊す変更を止める試験の観点:
  - `fork.ask` で起こす fork は `subagentType: "fork"` で、前置きを付けた全文を prompt にし、effort を渡さない
  - 自分の起こした fork の `agent.report` だけを consume し、他の subagent の知らせは本体に流す
  - btw の fork からの `comment_reply` は daemon に送らずに断る
  - `/compact` と `/clear` の後、本体の次の `turn.step` までは fork を起こさない
  - btw の fork は facts の subagent の一覧にも daemon の agent の木にも出ない
  - 取り消しと期限切れで `fork.stop` が同じ run に送られる
  - `fork.ask` を知らない module・module の無いセッションの btw は、理由と次にすることの文で `failed` になる
  - `entrypoint` が `sdk-cli` の行は owner の木にも Errors / Waiting にも出ない

## 関連

- [DR-0062](./DR-0062-comments.md) §14 — btw の記録・保存・配り方・画面
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — hooks module と sidecar
- [DR-0041](./DR-0041-request-model-effort-override.md) — セッションの通しの上書き (effort の読み方)
- [DR-0043](./DR-0043-sidebar-folds-and-globals.md) §10、§12 — SESSIONS の木と Errors / Waiting
- [findings 2026-11-23-btw-via-agent-fork](../findings/2026-11-23-btw-via-agent-fork.md) — mod から起こす fork の実測
