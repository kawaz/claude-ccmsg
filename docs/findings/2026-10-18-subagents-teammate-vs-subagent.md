# Agent tool の子が subagent になる時と teammate になる時: session facts の `subagents` に出るもの

- Date: 2026-10-18
- 対象: Claude Code 2.1.302、plugin ccmsg-v1 0.178.0 (途中から 0.179.0 が配布され、後から起きた子は 0.179.0 を読んだ。subagent を集める部分のコードは両版で同じ)。DR-0039 §6 の段 6 で入れた「走行中の subagent の一覧を session facts の `subagents` に載せる」機能が、実 model の試験用セッションで終始 `[]` だった件の切り分け
- 方法: 実 config dir (agent teams が有効、`teammateMode: "auto"`) で、試験用セッションを `.claude/skills/verify/SKILL.md` の手順 (継承された session 変数を `env -u` で外し、`--name 🤖ccmsg-verify-subagents`) で起動した。隔離 daemon (`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` を一時ディレクトリに) を立て、`session_status_subscribe` で daemon が受け取った facts の push を全部記録した。観測 mod (下の「probe mod」) を `--plugin-dir` で足し、`agent.*` / `turn.start` / `turn.complete` / `classic.Subagent*` / `classic.Teammate*` / `session.receive` / Agent の `tool.call` の `e` と結果、`$.agent.list()` の変化 (1 秒ごとに読み、変わった時だけ記録)、走行中に見えた id への `agentId` 付き `$.session.append` の結果を JSONL に書いた。model は実物 (fable)。子には `timeout 40 tail -f /dev/null` を Bash で実行させて観測窓を作った (`sleep 40` は harness に止められる)
- 端末: 専用 socket の tmux (`tmux -L <name>`)。セッション A は tmux の中でそのまま (`teammateMode: "auto"` が効く)、セッション B は `--settings '{"teammateMode":"in-process"}'` を足して起動した

## 結論

- **真因**: 実 model は Agent の入力に `name` を入れることがあり、agent teams が有効な環境では `name` 付きの Agent は teammate として起きる (`agent.spawn` の `e.isTeammate: true`、6/6)。前回の試験用セッションは tmux の中で起動されていたので、`teammateMode: "auto"` が split pane を選び、teammate は **別プロセス・別 session id** になった。module の `subagents` は自分のプロセスの engine が回す loop の `turn.start` (`e.agentId`) で集めているので、別プロセスの loop は一度も見えず、`[]` のままになる
- **split pane の teammate は「走行中の subagent」ではない**。leader で `agentId` 付きの `turn.start` / `turn.complete` は起きず (0/4)、`agentId` 付きの append は `refused: no running loop is <name>@session-<sid8>` で拒まれる (3/3)。`$.agent.list()` には `status: 'running'` → `'idle'` で載る (4/4) が、直送の宛先にはならない。段 6 の一覧から外れているのは、直送の宛先の一覧としては正しい
- **in-process の teammate と subagent は届く**。tmux の外で `auto` (公式 docs では tmux / iTerm2 の外は in-process に落ちる)、または `in-process` 指定なら、teammate も leader のプロセスの loop になり、`agentId` 付きの `turn.start` / `turn.complete` が起き (4/4)、append が子の次の request に載り (4/4)、facts の `subagents` に出て turn の終わりに消える (4/4)。idle の teammate に SendMessage で仕事を渡すと同じ `agentId` で `turn.start` が起き、再び一覧に出る (1/1)
- **段 6 の /verify (代役 API) との差**: 代役の台本の Agent の tool_use には `name` が無かったので、子は常に subagent だった。実 model の `name` と、tmux の中で起動したことの 2 つが重なって初めて split pane の teammate になる
- **今回の module の変更は無し**。報告された現象は、見ていた子が subagent ではなく別セッションだったことによる。split pane の teammate を ccmsg でどう扱うか (別セッションとして peers に出す、leader の webui に「このセッションの teammate」として見せる) は設計が要るので issue に分けた (`docs/issue/` の split-pane-teammate-sessions)

