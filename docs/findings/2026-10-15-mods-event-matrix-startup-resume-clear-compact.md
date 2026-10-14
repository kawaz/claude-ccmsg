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
  ANTHROPIC_BASE_URL=http://127.0.0.1:$(cat $LAB/fakeapi/port) ANTHROPIC_API_KEY=lab-dummy-key \
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

## `agentId` 付きの `$.session.append` で走行中の subagent に文脈を入れる

走行中の subagent (Agent tool で起こした子) の会話に、外の契機で 1 行足せるかの観測。環境は上と同じ (対話、`--permission-mode default --allowedTools Agent`、`ENABLE_TOOL_SEARCH=true`)。probe mod `mods-agent` が tool `wait` (`mcp__mods-agent__wait`) を登録し、代役の台本で子に `wait` を 2〜3 回呼ばせて tool ループを作った。`wait` の handler は 1500 ms 待ってから答え、その間の 300 ms 後に `$.clock.after` の timer (handler とは別の dispatch) から `$.session.append({ message: { type: 'user', ... }, agentId: <子の id> })` で `MARK-SUB-<k>` を足す。子の `turn.complete` の 1000 ms 後には、終わった子の id と、存在しない id (`a0000000000000000`) にも append した。子は 2 本 (A: `wait` 2 回、B: `wait` 3 回) を同じ session で順に起こした。

### 結論

- **(a) 届く**。走行中の子に `agentId` 付きで append すると、`{ message, uuid }` が返り (5/5)、**子の次の request** で、直前の tool_result と同じ user message の中の、tool_result の直後の text block として載る (5/5)。role は `user` (返り値の message は `isMeta: true`)。system の message ではない
- **(b) main には載らない**。同じ時間帯の main の request (8 件) のどれにも `MARK-SUB-*` は無かった
- **(c) 終わった子と存在しない id は拒否される**。`HooksError: $.session.append: refused: no running loop is <agentId>` で reject される (終わった子 2/2、存在しない id 2/2)。黙って捨てられることはなく、文言では終わった子と存在しない id を区別できない。終わった子は `$.agent.list()` に `status: 'completed'` で残っていた
- **(d) 同じもの**。子の `turn.start` の `e.agentId`、`turn.complete` の `e.agentId`、`$.agent.list()` の `id`、子が呼んだ tool の `tool.call` の `e.agentId` はすべて一致した (2/2)。前節の観測では、`Agent` tool の結果 (`{ isAsync: true, status: 'async_launched', agentId }`) の `agentId` も子の `tool.call` の `e.agentId` と一致した

### 観測

| 子 | append (走行中) | 結果 | 子の次の request での位置 | main の request |
|---|---|---|---|---|
| A (`aa3dff…`) | `MARK-SUB-1` (1 回目の `wait` の最中) | `{ message, uuid }` | `m[3] user: [tool_result(wait 1 回目)] [MARK-SUB-1]` | 無し |
| A | `MARK-SUB-2` (2 回目の `wait` の最中) | 同 | `m[6] user: [tool_result(wait 2 回目)] [MARK-SUB-2]` | 無し |
| B (`aff26b…`) | `MARK-SUB-4` / `5` / `6` (各 `wait` の最中) | 同 | それぞれ対応する tool_result の直後 (`m[3]` / `m[6]` / `m[9]`) | 無し |

| 終わった後の append | 結果 |
|---|---|
| A の id (`turn.complete` の 1 秒後、`status: completed`) | `refused: no running loop is aa3dff7390e59d994` |
| B の id (同) | `refused: no running loop is aff26b5a0984111d4` |
| 存在しない id (2 回) | `refused: no running loop is a0000000000000000` |

`$.agent.list()` の値 (B の `turn.start` の時点): `[{ id: 'aa3dff7390e59d994', description: 'probe sub A', type: 'claude', status: 'completed' }, { id: 'aff26b5a0984111d4', description: 'probe sub B', type: 'claude', status: 'running' }]`。

注: probe の `wait` は結果の文字列にも印を入れていた (`waited (MARK-SUB-1 ...)`) ので、request の中の印は tool_result の中と、その後ろの独立した text block の 2 か所に出る。append の到達は後者の独立した block で判定した。

### probe mod (`mods-agent`)

