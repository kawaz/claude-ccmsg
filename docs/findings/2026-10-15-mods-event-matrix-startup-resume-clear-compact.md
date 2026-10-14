# Claude Mods の startup / resume / clear / compact での event 列と、最初の turn の前の注入

- Date: 2026-10-15
- 対象: Claude Code 2.1.299。classic hook (`hooks/session-start.ts` の SessionStart、matcher `startup|resume|clear|compact`) を全廃して hooks module に寄せる前提で、classic.SessionStart の各 source に当たる mods の event と、model に文脈を注入する場所を実機で決めるための観測
- 方法: 隔離 config home (`$LAB/config`) に `on('*')` の観測 mod を `--plugin-dir` で載せ、`ANTHROPIC_BASE_URL` を手元の Messages API の代役 (`$LAB/fakeapi`、全 request の body を記録して固定の文を返す) に向けた。認証情報は使っていない (ダミーの API key 文字列)。turn と compaction は代役が答えるので実際に回り、**「model に届いたか」は model の復唱でなく request の body に印の文字列があるかで判定した**。対話は専用 socket の tmux (`tmux -S $LAB/tmux.sock`) で起動し、操作は `send-keys`
- 印: 注入の口ごとに `MARK-A` 〜 `MARK-I` の文字列を入れた (下の「観測 mod」)。各 request でどの印がどこ (何番目の message の何番目の block、role) にあるかを数えた
- 制約: 代役の API に対する request の形であって、first-party の API に送る時の形が同じかは見ていない。組織が管理する機械 (`sec-default`) での挙動は見ていない (その機械が無い)

## 判明した事実

### classic.SessionStart の各 source と mods の event

| classic.SessionStart の source | 同じ契機の mods の event | 実測 |
|---|---|---|
| `startup` | `session.start` | 対話 4 本・`-p` 2 本。対話では `session.start` と `classic.SessionStart` が同じ ms か 1 ms 差で dispatch され、dispatch 順を記録した 4 本 (resume 1 本を含む) ではすべて `session.start` が先。`-p` では `classic.SessionStart` が `session.start` の 13〜16 ms 前に来る (resume を含む 6/6) |
| `resume` (`--resume <sid>` と `--continue` の両方) | `session.start` (新しい process なので毎回起きる) | 対話 `--resume` 1 本・`--continue` 1 本、`-p --resume` 3 本・`-p --continue` 1 本。`--continue` でも source は `resume` |
| `clear` | **無い**。`command.run { command: 'clear' }` → `classic.SessionEnd (reason: clear)` → `session.end (reason: clear)` → `classic.SessionStart (source: clear、新 id)` の順で、`session.start` は起きない | 3/3。`command.run` の `next(e)` が resolve するのは `classic.SessionStart (clear)` の dispatch の後 (2/2)。module は再 load されない (同じ instance、register は再実行されない) |
| `compact` (手動・自動) | `session.compact` (`trigger: manual` / `auto`)。`command.run (compact)` → `session.compact` → `classic.PreCompact` → `classic.SessionStart (source: compact、同じ id)` → `classic.PostCompact` → `session.compact` の `next` が resolve → `command.run` の `next` が resolve | 対話の手動 3 回・自動 1 回、`-p` の `/compact` 1 回。`session.start` は起きない。自動 compact は `turn.start` の後、その turn の request の前に起きた (1/1) |

- engine の `session.start` は「process ごと・module の読み込みごと」なので、hot reload でも起きる (対話 1 回: reload で module の instance が変わり、`register` → `engine.create` → `session.start` が走った。`classic.SessionStart` は起きない)
- `session.start` の `e` には source に当たる欄が無い (`{ cwd, surface, isInteractive }`)。startup と resume を mods の event だけで区別する観測はしていない

### 最初の turn の前の注入: 口ごとの到達

`○` は印が次の request の body にあった、`×` は無かった。サンプル数は括弧内。

| 口 | startup 対話 | startup `-p` | resume / continue | `/clear` の後 | compact の後 |
|---|---|---|---|---|---|
| A: `session.start` の after で `$.session.append` | ○ (4) | ○ (2) | ○ (5) | × (起きない) | × (compaction で要約側に落ちる。下記) |
| B: `classic.SessionStart` の after で `$.session.append` | ○ (4) | × refuse (2) | 対話 ○ (2)、`-p` × refuse (4) | ○ (3) | × 捨てられる (5) |
| C: `classic.SessionStart` の結果 `additionalContext` | ○ (4) | ○ (1) | ○ (5) | ○ (3) | ○ (5) |
| D: `prompt.context` に独自 block | ○ (4) | ○ (2) | 前の内容のまま (作り直されない、4) | ○ 作り直し (3) | ○ (5、作り直しを確認できたのは 2) |
| E: `prompt.submit` の before で、`$.state` の印が無ければ `$.session.append` して印を置く | ○ (4) | ○ (2) | ○ 自動で再注入 (5) | ○ 自動で再注入 (3) | × 再注入されない (`$.state` が残るため、対話 4) |
| F: `turn.start` の before で同上 | × その request に間に合わない (全件) | × | × | × | × |
| I: `session.compact` の after で `$.state` に「compact 済み」を置き、次の `prompt.submit` の before で append | — | — | — | — | ○ (1) |
| Z: `engine.create` で `$.session.append` | `$` が空で TypeError (`undefined is not an object (evaluating '$.session.append')`、全件) | | | | |

- **B の refuse**: `-p` では起動時 (startup / resume) の `classic.SessionStart` の時点で `$.session.append` が `HooksError: $.session.append: refused: this session keeps no conversation to append to` で拒まれる (`-p` の 6/6)。同じ `-p` でも `/compact` の中の `classic.SessionStart (compact)` では append は通った (ただし下記のとおり消える)。`-p --continue` ではこの時点の `$.session.id()` が `e.session_id` と違う id を返した (1/1。`-p --resume` では一致、3/3)
- **compaction 中の append は消える**: `classic.SessionStart (compact)`・`classic.PostCompact` の after・`session.compact` の after のどこで append しても、行は transcript の `compact_boundary` より前に書かれ、compact 後の request に載らない (手動・自動・`-p` の計 5 回すべて)。compact の後に足すなら、次の `prompt.submit` で append する (I)
- **compaction の前に append 済みの行**: 普段は summary に置き換わって消える。ただし `compactMetadata.preservedSegment` が付いた compaction (今回は `preTokens` が約 99 万の 2 回だけ) では末尾の数行が summary の後に残り、そこに入っていた A が compact 後も載った (1 回)。保持区間が付く条件は切り分けていない
- **F (`turn.start`) は遅い**: append は成功し transcript にも入るが、その turn の最初の request には載らない。次の request からは「その turn の user message の末尾 (assistant の応答の前)」に差し込まれた形で載る (全件)。前の request の prefix を後から変えるので、prompt cache の再利用もそこで切れる
- **C の載り方**: user message の後に置かれた `role: "system"` の message に、`SessionStart hook additional context: <文>` の形で、Environment 等の他の attachment と一緒に入る。transcript では `attachment.type: hook_additional_context` の行として保存され、resume のたびに 1 つずつ増える
- **C の型**: 結果の `additionalContext` は `string[]` (hook ごとに 1 要素)。文字列を返すと hook ごと捨てられ、debug log に `[ERROR] mods-matrix: classic.SessionStart hook skipped: returned the wrong shape (additionalContext of the wrong type)` が出る (同じ hook の中で先に済ませた `$.session.append` は残る)
- **D の載り方**: 最初の user message の context block (`<system-reminder>\n# modsMatrix\n...`)。`/clear` の後は新しい session id で作り直され、resume では transcript にある古い block がそのまま使われる (新しく作った答えは送られない)。`-p` の `/compact` の後の resume では、作り直した block が最初の message ではなく最新の user message の先頭に載った (1 回)
- **A・B・E の位置**: どれも同じ user message の中で、context block の後・人の prompt の前に並ぶ (対話の startup では B → A → E → prompt の順)
- **resume のたびに積み重なる**: A・C・E は resume ごとに 1 つずつ新しく足される (前の resume で足したものも残る。`--resume` → `--continue` → `-p --continue` → `-p --resume` で 4 組まで積み上がったのを確認)