## マトリクス

セッション A = tmux の中 (`auto` → split pane)、B = `teammateMode: "in-process"`。「facts」は daemon が push した `session_status.subagents`。

| case | 入力 | `agent.spawn` の結果 | 子の実体 | leader の `turn.*` の `agentId` | `$.agent.list()` | append | facts の `subagents` |
|---|---|---|---|---|---|---|---|
| A-1 (case1, 5a) | `name` 無し、`run_in_background: true` | `{ agentId: 'a<hex>' }`、tool の結果は `async_launched` | 同じプロセスの subagent。transcript は `<sid>/subagents/agent-<id>.jsonl` | 有り (2/2) | `running` → `completed` | 届く (1/1、case1 は probe の追加前) | 出て、子の `turn.complete` で消える (2/2) |
| A-2 (case4a, 4b) | `name` 無し、`run_in_background` 指定なし | A-1 と同じ (`e.background: true`、meta は `requestShape: "background"`) | A-1 と同じ | 有り (2/2) | 同上 | 届く (2/2) | 同上 (2/2) |
| A-3 (case2, 5b) | `name` 有り、`run_in_background: true` | `{ agentId: '<name>@session-<sid8>', teammateId: 同じ値 }`、tool の結果は `teammate_spawned` (tmux pane id 付き) | tmux の別 pane の別プロセス。argv に `--agent-id` / `--team-name` / `--parent-session-id <leader の sid>` / `--agent-type`。自分の session id を持ち、transcript は project 直下の `<その sid>.jsonl` (1 行目 `type: agent-setting`) | 無し (0/2)。子のプロセスの中では `agentId` 無しの main の turn として起きる | `id === teammateId`、`running` → `idle` (子の turn の後)。`completed` にはならない | 拒否 `no running loop` (1/1、case2 は probe の追加前) | `[]` のまま (2/2) |
| A-4 (case3a, 3b) | `name` 有り、`run_in_background` 指定なし | A-3 と同じ (`e.background: true`、`isTeammate: true`) | A-3 と同じ | 無し (0/2) | A-3 と同じ | 拒否 (2/2) | `[]` のまま (2/2) |
| B-1 (case6a, 7a) | `name` 有り、`run_in_background: true` | `{ agentId: 'a<name>-<hex>', teammateId: '<name>@session-<sid8>' }` | leader のプロセスの loop。transcript は `<sid>/subagents/agent-a<name>-<hex>.jsonl` | 有り (2/2) | `id !== teammateId`、`running` → `idle` | 届く (2/2) | 出て、子の `turn.complete` で消える (2/2) |
| B-2 (case6b, 7b) | `name` 有り、`run_in_background` 指定なし | B-1 と同じ | B-1 と同じ | 有り (2/2) | 同上 | 届く (2/2) | 同上 (2/2) |
| B-3 (case6a の再起動) | idle の B-1 に SendMessage で仕事を渡す | — | 同じ loop が再開 | 同じ `agentId` で有り (1/1) | `idle` → `running` → `idle` | (未試行) | 再び出て、turn の終わりに消える (1/1) |

補足:

- 「届く」は append の返り値が `{ message, uuid }` で、子の次の request (transcript の `api-request-blob`) で直前の tool_result と同じ user message の text block に `PROBE-APPEND` が載ったこと。main (leader) の transcript には一度も載らなかった (2 セッションとも 0 件)
- `classic.SubagentStart` / `SubagentStop` は A-1・A-2・B-1・B-2 で leader に起き、A-3・A-4 では起きなかった。`classic.TeammateIdle` は B では leader に、A では teammate のプロセスの中で起きた
- A で 1 回、対応する `SubagentStart` も `agentId` 付きの `turn.*` も transcript も無い `classic.SubagentStop` (`agent_type: ""`) が起きた。engine の内部の agent と見られるが正体は見ていない。`turn.*` を起こさないので facts には影響しない
- A-3・A-4 の teammate の結果は leader の `session.receive` (`origin: { kind: 'peer', teammate: '<name>' }`) で届いた。A では `isVerified: false`、B では `isVerified: true`
- A・B とも、この環境では「フォアグラウンド」の指定 (`run_in_background` を付けない) でも `agent.spawn` の `e.background` は `true` で、leader の turn は子を待たずに終わった (8/8)。公式 docs の「main conversation から起きる subagent は background の既定に従う」に当たると読めるが、既定を決める設定は切り分けていない