`plugin.json` は `{ "name": "mods-agent", "version": "0.1.0", "description": "Probe: $.session.append with agentId into a running subagent." }`、`hooks/hooks.json` は `{ "modules": ["./register.ts"] }`。代役の台本は `{"for":"main","tool_use":{"name":"Agent","input":{"description":"probe sub A","prompt":"SUBTASK-A loop on wait","subagent_type":"claude"}}}` → `{"for":"sub","tool_use":{"name":"mcp__mods-agent__wait","input":{}}}` ×2 → `{"for":"sub","text":"SUB-A-DONE"}` → `{"for":"main","text":"DONE-A"}` (B は `wait` を 3 回)。

```ts
// Probe for $.session.append({ ..., agentId }) into a subagent's conversation.
//   tool `wait` (mcp__mods-agent__wait): while a subagent runs it, a timer 300 ms later (a separate dispatch)
//     appends MARK-SUB-<k> with that agentId, and the handler returns after 1500 ms
//   turn.start / turn.complete with agentId: log it and $.agent.list()
//   1000 ms after a subagent's turn.complete: append MARK-DONE-<k> with its agentId, and MARK-BOGUS-<k>
//     with an agentId that never existed; log what each returned or threw
// Logs to $MODS_LAB_DIR/agent-<inst>.jsonl.

const INST = Math.random().toString(36).slice(2, 8)
let seq = 0
let k = 0
let buf: unknown[] = []
let dir: string | undefined
let timer: (() => void) | undefined

function clip(v: unknown, n = 700): unknown {
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
  const path = `${dir}/agent-${INST}.jsonl`
  let prev = ''
  try { prev = await $.fs.read(path) } catch { prev = '' }
  await $.fs.write(path, prev + lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function appendTo($: any, agentId: string, text: string): Promise<unknown> {
  try {
    return clip(await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId }))
  } catch (err) {
    return `<threw: ${String(err)}>`
  }
}

async function agents($: any): Promise<unknown> {
  try { return clip(await $.agent.list(), 900) } catch (err) { return `<threw: ${String(err)}>` }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (timer === undefined) {
      dir = (await $.env.get('MODS_LAB_DIR')) ?? `${$.plugin.root}/log`
      timer = $.clock.every(500, () => { void flush($) })
    }
    try {
      await $.tool.register({ name: 'wait', description: 'Wait a moment (probe).', inputSchema: { type: 'object', properties: {} }, isDeferred: false })
    } catch (err) { log({ ev: '#tool.register', err: String(err) }) }
    return r
  })

  on('tool.call', { tool: 'mcp__mods-agent__wait' }, async ($: any, e: any) => {
    const agentId = e.agentId
    k += 1
    const mark = `MARK-SUB-${k} inst=${INST} to=${agentId ?? 'main'}`
    log({ ev: '#wait.start', agentId: agentId ?? null, mark })
    if (agentId !== undefined) {
      $.clock.after(300, () => { void (async () => { log({ ev: '#append', kind: 'running', agentId, mark, res: await appendTo($, agentId, mark) }) })() })
    }
    await $.clock.sleep(1500)
    log({ ev: '#wait.end', agentId: agentId ?? null })
    return { result: `waited (${mark})` }
  })

  on('turn.start', async ($: any, e: any, next: any) => {
    if (e.agentId !== undefined) log({ ev: 'turn.start', agentId: e.agentId, list: await agents($) })
    return next(e)
  })

  on('turn.complete', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      log({ ev: 'turn.complete', agentId, reason: e.reason, list: await agents($) })
      $.clock.after(1000, () => {
        void (async () => {
          k += 1
          log({ ev: '#append', kind: 'finished', agentId, list: await agents($), res: await appendTo($, agentId, `MARK-DONE-${k} inst=${INST} to=${agentId}`) })
          log({ ev: '#append', kind: 'bogus', agentId: 'a0000000000000000', res: await appendTo($, 'a0000000000000000', `MARK-BOGUS-${k} inst=${INST}`) })
        })()
      })
    }
    return r
  })

  on('session.end', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await flush($)
    return r
  })
}
```

### 未観測 (`agentId` 付き append)

