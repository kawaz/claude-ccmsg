// DR-0020 Phase 2/3: unit tests for the pure snapshot->display folds used by
// StatusPanel.tsx, timeline/Timeline.tsx's mini panel, and SessionList.tsx's sidebar
// badge. No store/DOM dependency — these operate on a bare
// SessionStatusSnapshot.
import { describe, expect, test } from "bun:test";
import type {
  AgentInfo,
  SessionBackgroundStatus,
  SessionStatusSnapshot,
  SessionTodo,
  SessionWorkflowStatus,
} from "@ccmsg/protocol";
import {
  buildStatusSections,
  buildWorkflowDrilldown,
  canonicalModelId,
  dedupeWorkflowRunsByRunId,
  formatAgentLiveState,
  formatContextUsage,
  formatContextWindow,
  formatSessionModelEffort,
  shortModel,
  formatSidebarBadge,
  miniSummaryLines,
  splitBackground,
  splitTodos,
} from "../src/client/session-status-view.ts";

function todo(overrides: Partial<SessionTodo> & { id: string; status: string }): SessionTodo {
  return { subject: overrides.id, ...overrides };
}

function workflow(
  overrides: Partial<SessionWorkflowStatus> & { task_id: string; status: string },
): SessionWorkflowStatus {
  return { name: overrides.task_id, started_at: "2026-07-16T00:00:00.000Z", ...overrides };
}

function background(
  overrides: Partial<SessionBackgroundStatus> & { task_id: string; status: string },
): SessionBackgroundStatus {
  return {
    kind: "bash",
    description: overrides.task_id,
    started_at: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_SNAPSHOT: SessionStatusSnapshot = {
  todos: [],
  workflows: [],
  background: [],
  teammates: [],
};

describe("splitTodos", () => {
  test("zero todos: all buckets empty", () => {
    expect(splitTodos([])).toEqual({ pending: [], inProgress: [], completed: [] });
  });

  test("buckets by status, preserving snapshot order within each bucket", () => {
    const todos = [
      todo({ id: "t1", status: "pending" }),
      todo({ id: "t2", status: "in_progress" }),
      todo({ id: "t3", status: "completed" }),
      todo({ id: "t4", status: "pending" }),
    ];
    const sections = splitTodos(todos);
    expect(sections.pending.map((t) => t.id)).toEqual(["t1", "t4"]);
    expect(sections.inProgress.map((t) => t.id)).toEqual(["t2"]);
    expect(sections.completed.map((t) => t.id)).toEqual(["t3"]);
  });
});

describe("splitBackground", () => {
  test("zero entries: both buckets empty", () => {
    expect(splitBackground([])).toEqual({ running: [], done: [] });
  });

  test("only 'running' counts as running, any other status is done (open-set terminal values)", () => {
    const background_ = [
      background({ task_id: "b1", status: "running" }),
      background({ task_id: "b2", status: "done" }),
      background({ task_id: "b3", status: "failed" }), // unrecognized-but-terminal value
    ];
    const sections = splitBackground(background_);
    expect(sections.running.map((b) => b.task_id)).toEqual(["b1"]);
    expect(sections.done.map((b) => b.task_id)).toEqual(["b2", "b3"]);
  });
});

describe("buildStatusSections", () => {
  test("folds todos と background を 1 回で射影する", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "in_progress" })],
      workflows: [workflow({ task_id: "w1", status: "running" })],
      background: [background({ task_id: "b1", status: "running" })],
      teammates: [],
    };
    const sections = buildStatusSections(snapshot);
    expect(sections.todos.inProgress).toHaveLength(1);
    expect(sections.background.running).toHaveLength(1);
  });
});

