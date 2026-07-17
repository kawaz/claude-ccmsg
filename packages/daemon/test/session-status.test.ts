import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionStatusSnapshot } from "@ccmsg/protocol";
import {
  createSessionStatusState,
  foldLine,
  isSessionStatusCandidate,
  scanTranscript,
  snapshot,
} from "../src/session-status.ts";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 20_000;
const START = "2026-07-14T16:27:55.672Z";
const END = "2026-07-14T16:28:55.672Z";

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  timestamp = START,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

function toolResult(
  id: string,
  result: unknown,
  timestamp = END,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content: "observed result", ...extra }],
    },
    toolUseResult: result,
  });
}

function assistantUsage(
  tokens: {
    input: number;
    cacheRead: number;
    cacheCreation: number;
  },
  opts: { model?: string; timestamp?: string; isSidechain?: boolean; usage?: unknown } = {},
): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: opts.isSidechain ?? false,
    timestamp: opts.timestamp ?? START,
    message: {
      model: opts.model ?? "claude-fable-5",
      usage: opts.usage ?? {
        input_tokens: tokens.input,
        cache_read_input_tokens: tokens.cacheRead,
        cache_creation_input_tokens: tokens.cacheCreation,
      },
      content: [{ type: "text", text: "observed assistant output" }],
    },
  });
}

function teammateRelay(content: string, timestamp = END): string {
  return JSON.stringify({
    type: "user",
    isSidechain: false,
    timestamp,
    message: {
      role: "user",
      content:
        "Another Claude session sent a message:\n" +
        content +
        "\n\nThis came from another Claude session — reply through SendMessage.",
    },
  });
}

function taskNotification(
  taskId: string,
  status?: string,
  opts: { operation?: string; bodyTag?: "event" | "result"; body?: string } = {},
): string {
  const body = opts.bodyTag ? `<${opts.bodyTag}>${opts.body ?? ""}</${opts.bodyTag}>` : "";
  return JSON.stringify({
    type: "queue-operation",
    operation: opts.operation ?? "enqueue",
    timestamp: END,
    content:
      `<task-notification>\n<task-id>${taskId}</task-id>\n` +
      (status === undefined ? "" : `<status>${status}</status>\n`) +
      `${body}\n</task-notification>`,
  });
}

function apply(lines: string[]): SessionStatusSnapshot {
  const state = createSessionStatusState();
  for (const line of lines) {
    if (isSessionStatusCandidate(line)) foldLine(state, line);
  }
  return snapshot(state);
}

function todoCreate(id = "1", subject = "First task"): string[] {
  return [
    toolUse("tc1", "TaskCreate", { subject, description: "desc", activeForm: "Working" }),
    toolResult("tc1", { task: { id, subject } }),
  ];
}

function todoUpdate(
  toolId: string,
  taskId: string,
  input: Record<string, unknown>,
  result: Record<string, unknown> = {
    success: true,
    taskId,
    updatedFields: ["status"],
    statusChange: { from: "pending", to: input.status },
  },
): string[] {
  return [toolUse(toolId, "TaskUpdate", { taskId, ...input }), toolResult(toolId, result)];
}

function monitorStart(taskId = "b1", toolId = "mon1"): string[] {
  return [
    toolUse(toolId, "Monitor", {
      command: "tail -f run.log",
      description: "watch run",
      persistent: true,
      timeout_ms: 0,
    }),
    toolResult(toolId, { taskId, timeoutMs: 0, persistent: true }),
  ];
}

function fixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-session-status-"));
}

async function sessionHello(ctx: DaemonCtx, sid: string, file?: string): Promise<TestClient> {
  const client = await connect(ctx.sock);
  await client.request({
    op: "hello",
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
    ...(file ? { transcript_path: file } : {}),
  });
  return client;
}

async function userHello(ctx: DaemonCtx): Promise<TestClient> {
  const client = await connect(ctx.sock);
  await client.hello({ role: "user" });
  return client;
}

interface StatusOk extends SessionStatusSnapshot {
  ok: true;
  sid: string;
}

interface StatusEvent extends SessionStatusSnapshot {
  ev: "session_status";
  sid: string;
}

interface ErrorLite {
  ok: false;
  error: { code: string };
}