- 子の request が stream の途中の時の append の位置 (今回は子が tool を実行している間だけ)
- 子が foreground (同期) の `Agent` で起きた時 (今回は 2 本とも background 起動)
- `-p` の子、teammate、workflow の agent
- peer socket からの配送を契機にした append (今回の契機は `$.clock.after` の timer)

## DR-0039 の前提の probe

DR-0039 (Proposed) の「Accepted の前提 (probe)」の表の行を、同じ隔離環境・代役の API で確かめた (`isDeferred` の行は実セッションの debug log が要るので対象外)。対話 1 本 (`--permission-mode default --settings '{"autoCompactEnabled":true}'`、`CLAUDE_CODE_MAX_RETRIES=0`) の中で順に行い、途中で probe mod を 1 度 hot reload した (`fail2` の追加)。probe mod `mods-dr39` の source は下。

### 結果

| 確かめること | 結果 | サンプル |
|---|---|---|
| `command.run (clear)` の `next(e)` の後で `$.session.id()` が新しい id を返す | **成り立つ**。after で読んだ id は `classic.SessionStart (clear)` の新 id と一致し、前の id とは違った | 2/2 |
| セッション内の `/resume` で `session.end (resume)` と `command.run (resume)` の after が起き、新しい id が読める | **成り立つ**。`/resume <sid>` で `command.run (resume)` → `classic.SessionEnd` → `session.end (reason: 'resume'、旧 id)` → `classic.SessionStart (source: 'resume'、再開した id)` → `command.run` の after で `$.session.id()` が再開した id。`session.start` は起きない | 2/2 |
| busy 中の Enter で `prompt.submit` の `next(e)` が Enter の時点で resolve する | **成り立つ** (tool の実行中の Enter について)。`prompt.submit` は Enter の時点で起き、`next(e)` は 9〜15 ms で resolve し、`classic.UserPromptSubmit` も同じ時点で起きた。queue された prompt は別の turn にならず、実行中の turn の次の request で、tool_result と同じ user message に `The user sent a new message while you were working: ...` の形で入った | 2/2 |
| `$.process.run` で `daemon start` を呼び、detached の daemon を待たずに返る | **成り立つ** (代役のスクリプトで)。CLI と同じ形 (stdio ignore、`detached: true`、`unref()`) で子を起こしてすぐ終わるスクリプトに対し、`$.process.run` は 25〜26 ms で返り、子は turn の後も生きていた。実物の `ccmsg daemon start` (daemon が応答するまで待つ) は走らせていない | 2/2 (子の生存の確認は 1) |
| `/clear` とセッション内の `/resume` の後に `$.tool.register` の登録が残る | **成り立つ**。`command.run` の after の `$.tool.list()` に登録した 4 つが残り、次の request の `tools` に載り、呼ぶと handler が答えた | `/clear` 2/2、`/resume` 2/2 |
| `/model` での切替が `config.set` (key `model`) か `command.run` (`model`) を通る | **`command.run (model)` は常に通る**。picker (既定として保存)、picker (`s` でこの session だけ)、引数付き (`/model <id>`) の全部で起き、after は `classic.PostModelSwitch` の後に resolve した。`config.set` (`key: 'model'`、`origin: composer`) は既定として保存する時だけ起き、picker の「この session だけ」では起きない | `command.run` 4/4 (うち切替あり 2)、`config.set` 3/4 |
| tool の handler が `{ isError: true, result }` を返した時に model に error として届く | **成り立たない**。`{ isError: true, result }` も `{ isError: true, result, text }` も、tool_result は `is_error` 無しで content が `result` の文字列になった (`text` は使われない)。engine 自身のエラー (下の「no tool.call hook answered」) は `is_error: true` で届く | 3/3 (2 つの形) |
| API error の行が `$.session.append` の hook を通り、分類と表示文が読める。`turn.complete (reason: 'error')` との順序 | **表示文は読める、分類は読めない**。API error の行は door `response` (`message.type: 'assistant'`、`origin: { kind: 'model', model: '<synthetic>' }`) で通り、`content` に画面と同じ表示文 (例: `API Error: 529 Overloaded-probe. ...`、`API Error: Request rejected (429) · ...`) がある。分類 (transcript の `error` / `apiErrorStatus`) は `e` に無い。順序は `session.append (response)` → `classic.StopFailure` (`error`: 529・500 は `server_error`、400 は `unknown`、429 は `rate_limit`) → `turn.complete` (`{ answer: '', durationMs, isAborted: false, turnId, reason: 'error' }`、分類も表示文も無い) → `session.append (notice)` | 529 / 500 / 400 / 429 の各 1、加えて 500 の 3 |
| `tool.call` の handler が待てる上限 | **`$.process.run` の待ちは予算に数えられない**。15 秒・40 秒 (`timeoutMs` を 70 秒に) とも待ち切って答えた。**`$.clock.sleep` は数えられ**、12 秒・15 秒とも 10 秒で `tool.call hook skipped: ran past its 10s budget` になり、hook が無いものとして core に落ち、許可ダイアログが出る (Yes で `no tool.call hook answered` のエラー結果 (`is_error: true`)、No で turn が中断)。handler の待ち中に人が Esc を押すと、`$.process.run` は `HooksError: ... $.process.run(sleep) aborted` で即 reject し、子 (sleep) は kill され、`next.signal.aborted` は true、`turn.complete` は `reason: 'aborted'` | process 15 秒・40 秒 各 1、clock 2/2、Esc 2/2 |
| 自動 compact の後に、§5 の I で案内が足し直される | **成り立つが 1 turn 遅れる**。自動 compact はその turn の `turn.start` の後に起きるので、`session.compact` の after で印を立てても、その turn の request (compaction の直後) には案内が無い。次の `prompt.submit` で足され、次の turn の request から載る | 2/2 |

