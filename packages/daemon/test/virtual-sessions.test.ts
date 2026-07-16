import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fsList, fsRead, fsWrite } from "../src/fs-access.ts";
import { transcriptRead } from "../src/transcript.ts";
import {
  deriveRepoLocation,
  isValidSid,
  resolveVirtualRoot,
  resolveVirtualTranscript,
} from "../src/virtual-sessions.ts";
import { connect, startTestDaemon, stopTestDaemon } from "./helpers.ts";

const T = 15000;
const roots: string[] = [];
const emptySessions = new Map();

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-virtual-session-"));
  roots.push(root);
  return root;
}

function sid(n = 1): string {
  return `11111111-2222-4333-8444-${n.toString(16).padStart(12, "0")}`;
}

function transcript(config: string, id: string, cwd: string, rows: unknown[] = []): string {
  const dir = path.join(config, "projects", "-fixture");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const all = [
    {
      type: "user",
      message: { role: "user", content: "hello" },
      cwd,
      timestamp: "2026-07-16T00:00:00.000Z",
    },
    ...rows,
  ];
  fs.writeFileSync(file, all.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("virtual session lookup boundary", () => {
  // Guarantees the only client-controlled path segment is a complete UUID. Every
  // traversal-like or suffix-extended value is rejected before filesystem lookup.
  test("malicious and malformed sid values fail strict UUID validation", () => {
    for (const value of ["../../../etc/passwd", "a/../b", "", `${sid()}junk`]) {
      expect(isValidSid(value)).toBe(false);
      expect(resolveVirtualTranscript(value, [fixtureRoot()])).toBeUndefined();
    }
  });

  // Guarantees lookup is physically scoped to projects/<project>/<sid>.jsonl;
  // the same basename directly under config_dir is never considered.
  test("lookup ignores a transcript outside projects child directories", () => {
    const config = fixtureRoot();
    fs.writeFileSync(path.join(config, `${sid()}.jsonl`), "{}\n");
    expect(resolveVirtualTranscript(sid(), [config])).toBeUndefined();
  });

  // Guarantees known-layout cwd derives the repository container while an
  // arbitrary layout keeps the cwd itself as the narrow containment root.
  test("cwd restoration derives known repo root and preserves unknown layout", () => {
    const config = fixtureRoot();
    const known = path.join(fixtureRoot(), "repos", "github.com", "owner", "repo", "main");
    fs.mkdirSync(known, { recursive: true });
    transcript(config, sid(1), known);

    const resolvedKnown = resolveVirtualRoot(sid(1), [config]);
    expect(resolvedKnown).toEqual({
      ok: true,
      root: fs.realpathSync(path.join(known, "..")),
      cwd: known,
    });

    const config2 = fixtureRoot();
    const unknown = path.join(fixtureRoot(), "arbitrary", "working-copy");
    fs.mkdirSync(unknown, { recursive: true });
    transcript(config2, sid(2), unknown);
    const resolvedUnknown = resolveVirtualRoot(sid(2), [config2]);
    expect(resolvedUnknown).toEqual({ ok: true, root: fs.realpathSync(unknown), cwd: unknown });
    expect(deriveRepoLocation(unknown).repo).toBeNull();
  });

  // Guarantees a hostile or degenerate transcript cwd cannot mint a wide
  // containment root: a cwd of "/" (filesystem root) or $HOME (ancestor of
  // every project) is refused outright instead of granting fs browsing there.
  test("filesystem root and home cwd are rejected as containment roots", () => {
    for (const cwd of [path.parse(os.homedir()).root, os.homedir()]) {
      const config = fixtureRoot();
      transcript(config, sid(), cwd);
      const result = resolveVirtualRoot(sid(), [config]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("path_forbidden");
    }
  });

  // Guarantees a stale historical cwd produces an explicit not_found carrying
  // that cwd instead of silently widening or substituting another directory.
  test("missing cwd returns an explicit not_found error", () => {
    const config = fixtureRoot();
    const missing = path.join(fixtureRoot(), "already-gone");
    transcript(config, sid(), missing);

    const result = resolveVirtualRoot(sid(), [config]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.msg).toContain(missing);
    }
  });

  // Guarantees virtual fs_list/fs_read retain realpath containment while
  // fs_write stays connected-only: a valid sid may read in-root files but
  // cannot write historically or use `..` to escape its root.
  test("virtual filesystem reads remain containment checked", () => {
    const config = fixtureRoot();
    const cwd = path.join(fixtureRoot(), "project");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "inside.txt"), "inside");
    fs.writeFileSync(path.join(path.dirname(cwd), "outside.txt"), "outside");
    transcript(config, sid(), cwd);

    const listed = fsList(emptySessions, sid(), undefined, {
      allowVirtual: true,
      configDirs: [config],
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.entries.map((entry) => entry.name)).toEqual(["inside.txt"]);

    const inside = fsRead(emptySessions, sid(), "inside.txt", {
      allowVirtual: true,
      configDirs: [config],
    });
    expect(inside.ok).toBe(true);
    if (inside.ok) expect(inside.data.content).toBe("inside");

    const write = fsWrite(emptySessions, sid(), "docs/inbox/new.md", "no");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.code).toBe("session_not_found");

    const escape = fsRead(emptySessions, sid(), "../outside.txt", {
      allowVirtual: true,
      configDirs: [config],
    });
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.code).toBe("path_forbidden");

    const malicious = fsRead(emptySessions, "../../../etc/passwd", "x", {
      allowVirtual: true,
      configDirs: [config],
    });
    expect(malicious.ok).toBe(false);
    if (!malicious.ok) expect(malicious.code).toBe("session_not_found");
  });

  // Guarantees SS-Q1=a without changing the legacy default: an unregistered sid
  // is readable only when the caller explicitly enables virtual resolution.
  test("unconnected transcript_read uses opt-in virtual fallback", () => {
    const config = fixtureRoot();
    const cwd = path.join(fixtureRoot(), "project");
    fs.mkdirSync(cwd);
    transcript(config, sid(), cwd, [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "world" }] },
      },
    ]);

    const legacy = transcriptRead(emptySessions, sid(), undefined, undefined);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.code).toBe("session_not_found");

    const virtual = transcriptRead(emptySessions, sid(), undefined, undefined, {
      allowVirtual: true,
      configDirs: [config],
    });
    expect(virtual.ok).toBe(true);
    if (virtual.ok) expect(virtual.data.lines).toHaveLength(2);
  });
});

describe("session_search wire authorization", () => {
  // Guarantees historical search is a human webui surface: a session identity
  // is rejected before any config-directory scan is attempted.
  test(
    "session role cannot call session_search",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "session", sid: "A", cwd: "/tmp" });
        const response = await client.request<{ ok: false; error: { code: string } }>({
          op: "session_search",
        });
        expect(response.ok).toBe(false);
        expect(response.error.code).toBe("bad_request");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