describe("miniSummaryLines", () => {
  test("zero running workflows and zero in_progress todos: empty (panel hidden)", () => {
    expect(miniSummaryLines(EMPTY_SNAPSHOT)).toEqual([]);
    // completed todos / done workflows alone must not surface a line.
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "completed" })],
      workflows: [workflow({ task_id: "w1", status: "completed" })],
      background: [],
      teammates: [],
    };
    expect(miniSummaryLines(snapshot)).toEqual([]);
  });

  // todo は Status タブの TodoRow と同じ "#{id} {subject}" 表記で出す
  // (両者を突き合わせられるように)。
  test("running workflow before in_progress todo, todo prefixed with its id", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "in_progress", subject: "fix bug" })],
      workflows: [workflow({ task_id: "w1", status: "running", name: "release" })],
      background: [],
      teammates: [],
    };
    expect(miniSummaryLines(snapshot)).toEqual([
      { kind: "workflow", text: "release" },
      { kind: "todo", text: "#t1 fix bug" },
    ]);
  });

  // 走行中のものは件数によらず全件出す (残数への畳み込みなし)。
  test("every running workflow and in_progress todo is listed, however many", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [
        todo({ id: "t1", status: "in_progress", subject: "a" }),
        todo({ id: "t2", status: "in_progress", subject: "b" }),
        todo({ id: "t3", status: "in_progress", subject: "c" }),
      ],
      workflows: [
        workflow({ task_id: "w1", status: "running", name: "wf1" }),
        workflow({ task_id: "w2", status: "running", name: "wf2" }),
      ],
      background: [],
      teammates: [],
    };
    expect(miniSummaryLines(snapshot)).toEqual([
      { kind: "workflow", text: "wf1" },
      { kind: "workflow", text: "wf2" },
      { kind: "todo", text: "#t1 a" },
      { kind: "todo", text: "#t2 b" },
      { kind: "todo", text: "#t3 c" },
    ]);
  });

  // issue 2026-07-17 #1: context 消費は「今動いているタスク」とは別枠の
  // 追加行として、その後ろに必ず出る。
  test("context usage is appended after the workflow/todo lines", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "in_progress", subject: "fix bug" })],
      workflows: [],
      background: [],
      teammates: [],
      context: {
        tokens: 640_000,
        window: 1_000_000,
        model: "claude-fable-5",
        timestamp: "2026-07-17T00:00:00.000Z",
      },
    };
    expect(miniSummaryLines(snapshot)).toEqual([
      { kind: "todo", text: "#t1 fix bug" },
      { kind: "context", text: "ctx 640k/1M (64%) · fable-5" },
    ]);
  });

  test("context alone (zero workflows/todos) still surfaces a line (panel not hidden)", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [],
      background: [],
      teammates: [],
      context: { tokens: 100_000, window: 200_000, model: "m", timestamp: "t" },
    };
    expect(miniSummaryLines(snapshot)).toEqual([
      { kind: "context", text: "ctx 100k/200k (50%) · m" },
    ]);
  });

  // The ctx line ends with the session's process: uptime and Claude Code
  // version (kawaz 2026-10-25), in the line's own " · " separation.
  test("the process parts end the ctx line", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [],
      background: [],
      teammates: [],
      context: {
        tokens: 100_000,
        window: 1_000_000,
        model: "claude-fable-5[1m]",
        effort: "low",
        timestamp: "t",
      },
    };
    expect(miniSummaryLines(snapshot, ["2d15h", "claude v2.1.310"])).toEqual([
      { kind: "context", text: "ctx 100k/1M (10%) · fable-5[1m] · low · 2d15h · claude v2.1.310" },
    ]);
  });

  // Before the transcript says anything of the context, what the process runs
  // as is still known, so the line carries that alone.
  test("process parts without context make the line on their own", () => {
    expect(miniSummaryLines(EMPTY_SNAPSHOT, ["35m20s", "claude v2.1.310"])).toEqual([
      { kind: "context", text: "35m20s · claude v2.1.310" },
    ]);
  });

  // issue 2026-07-17 #5: 活動中 (state === "active") の teammate だけを 1 行に
  // まとめる。spawned/idle/stopped は数えない (workflow の running 限定
  // フィルタと同じ厳密一致方針)。
  test("active teammates are summarized into one line, non-active states excluded", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [],
      background: [],
      teammates: [
        { name: "researcher", spawned: true, state: "active" },
        { name: "writer", spawned: true, state: "idle" },
        { name: "reviewer", spawned: true, state: "active" },
      ],
    };
    expect(miniSummaryLines(snapshot)).toEqual([
      { kind: "teammate", text: "researcher, reviewer" },
    ]);
  });

  test("more than 3 active teammates collapse into a summarized count", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [],
      background: [],
      teammates: [
        { name: "a", spawned: true, state: "active" },
        { name: "b", spawned: true, state: "active" },
        { name: "c", spawned: true, state: "active" },
        { name: "d", spawned: true, state: "active" },
      ],
    };
    expect(miniSummaryLines(snapshot)).toEqual([{ kind: "teammate", text: "a, b 他 2 名" }]);
  });

  test("zero active teammates (all idle/stopped/undefined): no teammate line", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [],
      background: [],
      teammates: [{ name: "idle-one", spawned: true, state: "idle" }],
    };
    expect(miniSummaryLines(snapshot)).toEqual([]);
  });

  test("workflows, todos, context, and teammates all combine in one call", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [
        todo({ id: "t1", status: "in_progress", subject: "a" }),
        todo({ id: "t2", status: "in_progress", subject: "b" }),
      ],
      workflows: [workflow({ task_id: "w1", status: "running", name: "wf" })],
      background: [],
      teammates: [{ name: "researcher", spawned: true, state: "active" }],
      context: { tokens: 522_000, window: 1_000_000, model: "m", timestamp: "t" },
    };
    expect(miniSummaryLines(snapshot)).toEqual([
      { kind: "workflow", text: "wf" },
      { kind: "todo", text: "#t1 a" },
      { kind: "todo", text: "#t2 b" },
      { kind: "context", text: "ctx 522k/1M (52%) · m" },
      { kind: "teammate", text: "researcher" },
    ]);
  });
});