### `$.state` と module の生死

| 場面 | module の再 load (`register` の再実行) | `$.state` |
|---|---|---|
| startup / resume / continue (対話・`-p`) | 新しい process なので load される | 空から始まる (前の process の値は無い、全件) |
| `/clear` | されない (3/3) | `classic.SessionStart (clear)` の hook の入口ではまだ前の session の値の一部が読める (key によって読めたり消えていたりした: 3/3 で何かしら残っていた)。次の `prompt.submit` の時点では全 key 消えている (3/3) |
| compact (手動・自動) | されない | 残る (対話 4 回・`-p` 1 回) |
| hot reload (mod のファイルを保存) | される (instance が変わる) | 残る (1 回)。`session.start` が再び走るので、A はセッションの途中でもう 1 回足された |

## 実用的な示唆 / ベストプラクティス

### classic hook を全廃する時の対応

| classic.SessionStart の source | mods での拾い方 |
|---|---|
| startup / resume | `session.start` (after)。両者の区別が要らない処理 (state file の書き出し、`daemon start`) ならこれ 1 つで足りる。hot reload でも走るので冪等にする |
| clear | `command.run` を `{ command: 'clear' }` で hook し `await next(e)` の後 (resolve した時点で新しい session は始まっている)、または `session.end` の `reason: 'clear'` で「次の session」を待つ。`classic.SessionStart (clear)` は今回の機械では mod に届いた (3/3) が、classic を全廃する目的なら使わない |
| compact | `session.compact` の after。session id は変わらない |

`$.state` を「この session で済ませた」の印に使う時、`/clear` の直後の hook の入口で読むと前の session の値が見えることがある。印を読むのは `prompt.submit` 以降にする。

### 最初の turn の前に文脈を入れる場所

推奨は **`prompt.submit` の before で、`$.state` の印が無ければ `$.session.append` して印を置く** (E)。加えて **`session.compact` の after で「compact 済み」の印を置き、次の `prompt.submit` で足し直す** (I)。

- 理由: 対話と `-p`、startup / resume / continue / `/clear` / compact のすべてで次の request に載ることを確かめた唯一の組み合わせ (C を除く)。`/clear` と resume では `$.state` が空になるので何もしなくても再注入され、compact だけ I で補う。hot reload では `$.state` が残るので二重にならない
- 位置: 人の prompt と同じ user message の、prompt の直前
- 代わりの口との比較

| 口 | 全場面で届くか | `-p` | 組織が管理する機械 | 問題 |
|---|---|---|---|---|
| E + I (`prompt.submit` + `$.state`) | ○ | ○ | `prompt.submit` と door `note` の append は `sec-default` の対象外 (リファレンス `capabilities` の記述、未検証) | resume のたびに 1 つ増える。最初の `prompt.submit` が来るまでは入らない (人以外の submit、peer の配送等でも最初の 1 回が入る) |
| A (`session.start` + append) | `/clear` と compact で × | ○ | 同上 | `/clear` と compact を別に拾う必要がある。hot reload で重複する |
| C (`classic.SessionStart` の `additionalContext`) | ○ | ○ | user tier の `classic.*` は飛ばされる (リファレンス) | classic を全廃する目的と逆。role `system` の message として prompt の後に載る |
| D (`prompt.context`) | resume で古いまま | ○ | 飛ばされる (リファレンス) | 中身が resume で更新されない |
| B (`classic.SessionStart` + append) | compact で × | × refuse | 飛ばされる | |
| F (`turn.start` + append) | 全場面で × | × | | その turn に間に合わず、後から prefix を変える |

- resume ごとに積み重なるのを避けたいなら、`$.session.messages()` で既に入っているかを見てから足す手はある (未検証)

### 実験の作り方

- 「model に届いたか」は、`ANTHROPIC_BASE_URL` を手元の代役に向けて request の body を記録すると、認証も model の応答も要らずに決まる。compaction も代役が summary を返せば回る (手動・自動とも)。自動 compact は代役が返す `usage.input_tokens` を大きくし、`--settings '{"autoCompactEnabled":true}'` で起こした
- 隔離 config home の `.claude.json` に `hasCompletedOnboarding`、ダミー鍵の末尾 20 字を `customApiKeyResponses.approved`、作業ディレクトリの realpath を `projects.<path>.hasTrustDialogAccepted: true` で置くと、初回のダイアログ (テーマ・API key の確認・trust) が出ずに対話が始まる
- `$.state` を使う mod は、`types/index.d.ts` に `declare module 'claude-code' { interface PluginState { '<plugin>': { <key>: <型> } } }` を置かないと `claude plugin validate` が `mods-matrix.boot is not declared: the manifest's types contract must name it in interface PluginState { ... }` で落ち、読み込めない

## 検証の詳細

### 実行した run

| run | 起動 | 操作 | mod の版 |
|---|---|---|---|
| S1a | `-p "hello-p1"` | 1 turn | C が文字列 (wrong shape で skip) |
| S1 | `-p "hello-p1"` | 1 turn | A〜F |
| I1 | 対話 | turn ×2 → `/clear` → turn → `/compact` → turn → mod を保存して hot reload → `/compact` → turn → `/exit` | A〜F、reload 後は G・H を追加 |
| I2 | 対話 `--resume <I1 の最後の sid>` | turn ×2 → `/exit` | A〜H |
| I3 | 対話 `--continue` | turn → `/exit` | A〜H、以降 `*` の記録に dispatch 順 (`nEnter`) を追加 |
| P-continue | `-p --continue "hello-pc1"` | 1 turn | 同上 |
| P-resume | `-p --resume <sid> "hello-pr1"` | 1 turn | 同上 |
| I4 | 対話 | turn → `/clear` → turn → `/clear` → turn → `/exit` | 同上 |
| I5 | 対話 `--settings '{"autoCompactEnabled":true}'` | turn → (代役の input_tokens を 990000 に) turn → turn (自動 compact) → `/exit` | 同上 |
| P-compact | `-p --resume <I5 の sid> "/compact"` | compaction | 同上 |
| P-compact-after | `-p --resume <I5 の sid> "hello-pk1"` | 1 turn | 同上 |
| I6 | 対話 | turn → `/compact` → turn → `/exit` | I を追加 |