## 前回の観測 (段 6 の後の実 model 試験) との照合

前回の試験用セッションの transcript でも、Agent の 2 回の呼び出しはどちらも `name` 付き (`run_in_background: true` と指定なし) で、結果は `status: 'teammate_spawned'`、`tmux_pane_id: '%1'` / `'%2'`、`is_splitpane: true` だった。project ディレクトリにあった別 sessionId の jsonl 2 つ (1 行目 `type: agent-setting`) はこの 2 つの teammate のプロセスの transcript で、`agentSetting` は teammate の `--agent-type` (`general-purpose`)。`<sid>/subagents/` が無かったのは、subagent が 1 つも起きていなかったため。今回の A-3・A-4 で同じ形を再現した。

## daemon から見た split pane の teammate

- teammate のプロセスも ccmsg の module を読み、自分の sid で sidecar を起こす。daemon はそれを受けるが、数秒後に `sidecar <teammate の sid>.<run> dropped: its harness is gone (not listed)` で捨てた (4/4、プロセスは生きていた)。daemon の agents の poll (`claude agents`) に teammate のプロセスが載らないため。結果として、split pane の teammate は peers / `send` の宛先にもならない (sid 宛ての `send` は未試行)
- 公式 docs によれば teammate の一覧と backend は team config (`teams/session-<sid8>/config.json` の `members`、`backendType`、`tmuxPaneId`) にある。in-process の時の中身は確認した (`backendType: "in-process"`)。split pane の時の中身 (teammate の session id が載るか) は、セッション A の終了で消えていて確認していない

## 直し方の判断

- 段 6 の一覧 (直送の宛先) に split pane の teammate を足すのは誤り。append は必ず拒まれるので、webui で選ぶと毎回 `not_running` になる
- `readSubagents` (session の開始・`/clear`・module の読み込み時に `$.agent.list()` の `status === 'running'` を一覧にする) は、その時点で走っている split pane の teammate も拾う。今回の観測では split pane の teammate は `id === teammateId`、in-process の teammate は `id !== teammateId` だったが、これは id の綴りの偶然で API の約束ではないので、これで区別する修正は入れていない (issue に記録)
- split pane の teammate を ccmsg の別セッションとして扱う (daemon が捨てない、leader と結び付けて webui に出す) かどうかは、teammate の sid を leader 側でどう知るか (team config か、teammate の module が親の sid を知る口があるか) の調査が要る。issue に分けた

## 観測の手順で踏んだこと

- **試験用セッションを tmux の中で起動すると、実 config の `teammateMode: "auto"` が split pane を選ぶ**。普段の端末 (tmux の外) と同じ in-process の形を見るなら、起動に `--settings '{"teammateMode":"in-process"}'` (または docs にある `--teammate-mode in-process`、`--help` には出ない) を付ける
- **試験用セッションには `CCMSG_STATE_DIR` だけでなく `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` も渡す**。観測中に plugin の新版が配布され、後から起きた teammate のプロセスが新版の sidecar で隔離 daemon に hello し、隔離 daemon が `graceful shutdown (upgrade)` で落ちた。代わりに新版の daemon が自動で起きたが、引き継いだのは `CCMSG_STATE_DIR` だけで、config / data は既定の場所を指していた (http は既定の port が使用中で bind に失敗)。気付いた時点で止め、隔離の 3 つを付けて起動し直した
- daemon の facts は `session_status_subscribe` の push で見た。subscribe はそのセッションの transcript ができる前だと `session has no transcript` で失敗するので、最初の turn を始めてから subscribe する

