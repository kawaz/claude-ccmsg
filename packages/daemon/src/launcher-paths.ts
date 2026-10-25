// Realpath containment for the session launcher's cwd tree (DR-0018 §3.4):
// dir_tree accepts absolute host paths, but only beneath the configured
// root_dirs. A launch's cwd is not held to the roots (§3.8): whether a cwd may
// be launched in is the launch command's call.
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode } from "@ccmsg/protocol";
import type { FsAccessResult } from "./fs-access.ts";

function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

export function containedInRoots(
  configuredRoots: readonly string[],
  candidate: string,
  field: string,
): FsAccessResult<{ realPath: string }> {
  if (candidate === "" || !path.isAbsolute(candidate)) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: `${field} must be a non-empty absolute path`,
    };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(candidate);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return { ok: false, code: ErrorCode.not_found, msg: `not found: ${candidate}` };
    }
    return {
      ok: false,
      code: ErrorCode.path_forbidden,
      msg: `cannot resolve ${field}: ${candidate}`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `not found: ${candidate}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: ErrorCode.invalid_args, msg: `${field} is not a directory` };
  }

  for (const configuredRoot of configuredRoots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(configuredRoot);
    } catch {
      // A stale configured root grants no access. Another valid configured root
      // may still contain the candidate, so continue rather than fail open/closed
      // for the whole list here.
      continue;
    }
    if (contains(realRoot, realPath)) return { ok: true, data: { realPath } };
  }

  return {
    ok: false,
    code: ErrorCode.path_forbidden,
    msg: `${field} is outside configured session launcher roots: ${candidate}`,
  };
}
