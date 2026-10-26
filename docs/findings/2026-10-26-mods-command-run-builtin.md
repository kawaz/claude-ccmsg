# mods の `$.command.run` で組み込みの `/model` `/effort` は走るか

- Date: 2026-10-26
- 対象: Claude Code 2.1.310。隔離 `CLAUDE_CONFIG_DIR` / `HOME` / `TMPDIR` / `XDG_*_HOME`、Messages API の代役 (`ANTHROPIC_BASE_URL` を手元の HTTP server に向ける)、tmux の対話 session (`--name "🤖ccmsg-verify-cmdrun-builtin"`)
- 方法: `--plugin-dir` で観測 mod (`on('*')` で全 event を記録) と下の probe mod を載せた。probe mod は `/probe-model <name>` / `/probe-effort <level>` から `$.command.run` で組み込みの `model` / `effort` を呼び、その前後の `$.session.model()` と `$.config.list()` を記録する。あわせて `command.run` / `config.set` / `classic.PostModelSwitch` / `turn.step` を hook で記録した。比べるため、人が打つ `/model opus` → `/effort high` も同じ session で実行した。その後、同じ config home で session を起動し直し、session だけの切替 (A: `turn.step` の書き換え、B: `config.set` の deny) を試した。隔離 config の `settings.json` は各段で写しを取った。初期値は `{"model":"opus","env":{"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS":"1"}}`

## 結論

- `$.command.run({ command: 'model' | 'effort', args })` で組み込みの `/model` / `/effort` が走り、その session の model と effort が切り替わる。**人が引数付きで打った時と同じく、既定として settings.json に保存される** (画面の出力も「saved as your default for new sessions」)
- 条件は、`command.run` hook がまだ返っていない間に呼ばないこと。hook の中で await すると host check で即座に reject される。hook が `{ text }` を返した後に投げれば (await せずに投げ、呼び出しが hook の return より後になる形)、session が idle になってから走る
- `/model` は `config.set (key: 'model')` を起こすが、`/effort` は `config.set` を起こさない。effort は `modelSettings.<model id>.effortLevel` に model ごとに保存される
- **保存せず、その session にだけ効かせる切替は `turn.step` の書き換えでできる** (下の「session だけの切替」の A)。`config.set` を deny して `/model` の保存だけを止める形 (同 B) は、切替ごと取り消されるので使えない

## マトリクス

| 操作 | model の切替 | effort の切替 | settings.json への保存 | event 列 (probe mod と観測 mod) |
|---|---|---|---|---|
| `/probe-model sonnet` (hook は `$.command.run` を await せずに投げ、先に `{ text }` を返す) | する。`$.session.model()` が `claude-opus-5-5[1m]` から `claude-sonnet-5-5` に。`$.config.list()` の `model` 行は `sonnet` | — | される: `"model": "sonnet"` | `command.run (model, origin: { kind: 'plugin', name: 'probe-cmdrun' })` → `classic.PreModelSwitch` → `config.set (key: model, value: sonnet, previous: opus[1m], origin: { kind: 'composer' })` → `classic.PostModelSwitch (requested_model: sonnet, source: command)` → `$.command.run` の解決値は `{}` |
| `/probe-effort low` (同上) | — | する。直後の turn で `turn.step` の `e.effort` が `low`、API request の `output_config.effort` も `low` (`model: claude-sonnet-5-5`、`thinking: { type: adaptive }`) | される: `modelSettings["claude-sonnet-5-5"].effortLevel: "low"` | `command.run (effort, origin: plugin)` だけで、`config.set` は起きない。解決値は `{}` |
| `/probe-model-await opus`、`/probe-effort-await high` (hook の中で `$.command.run` を await する) | しない | しない | されない | 呼んだ時点で reject: `HooksError: probe-cmdrun: command.run: called from a command.run hook, it would wait on the turn this hook is holding; answer { text } instead, or run it from a later event (turn.complete) (host check)` |
| 人が `/model` を打つ (picker を開いて Esc) | しない。picker には `Sonnet ✔` と `Low effort` が出る (probe での切替が反映されている)。Esc で「Kept model as Sonnet 5.5」 | — | 変化なし | `command.run (model, args: "", origin: composer)`。解決値は `{ ref: 1 }` |
| 人が `/model opus` を打つ | する。`claude-sonnet-5-5` から `claude-opus-5-5` に | — | される: `"model": "opus"` | `command.run (model, args: opus, origin: composer)` → `classic.PreModelSwitch` → `config.set (key: model, value: opus, previous: sonnet, origin: composer)` → `classic.PostModelSwitch (requested_model: opus, source: command)` → 解決値は `{ ref: 1 }` |
| 人が `/effort high` を打つ | — | する (画面は「Set effort level to high (saved as your default for new sessions)」) | される: `modelSettings["claude-opus-5-5"].effortLevel: "high"`。sonnet の `low` は残る | `command.run (effort, args: high, origin: composer)` だけで、`config.set` は起きない。解決値は `{ ref: 1 }` |
| A: `/probe-override sonnet low` の後に turn を回す (`turn.step` hook で `next({ ...e, model, effort })`) | する: 代役が受けた request の `model` が `claude-sonnet-5-5`。ただし `$.session.model()` は `claude-opus-5-5`、`$.config.list()` の `model` 行は `opus`、`/model` の picker は `Opus ✔` のまま | する: request の `output_config.effort` が `low`。`turn.step` の `e.effort` (差し替える前) は `high`、picker は `High effort` のまま | されない (settings.json は変化なし) | `command.run (probe-override)` だけ。`config.set` / `PreModelSwitch` / `PostModelSwitch` は起きない。差し替えは turn のたびに `turn.step` で行う |
| A の後に `/clear` してから turn を回す | 差し替えが残る (request の `model` が `claude-sonnet-5-5`) | 残る (`output_config.effort` が `low`) | されない | `command.run (clear)`。module は読み直されないので、module 変数がそのまま効く |
| B: `/probe-model-session sonnet` (`config.set` が `key: 'model'` で来た時に `{ deny }` を返す印を立て、`$.command.run('model')` を投げる) | **しない**。`$.session.model()` は `claude-opus-5-5` のまま、次の turn の request も `claude-opus-5-5` | — | されない | `command.run (model, origin: plugin)` → `classic.PreModelSwitch` → `config.set (origin: composer)` → deny で止まり、`classic.PostModelSwitch` は起きない。画面は「Couldn't save Model: probe: session only」、`$.command.run` の解決値は `{}` (reject しない) |