describe("session status fold (DR-0020 Phase 1)", () => {
  test("直近 assistant usage の 3 入力トークン値を合算し model/timestamp と保存する", () => {
    // 実 transcript の usage shape を最小化した fixture で、出力 token を含めず main context だけを測る。
    const result = apply([assistantUsage({ input: 2, cacheRead: 617_281, cacheCreation: 2_588 })]);
    expect(result.context).toEqual({
      tokens: 619_871,
      model: "claude-fable-5",
      timestamp: START,
    });
  });

  test("compaction 後に usage 合算が減っても直近値へ上書き追従する", () => {
    // context は累積最大値ではなく現在値なので、832384 から 147736 への減少を保持する。
    const result = apply([
      assistantUsage({ input: 4, cacheRead: 830_000, cacheCreation: 2_380 }),
      assistantUsage({ input: 2, cacheRead: 145_000, cacheCreation: 2_734 }, { timestamp: END }),
    ]);
    expect(result.context?.tokens).toBe(147_736);
    expect(result.context?.timestamp).toBe(END);
  });

  test("synthetic assistant 行は直前の context 観測値を上書きしない", () => {
    // <synthetic> は usage 全ゼロの harness 行であり、メインモデルの context として採用しない。
    const result = apply([
      assistantUsage({ input: 1, cacheRead: 99_999, cacheCreation: 0 }),
      assistantUsage(
        { input: 0, cacheRead: 0, cacheCreation: 0 },
        { model: "<synthetic>", timestamp: END },
      ),
    ]);
    expect(result.context?.tokens).toBe(100_000);
    expect(result.context?.model).toBe("claude-fable-5");
  });

  test("usage 無しまたは record でない assistant 行を例外なく無視する", () => {
    // status fold は通常テキスト行や壊れた usage shape が混じっても直前値を保持する。
    const state = createSessionStatusState();
    const accepted = assistantUsage({ input: 1, cacheRead: 1, cacheCreation: 1 });
    expect(foldLine(state, accepted)).toBe(true);
    for (const line of [
      JSON.stringify({
        type: "assistant",
        timestamp: END,
        message: { model: "claude-fable-5", content: [] },
      }),
      assistantUsage(
        { input: 0, cacheRead: 0, cacheCreation: 0 },
        { timestamp: END, usage: "not-record" },
      ),
    ]) {
      expect(foldLine(state, line)).toBe(false);
    }
    expect(snapshot(state).context?.tokens).toBe(3);
  });

  test("isSidechain:true の assistant usage はメイン context に採用しない", () => {
    // サブエージェントの大きい usage が main session の使用率へ混入しない境界を保証する。
    const result = apply([
      assistantUsage({ input: 2, cacheRead: 98, cacheCreation: 0 }),
      assistantUsage(
        { input: 2, cacheRead: 500_000, cacheCreation: 0 },
        { isSidechain: true, timestamp: END },
      ),
    ]);
    expect(result.context?.tokens).toBe(100);
  });

  test("同じ tokens/model の assistant 行は status 変化なしとして push を抑止する", () => {
    // timestamp だけ違う再記録は表示値を変えないため foldLine=false とし、不要な snapshot push を出さない。
    const state = createSessionStatusState();
    expect(foldLine(state, assistantUsage({ input: 2, cacheRead: 98, cacheCreation: 0 }))).toBe(
      true,
    );
    expect(
      foldLine(
        state,
        assistantUsage({ input: 2, cacheRead: 98, cacheCreation: 0 }, { timestamp: END }),
      ),
    ).toBe(false);
  });

  test("name 付き Agent spawn の teammate_spawned result を teammate として記録する", () => {
    // foreground Agent でも input.name + teammate_spawned result の組が teams spawn である実契約を固定する。
    const result = apply([
      toolUse("team-spawn", "Agent", {
        subagent_type: "codex-sol-worker",
        name: "m2-fixer",
        description: "fix",
        prompt: "inspect",
      }),
      toolResult("team-spawn", {
        status: "teammate_spawned",
        teammate_id: "m2-fixer@session-a8aebf86",
        agent_id: "m2-fixer@session-a8aebf86",
        agent_type: "codex-sol-worker",
        model: "gpt-5.6-sol",
        name: "m2-fixer",
        color: "cyan",
      }),
    ]);
    expect(result.teammates).toEqual([
      {
        name: "m2-fixer",
        spawned: true,
        agent_type: "codex-sol-worker",
        color: "cyan",
        spawned_at: END,
        state: "spawned",
      },
    ]);
  });

  test("background Agent result は従来の background に入り teammates へ混入しない", () => {
    // run_in_background + agentId は agent-teams ではないため、既存 background correlation を保つ。
    const result = apply([
      toolUse("background-agent", "Agent", {
        description: "research",
        prompt: "inspect",
        run_in_background: true,
        subagent_type: "Explore",
      }),
      toolResult("background-agent", {
        agentId: "agent-bg",
        status: "async_launched",
        isAsync: true,
      }),
    ]);
    expect(result.background.map((task) => task.task_id)).toEqual(["agent-bg"]);
    expect(result.teammates).toEqual([]);
  });

  test("SendMessage 成功 result は宛先 teammate の最終送信時刻を更新する", () => {
    // spawn を観測していない宛先も名前で突合し、送信成功が確定した result 時刻だけを記録する。
    const result = apply([
      toolUse("send", "SendMessage", {
        to: "kuu-cli-q8",
        summary: "done",
        message: "result",
      }),
      toolResult("send", {
        success: true,
        message: "Message sent to kuu-cli-q8's inbox",
        msg_id: "msg-1",
        routing: { sender: "team-lead", target: "@kuu-cli-q8", targetColor: "cyan" },
      }),
    ]);
    expect(result.teammates).toEqual([
      {
        name: "kuu-cli-q8",
        spawned: false,
        state: "active",
        last_sent_at: END,
      },
    ]);
  });

  test("SendMessage 失敗 result は teammate 状態を更新しない", () => {
    // tool_result error または success!==true は送信成功の証拠にならないため両方とも捨てる。
    const result = apply([
      toolUse("send-error", "SendMessage", { to: "worker-a", message: "x" }),
      toolResult("send-error", { success: true }, END, { is_error: true }),
      toolUse("send-false", "SendMessage", { to: "worker-b", message: "x" }),
      toolResult("send-false", { success: false }),
    ]);
    expect(result.teammates).toEqual([]);
  });

  test("単一 teammate-message relay を spawn 無し teammate の active 受信として記録する", () => {
    // summary 属性が無い実形でも teammate_id と本文を抽出し、relay 時刻を最終受信にする。
    const result = apply([
      teammateRelay(
        '<teammate-message teammate_id="kuu-cli-q8" color="cyan">実装完了</teammate-message>',
      ),
    ]);
    expect(result.teammates).toEqual([
      {
        name: "kuu-cli-q8",
        spawned: false,
        color: "cyan",
        state: "active",
        last_received_at: END,
      },
    ]);
  });

  test("1 user 行に連結された複数 teammate-message relay を全件抽出する", () => {
    // relay は 1 行 1 件とは限らない実観測に合わせ、global regex で両 teammate を更新する。
    const result = apply([
      teammateRelay(
        '<teammate-message teammate_id="a" color="cyan">A</teammate-message>\n' +
          '<teammate-message teammate_id="b" color="green">B</teammate-message>',
      ),
    ]);
    expect(result.teammates!.map((teammate) => teammate.name)).toEqual(["a", "b"]);
  });

  test("idle_notification relay は teammate の推定状態を idle にする", () => {
    // idle は TUI 内部状態ではなく teammate 自身から届いた JSON 通知の最後の観測として表示する。
    const result = apply([
      teammateRelay(
        '<teammate-message teammate_id="worker" color="cyan">' +
          '{"type":"idle_notification","from":"worker","timestamp":"2026-07-17T00:00:00Z","idleReason":"available"}' +
          "</teammate-message>",
      ),
    ]);
    expect(result.teammates?.[0]?.state).toBe("idle");
  });

  test("同名 teammate の re-spawn は 1 entry の metadata を後勝ち更新し送受信時刻を保持する", () => {
    // Agent tool の name は latest-wins で再利用されるため、Map key は name とし活動履歴を連続扱いする。
    const result = apply([
      toolUse("spawn-1", "Agent", {
        name: "worker",
        subagent_type: "first-worker",
        description: "first",
        prompt: "first",
      }),
      toolResult("spawn-1", {
        status: "teammate_spawned",
        name: "worker",
        agent_type: "first-worker",
        color: "cyan",
      }),
      toolUse("send-worker", "SendMessage", { to: "worker", message: "ping" }),
      toolResult("send-worker", { success: true, msg_id: "msg-worker" }),
      toolUse(
        "spawn-2",
        "Agent",
        {
          name: "worker",
          subagent_type: "second-worker",
          description: "second",
          prompt: "second",
        },
        "2026-07-17T00:02:00.000Z",
      ),
      toolResult(
        "spawn-2",
        {
          status: "teammate_spawned",
          name: "worker",
          agent_type: "second-worker",
          color: "magenta",
        },
        "2026-07-17T00:03:00.000Z",
      ),
    ]);
    expect(result.teammates).toHaveLength(1);
    expect(result.teammates?.[0]).toMatchObject({
      name: "worker",
      agent_type: "second-worker",
      color: "magenta",
      last_sent_at: END,
      spawned_at: "2026-07-17T00:03:00.000Z",
      state: "spawned",
    });
  });

  test("teammate_id=system の lifecycle relay を teammate として列挙しない", () => {
    // 実観測: teammate_terminated 等は <teammate-message teammate_id="system"> で届く。
    // system は teammate 名ではなくライフサイクル通知の送り主ラベルなので一覧から除外する。
    const result = apply([
      teammateRelay(
        '<teammate-message teammate_id="system">' +
          '{"type":"teammate_terminated","message":"worker has shut down."}' +
          "</teammate-message>",
      ),
    ]);
    expect(result.teammates).toEqual([]);
  });

  test("TaskStop の in_process_teammate result は該当 teammate を stopped に遷移させる", () => {
    // 実観測 (kuu 2026-07-17): TaskStop input.task_id は teammate 名、result は
    // {task_type:"in_process_teammate", task_id:"<内部id>"}。停止後に idle/active の
    // 推定が残り続けると「最後に観測した活動」表示として誤導するため stopped を立てる。
    const result = apply([
      toolUse("spawn", "Agent", { name: "worker", subagent_type: "x", prompt: "p" }),
      toolResult("spawn", { status: "teammate_spawned", name: "worker", agent_type: "x" }),
      toolUse("stop", "TaskStop", { task_id: "worker" }),
      toolResult("stop", {
        message: "Successfully stopped task: t123 (p...)",
        task_id: "t123",
        task_type: "in_process_teammate",
        command: "p...",
      }),
    ]);
    expect(result.teammates?.[0]?.state).toBe("stopped");
    // teammate 名の TaskStop は background/workflow へ entry を作らない。
    expect(result.background).toEqual([]);
    expect(result.workflows).toEqual([]);
  });

  test("未観測 teammate への TaskStop は stopped-only entry を作らない", () => {
    // spawn が transcript 外 (rotate 等) の場合、存在の証拠が無い名前を一覧へ足さない。
    const result = apply([
      toolUse("stop", "TaskStop", { task_id: "ghost" }),
      toolResult("stop", { task_id: "t9", task_type: "in_process_teammate", message: "ok" }),
    ]);
    expect(result.teammates).toEqual([]);
  });

  test("ccmsg peer 用 agent-message tag は teams relay として扱わない", () => {
    // <agent-message> は別プロトコルなので teammate-message と誤突合しないスコープ境界を固定する。
    const result = apply([
      JSON.stringify({
        type: "user",
        timestamp: END,
        message: {
          content:
            'Another Claude session sent a message:\n<agent-message from="peer">x</agent-message>',
        },
      }),
    ]);
    expect(result.teammates).toEqual([]);
  });

  test("context と teams の実 fixture は全て文字列 prefilter を通過する", () => {
    // parse 前 grep 相当で落ちると fold テストが直接呼べても実 scan では届かないため、入口を別途保証する。
    const fixtures = [
      assistantUsage({ input: 2, cacheRead: 98, cacheCreation: 0 }),
      toolUse("spawn", "Agent", { name: "worker", subagent_type: "x" }),
      toolResult("spawn", { status: "teammate_spawned", name: "worker" }),
      toolUse("send", "SendMessage", { to: "worker", message: "x" }),
      toolResult("send", { success: true, msg_id: "msg-prefilter" }),
      teammateRelay('<teammate-message teammate_id="worker">x</teammate-message>'),
    ];
    for (const fixture of fixtures) expect(isSessionStatusCandidate(fixture)).toBe(true);
  });

  test("TaskCreate の result id を採用し、TaskUpdate の状態遷移を最終状態まで再生する", () => {
    // TaskCreate input に id が無い実 transcript 契約を凍結し、result 側 id で TODO を同定する。
    const result = apply([
      ...todoCreate(),
      ...todoUpdate("tu1", "1", { status: "in_progress" }),
      ...todoUpdate("tu2", "1", { status: "completed" }),
    ]);
    expect(result.todos).toEqual([{ id: "1", subject: "First task", status: "completed" }]);
  });

  test("TaskUpdate は owner/subject を反映し、表示対象外 metadata だけの update は状態を変えない", () => {
    // owner/subject は Status 表示対象だが addBlockedBy/description は対象外、という境界を保証する。
    const state = createSessionStatusState();
    for (const line of [
      ...todoCreate(),
      ...todoUpdate("tu1", "1", { status: "in_progress", owner: "worker-a" }),
      ...todoUpdate(
        "tu2",
        "1",
        { subject: "Renamed", description: "new description" },
        {
          success: true,
          taskId: "1",
          updatedFields: ["subject", "description"],
        },
      ),
    ]) {
      if (isSessionStatusCandidate(line)) foldLine(state, line);
    }
    const before = snapshot(state);
    for (const line of todoUpdate(
      "tu3",
      "1",
      { addBlockedBy: ["2"] },
      {
        success: true,
        taskId: "1",
        updatedFields: ["addBlockedBy"],
      },
    )) {
      if (isSessionStatusCandidate(line)) expect(foldLine(state, line)).toBe(false);
    }
    expect(snapshot(state)).toEqual(before);
    expect(before.todos).toEqual([
      { id: "1", subject: "Renamed", status: "in_progress", owner: "worker-a" },
    ]);
  });

  test("TaskUpdate status:deleted は TODO をリストから取り除く", () => {
    // TUI の todo リストは deleted task を表示しない。folded 現在状態も「deleted のまま
    // 残る」のではなく削除で追随する (DR-0020 § 2.1 の TUI 同等)。実 result 形は
    // {success:true, updatedFields:["deleted"], statusChange:{to:"deleted"}} (実 transcript 観測)。
    const state = createSessionStatusState();
    for (const line of [
      ...todoCreate(),
      ...todoUpdate(
        "tu-del",
        "1",
        { status: "deleted" },
        {
          success: true,
          taskId: "1",
          updatedFields: ["deleted"],
          statusChange: { from: "pending", to: "deleted" },
        },
      ),
    ]) {
      if (isSessionStatusCandidate(line)) foldLine(state, line);
    }
    expect(snapshot(state).todos).toEqual([]);
    // 既に存在しない task の deleted は状態変化なし (= push を発生させない)。
    for (const line of todoUpdate(
      "tu-del2",
      "1",
      { status: "deleted" },
      { success: true, taskId: "1", updatedFields: ["deleted"] },
    )) {
      if (isSessionStatusCandidate(line)) expect(foldLine(state, line)).toBe(false);
    }
  });

  test("TaskCreate が無い TaskUpdate は unknown placeholder を作って状態を保持する", () => {
    // 実 transcript にも存在する途中開始 task を落とさず、id/status を可視化する。
    const result = apply(todoUpdate("tu-orphan", "6", { status: "completed" }));
    expect(result.todos).toEqual([{ id: "6", subject: "(unknown)", status: "completed" }]);
  });

  test("状態遷移の巻き戻り (completed → in_progress) は後勝ちで反映する", () => {
    // fold は transcript の出現順 = 実際の操作順。completed 後の再オープン
    // (やり直し) は上書きが正で、「completed に一度なったら固定」ではない。
    const result = apply([
      ...todoCreate(),
      ...todoUpdate("tu1", "1", { status: "completed" }),
      ...todoUpdate("tu2", "1", { status: "in_progress" }),
    ]);
    expect(result.todos).toEqual([{ id: "1", subject: "First task", status: "in_progress" }]);
  });

  test("同一 id の TaskCreate 再出現は後勝ちで subject/status を初期化する", () => {
    // 実 harness は id を単調採番するので通常起きないが、fold は「最後のイベントが真」
    // の単純規則で防御する (以前の owner/status を引きずらない)。
    const result = apply([
      ...todoCreate("1", "Old subject"),
      ...todoUpdate("tu1", "1", { status: "in_progress", owner: "worker-a" }),
      ...todoCreate("1", "Recreated"),
    ]);
    expect(result.todos).toEqual([{ id: "1", subject: "Recreated", status: "pending" }]);
  });

  test("起動記録の無い task-id への通知は幽霊エントリを作らない", () => {
    // subscribe 前の全量 scan が必ず [0, size) を読むため、起動が transcript に無い
    // 通知は「このセッション外のタスク」(例: 別経路の注入)。workflows/background の
    // どちらにも entry を作らず黙って捨てる。
    const result = apply([taskNotification("ghost-task", "completed")]);
    expect(result).toEqual({ todos: [], workflows: [], background: [], teammates: [] });
  });

  test("TaskUpdate は success:true の result と突合できた場合だけ反映する", () => {
    // 失敗または null result の input を先行反映せず、確定済み状態を保持する。
    const result = apply([
      ...todoCreate(),
      toolUse("bad1", "TaskUpdate", { taskId: "1", status: "completed" }),
      toolResult("bad1", { success: false, taskId: "1", updatedFields: ["status"], error: "no" }),
      toolUse("bad2", "TaskUpdate", { taskId: "1", status: "completed" }),
      toolResult("bad2", null),
    ]);
    expect(result.todos[0]?.status).toBe("pending");
  });

  test("Workflow は result taskId/name で起動し enqueue terminal 通知で完了する", () => {
    // Workflow tool_use と task-notification は tool/result 由来 taskId で突合される。
    const result = apply([
      toolUse("wf-tool", "Workflow", { script: "export const meta = {}" }),
      toolResult("wf-tool", {
        status: "async_launched",
        taskId: "w1",
        taskType: "local_workflow",
        workflowName: "build-flow",
        runId: "wf_run",
        summary: "Build workflow",
        transcriptDir: "/redacted",
        scriptPath: "/redacted/script.ts",
      }),
      taskNotification("w1", "completed"),
    ]);
    expect(result.workflows).toEqual([
      {
        task_id: "w1",
        name: "build-flow",
        summary: "Build workflow",
        status: "completed",
        started_at: START,
        ended_at: END,
      },
    ]);
  });

  test("queue-operation は enqueue の外側 status だけを terminal として扱う", () => {
    // remove/dequeue の重複と status 無し途中通知、および event 内の偽タグを全て無視する。
    const base = [
      ...monitorStart(),
      taskNotification("b1", "failed", { operation: "remove" }),
      taskNotification("b1"),
      taskNotification("b1", "running"),
      taskNotification("b1", undefined, {
        bodyTag: "event",
        body: "user data contains <status>failed</status>",
      }),
      taskNotification("b1", undefined, {
        bodyTag: "result",
        body: "user data contains <status>killed</status>",
      }),
      // <summary> は Monitor/Agent の description をそのまま埋め込む (ユーザ制御文字列)。
      // Monitor event 通知は <status> 無しで <summary> が先頭側に来るので、summary 内の
      // 偽 <status> タグを本物と誤認してはならない (harness の実タグ順は task-id →
      // tool-use-id → output-file → status → summary、実 transcript 観測)。
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: END,
        content:
          "<task-notification>\n<task-id>b1</task-id>\n" +
          '<summary>Monitor event: "desc with <status>failed</status>"</summary>\n' +
          "<event>line</event>\n</task-notification>",
      }),
    ];
    expect(apply(base).background[0]?.status).toBe("running");
  });

  test("Monitor/Bash/Agent background は実 result id で起動し、同期 Agent は除外する", () => {
    // 3 種の background correlation id が通知 task-id と一致し、run_in_background 無し Agent は出ない。
    const result = apply([
      ...monitorStart("b-monitor", "mon"),
      toolUse("bash", "Bash", {
        command: "bun run server",
        description: "server",
        run_in_background: true,
      }),
      toolResult("bash", { backgroundTaskId: "b-bash", stdout: "", stderr: "" }),
      toolUse("agent", "Agent", {
        description: "research",
        prompt: "inspect",
        run_in_background: true,
        subagent_type: "Explore",
      }),
      toolResult("agent", {
        agentId: "a-agent",
        status: "async_launched",
        description: "research",
        isAsync: true,
      }),
      toolUse("sync-agent", "Agent", {
        description: "sync",
        prompt: "inspect",
        subagent_type: "Explore",
      }),
      toolResult("sync-agent", { agentId: "a-sync", status: "completed" }),
      taskNotification("b-monitor", "completed"),
      taskNotification("b-bash", "failed"),
      taskNotification("a-agent", "killed"),
    ]);
    expect(result.background).toEqual([
      {
        task_id: "b-monitor",
        kind: "monitor",
        description: "watch run",
        status: "completed",
        started_at: START,
        ended_at: END,
      },
      {
        task_id: "b-bash",
        kind: "bash",
        description: "server",
        status: "failed",
        started_at: START,
        ended_at: END,
      },
      {
        task_id: "a-agent",
        kind: "agent",
        description: "research",
        status: "killed",
        started_at: START,
        ended_at: END,
      },
    ]);
  });

  test("TaskStop の成功 result は対応する background を stopped にする", () => {
    // snake_case task_id と実観測 TaskStop result shape の突合を保証する。
    const result = apply([
      ...monitorStart(),
      toolUse("stop", "TaskStop", { task_id: "b1" }),
      toolResult("stop", {
        task_id: "b1",
        task_type: "local_bash",
        command: "tail -f run.log",
        message: "stopped",
      }),
    ]);
    expect(result.background[0]).toMatchObject({ task_id: "b1", status: "stopped", ended_at: END });
  });

  test("壊れた JSON と strict shape 不一致を飛ばして後続イベントを再生する", () => {
    // 1 行の破損や content 非配列が全 transcript scan を停止させない。
    const result = apply([
      "{broken-json",
      JSON.stringify({ type: "assistant", timestamp: START, message: { content: "not-array" } }),
      ...todoCreate(),
      ...todoUpdate("tu", "1", { status: "completed" }),
    ]);
    expect(result.todos[0]?.status).toBe("completed");
  });

  test("プリフィルタは大量の対象外行を parse せず、対象イベントだけを fold する", () => {
    // 対象外 10k 行を含む大きな transcript でも機能結果が対象 3 行だけで決まる。
    const dir = fixtureDir();
    try {
      const file = path.join(dir, "large.jsonl");
      const irrelevant = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "plain" }] } })}\n`;
      fs.writeFileSync(
        file,
        irrelevant.repeat(10_000) +
          [...todoCreate(), ...todoUpdate("tu", "1", { status: "completed" })]
            .map((line) => `${line}\n`)
            .join(""),
      );
      const state = createSessionStatusState();
      scanTranscript(file, state);
      expect(snapshot(state).todos[0]?.status).toBe("completed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session_status daemon ops (DR-0020 Phase 1)", () => {
  test(
    "one-shot は hello 済み transcript 全量を返し、未接続 sid は session_not_found",
    async () => {
      // session_status が live subscribe の副作用なしに全量 fold と registry error を返す。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(
          file,
          [...todoCreate(), ...todoUpdate("tu", "1", { status: "completed" })]
            .map((line) => `${line}\n`)
            .join(""),
        );
        await sessionHello(ctx, sid, file);
        const user = await userHello(ctx);
        const ok = await user.request<StatusOk>({ op: "session_status", sid });
        expect(ok.todos[0]?.status).toBe("completed");
        const missing = await user.request<ErrorLite>({ op: "session_status", sid: "missing" });
        expect(missing.error.code).toBe("session_not_found");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "subscribe は初回 snapshot 後に status 変更だけを full snapshot push する",
    async () => {
      // tail 追記の TaskUpdate result で 1 push、通常 assistant text では push 無しを保証する。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(
          file,
          todoCreate()
            .map((line) => `${line}\n`)
            .join(""),
        );
        await sessionHello(ctx, sid, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        const initial = await user.request<StatusOk>({ op: "session_status_subscribe", sid });
        expect(initial.todos[0]?.status).toBe("pending");

        fs.appendFileSync(
          file,
          todoUpdate("tu", "1", { status: "completed" })
            .map((line) => `${line}\n`)
            .join(""),
        );
        const { ev } = await user.readEventUntil<StatusEvent>(
          (event) => event.ev === "session_status",
        );
        expect(ev.todos[0]?.status).toBe("completed");
        expect(ev.workflows).toEqual([]);
        expect(ev.background).toEqual([]);

        fs.appendFileSync(
          file,
          `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "plain" }] } })}\n`,
        );
        const peer = await sessionHello(ctx, "B");
        const room = await peer.request<{ room: string }>({ op: "create_room", members: [] });
        await peer.request({ op: "post", room: room.room, msg: "marker" });
        const { seen } = await user.readEventUntil(
          (event) => event.type === "msg" && event.msg === "marker",
        );
        expect(seen.some((event: any) => event.ev === "session_status")).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "context usage と teammate relay の追記を full snapshot push で逐次配信する",
    async () => {
      // foldLine の変化判定だけでなく、実 Watch→listener→session_status push 経路で新フィールドが届くことを保証する。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(
          file,
          `${assistantUsage({ input: 2, cacheRead: 98, cacheCreation: 0 })}\n`,
        );
        await sessionHello(ctx, sid, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        const initial = await user.request<StatusOk>({ op: "session_status_subscribe", sid });
        expect(initial.context?.tokens).toBe(100);
        expect(initial.teammates).toEqual([]);

        fs.appendFileSync(
          file,
          `${assistantUsage(
            { input: 2, cacheRead: 517_000, cacheCreation: 2_998 },
            { timestamp: END },
          )}\n`,
        );
        const contextPush = await user.readEventUntil<StatusEvent>(
          (event) => event.ev === "session_status" && event.context?.tokens === 520_000,
        );
        expect(contextPush.ev.context).toEqual({
          tokens: 520_000,
          model: "claude-fable-5",
          timestamp: END,
        });

        fs.appendFileSync(
          file,
          `${teammateRelay(
            '<teammate-message teammate_id="worker" color="cyan">ready</teammate-message>',
            "2026-07-17T00:05:00.000Z",
          )}\n`,
        );
        const teammatePush = await user.readEventUntil<StatusEvent>(
          (event) => event.ev === "session_status" && event.teammates?.[0]?.name === "worker",
        );
        expect(teammatePush.ev.context?.tokens).toBe(520_000);
        expect(teammatePush.ev.teammates?.[0]).toMatchObject({
          name: "worker",
          state: "active",
          last_received_at: "2026-07-17T00:05:00.000Z",
        });
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "transcript/status subscribe は同一 Watch で共存し、片方の解除後も他方が生きる",
    async () => {
      // 2 種の subscriber 集合が両方空になるまで fs Watch を teardown しない。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(
          file,
          todoCreate()
            .map((line) => `${line}\n`)
            .join(""),
        );
        await sessionHello(ctx, sid, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        await user.request({ op: "transcript_subscribe", sid });
        await user.request({ op: "session_status_subscribe", sid });

        await user.request({ op: "transcript_unsubscribe", sid });
        fs.appendFileSync(
          file,
          todoUpdate("tu", "1", { status: "completed" })
            .map((line) => `${line}\n`)
            .join(""),
        );
        const status = await user.readEventUntil<StatusEvent>(
          (event) => event.ev === "session_status",
        );
        expect(status.ev.todos[0]?.status).toBe("completed");

        await user.request({ op: "transcript_subscribe", sid });
        await user.request({ op: "session_status_unsubscribe", sid });
        fs.appendFileSync(
          file,
          todoUpdate("tu-after-unsubscribe", "1", { status: "in_progress" })
            .map((line) => `${line}\n`)
            .join(""),
        );
        const transcript = await user.readEventUntil((event) => event.ev === "transcript");
        expect(transcript.ev.lines).toHaveLength(2);
        expect(transcript.seen.some((event: any) => event.ev === "session_status")).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "transcript の全書き換え (縮小 rewrite) 後は再 fold した snapshot を push する",
    async () => {
      // /clear 等で transcript が置換・縮小されたら、折り畳み済み状態は存在しない
      // バイト列由来になる。Watch の reset イベント (lines=[]) を契機に全再 fold し、
      // 古い TODO を引きずらないことを保証する。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(
          file,
          [...todoCreate("1", "Old world"), ...todoUpdate("tu", "1", { status: "completed" })]
            .map((line) => `${line}\n`)
            .join(""),
        );
        await sessionHello(ctx, sid, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        const initial = await user.request<StatusOk>({ op: "session_status_subscribe", sid });
        expect(initial.todos).toEqual([{ id: "1", subject: "Old world", status: "completed" }]);

        // 同一パスへ小さい内容で置換 (truncate 検出経路)。
        fs.writeFileSync(
          file,
          todoCreate("9", "New world")
            .map((line) => `${line}\n`)
            .join(""),
        );
        const { ev } = await user.readEventUntil<StatusEvent>(
          (event) => event.ev === "session_status" && event.todos[0]?.id === "9",
        );
        expect(ev.todos).toEqual([{ id: "9", subject: "New world", status: "pending" }]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "status subscriber の切断後は dead conn を除去し、同じ sid へ再 subscribe できる",
    async () => {
      // connection close cleanup が line listener を解放し、Watch の close/reopen 後も push が復帰する。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(
          file,
          todoCreate()
            .map((line) => `${line}\n`)
            .join(""),
        );
        await sessionHello(ctx, sid, file);
        const first = await userHello(ctx);
        await first.request({ op: "session_status_subscribe", sid });
        first.close();

        const second = await userHello(ctx);
        const initial = await second.request<StatusOk>({ op: "session_status_subscribe", sid });
        expect(initial.todos[0]?.status).toBe("pending");
        fs.appendFileSync(
          file,
          todoUpdate("tu-after-close", "1", { status: "completed" })
            .map((line) => `${line}\n`)
            .join(""),
        );
        const pushed = await second.readEventUntil<StatusEvent>(
          (event) => event.ev === "session_status",
        );
        expect(pushed.ev.todos[0]?.status).toBe("completed");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "session role は session_status 3 op を呼べない",
    async () => {
      // Status は webui viewer 専用で、session identity には bad_request を返す。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, "");
        const session = await sessionHello(ctx, sid, file);
        for (const op of [
          "session_status",
          "session_status_subscribe",
          "session_status_unsubscribe",
        ]) {
          const response = await session.request<ErrorLite>({ op, sid });
          expect(response.error.code).toBe("bad_request");
        }
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});
