// DR-0025 §4 / §5: agent transcript resolver.
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
//   it first via `resolveTranscript(sessions, sid, {virtualConfigDirs})`, so this
//   module only observes a hello-validated (or virtual-resolver-checked)
//   basename of the form `<sid>.jsonl`.
// - We still check that the session's sibling directory, realpath'd, sits two
//   levels below a directory named `projects` (`isInsideProjectsDir`) — the
//   shape `<configDir>/projects/<project>/<sid>` — so a hypothetical caller
//   that fed us a crafted session path cannot redirect us anywhere on disk.
//   Which config dir it is under is not checked here: the transcript path was
//   validated when it was resolved.
// - What is read lies inside that real sibling directory (DR-0025 §5). Every
//   directory on the way (`subagents/`, `subagents/workflows/`,
//   `workflows/<runId>/`, `workflows/`) is resolved through any symlink and
//   must stay inside it (`sessionSubdir`, fs-access.ts's realpath
//   containment); the file read in it must be a regular file by `lstat`, so a
//   symlink in its place is not followed and counts as absent.
//
// Design rationale: a file that is a symlink is refused even when it points
// back inside the session directory, while a directory symlink that does is
// followed. Directories are few per read and realpath'd once; files are many
// (one per agent on every status push) and usually come from a directory
// listing whose entry type already says "regular file" without another
// syscall. Refusing file symlinks outright keeps that cheap and is the
// stricter side of the same rule.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentMetaTextSchema,
  ErrorCode,
  parseWith,
  type ErrorCode as ErrorCodeType,
} from "@ccmsg/protocol";
import { resolveContained, type ContainedErr, type ContainedOk } from "./fs-access.ts";

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

/** `sidDir` realpath'd: the root every agent artifact must stay inside.
 * Undefined when it does not resolve (the session has no such directory). */
export async function realSessionDir(sidDir: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(sidDir);
  } catch {
    return undefined;
  }
}

/** The real directory `segments` names under `realSidDir` (a realSessionDir
 * value), when it resolves inside it — symlinked directories on the way
 * included. `path_forbidden` when it resolves outside (or cannot be
 * resolved), `not_found` when it does not exist (fs-access.ts
 * resolveContained). */
export async function sessionSubdir(
  realSidDir: string,
  ...segments: string[]
): Promise<ContainedOk | ContainedErr> {
  return resolveContained(realSidDir, path.join(...segments));
}

/** sessionSubdir's directory, or undefined for any refusal: for readers that
 * treat "outside" the same as "absent". */
export async function sessionSubdirOrUndefined(
  realSidDir: string,
  ...segments: string[]
): Promise<string | undefined> {
  const dir = await sessionSubdir(realSidDir, ...segments);
  return dir.ok ? dir.realPath : undefined;
}

/** `name` in `dir` (a sessionSubdir directory), when it is a regular file by
 * `lstat`: a symlink in its place is not followed. */