I1 と I2 の `*` の記録は、`$.state` を読む `await` の後に行を書いていたので、同じ ms に来た event の前後は記録の順と dispatch の順が違いうる。I3 以降は dispatch 時の連番で並べた。

### event 列 (抜粋、dispatch 順)

対話の startup (I4):

```text
#register → engine.create → session.start (interactive=true) → classic.SessionStart (source=startup)
→ [B appended] → [A appended]
→ prompt.submit (hello-k1, composer) → [E appended] → classic.UserPromptSubmit → turn.start → prompt.context → [F appended] → turn.complete
```

`-p` の startup (S1):

```text
#register → engine.create → classic.SessionStart (source=startup) → [B refused] → session.start (interactive=false)
→ [A appended] → prompt.context → prompt.submit (sdk) → [E appended] → classic.UserPromptSubmit → turn.start → [F appended]
→ turn.complete → classic.SessionEnd (reason=other) → session.end (reason=other)
```

`/clear` (I4 の 1 回目):

```text
command.run (clear) → classic.SessionEnd (reason=clear, 旧 id) → session.end (reason=clear) → classic.SessionStart (source=clear, 新 id)
→ command.run の next が resolve → [B appended]
→ prompt.submit (hello-k2) → [E appended: $.state が空に戻っている] → classic.UserPromptSubmit → turn.start → prompt.context (新 id で作り直し) → [F appended]
```

手動 compact (I6):

```text
command.run (compact) → session.compact (manual) → classic.PreCompact (manual) → classic.SessionStart (source=compact, 同じ id) → [B appended]
→ classic.PostCompact (manual) → [G appended] → session.compact の next が resolve → [H appended, pendingCompact=true] → command.run の next が resolve
→ prompt.submit (hello-x2) → [I appended] → classic.UserPromptSubmit → turn.start → prompt.context → turn.complete
```

自動 compact (I5): `prompt.submit (hello-a3) → classic.UserPromptSubmit → turn.start → session.compact (auto) → classic.PreCompact (auto) → classic.SessionStart (compact) → classic.PostCompact (auto) → turn.complete`。

resume (I2、対話): `#register → engine.create → session.start → classic.SessionStart (source=resume)`。`$.state` は全 key 空。

hot reload (I1): debug log に `hooks module mods-matrix@inline reloaded in 8.1ms` が出て、新しい instance で `#register → engine.create → session.start` が走った。`$.state` の `injectedPS` / `injectedTS` は reload 前の instance が書いた値のまま読めた。

### request の中身 (印の位置)

対話の startup 直後の最初の request (I4):

```text
messages[0] user: [gitStatus 等の context] [MARK-D] [MARK-B startup] [MARK-A] [MARK-E] "hello-k1"
messages[1] system: "SessionStart hook additional context: MARK-C ... source=startup" + Environment 等
```

同じ session の 2 回目の request (I1): `messages[0]` の `"hello-i1"` の後ろに `MARK-F` が差し込まれ、`messages[3]` に `"hello-i2"`。

`/clear` の後 (I1): `messages[0]` = `[context] [MARK-D 新 id] [local-command-caveat] [/clear] [MARK-B clear] [local-command-stdout] [MARK-E] "hello-i3"`、`messages[1]` system に `MARK-C source=clear`。

手動 compact の後 (I1 の 2 回目、G・H 入り): `messages[0]` = `[context] [MARK-D 作り直し] [summary] ... "hello-i5"`、`messages[1]` system に `MARK-C source=compact`。B・G・H は無い。transcript では B・G・H の 3 行が `compact_boundary` の直前に並んでいた。

compact の後に I を足した版 (I6): `messages[0]` = `[context] [MARK-D] [summary] ... [MARK-I] "hello-x2"`。

resume の後 (I2): 前の会話 (summary と `MARK-C source=compact`) の後に、`messages[3]` = `[MARK-B resume] [MARK-A] [MARK-E] "hello-r1"`、`messages[4]` system に `MARK-C source=resume`。`MARK-D` は I1 の instance が書いた古い block のまま。

`-p` の resume (P-resume): 新しい user message に `[MARK-A] [MARK-E] "hello-pr1"`、続く system に `MARK-C source=resume`。B は refuse で無い。

### 観測 mod

`$LAB/mod/.claude-plugin/plugin.json`:

```json
{
  "name": "mods-matrix",
  "version": "0.1.0",
  "description": "Records every event and tries injection channels for the startup/resume/clear/compact matrix."
}
```

`$LAB/mod/hooks/hooks.json`:

```json
{ "modules": ["./register.ts"] }
```

`$LAB/mod/types/index.d.ts` (`$.state` の契約。無いと validate が落ちる):

```ts
export type ModsMatrixMark = { inst: string; at: number }
declare module 'claude-code' {
  interface PluginState {
    'mods-matrix': { boot: ModsMatrixMark; injectedPS: ModsMatrixMark; injectedTS: ModsMatrixMark; pendingCompact: boolean }
  }
}
```

`$LAB/mod/hooks/register.ts` (最終版。実験用の使い捨てで、リファレンスの observe-mod と同じく `any` で書いた):