### 補足

- `/model` の picker で「この session だけ」を選ぶと「Switch model? Your next response will be slower and use more tokens」の確認が出て、確認の後に `classic.PostModelSwitch` (`source: 'picker'`) が起きた。引数付きでは確認無しで `source: 'command'`
- 予算超過の hook には debug log に `hook overran: mods-dr39: still running 5000ms after its budget ran out; ignores its signal (tool.call)` も出た
- 自動 compact の観測では、代役が返す `usage.input_tokens` を 990000 にした応答の直後の turn で compact が起きた。compact 済みの turn では代役を 1000 に戻した

### probe mod (`mods-dr39`)

`plugin.json` は `{ "name": "mods-dr39", "version": "0.1.0", "description": "Probe: the preconditions of DR-0039." }`、`hooks/hooks.json` は `{ "modules": ["./register.ts"] }`、`types/index.d.ts`:

```ts
export type Dr39Pending = boolean
declare module 'claude-code' {
  interface PluginState {
    'mods-dr39': { pendingCompact: Dr39Pending }
  }
}
```

`hooks/register.ts` (`BIN` は下の代役スクリプトのパス):

```ts
// Probe for the preconditions of DR-0039. Logs to $MODS_LAB_DIR/dr39-<inst>.jsonl.
//   *                 every event name; `e` (clipped) for the events listed in KEY
//   command.run       after next: $.session.id() and this plugin's tools in $.tool.list()
//   prompt.submit     time of entry and of next(e) resolving; MARK-I append when $.state pendingCompact
//   session.compact   after next: pendingCompact = true
//   tools: wait {seconds, how: 'process'|'clock'}, fail ({ isError, result }), fail2 ({ isError, result, text }), spawnd (runs the daemon-start stand-in)

const INST = Math.random().toString(36).slice(2, 8)
const BIN = '$LAB/bin/fake-daemon-start.ts'
let seq = 0
let buf: unknown[] = []
let dir: string | undefined
let timer: (() => void) | undefined

const KEY = new Set(['command.run', 'config.set', 'session.end', 'session.start', 'classic.SessionStart', 'classic.SessionEnd',
  'prompt.submit', 'classic.UserPromptSubmit', 'turn.start', 'turn.complete', 'session.append', 'classic.StopFailure',
  'session.compact', 'classic.PreModelSwitch', 'classic.PostModelSwitch', 'classic.Notification'])

function clip(v: unknown, n = 900): unknown {
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
  const path = `${dir}/dr39-${INST}.jsonl`
  let prev = ''
  try { prev = await $.fs.read(path) } catch { prev = '' }
  await $.fs.write(path, prev + lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function mine($: any): Promise<unknown> {
  try {
    const all = await $.tool.list()
    return (all as any[]).map((t: any) => t.name ?? t).filter((n: string) => String(n).includes('mods-dr39'))
  } catch (err) { return `<threw: ${String(err)}>` }
}

export function register(on: any): void {
  on('*', ($: any, e: any, next: any) => {
    const ev = String(next.event)
    if (ev !== 'ui.render' && ev !== 'agent.offer' && !ev.startsWith('fs.') && !ev.startsWith('env.') && !ev.startsWith('telemetry')) {
      const entry: Record<string, unknown> = { ev, by: next.origin }
      if (KEY.has(ev)) entry.e = clip(e)
      log(entry)
    }
    return next(e)
  })

  on('session.start', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (timer === undefined) {
      dir = (await $.env.get('MODS_LAB_DIR')) ?? `${$.plugin.root}/log`
      timer = $.clock.every(500, () => { void flush($) })
    }
    const specs = [
      { name: 'wait', description: 'Wait (probe).', inputSchema: { type: 'object', properties: { seconds: { type: 'number' }, how: { type: 'string' } } }, isDeferred: false },
      { name: 'fail', description: 'Fail (probe).', inputSchema: { type: 'object', properties: {} }, isDeferred: false },
      { name: 'fail2', description: 'Fail with text (probe).', inputSchema: { type: 'object', properties: {} }, isDeferred: false },
      { name: 'spawnd', description: 'Run the daemon-start stand-in (probe).', inputSchema: { type: 'object', properties: {} }, isDeferred: false },
    ]
    for (const spec of specs) {
      try { await $.tool.register(spec) } catch (err) { log({ ev: '#tool.register', name: spec.name, err: String(err) }) }
    }
    log({ ev: '#registered', tools: await mine($) })
    return r
  })

  on('command.run', async ($: any, e: any, next: any) => {
    let before: unknown
    try { before = await $.session.id() } catch (err) { before = String(err) }
    const r = await next(e)
    let after: unknown
    try { after = await $.session.id() } catch (err) { after = String(err) }
    log({ ev: '#command.run.after', command: e.command, args: e.args, sidBefore: before, sidAfter: after, tools: await mine($), r: clip(r, 300) })
    return r
  })

  on('prompt.submit', async ($: any, e: any, next: any) => {
    const t0 = Date.now()
    const pending = await $.state.get({ plugin: 'mods-dr39', key: 'pendingCompact' })
    if (pending.value === true) {
      let res: unknown
      try { res = clip(await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `MARK-I after compaction inst=${INST}` }] } }), 200) } catch (err) { res = String(err) }
      await $.state.set({ plugin: 'mods-dr39', key: 'pendingCompact' }, false)
      log({ ev: '#inject.I', res })
    }
    const r = await next(e)
    log({ ev: '#prompt.submit.resolved', text: String(e.text).slice(0, 40), origin: e.origin?.kind, enteredAt: t0, resolvedAfterMs: Date.now() - t0, r: clip(r, 300) })
    return r
  })

  on('session.compact', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await $.state.set({ plugin: 'mods-dr39', key: 'pendingCompact' }, true)
    log({ ev: '#pendingCompact', trigger: e.trigger })
    return r
  })

  on('tool.call', { tool: 'mcp__mods-dr39__wait' }, async ($: any, e: any, next: any) => {
    const t0 = Date.now()
    const seconds = Number(e.seconds ?? 15)
    log({ ev: '#wait.start', seconds, how: e.how })
    let out: unknown
    try {
      if (e.how === 'clock') { await $.clock.sleep(seconds * 1000); out = 'slept' }
      else out = clip(await $.process.run(['sleep', String(seconds)], { timeoutMs: (seconds + 30) * 1000 }), 300)
    } catch (err) { out = `<threw: ${String(err)}>` }
    log({ ev: '#wait.end', seconds, how: e.how, elapsedMs: Date.now() - t0, out, aborted: next.signal?.aborted ?? null })
    return { result: `WAITED ${seconds}s via ${e.how} in ${Date.now() - t0}ms` }
  })

  on('tool.call', { tool: 'mcp__mods-dr39__fail' }, async () => ({ isError: true, result: 'FAIL-TEXT the probe reports a failure' }))

  on('tool.call', { tool: 'mcp__mods-dr39__fail2' }, async () => ({ isError: true, result: 'FAIL2-RESULT', text: 'FAIL2-TEXT' }))

  on('tool.call', { tool: 'mcp__mods-dr39__spawnd' }, async ($: any) => {
    const t0 = Date.now()
    let out: unknown
    try { out = clip(await $.process.run(['bun', BIN], { timeoutMs: 30000 }), 400) } catch (err) { out = `<threw: ${String(err)}>` }
    log({ ev: '#spawnd', elapsedMs: Date.now() - t0, out })
    return { result: `SPAWND ${JSON.stringify(out)} in ${Date.now() - t0}ms` }
  })

  on('session.end', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await flush($)
    return r
  })
}
```