export async function regularFileIn(dir: string, name: string): Promise<string | undefined> {
  const file = path.join(dir, name);
  try {
    return (await fs.promises.lstat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve one of `{agentId, runId?}` or `{teammate}` to the concrete
 * `agent-<...>.jsonl` file under `<sidDir>/subagents/`. `sidDir` is the
 * transcript path minus its trailing `.jsonl`; the caller obtained it from
 * `resolveTranscript` (hello-validated or virtual-resolver-validated), so
 * its basename is guaranteed to be a real sid.
 */
export async function resolveAgentTranscript(
  sessionTranscriptFile: string,
  opts: AgentTranscriptOptions,
): Promise<AgentTranscriptResolveResult> {
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
  const realSidDir = await realSessionDir(sessionTranscriptFile.slice(0, -".jsonl".length));
  if (realSidDir === undefined) {
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
      msg: "session directory is not under a projects/ directory",
    };
  }

  const dir = await sessionSubdir(
    realSidDir,
    ...(runId !== undefined ? ["subagents", "workflows", runId] : ["subagents"]),
  );
  if (!dir.ok) return agentDirRefusal(dir);
  if (teammate !== undefined) {
    return await resolveTeammate(dir.realPath, teammate);
  }
  // agentId is defined here (mutual exclusion above).
  return await lstatIsFileOrNotFound(path.join(dir.realPath, `agent-${agentId}.jsonl`));
}

/** A refused agent directory, worded for transcript_read: outside the
 * session directory stays `path_forbidden`, a missing one `not_found`. */
function agentDirRefusal(dir: ContainedErr): AgentTranscriptResolveResult {
  return dir.code === ErrorCode.not_found
    ? { ok: false, code: ErrorCode.not_found, msg: "agent transcript not found" }
    : {
        ok: false,
        code: ErrorCode.path_forbidden,
        msg: "agent transcript directory escapes the session directory",
      };
}

/** One agent transcript of a session: the agent's id, as its file names it
 * and as its pushed rows carry it (`agent_id`). */
export interface AgentTranscriptFile {
  agentId: string;
  file: string;
}

/** The transcript of each of the session's subagents, teammates and
 * workflow agents: `<sidDir>/subagents/agent-<agentId>.jsonl` and
 * `<sidDir>/subagents/workflows/<runId>/agent-<agentId>.jsonl`, by name.
 * `sessionTranscriptFile` is a resolved session transcript, as for
 * resolveAgentTranscript. Only regular files count (a symlink is not one, so
 * nothing outside the directory is read), and only names that the id and run
 * patterns accept. None when the session has no such directory. */
export async function listAgentTranscripts(
  sessionTranscriptFile: string,
): Promise<AgentTranscriptFile[]> {
  if (!sessionTranscriptFile.endsWith(".jsonl")) return [];
  const realSidDir = await realSessionDir(sessionTranscriptFile.slice(0, -".jsonl".length));
  if (realSidDir === undefined || !isInsideProjectsDir(realSidDir)) return [];
  const subagentsDir = await sessionSubdirOrUndefined(realSidDir, "subagents");
  if (subagentsDir === undefined) return [];
  const out = await agentTranscriptsIn(subagentsDir);
  const workflowsDir = await sessionSubdirOrUndefined(realSidDir, "subagents", "workflows");
  if (workflowsDir === undefined) return out;
  for (const run of await sortedEntries(workflowsDir)) {
    if (!run.isDirectory() || !RUN_ID_RE.test(run.name)) continue;
    out.push(...(await agentTranscriptsIn(path.join(workflowsDir, run.name))));
  }
  return out;
}

async function sortedEntries(dir: string): Promise<fs.Dirent[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function agentTranscriptsIn(dir: string): Promise<AgentTranscriptFile[]> {
  const out: AgentTranscriptFile[] = [];
  for (const entry of await sortedEntries(dir)) {
    if (!entry.isFile() || !entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const agentId = entry.name.slice("agent-".length, -".jsonl".length);
    if (!AGENT_ID_RE.test(agentId)) continue;
    out.push({ agentId, file: path.join(dir, entry.name) });
  }
  return out;
}

async function lstatIsFileOrNotFound(file: string): Promise<AgentTranscriptResolveResult> {
  let stat: fs.Stats;
  try {
    // lstat so a symlink under subagents/ is rejected (isFile() checks
    // the link's own inode, not its target) — otherwise a swap could point
    // outside projects/.
    stat = await fs.promises.lstat(file);
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

/** `subagentsDir` is the session's real `subagents/` (sessionSubdir): only
 * its regular files are read, so neither a symlinked meta.json nor a
 * symlinked transcript beside it is followed. */
async function resolveTeammate(
  subagentsDir: string,
  teammate: string,
): Promise<AgentTranscriptResolveResult> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(subagentsDir, { withFileTypes: true });
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
      raw = await fs.promises.readFile(metaPath, "utf-8");
    } catch {
      continue;
    }
    const read = parseWith(AgentMetaTextSchema, raw);
    if (!read.ok) continue;
    const meta = read.value;
    if (meta.taskKind !== "in_process_teammate") continue;
    if (meta.name !== teammate) continue;
    const jsonlName = entry.name.slice(0, -".meta.json".length) + ".jsonl";
    const jsonlPath = path.join(subagentsDir, jsonlName);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(jsonlPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    candidates.push({ file: jsonlPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const [newest] = candidates;
  if (newest === undefined) {
    return { ok: false, code: ErrorCode.not_found, msg: `teammate not found: ${teammate}` };
  }
  return { ok: true, file: newest.file };
}