```ts
// Lab mod for the startup / resume / clear / compact matrix.
// Records every event (`on('*')`) to $MODS_LAB_DIR/events-<inst>.jsonl, and tries
// injection channels, each with its own marker text so the request body shows
// which ones reached the model:
//   MARK-A  $.session.append in session.start (after next)
//   MARK-B  $.session.append in classic.SessionStart (after next)
//   MARK-C  classic.SessionStart result additionalContext
//   MARK-D  prompt.context: a block of this plugin's own
//   MARK-E  $.session.append in prompt.submit (before next), once per $.state 'injectedPS'
//   MARK-F  $.session.append in turn.start (before next, main only), once per $.state 'injectedTS'
//   MARK-G  $.session.append in classic.PostCompact (after next)
//   MARK-H  $.session.append in session.compact (after next)
//   MARK-I  $.session.append in prompt.submit (before next) when $.state 'pendingCompact' was set by session.compact (after next)
//   MARK-Z  $.session.append tried in engine.create ($ is expected to be empty)
// <inst> is drawn when the module is evaluated: a new one means the module was loaded again.

const INST = Math.random().toString(36).slice(2, 8)
const CLIP = 700
let registers = 0
let seq = 0
let buf: unknown[] = []
let dir: string | undefined
let timer: (() => void) | undefined
let flushing = false

const KEY_EVENTS = new Set([
  'session.start', 'session.end', 'classic.SessionStart', 'classic.SessionEnd', 'command.run',
  'prompt.submit', 'turn.start', 'turn.complete', 'session.compact', 'classic.PreCompact',
  'classic.PostCompact', 'session.append', 'prompt.context', 'classic.UserPromptSubmit', 'classic.Setup',
])

function clip(v: unknown): unknown {
  try {
    const s = JSON.stringify(v)
    if (s === undefined) return String(v)
    return s.length > CLIP ? s.slice(0, CLIP) + '...<clipped>' : JSON.parse(s)
  } catch (err) {
    return `<unserializable: ${String(err)}>`
  }
}

function log(entry: Record<string, unknown>): void {
  seq += 1
  buf.push({ inst: INST, n: seq, t: Date.now(), ...entry })
}

async function flush($: any): Promise<void> {
  if (flushing || dir === undefined || buf.length === 0) return
  flushing = true
  try {
    const lines = buf; buf = []
    const path = `${dir}/events-${INST}.jsonl`
    let prev = ''
    try { prev = await $.fs.read(path) } catch { prev = '' }
    await $.fs.write(path, prev + lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  } finally {
    flushing = false
  }
}

async function ensureFlushing($: any): Promise<void> {
  if (timer !== undefined) return
  dir = (await $.env.get('MODS_LAB_DIR')) ?? `${$.plugin.root}/log`
  timer = $.clock.every(500, () => { void flush($) })
}

async function marks($: any): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  try { out.boot = (await $.state.get({ plugin: 'mods-matrix', key: 'boot' })).value } catch (err) { out.bootErr = String(err) }
  try { out.injectedPS = (await $.state.get({ plugin: 'mods-matrix', key: 'injectedPS' })).value } catch (err) { out.psErr = String(err) }
  try { out.injectedTS = (await $.state.get({ plugin: 'mods-matrix', key: 'injectedTS' })).value } catch (err) { out.tsErr = String(err) }
  try { out.sid = await $.session.id() } catch (err) { out.sidErr = String(err) }
  return out
}

async function inject($: any, text: string): Promise<unknown> {
  try {
    return clip(await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }))
  } catch (err) {
    return `<threw: ${String(err)}>`
  }
}

export function register(on: any): void {
  registers += 1
  log({ ev: '#register', registers })

  on('*', async ($: any, e: any, next: any) => {
    const ev = String(next.event)
    // Dispatch order and time, taken before any await (the line itself is logged after reading marks).
    seq += 1
    const entry: Record<string, unknown> = { ev, by: next.origin, nEnter: seq, tEnter: Date.now() }
    if (e && typeof e === 'object') {
      if ('agentId' in e) entry.agentId = e.agentId
      if ('agent_id' in e) entry.agent_id = e.agent_id
      if (ev === 'ui.render') entry.component = e.component
      if (KEY_EVENTS.has(ev)) entry.e = clip(e)
      else entry.keys = Object.keys(e)
    }
    if (KEY_EVENTS.has(ev) && ev !== 'session.append' && next.origin?.plugin !== 'mods-matrix') {
      try { entry.marks = await marks($) } catch (err) { entry.marksErr = String(err) }
    }
    log(entry)
    const r = await next(e)
    if (ev === 'session.append' || ev === 'classic.SessionStart' || ev === 'prompt.context' || ev === 'command.run' || ev === 'session.compact') {
      log({ ev: `${ev}#result`, r: clip(r) })
    }
    return r
  })

  on('engine.create', async ($: any, e: any, next: any) => {
    let res: unknown
    try { res = clip(await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `MARK-Z engine.create inst=${INST}` }] } })) } catch (err) { res = `<threw: ${String(err)}>` }
    log({ ev: '#inject', mark: 'Z', res })
    return next(e)
  })

  on('session.start', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await ensureFlushing($)
    const prev = await $.state.get({ plugin: 'mods-matrix', key: 'boot' })
    await $.state.set({ plugin: 'mods-matrix', key: 'boot' }, { inst: INST, at: Date.now() })
    log({ ev: '#state', key: 'boot', prev: prev.value ?? null, prevVersion: prev.version })
    log({ ev: '#inject', mark: 'A', res: await inject($, `MARK-A session.start inst=${INST}`) })
    return r
  })

  on('classic.SessionStart', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await ensureFlushing($)
    const src = e?.source
    log({ ev: '#inject', mark: 'B', res: await inject($, `MARK-B classic.SessionStart source=${src} inst=${INST}`) })
    const ctx = `MARK-C additionalContext source=${src} inst=${INST}`
    // ClassicResult.additionalContext is string[] (one entry per hook); a string is the wrong shape and the hook is skipped.
    return { ...r, additionalContext: [...(r?.additionalContext ?? []), ctx] }
  })

  on('prompt.context', async ($: any, e: any, next: any) => {
    const r = await next(e)
    let sid = '?'
    try { sid = await $.session.id() } catch {}
    return { ...r, blocks: [...r.blocks, { name: 'modsMatrix', text: `MARK-D prompt.context sid=${sid} inst=${INST}` }] }
  })

  on('prompt.submit', async ($: any, e: any, next: any) => {
    await ensureFlushing($)
    const held = await $.state.get({ plugin: 'mods-matrix', key: 'injectedPS' })
    if (held.value === undefined) {
      log({ ev: '#inject', mark: 'E', res: await inject($, `MARK-E prompt.submit inst=${INST}`) })
      await $.state.set({ plugin: 'mods-matrix', key: 'injectedPS' }, { inst: INST, at: Date.now() })
    }
    const pending = await $.state.get({ plugin: 'mods-matrix', key: 'pendingCompact' })
    if (pending.value === true) {
      log({ ev: '#inject', mark: 'I', res: await inject($, `MARK-I prompt.submit after compaction inst=${INST}`) })
      await $.state.set({ plugin: 'mods-matrix', key: 'pendingCompact' }, false)
    }
    return next(e)
  })

  on('turn.start', async ($: any, e: any, next: any) => {
    if (e?.agentId === undefined) {
      const held = await $.state.get({ plugin: 'mods-matrix', key: 'injectedTS' })
      if (held.value === undefined) {
        log({ ev: '#inject', mark: 'F', res: await inject($, `MARK-F turn.start inst=${INST}`) })
        await $.state.set({ plugin: 'mods-matrix', key: 'injectedTS' }, { inst: INST, at: Date.now() })
      }
    }
    return next(e)
  })

  on('classic.PostCompact', async ($: any, e: any, next: any) => {
    const r = await next(e)
    log({ ev: '#inject', mark: 'G', res: await inject($, `MARK-G classic.PostCompact trigger=${e?.trigger} inst=${INST}`) })
    return r
  })

  on('session.compact', async ($: any, e: any, next: any) => {
    const r = await next(e)
    log({ ev: '#inject', mark: 'H', res: await inject($, `MARK-H session.compact(after next) trigger=${e?.trigger} inst=${INST}`) })
    await $.state.set({ plugin: 'mods-matrix', key: 'pendingCompact' }, true)
    return r
  })

  on('session.end', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await flush($)
    return r
  })
}
```

### Messages API の代役

`$LAB/fakeapi/server.ts` (`FAKEAPI_DIR=$LAB/fakeapi bun $LAB/fakeapi/server.ts`)。起動時に来たのは `HEAD /api/hello`、`GET /v1/models?limit=1000`、`POST /v1/messages?beta=true` の 3 種で、`/v1/messages` には stream で答える。compaction の request は最後の message の文面で見分けて summary を返す。

```ts
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const dir = process.env.FAKEAPI_DIR!;
let n = 0;