describe("agent live state display", () => {
  const agent: AgentInfo = {
    pid: 63828,
    cwd: "/repo",
    kind: "interactive",
    startedAt: 1784456050131,
    sessionId: "s1",
    config_dir: "/home/.claude-personal",
  };

  const since = "2026-10-18T00:00:00.000Z";

  test("ダイアログ待ちは waitingFor を upstream 語彙のまま添えて waiting と出す", () => {
    expect(formatAgentLiveState({ ...agent, status: "waiting", waitingFor: "dialog open" })).toBe(
      "waiting (dialog open)",
    );
    expect(formatAgentLiveState({ ...agent, status: "waiting" })).toBe("waiting");
    expect(
      formatAgentLiveState({ ...agent, status: "waiting", turn: { state: "responding", since } }),
    ).toBe("waiting");
  });

  // DR-0035 §3: 応答中かは hooks module の turn から。Claude Code の status は
  // 背景 shell が動いている間ずっと busy を返すので読まない
  test("応答中かは module の turn から出し、Claude Code の status は読まない", () => {
    expect(formatAgentLiveState({ ...agent, turn: { state: "responding", since } })).toBe(
      "responding",
    );
    expect(formatAgentLiveState({ ...agent, status: "busy", turn: { state: "idle", since } })).toBe(
      "idle",
    );
  });

  test("module が何も言っていなければ表示しない (status があっても)", () => {
    expect(formatAgentLiveState(agent)).toBeNull();
    expect(formatAgentLiveState({ ...agent, status: "busy" })).toBeNull();
    expect(formatAgentLiveState(undefined)).toBeNull();
  });
});