`daemon start` の代役 (`$LAB/bin/fake-daemon-start.ts`。CLI の `spawnDaemon` と同じ spawn の形):

```ts
const proc = Bun.spawn(["sleep", "40"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
proc.unref();
console.log(JSON.stringify({ started: true, pid: proc.pid }));
process.exit(0);
```

代役の API には台本の行 `{"error":{"status","type","message"}}` を足した (その request に `{ type: 'error', error: { type, message } }` を `status` で返す)。

```ts
if (scripted?.error) return Response.json({ type: "error", error: { type: scripted.error.type, message: scripted.error.message } }, { status: scripted.error.status, headers: { "request-id": `req_fake_${n}` } });
```

### 未観測 (DR-0039 の前提)

- busy 中の Enter のうち、model が tool を呼ばずに応答を stream している最中の Enter (今回は tool の実行中だけ)。queue された prompt が別の turn になるか、同じ turn に入るか
- 実物の `ccmsg daemon start` を `$.process.run` で呼んだ時の所要時間 (daemon の応答を待つ分)
- picker で既定として保存しつつ別のモデルに切り替えた時の `config.set` と `classic.PostModelSwitch` の順 (切替ありの観測は「この session だけ」の picker と引数付きの 2 回)
- retry が有効 (既定) な時の API error の event の並び (今回は `CLAUDE_CODE_MAX_RETRIES=0`)
- 手動 compact の `/compact` で I の足し直しが次の turn に載ることは前の節で 1 回、自動 compact はこの節で 2 回

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
- `dollar-api` の `session` の `append` / `practices` の「main と subagent の見分け」: `agentId` 付きの append は走行中の子の次の request に、直前の tool_result と同じ user message の後ろの text block として載り、main には載らない。終わった子・存在しない id は `refused: no running loop is <agentId>` で reject される (黙って捨てられない)。`turn.*` の `agentId`・`$.agent.list()` の `id`・`tool.call` の `agentId`・`Agent` tool の結果の `agentId` は同じ値
- `events` の「意味論の注意」: セッション内の `/resume` は `command.run (resume)` → `classic.SessionEnd` → `session.end (reason: resume)` → `classic.SessionStart (source: resume)` で `session.start` は起きず、`command.run` の after では `$.session.id()` が再開した id を返す。`/clear` の after も新しい id を返す。busy 中 (tool の実行中) の Enter は `prompt.submit` と `classic.UserPromptSubmit` がその時点で起き、`next(e)` は数 ms で resolve し、prompt は実行中の turn の次の request に `The user sent a new message while you were working` として入る。`/model` は常に `command.run (model)` を通り (after は `classic.PostModelSwitch` の後)、`config.set (model)` は既定として保存する時だけ
- `capabilities` の `tool.call` の行: plugin が返す `{ isError: true, result }` は model には `is_error` 無しの tool_result として届く (`text` も使われない)。`session.append` の行: API error の行は door `response`、`origin: { kind: model, model: <synthetic> }` で表示文だけを持ち、分類は `classic.StopFailure` の `error` にしか無い。`turn.complete (reason: error)` の `e` は分類も表示文も持たない
- `dollar-api` の「制限」の予算: `$.process.run` の待ちは数えられず 40 秒でも通り、`$.clock.sleep` は数えられ 10 秒で hook が skip されて core に落ちる (許可ダイアログ → `no tool.call hook answered`)。人の Esc で `$.process.run` は `aborted` で reject し子は kill される (実測で「未検証」を埋められる)
- `practices` の「model に文脈を足す」: 自動 compact は turn の途中 (`turn.start` の後) に起きるので、`session.compact` の after で立てた印での足し直しは次の turn からになる
