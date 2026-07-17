// DR-0025 Phase 1: agent transcript resolver.
//
// A session's transcript_read (DR-0009 / DR-0021) targets its own `<sid>.jsonl`.
// This module adds a strict, opt-in expansion path so the same op can also
// serve the subagent / workflow-agent / teammate transcripts that live next
// to `<sid>.jsonl` in the sibling directory Claude Code writes:
//
//   <projDir>/<sid>.jsonl                                # the session itself
//   <projDir>/<sid>/subagents/agent-<agentId>.jsonl      # direct subagent / teammate
//   <projDir>/<sid>/subagents/agent-<agentId>.meta.json
//   <projDir>/<sid>/subagents/workflows/<runId>/agent-<agentId>.jsonl
//
// Security posture (same shape as virtual-sessions.ts):
//
// - The caller passes only opaque tokens (`agentId`, `runId`, `teammate`).
//   Each is regex-validated to reject every character that could form a
//   traversal (`/`, `\`, `.`, NUL, whitespace, ...) BEFORE any `path.join`.
//   The regexes below therefore make traversal literally unrepresentable in
//   the string that will be joined, not just "unlikely".
// - The session transcript path is not client-supplied: the caller resolves
//   it first via `resolveTranscript(sessions, sid, {allowVirtual})`, so this
//   module only observes a hello-validated (or virtual-resolver-checked)
//   basename of the form `<sid>.jsonl`.
// - We still verify that the sibling directory sits under a detected
//   `<configDir>/projects/` — otherwise a hypothetical caller that fed us a
//   crafted session path could redirect us anywhere on disk.
// - `lstatSync` (not `statSync`) fails a symlink-swap attempt: a malicious
//   symlink under `subagents/` reports `isFile() === false` on the link's
//   own inode and is treated as `not_found`.

import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode, type ErrorCode as ErrorCodeType } from "@ccmsg/protocol";

/** `wf_XXXXXXXX-XXX` — observed 165/165 workflow run directories match this
 * exact shape (2026-07-17, empirical). Uppercase hex is intentionally
 * rejected so a case-varied variant cannot bypass a duplicate-detection
 * check downstream. */
export const RUN_ID_RE = /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/;

/** Observed agent id shapes (2026-07-17): `a[0-9a-f]{16}` (workflow-owned +
 * most direct subagents), `a[0-9a-f]{6}` (short subagents), and named
 * variants `a<name>-<hex>` / `a<name>_<hex>` where `<name>` uses
 * `[A-Za-z0-9_-]`. The regex picks the union: leading `a`, then 5..120 of
 * `[A-Za-z0-9_-]`. Dot/slash/backslash/whitespace/NUL are all outside the
 * class, so path.join with this token cannot escape a directory. */
export const AGENT_ID_RE = /^a[A-Za-z0-9_-]{5,120}$/;

/** teammate names as observed in meta.json (`name` field) and TaskCreate
 * inputs. Matches the same characters as `agent_id`'s tail, since names
 * become part of the resolved basename `agent-a<name>-<hex>.jsonl`. */
export const TEAMMATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type AgentTranscriptResolveResult =
  | { ok: true; file: string }
  | { ok: false; code: ErrorCodeType; msg: string };

export interface AgentTranscriptOptions {
  agentId?: string;
  runId?: string;
  teammate?: string;
}

/**
 * Return true if `sidDir` is (physically) `<something>/projects/<x>/<y>` —
 * i.e. two levels below a `projects` segment. `path.basename(dirname(dirname(x)))`
 * is enough because the caller has already realpath-resolved `sidDir`, so
 * neither symlinks nor `..` components can bend the segment interpretation.
 */
function isInsideProjectsDir(realSidDir: string): boolean {
  const grandparent = path.dirname(path.dirname(realSidDir));
  return path.basename(grandparent) === "projects";
}

/**
 * Resolve one of `{agentId, runId?}` or `{teammate}` to the concrete
 * `agent-<...>.jsonl` file under `<sidDir>/subagents/`. `sidDir` is the
 * transcript path minus its trailing `.jsonl`; the caller obtained it from
 * `resolveTranscript` (hello-validated or virtual-resolver-validated), so
 * its basename is guaranteed to be a real sid.
 */