function inputTokens(): number {
  const f = `${dir}/usage-input`;
  if (!existsSync(f)) return 1000;
  return Number(readFileSync(f, "utf8").trim()) || 1000;
}

function sse(model: string, text: string): string {
  const usage = { input_tokens: inputTokens(), output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev("message_start", { type: "message_start", message: { id: `msg_fake_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
    ev("message_stop", { type: "message_stop" })
  );
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    n += 1;
    const url = new URL(req.url);
    const raw = req.method === "GET" ? "" : await req.text();
    let body: unknown = raw;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    appendFileSync(`${dir}/requests.jsonl`, JSON.stringify({ n, t: Date.now(), method: req.method, path: url.pathname + url.search, body }) + "\n");
    if (url.pathname === "/v1/messages/count_tokens") return Response.json({ input_tokens: inputTokens() });
    if (url.pathname === "/v1/messages") {
      const b = body as { model?: string; stream?: boolean; messages?: unknown[] };
      const last = JSON.stringify(b?.messages?.at(-1) ?? "");
      const text = /detailed summary|summary of the conversation/i.test(last)
        ? `<analysis>fake</analysis>\n<summary>FAKE-SUMMARY-${n}</summary>`
        : `FAKE-REPLY-${n}`;
      const model = b?.model ?? "claude-haiku";
      if (b?.stream) return new Response(sse(model, text), { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: `msg_fake_${n}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: inputTokens(), output_tokens: 5 } });
    }
    if (url.pathname === "/v1/models") return Response.json({ data: [], has_more: false, first_id: null, last_id: null });
    return Response.json({ type: "error", error: { type: "not_found_error", message: "fake" } }, { status: 404 });
  },
});
writeFileSync(`${dir}/port`, String(server.port));
```

### 起動

`$LAB/config/settings.json` は個人面の settings から `apiKeyHelper`・`statusLine`・`extraKnownMarketplaces` と env の `ANTHROPIC_*` を抜き、`enabledPlugins` を空にしたもの。`$LAB/config/.claude.json`:

```json
{
  "hasCompletedOnboarding": true,
  "theme": "dark",
  "customApiKeyResponses": { "approved": ["<ダミー鍵の末尾 20 字>"], "rejected": [] },
  "projects": { "<$LAB/ws の realpath>": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } }
}
```

起動 (`$LAB/run-claude.sh`、対話は `tmux -S $LAB/tmux.sock new-session -d -s lab -x 160 -y 50 -c $LAB/ws $LAB/run-claude.sh --name "🤖ccmsg-verify-mods-matrix" [--resume <sid> | --continue]`、`-p` は `$LAB/ws` で直接):

```sh
exec env -i HOME="$HOME" USER="$USER" PATH="$PATH" TERM=xterm-256color LANG=ja_JP.UTF-8 \
  CLAUDE_CONFIG_DIR=$LAB/config MODS_LAB_DIR=$LAB/log TMPDIR=$LAB/tmp \
  XDG_CACHE_HOME=$LAB/xdg/cache XDG_STATE_HOME=$LAB/xdg/state XDG_DATA_HOME=$LAB/xdg/data XDG_CONFIG_HOME=$LAB/xdg/config \
  DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \
  ANTHROPIC_BASE_URL=http://127.0.0.1:$(cat $LAB/fakeapi/port) ANTHROPIC_API_KEY=sk-ant-api03-lab-dummy-key-not-a-secret-0000000000 \
  claude --plugin-dir $LAB/mod --debug --model claude-haiku-5-5 "$@"
