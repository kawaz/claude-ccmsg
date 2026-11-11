import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode } from "@ccmsg/protocol";
import {
  AGENT_ID_RE,
  listAgentTranscripts,
  resolveAgentTranscript,
  RUN_ID_RE,
} from "../src/agent-transcripts.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmpDir = perTestTmpDir();

/** Build a minimal `<configDir>/projects/<project>/<sid>.jsonl` + sidebar
 * tree in a tempdir. Returns the transcript file the resolver expects. */
function buildFixture(): {
  transcriptFile: string;
  sidDir: string;
  configDir: string;
} {
  const configDir = tmpDir("cfg-");
  const projectDir = path.join(configDir, "projects", "some-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const transcriptFile = path.join(projectDir, `${sid}.jsonl`);
  fs.writeFileSync(transcriptFile, "");
  const sidDir = path.join(projectDir, sid);
  fs.mkdirSync(path.join(sidDir, "subagents"), { recursive: true });
  return { transcriptFile, sidDir, configDir };
}

describe("resolveAgentTranscript (DR-0025)", () => {
  test("regex 定義: RUN_ID_RE / AGENT_ID_RE の期待する形を通し、外れは弾く", async () => {
    expect(RUN_ID_RE.test("wf_abcdef01-234")).toBe(true);
    expect(RUN_ID_RE.test("wf_ABCDEF01-234")).toBe(false);
    expect(RUN_ID_RE.test("../etc/passwd")).toBe(false);

    expect(AGENT_ID_RE.test("a1234567890abcdef")).toBe(true);
    expect(AGENT_ID_RE.test("acwd-option-impl-152981998571c92a")).toBe(true);
    expect(AGENT_ID_RE.test("a")).toBe(false); // too short
    expect(AGENT_ID_RE.test("a/../")).toBe(false);
    expect(AGENT_ID_RE.test("a1234.tsx")).toBe(false);
    expect(AGENT_ID_RE.test("a" + "x".repeat(200))).toBe(false); // too long
  });

  test("workflow agent の transcript を解決する (agent_id + run_id)", async () => {
    const { transcriptFile, sidDir } = buildFixture();
    const runId = "wf_01234567-abc";
    const agentId = "a1111111111111111";
    const runDir = path.join(sidDir, "subagents", "workflows", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const jsonl = path.join(runDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(jsonl, "{}");
    const r = await resolveAgentTranscript(transcriptFile, { agentId, runId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(jsonl));
  });

  test("直下 subagent を解決する (agent_id のみ)", async () => {
    const { transcriptFile, sidDir } = buildFixture();
    const agentId = "a2222222222222222";
    const jsonl = path.join(sidDir, "subagents", `agent-${agentId}.jsonl`);
    fs.writeFileSync(jsonl, "{}");
    const r = await resolveAgentTranscript(transcriptFile, { agentId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(jsonl));
  });

  test("teammate は name → meta.json 走査で解決する", async () => {
    const { transcriptFile, sidDir } = buildFixture();
    const agentId = "amyname-1234567890abcdef";
    const jsonl = path.join(sidDir, "subagents", `agent-${agentId}.jsonl`);
    const meta = path.join(sidDir, "subagents", `agent-${agentId}.meta.json`);
    fs.writeFileSync(jsonl, "{}");
    fs.writeFileSync(
      meta,
      JSON.stringify({ taskKind: "in_process_teammate", name: "myname", agentType: "sonnet5" }),
    );
    const r = await resolveAgentTranscript(transcriptFile, { teammate: "myname" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(jsonl));
  });

  test("teammate: taskKind が違う meta / name 不一致は not_found", async () => {
    const { transcriptFile, sidDir } = buildFixture();
    fs.writeFileSync(
      path.join(sidDir, "subagents", "agent-aother-1234567890abcdef.meta.json"),
      JSON.stringify({ taskKind: "general", name: "myname" }),
    );
    const r = await resolveAgentTranscript(transcriptFile, { teammate: "myname" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.not_found);
  });

  test("敵対 agent_id / run_id は invalid_args", async () => {
    const { transcriptFile } = buildFixture();
    for (const bad of ["../etc/passwd", "a/..", "a", "", "a" + "x".repeat(200), "a1234.tsx"]) {
      const r = await resolveAgentTranscript(transcriptFile, { agentId: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
    }
    for (const bad of ["../", "wf_..", "wf_ABCDEF01-234", ""]) {
      const r = await resolveAgentTranscript(transcriptFile, {
        agentId: "a1234567890abcdef",
        runId: bad,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
    }
  });

  test("agent_id と teammate 同時指定は invalid_args", async () => {
    const { transcriptFile } = buildFixture();
    const r = await resolveAgentTranscript(transcriptFile, {
      agentId: "a1234567890abcdef",
      teammate: "n",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
  });

  test("run_id 単体 (agent_id なし) は invalid_args", async () => {
    const { transcriptFile } = buildFixture();
    const r = await resolveAgentTranscript(transcriptFile, { runId: "wf_01234567-abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
  });

  test("teammate name の regex 違反は invalid_args", async () => {
    const { transcriptFile } = buildFixture();
    for (const bad of ["", "n/../", "a".repeat(100)]) {
      const r = await resolveAgentTranscript(transcriptFile, { teammate: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
    }
  });

  test("symlink 差し替えは lstat で not_found", async () => {
    const { transcriptFile, sidDir } = buildFixture();
    const agentId = "a3333333333333333";
    const jsonl = path.join(sidDir, "subagents", `agent-${agentId}.jsonl`);
    // Symlink pointing outside — resolver uses lstatSync so isFile() → false.
    fs.symlinkSync("/etc/hosts", jsonl);
    const r = await resolveAgentTranscript(transcriptFile, { agentId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.not_found);
  });

  test("projects/ 外の session path は path_forbidden", async () => {
    const outside = tmpDir("outside-");
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const transcriptFile = path.join(outside, `${sid}.jsonl`);
    fs.writeFileSync(transcriptFile, "");
    const sidDir = path.join(outside, sid);
    fs.mkdirSync(path.join(sidDir, "subagents"), { recursive: true });
    const jsonl = path.join(sidDir, "subagents", `agent-a1234567890abcdef.jsonl`);
    fs.writeFileSync(jsonl, "{}");
    const r = await resolveAgentTranscript(transcriptFile, { agentId: "a1234567890abcdef" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.path_forbidden);
  });

  // 何を保証するか (DR-0025 §5): 読むのは、途中のディレクトリの symlink も解決した
  // 実体が <sid> のディレクトリの下にある通常のファイルだけ。ディレクトリが外を
  // 指していれば path_forbidden で、外のファイルを解決しない。
  describe("<sid> の外を指すディレクトリの symlink", () => {
    test("subagents/ 自体が外への symlink なら path_forbidden", async () => {
      const { transcriptFile, sidDir } = buildFixture();
      const outside = tmpDir("outside-");
      const agentId = "a9999999";
      fs.writeFileSync(path.join(outside, `agent-${agentId}.jsonl`), "SECRET\n");
      fs.rmSync(path.join(sidDir, "subagents"), { recursive: true });
      fs.symlinkSync(outside, path.join(sidDir, "subagents"));
      const r = await resolveAgentTranscript(transcriptFile, { agentId });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.path_forbidden);
    });

    test("subagents/workflows/<runId>/ が外への symlink なら path_forbidden", async () => {
      const { transcriptFile, sidDir } = buildFixture();
      const outside = tmpDir("outside-");
      const runId = "wf_01234567-abc";
      const agentId = "a8888888";
      fs.writeFileSync(path.join(outside, `agent-${agentId}.jsonl`), "SECRET\n");
      fs.mkdirSync(path.join(sidDir, "subagents", "workflows"), { recursive: true });
      fs.symlinkSync(outside, path.join(sidDir, "subagents", "workflows", runId));
      const r = await resolveAgentTranscript(transcriptFile, { agentId, runId });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.path_forbidden);
    });

    test("subagents/workflows/ が外への symlink なら path_forbidden", async () => {
      const { transcriptFile, sidDir } = buildFixture();
      const outside = tmpDir("outside-");
      const runId = "wf_01234567-abc";
      const agentId = "a8888888";
      fs.mkdirSync(path.join(outside, runId));
      fs.writeFileSync(path.join(outside, runId, `agent-${agentId}.jsonl`), "SECRET\n");
      fs.symlinkSync(outside, path.join(sidDir, "subagents", "workflows"));
      const r = await resolveAgentTranscript(transcriptFile, { agentId, runId });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.path_forbidden);
    });

    test("teammate の走査は外を指す subagents/ の meta.json を読まない", async () => {
      const { transcriptFile, sidDir } = buildFixture();
      const outside = tmpDir("outside-");
      const agentId = "amyname-1234567890abcdef";
      fs.writeFileSync(path.join(outside, `agent-${agentId}.jsonl`), "SECRET\n");
      fs.writeFileSync(
        path.join(outside, `agent-${agentId}.meta.json`),
        JSON.stringify({ taskKind: "in_process_teammate", name: "myname" }),
      );
      fs.rmSync(path.join(sidDir, "subagents"), { recursive: true });
      fs.symlinkSync(outside, path.join(sidDir, "subagents"));
      const r = await resolveAgentTranscript(transcriptFile, { teammate: "myname" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.path_forbidden);
    });

    test("teammate の走査は外を指す meta.json / transcript の symlink を辿らない", async () => {
      const { transcriptFile, sidDir } = buildFixture();
      const outside = tmpDir("outside-");
      const sub = path.join(sidDir, "subagents");
      // meta.json が外への symlink: 名前が合っても候補にしない。
      const linkedMeta = path.join(outside, "meta.json");
      fs.writeFileSync(
        linkedMeta,
        JSON.stringify({ taskKind: "in_process_teammate", name: "myname" }),
      );
      fs.symlinkSync(linkedMeta, path.join(sub, "agent-amyname-1111111111.meta.json"));
      fs.writeFileSync(path.join(sub, "agent-amyname-1111111111.jsonl"), "{}");
      // meta.json は本物でも、隣の transcript が外への symlink なら候補にしない。
      fs.writeFileSync(
        path.join(sub, "agent-amyname-2222222222.meta.json"),
        JSON.stringify({ taskKind: "in_process_teammate", name: "myname" }),
      );
      const linkedJsonl = path.join(outside, "x.jsonl");
      fs.writeFileSync(linkedJsonl, "SECRET\n");
      fs.symlinkSync(linkedJsonl, path.join(sub, "agent-amyname-2222222222.jsonl"));
      const r = await resolveAgentTranscript(transcriptFile, { teammate: "myname" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.not_found);
    });

    test("<sid> の中を指すディレクトリの symlink は、解決した先の通常のファイルを読む", async () => {
      const { transcriptFile, sidDir } = buildFixture();
      const agentId = "a7777777";
      const real = path.join(sidDir, "real-subagents");
      fs.mkdirSync(real);
      const jsonl = path.join(real, `agent-${agentId}.jsonl`);
      fs.writeFileSync(jsonl, "{}");
      fs.rmSync(path.join(sidDir, "subagents"), { recursive: true });
      fs.symlinkSync(real, path.join(sidDir, "subagents"));
      const r = await resolveAgentTranscript(transcriptFile, { agentId });
      expect(r.ok).toBe(true);
      if (r.ok) expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(jsonl));
    });
  });

  test("agent_id / teammate が両方無いのは invalid_args", async () => {
    const { transcriptFile } = buildFixture();
    const r = await resolveAgentTranscript(transcriptFile, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
  });
});

describe("listAgentTranscripts (DR-0050 §5)", () => {
  // 何を保証するか: notification_list が読む agent の transcript は、subagents/ 直下と
  // workflows/<runId>/ の agent-<id>.jsonl の全部 (名前順)。id は file 名から取る。
  // meta.json 等の他の file、id / run id の形に合わない名前、symlink は入れない
  // (directory の外を読ませない)。subagents/ が無ければ空。
  test("lists every agent's transcript, by name, and nothing else", async () => {
    const { transcriptFile, sidDir } = buildFixture();
    const sub = path.join(sidDir, "subagents");
    const run = path.join(sub, "workflows", "wf_01234567-abc");
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(path.join(sub, "workflows", "not-a-run"), { recursive: true });
    for (const file of [
      path.join(sub, "agent-a2222222.jsonl"),
      path.join(sub, "agent-a1111111.jsonl"),
      path.join(sub, "agent-a1111111.meta.json"),
      path.join(sub, "agent-a.jsonl"),
      path.join(run, "agent-a3333333.jsonl"),
      path.join(sub, "workflows", "not-a-run", "agent-a4444444.jsonl"),
    ]) {
      fs.writeFileSync(file, "");
    }
    const outside = path.join(tmpDir("outside-"), "x.jsonl");
    fs.writeFileSync(outside, "");
    fs.symlinkSync(outside, path.join(sub, "agent-a5555555.jsonl"));

    const listed = await listAgentTranscripts(transcriptFile);
    expect(listed.map((a) => [a.agentId, path.relative(fs.realpathSync(sub), a.file)])).toEqual([
      ["a1111111", "agent-a1111111.jsonl"],
      ["a2222222", "agent-a2222222.jsonl"],
      ["a3333333", path.join("workflows", "wf_01234567-abc", "agent-a3333333.jsonl")],
    ]);
  });

  test("subagents/ や subagents/workflows/ が外への symlink なら、その先を並べない", async () => {
    const { transcriptFile, sidDir } = buildFixture();
    const outside = tmpDir("outside-");
    fs.writeFileSync(path.join(outside, "agent-a1111111.jsonl"), "SECRET\n");
    fs.mkdirSync(path.join(outside, "wf_01234567-abc"));
    fs.writeFileSync(path.join(outside, "wf_01234567-abc", "agent-a2222222.jsonl"), "SECRET\n");
    const sub = path.join(sidDir, "subagents");
    fs.writeFileSync(path.join(sub, "agent-a3333333.jsonl"), "");
    fs.symlinkSync(outside, path.join(sub, "workflows"));
    expect((await listAgentTranscripts(transcriptFile)).map((a) => a.agentId)).toEqual([
      "a3333333",
    ]);

    fs.rmSync(sub, { recursive: true });
    fs.symlinkSync(outside, sub);
    expect(await listAgentTranscripts(transcriptFile)).toEqual([]);
  });

  test("a session with no subagents directory has none", async () => {
    const configDir = tmpDir("cfg-");
    const projectDir = path.join(configDir, "projects", "p");
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptFile = path.join(projectDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    fs.writeFileSync(transcriptFile, "");
    expect(await listAgentTranscripts(transcriptFile)).toEqual([]);
  });
});