## probe mod (`probe-agents`)

`.claude-plugin/plugin.json` は `{ "name": "probe-agents", "version": "0.1.0", "description": "Probe: how Agent-tool children show up to a hooks module." }`、`hooks/hooks.json` は `{ "modules": ["./register.ts"] }`。split pane の teammate のプロセスにも `--plugin-dir` が引き継がれ、同じ mod が自分の sid で記録した。

```ts
// Probe: how Agent-tool children show up to a hooks module.
//   agent.* / turn.start / turn.complete / classic.Subagent* / classic.Teammate* /
//   classic.Task* / session.receive / tool.call(Agent): the `e` (clipped), and for
//   agent.spawn the value next(e) resolved to
//   $.agent.list(): at turn.start / turn.complete, and on a 1 s timer when it changed
//   once per id seen running: `$.session.append({ agentId })` 3 s later
// Logs to $MODS_LAB_DIR/probe-<sessionId>-<inst>.jsonl.

type Next = ((e: unknown) => unknown) & { event: string; origin?: unknown };
type Dollar = {
  env: { get(key: string): Promise<string | undefined> };
  fs: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void> };
  session: { id(): Promise<string>; append(a: unknown): Promise<unknown> };
  agent: { list(): Promise<unknown> };
  clock: { every(ms: number, fn: () => void): unknown; after(ms: number, fn: () => void): unknown };
  plugin: { root: string };
};
type Hook = ($: Dollar, e: unknown, next: Next) => unknown;
type On = (name: string, hook: Hook) => unknown;

const INST = Math.random().toString(36).slice(2, 8);
const CLIP = 2500;
let dir: string | undefined;
let sid = "unknown";
let seq = 0;
let buf: unknown[] = [];
let flushing = false;
let lastList = "";
let started = false;

function clip(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > CLIP ? `${s.slice(0, CLIP)}...<clipped>` : JSON.parse(s);
  } catch (err) {
    return `<unserializable: ${String(err)}>`;
  }
}

function log(entry: Record<string, unknown>): void {
  seq += 1;
  buf.push({ inst: INST, sid, n: seq, t: Date.now(), ...entry });
}

async function flush($: Dollar): Promise<void> {
  if (flushing || dir === undefined || buf.length === 0) return;
  flushing = true;
  try {
    const lines = buf;
    buf = [];
    const path = `${dir}/probe-${sid}-${INST}.jsonl`;
    let prev = "";
    try {
      prev = await $.fs.read(path);
    } catch {
      prev = "";
    }
    await $.fs.write(path, prev + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  } finally {
    flushing = false;
  }
}

async function list($: Dollar): Promise<unknown> {
  try {
    return clip(await $.agent.list());
  } catch (err) {
    return `<threw: ${String(err)}>`;
  }
}

const WATCHED = /^(agent\.|turn\.start$|turn\.complete$|classic\.(Subagent|Teammate|Task)|session\.receive$|session\.start$|session\.end$)/;

function agentIdOf(e: unknown): unknown {
  if (e !== null && typeof e === "object" && "agentId" in e) return e.agentId;
  return undefined;
}

function toolOf(e: unknown): unknown {
  if (e !== null && typeof e === "object" && "tool" in e) return e.tool;
  return undefined;
}

const tried = new Set<string>();

type Listed = { id: string; status: string; teammateId?: string };
function listed(l: unknown): Listed[] {
  if (!Array.isArray(l)) return [];
  const out: Listed[] = [];
  for (const a of l) {
    if (a !== null && typeof a === "object" && "id" in a && "status" in a && typeof a.id === "string" && typeof a.status === "string") {
      out.push({ id: a.id, status: a.status, ...("teammateId" in a && typeof a.teammateId === "string" ? { teammateId: a.teammateId } : {}) });
    }
  }
  return out;
}

async function tryAppend($: Dollar, l: unknown): Promise<void> {
  for (const a of listed(l)) {
    if (a.status !== "running" || tried.has(a.id)) continue;
    tried.add(a.id);
    $.clock.after(3000, () => {
      void (async () => {
        try {
          const r = await $.session.append({ message: { type: "user", content: [{ type: "text", text: `PROBE-APPEND to=${a.id}` }] }, agentId: a.id });
          log({ ev: "#append", agentId: a.id, teammate: a.teammateId !== undefined, r: clip(r) });
        } catch (err) {
          log({ ev: "#append", agentId: a.id, teammate: a.teammateId !== undefined, err: String(err) });
        }
      })();
    });
  }
}

export function register(on: On): void {
  on("*", ($, e, next) => {
    const ev = String(next.event);
    const isAgentCall = ev === "tool.call" && toolOf(e) === "Agent";
    if (!WATCHED.test(ev) && !isAgentCall) return next(e);
    log({ ev, by: clip(next.origin), agentId: agentIdOf(e) ?? null, e: clip(e) });
    const r = next(e);
    if (ev === "agent.spawn" || isAgentCall) {
      void Promise.resolve(r).then(
        (v) => log({ ev: `${ev}#result`, r: clip(v) }),
        (err) => log({ ev: `${ev}#threw`, err: String(err) }),
      );
    }
    if ((ev === "turn.start" || ev === "turn.complete") && started) {
      void list($).then((l) => log({ ev: `${ev}#list`, agentId: agentIdOf(e) ?? null, list: l }));
    }
    return r;
  });

  on("session.start", async ($, e, next) => {
    const r = await next(e);
    dir = (await $.env.get("MODS_LAB_DIR")) ?? `${$.plugin.root}/log`;
    sid = await $.session.id();
    if (!started) {
      started = true;
      log({ ev: "#start", list: await list($) });
      $.clock.every(1000, () => {
        void (async () => {
          const l = await list($);
          void tryAppend($, l);
          const s = JSON.stringify(l);
          if (s !== lastList) {
            lastList = s;
            log({ ev: "#list-changed", list: l });
          }
          await flush($);
        })();
      });
    }
    return r;
  });
}
```

## 未観測

- split pane の teammate の sid を宛先にした ccmsg の `send` (daemon が sidecar を捨てた後なので届かないと見込むが、試していない)
- split pane の時の team config の中身 (teammate の session id が載るか)
- iTerm2 (`it2`) の split pane。tmux と同じく別プロセスになると見込むが見ていない
- 普段の端末 (hyoui / Ghostty、tmux の外) での `auto` が in-process に落ちること。公式 docs の記述と、このセッションの環境に `TMUX` が無いことまでは確認したが、その端末で teammate を起こしてはいない
- teammate が走行中に module が読み込まれた時 (`readSubagents`) の一覧。split pane の teammate が `running` で拾われる経路は、コードを読んだ上での見込み
- 子の request が stream の途中の時の append の位置、`-p` の子、workflow の agent (2026-10-15 の findings の未観測のうち、今回も見ていないもの)
- 副次: probe mod の hot reload (2 回) の後も、読み込み直す前の instance の `$.clock.every` の timer が記録を続けているように見えた (instance の印の違う行が並んだ)。切り分けていない

## リファレンス (claude-mods) への反映候補

- `events` の `turn.start` の `agentId` の注記 (「subagent / teammate の turn だけ」) に、teammate は in-process の時だけで、split pane の teammate は別プロセスの main の turn になり leader では起きないことを足す。根拠: 本 findings のマトリクス A-3・A-4・B-1・B-2
- `dollar-api` の `agent.list()` に、split pane の teammate も載る (`id === teammateId`、`status` は `running` / `idle`) が append の宛先にならないことを足す