```

操作は `tmux -S $LAB/tmux.sock send-keys -t lab -l "<文>"` の後に `send-keys -t lab Enter`。turn の終わりは観測 mod の log の `turn.complete` の行数で待った。`-p` は stdin を `< /dev/null` にしないと「no stdin data received in 3s」で 3 秒待つ。

### 未観測

- first-party の API に送る時の request の形 (代役に対しては C が `role: "system"` の message になった)
- 組織が管理する機械 (`sec-default`) で E + I が効くか (リファレンスの記述からの読みのみ)
- `/resume` コマンド (session の中から別 session に移る) と `--fork-session`
- startup と resume を mods の event だけで区別する手段
- `command.run (clear)` の after で直接 `$.session.id()` を読むこと (新 id は `classic.SessionStart (clear)` の入口で読んだ)
- 保持区間 (`preservedSegment`) が付く compaction の条件
- subagent・teammate の turn での注入

## `$.tool.register` の可視範囲と typed call

ccmsg がエージェントに使わせる口を、CLI から `$.tool.register` の tool (JSON Schema で型の付いた tool) に置き換えられるかを決めるための追加の観測。環境は上と同じ隔離 config home と代役の API で、代役に「tool を 3 つ以上持つ request (main か subagent の loop) には台本 (`script.jsonl`) の先頭の応答 (tool_use か text) を返す」機能を足し、model が tool を呼ぶ場面を再現した。probe mod は上の観測 mod とは別の `mods-tool` (下の source) で、`session.start` で 3 つの tool を登録する。

| 登録名 (model から見える名前) | `isDeferred` | handler |
|---|---|---|
| `ccmsg_send` (`mcp__mods-tool__ccmsg_send`) | `false` | `tool.call` で `next` を呼ばずに `{ result }` を返す |
| `ccmsg_deferred` (`mcp__mods-tool__ccmsg_deferred`) | `true` | 同上 |
| `ccmsg_checked` (`mcp__mods-tool__ccmsg_checked`) | `false` | `tool.call` で先に `await next(e)` を呼び、その後で `{ result }` を返す |

input schema は 3 つとも `{ session_id?: string, cwd?: string, name?: string, pid?: string, text: string }` (`required: ['text']`、`additionalProperties: false`)。

### 結論

- **置き換えは可能**。`--plugin-dir` (managed でない user tier) の mod が `session.start` で登録した tool は、対話・`-p`・subagent の request の `tools` に載り、model の呼び出しが `tool.call` の handler に届き、返した文字列がそのまま tool_result になった
- handler の中で、呼び手の session id (`$.session.id()`)、cwd (`$.session.cwd()`)、subagent なら `e.agentId` が取れる。**subagent からの呼び出しでも `$.session.id()` は親 (main) の session id** で、subagent の区別は `e.agentId` だけ (3/3)
- 制約が 4 つある
  - **engine は input schema で入力を検査しない**。`text` 欠落、`text: 123`、`pid: 42` (数値) がそのまま handler に届き、エラーにもならなかった (`-p` 4 件、subagent 1 件)。handler の入口で parse する (valibot 等) のが必須
  - **`next` を呼ばずに答えると permission の判定を一切通らない** (`tool.check`・PreToolUse・ダイアログ・auto mode の classifier のどれも起きない)。permission を通したいなら `next(e)` を呼ぶ形になるが、そうすると core まで降りて「no tool.call hook answered」のエラー結果が返る (下記)
  - **`isDeferred: true` は、`ANTHROPIC_BASE_URL` が first-party でないと効かない**。代役の URL では ToolSearch 自体が無効になり、deferred の tool も全文で `tools` に載った。`ENABLE_TOOL_SEARCH=true` で有効にすると期待どおり後ろに回った。kawaz の個人面の settings は gateway の `ANTHROPIC_BASE_URL` を持つので、同じく無効になっている可能性がある (未確認。実 session の debug log の `[ToolSearch:optimistic]` の行で分かる)
  - **hot reload で説明文を変えても、main thread の request は session 開始時の説明のまま**。subagent の request には新しい説明が載った (2/2)。tool 自体は reload 後も呼べ、新しい instance の handler が答えた

### マトリクス

| 観測 | `-p` tool search 無効 (P1) | `-p` tool search 有効 (P2) | 対話 (I1・I2・I3、有効) | subagent (I2・I3 で計 3 本) | hot reload 後 (I2・I3) |
|---|---|---|---|---|---|
| `isDeferred: false` の tool が `tools` に載る | ○ | ○ | ○ (3) | ○ (子の request 8 件すべて) | ○ (2) |
| `isDeferred: true` の tool | `tools` に全文で載る (deferral 無効) | `tools` に無く、system-reminder の deferred 一覧に名前だけ。ToolSearch の後は `defer_loading: true` 付きで `tools` に載る | 同左 (I1) | 子の deferred 一覧に名前 | — |
| handler の `$.session.id()` | main の id | main の id | main の id | **親の id** | main の id |
| handler の `e.agentId` | 無し | 無し | 無し | 子の agentId | 無し |
| handler の `$.session.cwd()` | 作業ディレクトリの realpath | 同 | 同 | 同 | 同 |
| 戻り値 `{ result: string }` | tool_result の content がその文字列、`is_error` 無し | 同 | 同 (画面には `mods-tool - ccmsg_send (MCP)(...)` と結果) | 同 | 同 |
| schema 違反の入力 | handler に届く、エラーにならない (2 件) | 同 (2 件) | — | 同 (1 件) | — |
| 未ロードの deferred tool を名前で直接呼ぶ | (deferral 無効なので該当なし) | — | handler に届いた (I1。一覧の注記は「InputValidationError で失敗する」と書くが、そうならなかった) | — | — |
| `tool.call` | 通る (handler はここ) | 通る | 通る | 通る (`e.agentId` 付き) | 通る |
| `tool.check` (`next` を呼ばずに答えた時) | 起きない | 起きない | 起きない | 起きない | 起きない |
| `tool.check` (`next(e)` を呼んだ時、`ccmsg_checked`) | — | `ask` → auto mode の classifier (代役なので判定できず) → `next` の結果は「Auto mode could not evaluate this action ...」のエラー文 | default mode: `ask` → 許可ダイアログ (「mods-tool — Ccmsg Checked Tool: (MCP)」、Yes / 以後聞かない / No) → Yes → `next` の結果は `Error: mods-tool registered the tool ccmsg_checked but no tool.call hook answered this call: ...` | — | — |
| `tool.describe` で SendMessage の説明を書き換え | 書き換えた説明が `tools` に載る | SendMessage は deferred で `tools` に無い | ToolSearch で SendMessage を読み込んだ後、書き換えた説明で載る (I1) | — | — |
| reload 後の説明文 | — | — | — | 新しい説明 (2) | main は session 開始時の説明のまま (2) |

- 「—」は観測していない欄
- `tool.describe` は登録した tool にも起き、`provider` は `{ plugin: 'mods-tool@inline', tier: 'user' }`、`isDeferred` は `isDeferred: true` で登録した方だけに `true` が入る
- `Agent` tool は今回の config では background 起動 (`isAsync: true`, `status: async_launched`) になった。auto mode では `Agent` の呼び出しも classifier に回り、代役では判定できずに拒まれたので、subagent の観測は `--permission-mode default --allowedTools Agent` で行った

### context のコスト

| request | `tools` の数 | `tools` の JSON の大きさ |
|---|---|---|
| `-p`、tool search 無効 | 23 | 59,320 byte |
| `-p`、tool search 有効 | 14 | 28,844 byte |
| 対話、tool search 有効 | 15 | 33,334 byte |
| subagent (対話の子)、tool search 有効 | 10 | 14,863 byte |

- probe の tool 1 つの entry は 487 byte (説明 54 字、property 5 つ)。説明を 70 字にすると 503 byte
- deferred の tool は、読み込まれるまで一覧の名前 1 行 (`mcp__mods-tool__ccmsg_deferred`、30 字) だけ。読み込まれると `defer_loading: true` が付いた 494 byte の entry になる
- tool search が無効だと、SendMessage 等の engine の deferred tool も全文で載り、`tools` は約 2 倍になった

### 実行した run

| run | 起動 | 台本 |
|---|---|---|
| P1 | `-p`、`ENABLE_TOOL_SEARCH` 無し | `ccmsg_send` 正常 → `text` 欠落 → `text: 123` → ToolSearch (無効なので `No such tool available: ToolSearch`) → `ccmsg_deferred` → 終了 |
| P2 | `-p`、`ENABLE_TOOL_SEARCH=true` | P1 に `ccmsg_checked` を足したもの |
| I1 | 対話、有効、auto mode | `ccmsg_send` → 未ロードの `ccmsg_deferred` → ToolSearch (`select:SendMessage,mcp__mods-tool__ccmsg_deferred`) → `Agent` (classifier で拒否され subagent は起きず) |
| I2 | 対話、有効、`--permission-mode default --allowedTools Agent` | `ccmsg_send` → `Agent` → 子が `ccmsg_send` → hot reload (説明を変更) → 同じ流れをもう 1 回 (2 回目は main と子が並行し、子向けの台本を main が取ったので子の handler の観測からは外した) |
| I3 | I2 と同じ | 台本を main / 子で振り分ける版にして `Agent` → 子が `ccmsg_send` 正常と `pid: 42` → hot reload → main の `ccmsg_send` と `Agent` → 子が `ccmsg_send` → main が `ccmsg_checked` (ダイアログで Yes) |

### probe mod (`mods-tool`)

`$LAB/mod-tool/.claude-plugin/plugin.json` は `{ "name": "mods-tool", "version": "0.1.0", "description": "Probe: $.tool.register visibility and typed calls." }`、`hooks/hooks.json` は `{ "modules": ["./register.ts"] }`。`hooks/register.ts` (最終版。説明文は hot reload の観測のため v3 に書き換えた後のもの):

```ts
// Probe for $.tool.register: registers two tools at session.start and answers them in tool.call.
//   ccmsg_send       isDeferred: false (kept in the request's tools)
//   ccmsg_deferred   isDeferred: true  (behind ToolSearch)
//   ccmsg_checked    isDeferred: false, and its tool.call hook runs next(e) first (the engine's permission path)
// Logs to $MODS_LAB_DIR/tool-<inst>.jsonl: registrations, tool.describe / tool.check / tool.call of
// these tools and SendMessage, and what the handler can read ($.session.id / cwd, agentId).
// SendMessage's description gets a MARK-DESC suffix through tool.describe.