describe("context usage display", () => {
  // 分母は hooks module が Claude Code から読んだ window (findings
  // 2026-10-14-mods-vs-transcript-information-sources)。opus[1m] で起動した
  // 直後でも 1M で割る。
  test("window があればその値で割る", () => {
    const formatted = formatContextUsage({
      tokens: 100_000,
      window: 1_000_000,
      model: "claude-opus-5-5[1m]",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    expect(formatted.text).toBe("ctx 100k/1M (10%) · opus-5-5[1m]");
    expect(formatted.title).toContain("100,000 tokens");
    expect(formatted.title).toContain("context window 1,000,000");
  });

  // window はモデルの既定と環境変数の上書きで決まり、transcript には残らない。
  // module の無いセッションでは分母を推定せず、使用量だけを出す。
  test("window が無ければ分母も % も出さない", () => {
    const formatted = formatContextUsage({
      tokens: 522_000,
      model: "claude-fable-5",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    expect(formatted.text).toBe("ctx 522k · fable-5");
    expect(formatted.title).toContain("context window unknown");
  });

  // 最初の応答の前は使用量が無い。window と model は module が起動直後に送る。
  test("使用量の無い window は — で出す", () => {
    const formatted = formatContextUsage({ window: 1_000_000, model: "m", timestamp: "t" });
    expect(formatted.text).toBe("ctx —/1M · m");
    expect(formatted.title).toContain("no response yet");
  });

  test("100 万の倍数でない window は k で出す", () => {
    // DISABLE_COMPACT + CLAUDE_CODE_MAX_CONTEXT_TOKENS の上書きで 300,000 になる実測がある。
    expect(formatContextWindow(200_000)).toBe("200k");
    expect(formatContextWindow(300_000)).toBe("300k");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(2_000_000)).toBe("2M");
  });

  test("100% 超を丸め込まず表示する", () => {
    // clamp すると「window より多く使っている」という診断情報を失う。
    expect(
      formatContextUsage({ tokens: 1_100_000, window: 1_000_000, model: "m", timestamp: "t" }).text,
    ).toBe("ctx 1100k/1M (110%) · m");
  });

  test("formatSessionModelEffort は model を持つ最初の候補だけを採用する", () => {
    // effort は model を報告したのと同じ観測に属する値なので、model を採用した
    // 候補の effort だけを使う (後続候補の effort を混ぜると、実際には走って
    // いない組み合わせを表示してしまう)。
    const info = formatSessionModelEffort([
      undefined,
      { model: "claude-fable-5[1m]", effort: "low" },
      { model: "claude-sonnet-5", effort: "high" },
    ]);
    expect(info?.model).toBe("fable-5[1m]");
    expect(info?.effort).toBe("low");
    expect(info?.title).toBe("model claude-fable-5[1m] / effort low");
  });

  test("formatSessionModelEffort は model を持たない候補を飛ばして次を見る", () => {
    // 購読していない行では context 観測が無く、gateway の直近リクエスト
    // (model のみ) や凍結値へ落ちる。effort が無い候補では effort 節を出さない。
    const info = formatSessionModelEffort([
      undefined,
      { model: undefined, effort: "medium" },
      { model: "gpt-5.6-sol" },
    ]);
    // effort は要素ごと出さない (null) — 行の狭さを考えると、値の無いことを
    // 示す文字列に幅を割く意味がない。
    expect(info?.model).toBe("gpt-5.6-sol");
    expect(info?.effort).toBeNull();
    expect(info?.title).toBe("model gpt-5.6-sol");
  });

  test("formatSessionModelEffort は model がどこからも取れなければ null", () => {
    // 行に placeholder を足さない境界 (「未購読かつ直近リクエスト無し」の行)。
    expect(formatSessionModelEffort([])).toBeNull();
    expect(formatSessionModelEffort([undefined, {}, { effort: "low" }])).toBeNull();
  });

  test("shortModel は claude- prefix だけを剥がし [1m] suffix と非 claude 名を保持する", () => {
    // 表示短縮の仕様: prefix は冗長情報なので削るが、[1m] は 1M context pin の
    // 実情報なので残す。prefix 無し (codex 系等) はそのまま通す。
    expect(shortModel("claude-fable-5")).toBe("fable-5");
    expect(shortModel("claude-fable-5[1m]")).toBe("fable-5[1m]");
    expect(shortModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  test("effort ありの context は「· model · effort」の順で text に付く", () => {
    // DR-0020 addendum 2026-07-18 の表示形を仕様として厳密固定する。
    const formatted = formatContextUsage({
      tokens: 331_000,
      window: 1_000_000,
      model: "claude-fable-5",
      effort: "low",
      timestamp: "t",
    });
    expect(formatted.text).toBe("ctx 331k/1M (33%) · fable-5 · low");
    expect(formatted.title).toContain("effort low");
  });

  test("effort なし (旧 CC transcript) の context は effort 節を出さない", () => {
    // effort は CC ≤2.1.211 の行に無い optional。欠落時に「· undefined」等を
    // 出さない境界を固定する。
    const formatted = formatContextUsage({
      tokens: 100_000,
      window: 200_000,
      model: "claude-fable-5",
      timestamp: "t",
    });
    expect(formatted.text).toBe("ctx 100k/200k (50%) · fable-5");
    expect(formatted.title).not.toContain("effort");
  });
});

describe("formatSidebarBadge", () => {
  test("no snapshot (not subscribed / not yet arrived): null", () => {
    expect(formatSidebarBadge(undefined)).toBeNull();
  });

  test("all-zero snapshot: null (no badge segments)", () => {
    expect(formatSidebarBadge(EMPTY_SNAPSHOT)).toBeNull();
  });

  test("running-only counts for wf/bg, zero axes omitted", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [
        workflow({ task_id: "w1", status: "running" }),
        workflow({ task_id: "w2", status: "completed" }),
      ],
      background: [],
      teammates: [],
    };
    expect(formatSidebarBadge(snapshot)).toBe("wf:1");
  });

  test("todo fraction excludes completed from both numerator and denominator", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [
        todo({ id: "t1", status: "in_progress" }),
        todo({ id: "t2", status: "in_progress" }),
        todo({ id: "t3", status: "pending" }),
        todo({ id: "t4", status: "completed" }),
        todo({ id: "t5", status: "completed" }),
      ],
      workflows: [],
      background: [],
      teammates: [],
    };
    expect(formatSidebarBadge(snapshot)).toBe("todo:2/3");
  });

  test("all three axes present join with a single space, in wf/bg/todo order", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "pending" })],
      workflows: [workflow({ task_id: "w1", status: "running" })],
      background: [background({ task_id: "b1", status: "running" })],
      teammates: [],
    };
    expect(formatSidebarBadge(snapshot)).toBe("wf:1 bg:1 todo:0/1");
  });
});

