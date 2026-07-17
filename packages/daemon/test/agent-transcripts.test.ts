import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ErrorCode } from "@ccmsg/protocol";
import { AGENT_ID_RE, resolveAgentTranscript, RUN_ID_RE } from "../src/agent-transcripts.ts";

/** Build a minimal `<configDir>/projects/<project>/<sid>.jsonl` + sidebar
 * tree in a tempdir. Returns the transcript file the resolver expects. */
function buildFixture(): {
  transcriptFile: string;
  sidDir: string;
  configDir: string;
} {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
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
  test("regex 定義: RUN_ID_RE / AGENT_ID_RE の期待する形を通し、外れは弾く", () => {
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

  test("workflow agent の transcript を解決する (agent_id + run_id)", () => {
    const { transcriptFile, sidDir } = buildFixture();
    const runId = "wf_01234567-abc";
    const agentId = "a1111111111111111";
    const runDir = path.join(sidDir, "subagents", "workflows", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const jsonl = path.join(runDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(jsonl, "{}");
    const r = resolveAgentTranscript(transcriptFile, { agentId, runId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(jsonl));
  });

  test("直下 subagent を解決する (agent_id のみ)", () => {
    const { transcriptFile, sidDir } = buildFixture();
    const agentId = "a2222222222222222";
    const jsonl = path.join(sidDir, "subagents", `agent-${agentId}.jsonl`);
    fs.writeFileSync(jsonl, "{}");
    const r = resolveAgentTranscript(transcriptFile, { agentId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(jsonl));
  });

  test("teammate は name → meta.json 走査で解決する", () => {
    const { transcriptFile, sidDir } = buildFixture();
    const agentId = "amyname-1234567890abcdef";
    const jsonl = path.join(sidDir, "subagents", `agent-${agentId}.jsonl`);
    const meta = path.join(sidDir, "subagents", `agent-${agentId}.meta.json`);
    fs.writeFileSync(jsonl, "{}");
    fs.writeFileSync(
      meta,
      JSON.stringify({ taskKind: "in_process_teammate", name: "myname", agentType: "sonnet5" }),
    );
    const r = resolveAgentTranscript(transcriptFile, { teammate: "myname" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(jsonl));
  });

  test("teammate: taskKind が違う meta / name 不一致は not_found", () => {
    const { transcriptFile, sidDir } = buildFixture();
    fs.writeFileSync(
      path.join(sidDir, "subagents", "agent-aother-1234567890abcdef.meta.json"),
      JSON.stringify({ taskKind: "general", name: "myname" }),
    );
    const r = resolveAgentTranscript(transcriptFile, { teammate: "myname" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.not_found);
  });

  test("敵対 agent_id / run_id は invalid_args", () => {
    const { transcriptFile } = buildFixture();
    for (const bad of ["../etc/passwd", "a/..", "a", "", "a" + "x".repeat(200), "a1234.tsx"]) {
      const r = resolveAgentTranscript(transcriptFile, { agentId: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
    }
    for (const bad of ["../", "wf_..", "wf_ABCDEF01-234", ""]) {
      const r = resolveAgentTranscript(transcriptFile, {
        agentId: "a1234567890abcdef",
        runId: bad,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
    }
  });

  test("agent_id と teammate 同時指定は invalid_args", () => {
    const { transcriptFile } = buildFixture();
    const r = resolveAgentTranscript(transcriptFile, {
      agentId: "a1234567890abcdef",
      teammate: "n",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
  });

  test("run_id 単体 (agent_id なし) は invalid_args", () => {
    const { transcriptFile } = buildFixture();
    const r = resolveAgentTranscript(transcriptFile, { runId: "wf_01234567-abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
  });

  test("teammate name の regex 違反は invalid_args", () => {
    const { transcriptFile } = buildFixture();
    for (const bad of ["", "n/../", "a".repeat(100)]) {
      const r = resolveAgentTranscript(transcriptFile, { teammate: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
    }
  });

  test("symlink 差し替えは lstat で not_found", () => {
    const { transcriptFile, sidDir } = buildFixture();
    const agentId = "a3333333333333333";
    const jsonl = path.join(sidDir, "subagents", `agent-${agentId}.jsonl`);
    // Symlink pointing outside — resolver uses lstatSync so isFile() → false.
    fs.symlinkSync("/etc/hosts", jsonl);
    const r = resolveAgentTranscript(transcriptFile, { agentId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.not_found);
  });

  test("projects/ 外の session path は path_forbidden", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const transcriptFile = path.join(outside, `${sid}.jsonl`);
    fs.writeFileSync(transcriptFile, "");
    const sidDir = path.join(outside, sid);
    fs.mkdirSync(path.join(sidDir, "subagents"), { recursive: true });
    const jsonl = path.join(sidDir, "subagents", `agent-a1234567890abcdef.jsonl`);
    fs.writeFileSync(jsonl, "{}");
    const r = resolveAgentTranscript(transcriptFile, { agentId: "a1234567890abcdef" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.path_forbidden);
  });

  test("agent_id / teammate が両方無いのは invalid_args", () => {
    const { transcriptFile } = buildFixture();
    const r = resolveAgentTranscript(transcriptFile, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.invalid_args);
  });
});