const INST = Math.random().toString(36).slice(2, 8)
const SEND = 'mcp__mods-tool__ccmsg_send'
const DEFERRED = 'mcp__mods-tool__ccmsg_deferred'
const CHECKED = 'mcp__mods-tool__ccmsg_checked'
let seq = 0
let buf: unknown[] = []
let dir: string | undefined
let timer: (() => void) | undefined

const SCHEMA = {
  type: 'object',
  properties: {
    session_id: { type: 'string', description: 'Target session id' },
    cwd: { type: 'string', description: 'Target cwd' },
    name: { type: 'string', description: 'Target session name' },
    pid: { type: 'string', description: 'Target pid' },
    text: { type: 'string', description: 'Message text' },
  },
  required: ['text'],
  additionalProperties: false,
}

function clip(v: unknown, n = 600): unknown {
  try {
    const s = JSON.stringify(v)
    if (s === undefined) return String(v)
    return s.length > n ? s.slice(0, n) + '...<clipped>' : JSON.parse(s)
  } catch (err) {
    return `<unserializable: ${String(err)}>`
  }
}

function log(entry: Record<string, unknown>): void {
  seq += 1
  buf.push({ inst: INST, n: seq, t: Date.now(), ...entry })
}

async function flush($: any): Promise<void> {
  if (dir === undefined || buf.length === 0) return
  const lines = buf; buf = []
  const path = `${dir}/tool-${INST}.jsonl`
  let prev = ''
  try { prev = await $.fs.read(path) } catch { prev = '' }
  await $.fs.write(path, prev + lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function answer($: any, e: any, which: string): Promise<unknown> {
  const facts: Record<string, unknown> = { agentId: e.agentId ?? null }
  try { facts.sid = await $.session.id() } catch (err) { facts.sidErr = String(err) }
  try { facts.cwd = await $.session.cwd() } catch (err) { facts.cwdErr = String(err) }
  log({ ev: '#handler', which, e: clip(e), facts })
  return { result: `TOOL-RESULT ${which} text=${JSON.stringify(e.text)} sid=${facts.sid} agent=${facts.agentId} inst=${INST}` }
}

export function register(on: any): void {
  log({ ev: '#register' })

  on('session.start', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (timer === undefined) {
      dir = (await $.env.get('MODS_LAB_DIR')) ?? `${$.plugin.root}/log`
      timer = $.clock.every(500, () => { void flush($) })
    }
    for (const spec of [
      { name: 'ccmsg_send', description: 'Send a message to another Claude Code session (probe v3 after reload).', inputSchema: SCHEMA, isDeferred: false },
      { name: 'ccmsg_deferred', description: 'Deferred twin of ccmsg_send (probe).', inputSchema: SCHEMA, isDeferred: true },
      { name: 'ccmsg_checked', description: 'Twin of ccmsg_send answered after next(e) (probe).', inputSchema: SCHEMA, isDeferred: false },
    ]) {
      try { log({ ev: '#tool.register', name: spec.name, res: clip(await $.tool.register(spec)) }) } catch (err) { log({ ev: '#tool.register', name: spec.name, err: String(err) }) }
    }
    return r
  })

  on('tool.describe', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (e.tool === SEND || e.tool === DEFERRED || e.tool === CHECKED || e.tool === 'SendMessage' || e.tool === 'ToolSearch') {
      log({ ev: 'tool.describe', tool: e.tool, isDeferred: e.isDeferred ?? null, provider: e.provider, descLen: String(e.description).length })
    }
    if (e.tool === 'SendMessage') return { ...r, description: `${r.description}\nMARK-DESC appended by mods-tool inst=${INST}` }
    return r
  })

  on('tool.check', async ($: any, e: any, next: any) => {
    const r = await next(e)
    log({ ev: 'tool.check', tool: e.tool, agentId: e.agentId ?? null, input: clip(e.input, 200), r: clip(r, 300) })
    return r
  })

  on('tool.call', async ($: any, e: any, next: any) => {
    if (e.tool === SEND) return answer($, e, 'send')
    if (e.tool === DEFERRED) return answer($, e, 'deferred')
    if (e.tool === CHECKED) {
      let below: unknown
      try { below = clip(await next(e), 400) } catch (err) { below = `<threw: ${String(err)}>` }
      log({ ev: '#checked.next', below })
      return answer($, e, 'checked')
    }
    const r = await next(e)
    log({ ev: 'tool.call', tool: e.tool, agentId: e.agentId ?? null, r: clip(r, 300) })
    return r
  })

  on('turn.complete', async ($: any, e: any, next: any) => {
    const r = await next(e)
    log({ ev: 'turn.complete', agentId: e.agentId ?? null, reason: e.reason })
    return r
  })

  on('session.end', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await flush($)
    return r
  })
}
```

### 代役の API の差分 (台本)

上の「Messages API の代役」に次を足した。台本の 1 行は `{"tool_use":{"name","input"},"for"?}` か `{"text","for"?}` で、`for` (`main` / `sub`) があればその呼び手だけが取る。subagent の request は最初の message に台本の合言葉 `SUBTASK-` を含むことで見分ける (`Agent` の `prompt` に入れる)。

```ts
type Scripted = { tool_use?: { name: string; input: unknown }; text?: string; for?: "main" | "sub" };

// A line with `for` is taken only by that requester (a subagent's first message carries SUBTASK-).
function takeScript(who: "main" | "sub"): Scripted | undefined {
  const f = `${dir}/script.jsonl`;
  if (!existsSync(f)) return undefined;
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  const i = lines.findIndex((l) => { const s = JSON.parse(l) as Scripted; return s.for === undefined || s.for === who; });
  if (i < 0) return undefined;
  writeFileSync(f, lines.filter((_, j) => j !== i).map((l) => l + "\n").join(""));
  return JSON.parse(lines[i]!) as Scripted;
}