plugin から走らせた場合と人が打った場合の違いは、`command.run` の `origin` (`plugin` か `composer` か) と、解決値の形 (`{}` か `{ ref: 1 }` か) だけだった。切替の効き方、settings への保存、その他の event 列は同じ。

各段の settings.json:

| 時点 | 中身 (`env` は略) |
|---|---|
| 起動前 | `"model": "opus"` |
| 起動直後 | `"model": "opus[1m]"` |
| `/probe-model sonnet` の後 | `"model": "sonnet"` |
| `/probe-effort low` の後 | `"model": "sonnet"`, `modelSettings: { "claude-sonnet-5-5": { effortLevel: "low" } }` |
| 人の `/model opus` → `/effort high` の後 | `"model": "opus"`, `modelSettings: { "claude-sonnet-5-5": { effortLevel: "low" }, "claude-opus-5-5": { effortLevel: "high" } }` |
| A / B の session (同じ config home で起動し直した) の間 | 上と同じのまま変化なし |

## session だけの切替

保存せず、その session だけで model / effort を変えたい場合に試した 2 つの形 (A / B は上のマトリクスの行)。

### A: `turn.step` で `model` / `effort` を書き換える (推奨)

- module 変数に値を持ち、`turn.step` hook で `next({ ...e, model, effort })` として渡す。`model` は alias (`sonnet`) で渡しても、request では `claude-sonnet-5-5` に解決されていた
- 効くもの: API に送る request の `model` と `output_config.effort`。代役が返す応答は request の `model` をそのまま返すので、transcript の assistant 行の `message.model` も `claude-sonnet-5-5` になった (本物の API で同じになるかは未確認)
- 保存されないもの: settings.json は変化しない。`config.set` も `PostModelSwitch` も起きない
- 気をつけること: session が持つ model / effort の値は変わらない。`$.session.model()`、`$.config.list()`、`/model` の picker はどれも元の値のままで、`turn.step` の `e.model` / `e.effort` も差し替える前の値で来る。今どの model で送っているかを人に見せるなら、plugin 側で表示する必要がある
- `/clear` の後も効く (module 変数なので)。process を起動し直すと消える。resume した後に欲しければ、値を `$.state` などに残して `session.start` で戻す (未検証)

### B: `config.set` を deny して `/model` の保存だけを止める (使えない)

- `config.set` の deny は「保存だけ止める」ではなく、切替ごと取り消された。`PreModelSwitch` の後に `config.set` が deny されると、`PostModelSwitch` は起きず、`$.session.model()` も次の request の model も元のまま
- `/effort` は `config.set` を起こさないので、この形ではそもそも止められない