export function resolveAgentTranscript(
  sessionTranscriptFile: string,
  opts: AgentTranscriptOptions,
): AgentTranscriptResolveResult {
  const { agentId, runId, teammate } = opts;
  if (agentId !== undefined && teammate !== undefined) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read: agent_id and teammate are mutually exclusive",
    };
  }
  if (agentId === undefined && teammate === undefined) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read: agent_id or teammate required",
    };
  }
  if (runId !== undefined && agentId === undefined) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read: run_id requires agent_id",
    };
  }
  if (agentId !== undefined && !AGENT_ID_RE.test(agentId)) {
    return { ok: false, code: ErrorCode.invalid_args, msg: `invalid agent_id: ${agentId}` };
  }
  if (runId !== undefined && !RUN_ID_RE.test(runId)) {
    return { ok: false, code: ErrorCode.invalid_args, msg: `invalid run_id: ${runId}` };
  }
  if (teammate !== undefined && !TEAMMATE_NAME_RE.test(teammate)) {
    return { ok: false, code: ErrorCode.invalid_args, msg: `invalid teammate: ${teammate}` };
  }

  // The caller's transcript path is `<projDir>/<sid>.jsonl`; siblings live
  // in `<projDir>/<sid>/`. Strip the extension lexically first, then
  // realpath-verify containment.
  if (!sessionTranscriptFile.endsWith(".jsonl")) {
    return {
      ok: false,
      code: ErrorCode.not_found,
      msg: "session transcript path missing .jsonl suffix",
    };
  }
  const sidDirLexical = sessionTranscriptFile.slice(0, -".jsonl".length);
  let realSidDir: string;
  try {
    realSidDir = fs.realpathSync(sidDirLexical);
  } catch {
    return {
      ok: false,
      code: ErrorCode.not_found,
      msg: "session has no subagents directory",
    };
  }
  if (!isInsideProjectsDir(realSidDir)) {
    return {
      ok: false,
      code: ErrorCode.path_forbidden,
      msg: "session directory escapes <configDir>/projects/",
    };
  }

  if (teammate !== undefined) {
    return resolveTeammate(realSidDir, teammate);
  }
  // agentId is defined here (mutual exclusion above).
  const agentBasename = `agent-${agentId}.jsonl`;
  const candidate =
    runId !== undefined
      ? path.join(realSidDir, "subagents", "workflows", runId, agentBasename)
      : path.join(realSidDir, "subagents", agentBasename);
  return lstatIsFileOrNotFound(candidate);
}

function lstatIsFileOrNotFound(file: string): AgentTranscriptResolveResult {
  let stat: fs.Stats;
  try {
    // lstatSync so a symlink under subagents/ is rejected (isFile() checks
    // the link's own inode, not its target) — otherwise a swap could point
    // outside projects/.
    stat = fs.lstatSync(file);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `agent transcript not found` };
  }
  if (!stat.isFile()) {
    return { ok: false, code: ErrorCode.not_found, msg: `agent transcript not a file` };
  }
  return { ok: true, file };
}

interface TeammateCandidate {
  file: string;
  mtimeMs: number;
}

function resolveTeammate(realSidDir: string, teammate: string): AgentTranscriptResolveResult {
  const subagentsDir = path.join(realSidDir, "subagents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `no subagents directory` };
  }
  const candidates: TeammateCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".meta.json")) continue;
    const metaPath = path.join(subagentsDir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(metaPath, "utf-8");
    } catch {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const meta = value as Record<string, unknown>;
    if (meta.taskKind !== "in_process_teammate") continue;
    if (meta.name !== teammate) continue;
    const jsonlName = entry.name.slice(0, -".meta.json".length) + ".jsonl";
    const jsonlPath = path.join(subagentsDir, jsonlName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(jsonlPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    candidates.push({ file: jsonlPath, mtimeMs: stat.mtimeMs });
  }
  if (candidates.length === 0) {
    return { ok: false, code: ErrorCode.not_found, msg: `teammate not found: ${teammate}` };
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ok: true, file: candidates[0]!.file };
}