function sseToolUse(model: string, name: string, input: unknown): string {
  const usage = { input_tokens: inputTokens(), output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev("message_start", { type: "message_start", message: { id: `msg_fake_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_fake_${n}`, name, input: {} } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
    ev("message_stop", { type: "message_stop" })
  );
}

// fetch の /v1/messages の先頭で:
//   const who = /SUBTASK-/.test(JSON.stringify(b?.messages?.[0] ?? "")) ? "sub" : "main";
//   const scripted = (b?.tools?.length ?? 0) >= 3 ? takeScript(who) : undefined;
//   if (scripted?.tool_use && b?.stream) return new Response(sseToolUse(...), { headers: { "content-type": "text/event-stream" } });
//   text の応答は scripted?.text を優先する
```

起動は上の `run-claude.sh` の `--plugin-dir` を `$LAB/mod-tool` にし、tool search を有効にする run では env に `ENABLE_TOOL_SEARCH=true` を足した。代役の URL で tool search が無効になる理由は debug log に `[ToolSearch:optimistic] disabled: ANTHROPIC_BASE_URL=http://127.0.0.1:<port> is not a first-party Anthropic host. Set ENABLE_TOOL_SEARCH=true (or auto / auto:N) if your proxy forwards tool_reference blocks.` と出る。

### 未観測 (`$.tool.register`)

- managed settings の `allowedMcpServers` がある機械で user tier の登録が拒まれるか (リファレンスの記述のみ)
- `next(e)` を呼ぶ形で、許可ダイアログで No を選んだ時・deny rule がある時の `next` の結果 (許可した時の形だけ見た)。permission を通しつつ自前で答える正規の形は見つけていない
- first-party の API に対する request の形 (`defer_loading` や `tool_reference` が同じか)
- `-p` の subagent、teammate、workflow の agent からの呼び出し
- `/clear` と resume の後に登録が残るか (`session.start` は resume では起き `/clear` では起きないので、`/clear` の後に tool が残るかは要確認)
- handler の戻り値に `isError` や画像を含める形

## リファレンス (claude-mods) への反映候補

- `events` の「意味論の注意」: `/clear` の列に `command.run` の resolve の位置 (`classic.SessionStart (clear)` の dispatch の後) を足す。compact の列 (`command.run → session.compact → classic.PreCompact → classic.SessionStart (compact) → classic.PostCompact → session.compact と command.run の resolve`) と、自動 compact が `turn.start` の後・その turn の request の前に起きることを足す。根拠: 本 findings の「event 列」
- `events` の「対話と `-p` の差」の表: `session.start` と `classic.SessionStart (startup)` の順 (対話は同時に dispatch、`-p` は classic が先)、`-p` の `classic.SessionStart` の時点では `$.session.append` が refuse されること、`--continue` の source が `resume` になることを足す
- `events` の `session.start` の項: hot reload でも走る旨は既にあるが、「`$.state` は残るので、session.start で無条件に足す処理は reload のたびに重複する」を足す
- `capabilities` の `classic.*` 共通: 結果の `additionalContext` は `string[]` で、文字列を返すと hook ごと skip される (debug の文言付き)。`classic.SessionStart` の行に「model への載り方: prompt の後の `role: system` の message に `SessionStart hook additional context: ` 付きで、resume のたびに増える」(代役に対する観測と明記)
- `capabilities` の「2026-10-14 時点の未確認」の `classic.SessionStart (source: clear) が /clear で mod に届くか`: 届く (3/3) に移す
- `capabilities` の `session.append` / `prompt.context` の行と「model に文脈を足す」の表: compaction の最中 (`classic.SessionStart (compact)`・`classic.PostCompact`・`session.compact` の after) の append は `compact_boundary` より前に書かれて消えること、`turn.start` での append はその turn の request に間に合わず後から prefix に差し込まれること、`prompt.context` の独自 block は `/clear` と compaction で作り直され resume では作り直されないこと
- `practices` の「model に文脈を足す」: 「最初の turn の前に入れるなら `prompt.submit` の before + `$.state` の印、compact は `session.compact` の after で印を立てて次の `prompt.submit` で足し直す」を推奨形として足す
- `practices` の「状態の置き場」の `$.state` の寿命: 「`/clear`・resume・終了で消える」を「compact と hot reload では残る。`/clear` では次の `prompt.submit` までに消えるが、`classic.SessionStart (clear)` の hook の入口では前の session の値が読めることがある」に直す
- `dollar-api` の `state` / `develop` の validate: `$.state` の key は `types/index.d.ts` の `PluginState` の契約が無いと validate が落ちる (エラー文言付き)。観測 mod を真似て `$.state` を足す人が最初に踏む
- `lab-setup`: (1) Messages API の代役を `ANTHROPIC_BASE_URL` に向ける構成 (認証無しで turn と compaction が回り、request の body で到達を判定できる)、(2) `.claude.json` の事前設定で初回ダイアログを飛ばす方法、(3) tmux の構成を「未検証」から実測済みに (`-S` の専用 socket で普段の tmux と分ける)、(4) 観測 mod の `*` hook で `$` を `await` してから行を書くと同じ ms の event の順が入れ替わりうるので、dispatch 時に連番を取る、(5) `-p` は stdin を `/dev/null` に、(6) 今回の起動では messaging socket は `/tmp/cc-socks/` 側に作られた (終了後は残っていない)、(7) 代役に台本を持たせて tool_use を返すと tool の呼び出しも再現できる。auto mode では `Agent` や permission の要る tool が classifier に回り代役では判定できないので、`--permission-mode default` と `--allowedTools` で起動する、(8) background の `Agent` は `TMPDIR` を作業ディレクトリに向けても `/private/tmp/claude-<uid>/<cwd を変形した名前>/<session id>/tasks/` に output を作る (後始末で消す)
- `dollar-api` の `tool` / `practices` の「skill と tool の分担」: `$.tool.register` の tool の入力は engine が input schema で検査しない (handler に違反した入力がそのまま届く) ので handler の入口で parse すること、`tool.call` で `next` を呼ばずに答えると permission の判定 (`tool.check`・PreToolUse・ダイアログ・classifier) を一切通らないこと、`next(e)` を呼ぶと判定を通った後に `no tool.call hook answered` のエラー結果が返ること、handler の `$.session.id()` は subagent からの呼び出しでも親の id であること
- `practices` の「skill と tool の分担」の `isDeferred`: `ANTHROPIC_BASE_URL` が first-party でない時は `ENABLE_TOOL_SEARCH` を設定しない限り ToolSearch が無効で、`isDeferred: true` の tool も全文で載る (debug の文言付き)。未ロードの deferred tool を名前で直接呼んでも、plugin の tool なら handler に届いた
- `capabilities` の `tool.describe` の行: 「session 内で cache」の実例として、hot reload で登録し直した tool の説明は main thread の request では変わらず、以後に起こした subagent の request には新しい説明が載る。engine の deferred tool (SendMessage) の書き換えは、ToolSearch で読み込まれた後の entry に反映される