## 副次的に分かったこと

1. **再入の扱い: 呼んだ plugin の `command.run` hook は全部飛ばされる**
   - 自分の `$.command.run` が起こした `command.run` では、probe mod の `command.run` hook が 2 つとも飛ばされた。呼んだ `{ command: 'probe-model' }` の hook だけでなく、matcher 無しの catch-all の hook もである
   - debug log には `hooks module probe-cmdrun@inline command.run skipped: re-entry (the plugin's own code raised it; origin probe-cmdrun)` が hook の数だけ出る
   - 同じ dispatch から入れ子で起きた `config.set` と `classic.PostModelSwitch` では、probe mod の hook も走った
   - 別 plugin の観測 mod は `command.run nested in probe-cmdrun` として見ている
2. **await すると reject される**
   - hook の中から await した場合は、上の表のとおり host check で即座に reject される (デッドロックにはならない)
   - await しない版でも、`$.command.run` を呼んだのは hook が `{ text }` を返した後だった。probe mod は呼ぶ前に `$.fs` / `$.config.list()` を await している。hook が return する前の同期区間で呼んだ場合は確かめていない
3. **`config.set` の origin は composer**
   - `$.command.run` を経由した `/model` でも、起きる `config.set` の `origin` は `{ kind: 'composer' }` だった。`config.set` の origin では plugin から来た切替を見分けられない
   - 見分けるなら `command.run` の `origin` を見る。ただし呼んだ plugin 自身の hook は飛ばされるので、見えるのは他の plugin だけ
4. **起動時に `opus` が `opus[1m]` に書き換えられる**
   - 起動直後、隔離 settings.json の `"model": "opus"` が `"opus[1m]"` に書き換えられた (debug log に起動時の atomic write がある)
   - `$.config.list()` の `model` 行も `opus[1m]`、`$.session.model()` は `claude-opus-5-5[1m]`
   - probe とは関係の無い、起動時の処理
5. **起動し直した session では書き換えが起きなかった**
   - A / B の session は、同じ config home で起動し直したもの。`"model": "opus"` は書き換えられず、`$.session.model()` は `claude-opus-5-5` (`[1m]` 無し) だった
   - 1 回目との違いは、settings.json に `modelSettings` があったこと。書き換えが起きるかどうかの条件は切り分けていない
6. **effort は `$.config.list()` に無い**
   - `$.config.list()` の model 系の行は `switchModelsOnFlag` / `thinking` / `model` で、effort の行は無い
   - 今回 effort を読めたのは `turn.step` の `e.effort` だけ (と、代役が受けた request の `output_config.effort`)

## probe mod

`hooks/hooks.json`:

```json
{
  "description": "probe-cmdrun: $.command.run で組み込み model / effort を呼ぶ",
  "modules": ["./register.ts"]
}
```

`hooks/register.ts`:

```ts
let dir: string | undefined
let seq = 0
// A: turn.step で差し替える値 (module 変数)
let override: { model?: string, effort?: string } = {}
// B: 次の config.set (key model) を deny する印
let denyNextModelSave = false

async function log($: any, rec: Record<string, unknown>): Promise<void> {
  seq += 1
  const line = JSON.stringify({ n: seq, t: Date.now(), ...rec })
  if (dir === undefined) return
  let prev = ''
  try { prev = await $.fs.read(`${dir}/probe.jsonl`) } catch { prev = '' }
  await $.fs.write(`${dir}/probe.jsonl`, prev + line + '\n')
}

async function state($: any): Promise<Record<string, unknown>> {
  const model = await $.session.model()
  let rows: unknown = undefined
  try {
    rows = (await $.config.list())
      .filter((r: any) => /model|effort|thinking/i.test(String(r.key)))
      .map((r: any) => ({ key: r.key, value: r.value }))
  } catch (err) { rows = `config.list error: ${String(err)}` }
  return { model, rows }
}

async function invoke($: any, label: string, command: string, args: string): Promise<unknown> {
  await log($, { label, phase: 'before', command, args, ...(await state($)) })
  try {
    const res = await $.command.run({ command, args })
    await log($, { label, phase: 'resolved', result: res, ...(await state($)) })
    return res
  } catch (err) {
    await log($, { label, phase: 'rejected', error: String(err), ...(await state($)) })
    return { error: String(err) }
  }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    dir = (await $.env.get('MODS_LAB_DIR')) ?? `${$.plugin.root}/log`
    for (const [name, hint] of [['probe-model', '<model>'], ['probe-effort', '<level>'], ['probe-model-await', '<model>'], ['probe-effort-await', '<level>'], ['probe-state', ''], ['probe-override', '<model|-> <effort|->'], ['probe-model-session', '<model>']]) {
      await $.command.register({ name, description: `probe: ${name}`, argumentHint: hint })
    }
    await log($, { label: 'session.start', ...(await state($)) })
    return next(e)
  })

  for (const [name, target] of [['probe-model', 'model'], ['probe-effort', 'effort']]) {
    on('command.run', { command: name }, async ($: any, e: any) => {
      void invoke($, name, target, e.args)
      return { text: `${name}: queued $.command.run({ command: '${target}', args: '${e.args}' })` }
    })
    on('command.run', { command: `${name}-await` }, async ($: any, e: any) => {
      const r = await Promise.race([
        invoke($, `${name}-await`, target, e.args),
        $.clock.sleep(15000).then(() => 'timeout 15s'),
      ])
      return { text: `${name}-await: ${JSON.stringify(r)}` }
    })
  }

  on('command.run', { command: 'probe-override' }, async ($: any, e: any) => {
    const [m, ef] = String(e.args).trim().split(/\s+/)
    override = { model: m && m !== '-' ? m : undefined, effort: ef && ef !== '-' ? ef : undefined }
    await log($, { label: 'probe-override', override, ...(await state($)) })
    return { text: `probe-override: ${JSON.stringify(override)}` }
  })
  on('command.run', { command: 'probe-model-session' }, async ($: any, e: any) => {
    denyNextModelSave = true
    void invoke($, 'probe-model-session', 'model', e.args)
    return { text: `probe-model-session: queued model ${e.args} with config.set deny` }
  })

  on('command.run', { command: 'probe-state' }, async ($: any) => {
    const s = await state($)
    await log($, { label: 'probe-state', ...s })
    return { text: `probe-state: ${JSON.stringify(s)}` }
  })

  on('command.run', async ($: any, e: any, next: any) => {
    await log($, { label: 'ev', ev: 'command.run', phase: 'in', command: e.command, args: e.args, origin: e.origin, by: next.origin })
    const r = await next(e)
    await log($, { label: 'ev', ev: 'command.run', phase: 'out', command: e.command, result: r, ...(await state($)) })
    return r
  })
  on('config.set', async ($: any, e: any, next: any) => {
    await log($, { label: 'ev', ev: 'config.set', phase: 'in', key: e.key, value: e.value, previous: e.previous, origin: e.origin })
    if (e.key === 'model' && denyNextModelSave) {
      denyNextModelSave = false
      const r = { deny: 'probe: session only' }
      await log($, { label: 'ev', ev: 'config.set', phase: 'denied', key: e.key, result: r })
      return r
    }
    const r = await next(e)
    await log($, { label: 'ev', ev: 'config.set', phase: 'out', key: e.key, result: r })
    return r
  })
  on('classic.PostModelSwitch', async ($: any, e: any, next: any) => {
    await log($, { label: 'ev', ev: 'classic.PostModelSwitch', e })
    return next(e)
  })
  on('turn.step', async function* ($: any, e: any, next: any) {
    const sent = { ...e, ...(override.model ? { model: override.model } : {}), ...(override.effort ? { effort: override.effort } : {}) }
    await log($, { label: 'ev', ev: 'turn.step', model: e.model, effort: e.effort, index: e.index, sentModel: sent.model, sentEffort: sent.effort })
    return yield* next(sent)
  })
}
```

観測 mod は、rules リポの reference `claude-mods/scripts/observe-mod` をそのまま使った。

## 未観測

- `$.command.run` から、組み込みの `/model` の「この session だけ」(picker の `s`) に当たる経路を呼べるか。引数付きの `/model <name>` は常に既定として保存された。上の A は組み込みの経路を通らない代替
- A で、本物の API の応答と transcript の `message.model`、prompt cache の扱い (turn の途中で model が変わる場合を含む)
- A を subagent の turn (`e.agentId` がある `turn.step`) に適用した場合
- hook が return する前の同期区間で `$.command.run` を呼んだ場合 (今回の await しない版は、呼ぶ前に別の `$` を await している)
- `turn.complete` などの turn の後の event から `$.command.run` を呼んだ場合 (reject の文言では勧められている形)
- headless (`-p`) での挙動、`immediate: true` で登録した command から呼んだ場合
- 人が打った `/effort high` の後の `turn.step` の `e.effort` (turn は回していない。settings.json と画面の表示だけで確かめた)