describe("canonicalModelId (issue 2026-07-21 #6)", () => {
  test("既知の短縮エイリアスは full ID に寄せる", () => {
    // workflowProgress や meta.json は呼び出し側の値をそのまま記録するため
    // 「haiku」等の alias 表記が混じる。表示層で full ID 側に統一する。
    expect(canonicalModelId("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(canonicalModelId("sonnet")).toBe("claude-sonnet-5");
    expect(canonicalModelId("opus")).toBe("claude-opus-4-7");
    expect(canonicalModelId("fable")).toBe("claude-fable-5");
  });
  test("既に full ID / 未知の値は passthrough (open-set)", () => {
    // 新しいモデル alias や snapshot 付き ID を沈黙で切り落とさないため、
    // 未知は生値のまま返す。
    expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(canonicalModelId("claude-fable-5[1m]")).toBe("claude-fable-5[1m]");
    expect(canonicalModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});

describe("dedupeWorkflowRunsByRunId (issue 2026-07-21 #5)", () => {
  test("run_id が同じ複数 entry は 1 件に集約 (running 優先で最新 started_at)", () => {
    // pause→resume で同一 runId の Workflow toolUseResult が taskId 別に複数出現する
    // 実データ (wf_666fea3f-0be, 3 件観測) に対する fold。
    const wfs = [
      workflow({
        task_id: "w1mej0pil",
        status: "completed",
        run_id: "wf_666fea3f-0be",
        started_at: "2026-07-21T00:00:00.000Z",
      }),
      workflow({
        task_id: "wwrizukyz",
        status: "running",
        run_id: "wf_666fea3f-0be",
        started_at: "2026-07-21T00:05:00.000Z",
      }),
      workflow({
        task_id: "wwwn9yid4",
        status: "running",
        run_id: "wf_666fea3f-0be",
        started_at: "2026-07-21T00:10:00.000Z",
      }),
    ];
    const out = dedupeWorkflowRunsByRunId(wfs);
    expect(out).toHaveLength(1);
    // running のうち最新 started_at → wwwn9yid4
    expect(out[0]?.task_id).toBe("wwwn9yid4");
  });
  test("全て terminal なら started_at が最新の entry を採用", () => {
    const wfs = [
      workflow({
        task_id: "a",
        status: "completed",
        run_id: "wf_11111111-abc",
        started_at: "2026-07-21T00:00:00.000Z",
      }),
      workflow({
        task_id: "b",
        status: "failed",
        run_id: "wf_11111111-abc",
        started_at: "2026-07-21T01:00:00.000Z",
      }),
    ];
    const out = dedupeWorkflowRunsByRunId(wfs);
    expect(out).toHaveLength(1);
    expect(out[0]?.task_id).toBe("b");
  });
  test("run_id 未設定 (旧型 / 不正 run_id) の entry は passthrough (落とさない)", () => {
    const wfs = [
      workflow({ task_id: "old1", status: "running" }),
      workflow({ task_id: "old2", status: "completed" }),
    ];
    expect(dedupeWorkflowRunsByRunId(wfs).map((w) => w.task_id)).toEqual(["old1", "old2"]);
  });
  test("出現順は初回登場位置を保つ (混在 case)", () => {
    // run_id 有無を混ぜても表示順序が崩れないことを固定する
    // (Status タブでの並びが不意にひっくり返らないため)。
    const wfs = [
      workflow({ task_id: "solo1", status: "running" }),
      workflow({
        task_id: "grpA1",
        status: "running",
        run_id: "wf_22222222-abc",
        started_at: "2026-07-21T00:00:00.000Z",
      }),
      workflow({ task_id: "solo2", status: "completed" }),
      workflow({
        task_id: "grpA2",
        status: "running",
        run_id: "wf_22222222-abc",
        started_at: "2026-07-21T00:05:00.000Z",
      }),
    ];
    expect(dedupeWorkflowRunsByRunId(wfs).map((w) => w.task_id)).toEqual([
      "solo1",
      "grpA2",
      "solo2",
    ]);
  });
});

describe("buildWorkflowDrilldown (DR-0025)", () => {
  test("phases/agents 双方 undefined なら null", () => {
    expect(buildWorkflowDrilldown(workflow({ task_id: "w1", status: "running" }))).toBeNull();
  });

  test("phases/agents 写像 + icon 分岐 + label fallback", () => {
    const wf: SessionWorkflowStatus = {
      ...workflow({ task_id: "w1", status: "completed" }),
      run_id: "wf_01234567-abc",
      phases: [
        { title: "Plan", done: 1, total: 1 },
        { title: "Verify", done: 0, total: 1 },
      ],
      agents: [
        {
          agent_id: "a1",
          label: "plan",
          model: "claude-fable-5[1m]",
          state: "done",
          tokens: 149564,
          phase_title: "Plan",
        },
        {
          agent_id: "a2",
          agent_type: "sonnet5",
          state: "running",
        },
        { agent_id: "a3", state: "error", error: "boom" },
        { agent_id: "a4", state: "progress" },
        { agent_id: "a5", state: "queued" },
      ],
    };
    const view = buildWorkflowDrilldown(wf);
    expect(view).not.toBeNull();
    expect(view?.phases).toEqual([
      { title: "Plan", done: 1, total: 1 },
      { title: "Verify", done: 0, total: 1 },
    ]);
    const icons = view?.agents.map((a) => `${a.agentId}:${a.icon}`);
    expect(icons).toEqual(["a1:done", "a2:running", "a3:error", "a4:running", "a5:pending"]);
    // label fallback: agent_type when label absent, agent_id when both absent
    expect(view?.agents[1]?.label).toBe("sonnet5");
    expect(view?.agents[2]?.label).toBe("a3");
    expect(view?.agents[0]?.tokens).toBe(149564);
    expect(view?.agents[0]?.phaseTitle).toBe("Plan");
    expect(view?.agents[2]?.error).toBe("boom");
  });
});
