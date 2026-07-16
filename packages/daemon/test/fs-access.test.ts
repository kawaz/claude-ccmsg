// fs_list / fs_read (DR-0008): containment-checked workspace file browsing.
// Each test spawns a real daemon over UDS and a separate real filesystem
// fixture directory (distinct from the daemon's own state dir) that plays
// the role of a connected session's project root.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FS_READ_MAX_BYTES } from "@ccmsg/protocol";
import { validateRepoRoot } from "../src/fs-access.ts";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

/** A session connection whose hello advertises `cwd` as the fs-access root. */
async function sessionAt(ctx: DaemonCtx, sid: string, cwd: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: "r", ws: "w", cwd });
  return c;
}

/** A session connection whose hello advertises both `cwd` and `repo_root`
 *  (DR-0008 addendum) — raw request, bypassing TestClient.hello's narrower
 *  typed signature (same pattern as transcript.test.ts's sessionHello). */
async function sessionAtWithRoot(
  ctx: DaemonCtx,
  sid: string,
  cwd: string,
  repoRoot: string,
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd,
    repo_root: repoRoot,
  });
  return c;
}

function mkfixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-fsroot-"));
}

describe("fs_list / fs_read", () => {
  test(
    "hello_required: fs_list without hello is rejected before touching any session",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await connect(ctx.sock);
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "whatever",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("hello_required");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "session_not_found: an sid with no live connection can't be browsed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionAt(ctx, "A", mkfixture());
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "no-such-sid",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("session_not_found");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "root listing: file/dir entries, sizes, dir-first name-ascending order",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        // Deliberately created out of the expected final order so the sort
        // in fs-access.ts (not fixture creation order) is what's asserted.
        fs.writeFileSync(path.join(root, "b.txt"), "bb");
        fs.writeFileSync(path.join(root, "a.txt"), "a");
        fs.mkdirSync(path.join(root, "z_dir"));
        fs.mkdirSync(path.join(root, "m_dir"));

        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{
          ok: true;
          path: string;
          entries: { name: string; type: string; size?: number }[];
        }>({ op: "fs_list", sid: "A" });

        expect(res.ok).toBe(true);
        expect(res.path).toBe(""); // root itself
        // dirs (m_dir, z_dir) before files (a.txt, b.txt); each group name-ascending
        expect(res.entries.map((e) => [e.name, e.type])).toEqual([
          ["m_dir", "dir"],
          ["z_dir", "dir"],
          ["a.txt", "file"],
          ["b.txt", "file"],
        ]);
        // size is reported for files only
        const aTxt = res.entries.find((e) => e.name === "a.txt")!;
        expect(aTxt.size).toBe(1);
        const mDir = res.entries.find((e) => e.name === "m_dir")!;
        expect(mDir.size).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "subdirectory listing and file read round-trip content exactly",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        fs.mkdirSync(path.join(root, "sub"));
        fs.writeFileSync(path.join(root, "sub", "hello.txt"), "hello world");

        const c = await sessionAt(ctx, "A", root);
        const listed = await c.request<{ ok: true; path: string; entries: { name: string }[] }>({
          op: "fs_list",
          sid: "A",
          path: "sub",
        });
        expect(listed.path).toBe("sub");
        expect(listed.entries.map((e) => e.name)).toEqual(["hello.txt"]);

        const read = await c.request<{
          ok: true;
          path: string;
          size: number;
          truncated: boolean;
          binary: boolean;
          content: string;
        }>({ op: "fs_read", sid: "A", path: "sub/hello.txt" });
        expect(read.path).toBe(path.join("sub", "hello.txt"));
        expect(read.content).toBe("hello world");
        expect(read.size).toBe(11);
        expect(read.truncated).toBe(false);
        expect(read.binary).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "empty directory lists as an empty entries array",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        fs.mkdirSync(path.join(root, "empty"));
        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{ ok: true; entries: unknown[] }>({
          op: "fs_list",
          sid: "A",
          path: "empty",
        });
        expect(res.entries).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    '"" (absent), "." and explicit "" all address the root identically',
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        fs.writeFileSync(path.join(root, "only.txt"), "x");
        const c = await sessionAt(ctx, "A", root);

        const noPath = await c.request<{ ok: true; path: string; entries: { name: string }[] }>({
          op: "fs_list",
          sid: "A",
        });
        const dotPath = await c.request<{ ok: true; path: string; entries: { name: string }[] }>({
          op: "fs_list",
          sid: "A",
          path: ".",
        });
        const emptyPath = await c.request<{ ok: true; path: string; entries: { name: string }[] }>({
          op: "fs_list",
          sid: "A",
          path: "",
        });

        for (const res of [noPath, dotPath, emptyPath]) {
          expect(res.path).toBe("");
          expect(res.entries.map((e) => e.name)).toEqual(["only.txt"]);
        }
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "security: absolute path is path_forbidden even when it happens to point inside root",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        fs.writeFileSync(path.join(root, "only.txt"), "x");
        const c = await sessionAt(ctx, "A", root);
        // The wire contract says path is always relative to the session root;
        // an absolute path — even one that literally *is* inside root — is a
        // contract violation, not something clients have a legitimate way to
        // construct (they never learn the root's absolute filesystem path).
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: root, // absolute, coincidentally == root
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    'security: ".." traversal out of root is path_forbidden (fs_list and fs_read)',
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        const c = await sessionAt(ctx, "A", root);
        const list = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: "../etc",
        });
        expect(list.ok).toBe(false);
        expect(list.error.code).toBe("path_forbidden");

        const read = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_read",
          sid: "A",
          path: "../etc/passwd",
        });
        expect(read.ok).toBe(false);
        expect(read.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "security: a symlink whose target is outside root is path_forbidden to read/list, even though the link itself is a root-relative name",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const outside = mkfixture();
      try {
        fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
        fs.mkdirSync(path.join(outside, "secret_dir"));
        fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link_out_file"));
        fs.symlinkSync(path.join(outside, "secret_dir"), path.join(root, "link_out_dir"));

        const c = await sessionAt(ctx, "A", root);
        const read = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_read",
          sid: "A",
          path: "link_out_file",
        });
        expect(read.ok).toBe(false);
        expect(read.error.code).toBe("path_forbidden");

        const list = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: "link_out_dir",
        });
        expect(list.ok).toBe(false);
        expect(list.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "security: a symlink that stays inside root is followed normally, and reported as type:symlink in listings",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        fs.mkdirSync(path.join(root, "real_dir"));
        fs.writeFileSync(path.join(root, "real_dir", "hello.txt"), "hi");
        fs.symlinkSync(path.join(root, "real_dir"), path.join(root, "link_in"));

        const c = await sessionAt(ctx, "A", root);

        // listing root: link_in must show up with type "symlink" (never
        // promoted to "dir" just because its target is a directory)
        const rootList = await c.request<{ ok: true; entries: { name: string; type: string }[] }>({
          op: "fs_list",
          sid: "A",
        });
        const linkEntry = rootList.entries.find((e) => e.name === "link_in")!;
        expect(linkEntry.type).toBe("symlink");

        // but traversing *through* it works: fs_list("link_in") and
        // fs_read("link_in/hello.txt") both succeed against the real target
        const listed = await c.request<{ ok: true; entries: { name: string }[] }>({
          op: "fs_list",
          sid: "A",
          path: "link_in",
        });
        expect(listed.entries.map((e) => e.name)).toEqual(["hello.txt"]);

        const read = await c.request<{ ok: true; content: string }>({
          op: "fs_read",
          sid: "A",
          path: "link_in/hello.txt",
        });
        expect(read.content).toBe("hi");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "not_found: a missing path under an existing (in-root) directory is not_found, not path_forbidden",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_read",
          sid: "A",
          path: "does/not/exist.txt",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("not_found");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "invalid_args: fs_list on a file path, fs_read on a directory path",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        fs.writeFileSync(path.join(root, "a_file.txt"), "x");
        fs.mkdirSync(path.join(root, "a_dir"));
        const c = await sessionAt(ctx, "A", root);

        const listFile = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: "a_file.txt",
        });
        expect(listFile.ok).toBe(false);
        expect(listFile.error.code).toBe("invalid_args");

        const readDir = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_read",
          sid: "A",
          path: "a_dir",
        });
        expect(readDir.ok).toBe(false);
        expect(readDir.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "binary detection: a NUL byte in the first 8 KiB suppresses content",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        // NUL at the very start guarantees it's within the 8 KiB sniff window
        // regardless of surrounding content.
        const buf = Buffer.concat([Buffer.from([0]), Buffer.from("rest of file")]);
        fs.writeFileSync(path.join(root, "bin.dat"), buf);

        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{ ok: true; binary: boolean; content: string; size: number }>({
          op: "fs_read",
          sid: "A",
          path: "bin.dat",
        });
        expect(res.binary).toBe(true);
        expect(res.content).toBe(""); // DR-0008: content omitted for binaries
        expect(res.size).toBe(buf.length);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "truncation: a file larger than FS_READ_MAX_BYTES comes back truncated with only the head",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        // FS_READ_MAX_BYTES is 512 KiB; write distinguishable head/tail bytes
        // ('h' vs 't') so we can assert exactly FS_READ_MAX_BYTES worth of
        // head content came back and nothing from the tail leaked in.
        const extra = 1024;
        const full = Buffer.alloc(FS_READ_MAX_BYTES + extra);
        full.fill("h".charCodeAt(0), 0, FS_READ_MAX_BYTES);
        full.fill("t".charCodeAt(0), FS_READ_MAX_BYTES);
        fs.writeFileSync(path.join(root, "big.txt"), full);

        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{
          ok: true;
          size: number;
          truncated: boolean;
          binary: boolean;
          content: string;
        }>({ op: "fs_read", sid: "A", path: "big.txt" });

        expect(res.size).toBe(FS_READ_MAX_BYTES + extra); // true on-disk size, not the capped read
        expect(res.truncated).toBe(true);
        expect(res.binary).toBe(false);
        expect(res.content.length).toBe(FS_READ_MAX_BYTES);
        expect(res.content).toBe("h".repeat(FS_READ_MAX_BYTES));
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    // Regression: resolveContained used to build the containment prefix as
    // `root + path.sep`, which for root === "/" produced "//" — no real
    // child path starts with "//", so every fs_list under a cwd of "/" was
    // misclassified as path_forbidden. We don't assert on the real /tmp's
    // entries (it's live filesystem state), only that containment itself
    // doesn't reject a direct child of "/".
    "root='/': a direct child of the filesystem root is not misclassified as path_forbidden",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionAt(ctx, "A", "/");
        const res = await c.request<{ ok: boolean; error?: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: "tmp",
        });
        if (!res.ok) {
          expect(res.error?.code).not.toBe("path_forbidden");
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "invalid_args: fs_list with a non-string path is rejected (symmetry with fs_read's own guard)",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: 123 as unknown as string,
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "security: a missing leaf under a root-escaping symlink directory is path_forbidden, not not_found (existence not leaked)",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const outside = mkfixture();
      try {
        fs.mkdirSync(path.join(outside, "secret_dir"));
        fs.symlinkSync(path.join(outside, "secret_dir"), path.join(root, "lnk_out_dir"));

        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_read",
          sid: "A",
          path: "lnk_out_dir/missing",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "invalid_args: fs_read with an empty path string",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        const c = await sessionAt(ctx, "A", root);
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_read",
          sid: "A",
          path: "",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );
});

describe("fs_write (DR-0019 Phase W1)", () => {
  // fs_write is a webui-only mutation surface: a session identity must be
  // rejected before it can create anything in its own or another session's root.
  test(
    "role gate: session role cannot call fs_write",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        const session = await sessionAt(ctx, "A", root);
        const res = await session.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/denied.md",
          content: "must not be written",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("bad_request");
        expect(fs.existsSync(path.join(root, "docs", "inbox", "denied.md"))).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // Absolute paths are outside the relative-path wire contract even when the
  // caller knows a real host path; rejecting them preserves the session-root boundary.
  test(
    "containment: an absolute path outside the session root is path_forbidden",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const outside = mkfixture();
      try {
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const outsidePath = path.join(outside, "escaped.md");
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: outsidePath,
          content: "must stay contained",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
        expect(fs.existsSync(outsidePath)).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    T,
  );

  // A lexical docs/inbox prefix must not hide traversal that normalizes beyond
  // the session root; containment is checked on the normalized candidate first.
  test(
    'containment: ".." traversal out of the session root is path_forbidden',
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/../../../escaped.md",
          content: "must stay contained",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // A root-relative docs/inbox name is not sufficient when an existing symlink
  // redirects that directory outside the root; realpath containment must win.
  test(
    "containment: a docs/inbox symlink escaping the root is path_forbidden",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const outside = mkfixture();
      try {
        fs.mkdirSync(path.join(root, "docs"));
        fs.symlinkSync(outside, path.join(root, "docs", "inbox"));
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/escaped.md",
          content: "must stay contained",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
        expect(fs.existsSync(path.join(outside, "escaped.md"))).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    T,
  );

  // Containment alone is not enough for the write policy: docs/inbox may be a
  // symlink to another directory INSIDE the root (e.g. -> src/). That passes
  // realpath containment, so the inbox prefix must be judged on the resolved
  // realpath — a lexical "docs/inbox/…" request must not smuggle a new file
  // into src/. Regression test for the in-root redirect found in review.
  test(
    "write policy: docs/inbox symlinked to another in-root dir is path_not_writable",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        fs.mkdirSync(path.join(root, "src"));
        fs.mkdirSync(path.join(root, "docs"));
        fs.symlinkSync(path.join(root, "src"), path.join(root, "docs", "inbox"));
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/evil.md",
          content: "must not land in src/",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_not_writable");
        expect(fs.existsSync(path.join(root, "src", "evil.md"))).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // The wire contract requires a non-empty relative path; an empty string has
  // no leaf to create and is rejected as malformed input, not as a policy miss.
  test(
    "invalid_args: fs_write with an empty path string",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "",
          content: "no destination",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // The allowed prefix is "docs/inbox/" WITH the separator: a sibling name that
  // merely starts with the same characters (docs/inboxx/) is a different
  // directory and must be refused — classic startsWith-without-separator trap.
  test(
    "write policy: sibling directory docs/inboxx is path_not_writable",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inboxx/memo.md",
          content: "prefix trap",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_not_writable");
        expect(fs.existsSync(path.join(root, "docs", "inboxx"))).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // "docs/inbox" itself (no leaf under it) is the directory, not a memo: the
  // grant is strictly for descendants, so the bare directory path is refused.
  test(
    "write policy: docs/inbox itself (no filename under it) is path_not_writable",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox",
          content: "not a memo",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_not_writable");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // Phase W1 grants exactly docs/inbox descendants, so another in-root path is
  // refused with the write-policy error rather than the containment error.
  test(
    "write policy: a path outside docs/inbox is path_not_writable",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      try {
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/note.md",
          content: "wrong directory",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_not_writable");
        expect(fs.existsSync(path.join(root, "docs", "note.md"))).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // Inbox writes are create-only: an existing path must be rejected and its
  // original bytes must remain unchanged rather than being truncated or replaced.
  test(
    "create-only: an existing file is file_exists and remains unchanged",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const target = path.join(root, "docs", "inbox", "existing.md");
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "original");
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: false; error: { code: string } }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/existing.md",
          content: "replacement",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("file_exists");
        expect(fs.readFileSync(target, "utf-8")).toBe("original");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // In a repo-container session, the request path is relative to the session's
  // own cwd, while the response path stays relative to the browsable root so
  // FileTree/FileViewer can immediately address the created file. This is the
  // jj-workspace invariant: the memo must land in the working copy where
  // `jj status` can see it, never in the container directory beside every
  // workspace.
  test(
    "repo_root session: writes under cwd and returns the root-relative created path",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const cwd = path.join(root, "main");
      const target = path.join(cwd, "docs", "inbox", "memo.md");
      const oldContainerTarget = path.join(root, "docs", "inbox", "memo.md");
      try {
        fs.mkdirSync(cwd);
        await sessionAtWithRoot(ctx, "A", cwd, root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: true; sid: string; path: string }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/memo.md",
          content: "working-copy memo",
        });
        expect(res).toEqual({
          ok: true,
          sid: "A",
          path: path.join("main", "docs", "inbox", "memo.md"),
        });
        expect(fs.readFileSync(target, "utf-8")).toBe("working-copy memo");
        expect(fs.existsSync(oldContainerTarget)).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // An inbox-less working copy is a supported starting state: fs_write creates
  // docs/inbox recursively below cwd before creating the requested new memo.
  test(
    "parent creation: missing docs/inbox is created recursively",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const target = path.join(root, "docs", "inbox", "created.md");
      try {
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: true; sid: string; path: string }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/created.md",
          content: "created with parents",
        });
        expect(res).toEqual({ ok: true, sid: "A", path: path.join("docs", "inbox", "created.md") });
        expect(fs.readFileSync(target, "utf-8")).toBe("created with parents");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // With docs/inbox already present, a normal request writes the exact UTF-8
  // content and returns the normalized root-relative path of the created file.
  test(
    "normal write: creates a new UTF-8 memo and returns sid/path",
    async () => {
      const ctx = await startTestDaemon();
      const root = mkfixture();
      const inbox = path.join(root, "docs", "inbox");
      const target = path.join(inbox, "memo.md");
      try {
        fs.mkdirSync(inbox, { recursive: true });
        await sessionAt(ctx, "A", root);
        const user = await connect(ctx.sock);
        await user.hello({ role: "user" });
        const res = await user.request<{ ok: true; sid: string; path: string }>({
          op: "fs_write",
          sid: "A",
          path: "docs/inbox/memo.md",
          content: "日本語のメモ\n",
        });
        expect(res).toEqual({ ok: true, sid: "A", path: path.join("docs", "inbox", "memo.md") });
        expect(fs.readFileSync(target, "utf-8")).toBe("日本語のメモ\n");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );
});

// repo_root containment (DR-0008 addendum): a session's self-declared
// repo_root, once hello-time-validated (fs-access.ts's validateRepoRoot),
// widens fs_list/fs_read's containment root from "just this session's cwd" to
// "the whole repo container" — sibling workspaces/worktrees become browsable.
// An unvalidated/rejected repo_root is a silent no-op: root stays cwd exactly
// as if repo_root had never been announced (fail-open).
describe("repo_root containment (DR-0008 addendum)", () => {
  test(
    "採用時: sibling workspace のファイルが fs_list/fs_read で読める",
    async () => {
      const ctx = await startTestDaemon();
      const container = mkfixture(); // plays the role of repo_root
      const main = path.join(container, "main");
      const feature = path.join(container, "feature");
      fs.mkdirSync(main);
      fs.mkdirSync(feature);
      fs.writeFileSync(path.join(feature, "note.txt"), "hello from feature");
      try {
        // session's own cwd is "main"; repo_root announces the container
        // that also holds the sibling "feature" workspace.
        const c = await sessionAtWithRoot(ctx, "A", main, container);

        // root listing now shows the *container's* children (main, feature),
        // not main's own (empty) children — proof the root actually widened.
        const rootList = await c.request<{
          ok: true;
          path: string;
          entries: { name: string; type: string }[];
        }>({ op: "fs_list", sid: "A" });
        expect(rootList.path).toBe("");
        expect(rootList.entries.map((e) => e.name).sort()).toEqual(["feature", "main"]);

        // sibling workspace is listable...
        const listed = await c.request<{ ok: true; entries: { name: string }[] }>({
          op: "fs_list",
          sid: "A",
          path: "feature",
        });
        expect(listed.entries.map((e) => e.name)).toEqual(["note.txt"]);

        // ...and its file is readable, despite living outside cwd entirely.
        const read = await c.request<{ ok: true; content: string }>({
          op: "fs_read",
          sid: "A",
          path: "feature/note.txt",
        });
        expect(read.content).toBe("hello from feature");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(container, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "検証輪郭: 相対パスの repo_root は不採用 (peers に現れない)",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = mkfixture();
      try {
        const c = await sessionAtWithRoot(ctx, "A", cwd, "relative/not-allowed");
        const peers = await c.request<{ ok: true; peers: { sid: string; repo_root?: string }[] }>({
          op: "peers",
        });
        expect(peers.peers.find((p) => p.sid === "A")!.repo_root).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "検証輪郭: cwd の ancestor でない (無関係な兄弟パス) repo_root は不採用",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = mkfixture();
      const unrelated = mkfixture(); // a sibling tmpdir, NOT an ancestor of cwd
      try {
        const c = await sessionAtWithRoot(ctx, "A", cwd, unrelated);
        const peers = await c.request<{ ok: true; peers: { sid: string; repo_root?: string }[] }>({
          op: "peers",
        });
        expect(peers.peers.find((p) => p.sid === "A")!.repo_root).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(unrelated, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "検証輪郭: cwd 自身を repo_root に指定しても不採用 (strict ancestor 違反)",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = mkfixture();
      try {
        const c = await sessionAtWithRoot(ctx, "A", cwd, cwd);
        const peers = await c.request<{ ok: true; peers: { sid: string; repo_root?: string }[] }>({
          op: "peers",
        });
        expect(peers.peers.find((p) => p.sid === "A")!.repo_root).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    '検証輪郭: repo_root="/" は不採用 (cwd がその strict ancestor であっても)',
    async () => {
      const ctx = await startTestDaemon();
      const cwd = mkfixture(); // any tmpdir is trivially a strict descendant of "/"
      try {
        const c = await sessionAtWithRoot(ctx, "A", cwd, "/");
        const peers = await c.request<{ ok: true; peers: { sid: string; repo_root?: string }[] }>({
          op: "peers",
        });
        expect(peers.peers.find((p) => p.sid === "A")!.repo_root).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "検証輪郭: repo_root=$HOME は不採用 (cwd が $HOME 配下であっても)",
    async () => {
      const ctx = await startTestDaemon();
      const home = os.homedir();
      // cwd must genuinely be a descendant of $HOME for this to isolate the
      // $HOME-exclusion branch (condition 5) from the ancestor check
      // (condition 4) — a tmpdir under os.tmpdir() usually isn't under $HOME.
      const cwd = fs.mkdtempSync(path.join(home, ".ccmsg-fsroot-home-test-"));
      try {
        const c = await sessionAtWithRoot(ctx, "A", cwd, home);
        const peers = await c.request<{ ok: true; peers: { sid: string; repo_root?: string }[] }>({
          op: "peers",
        });
        expect(peers.peers.find((p) => p.sid === "A")!.repo_root).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "検証輪郭: repo_root が $HOME の ancestor (例: /Users) でも不採用 (完全一致だけでなく祖先も塞ぐ)",
    async () => {
      const ctx = await startTestDaemon();
      const home = os.homedir();
      const homeAncestor = path.dirname(home);
      // homeAncestor が "/" になる環境 (home 自体が "/" 直下、例: CI の
      // "/root") では realRoot==="/" の既存チェックが先に効いてしまい、
      // 本テストが検証したい「home の ancestor-or-self」分岐を通らない
      // ("/" チェックとの重複になるだけで、期待する不採用の結論自体は
      // どのみち成立するため test 自体は skip せず進める)。
      const cwd = fs.mkdtempSync(path.join(home, ".ccmsg-fsroot-homeanc-test-"));
      try {
        const c = await sessionAtWithRoot(ctx, "A", cwd, homeAncestor);
        const peers = await c.request<{ ok: true; peers: { sid: string; repo_root?: string }[] }>({
          op: "peers",
        });
        expect(peers.peers.find((p) => p.sid === "A")!.repo_root).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "回帰確認: $HOME 配下の通常 container (= $HOME 自身でもその ancestor でもない) は採用される",
    async () => {
      const ctx = await startTestDaemon();
      const home = os.homedir();
      // $HOME 配下に container/{main,feature} を作る — 修正2 の ancestor-or-self
      // 拒否は「home 自身 / home の祖先」だけを狙うもので、home の子孫である
      // 通常の repo container まで巻き込んで拒否してはいけないことの確認。
      const container = fs.mkdtempSync(path.join(home, ".ccmsg-fsroot-homeok-test-"));
      const main = path.join(container, "main");
      const feature = path.join(container, "feature");
      fs.mkdirSync(main);
      fs.mkdirSync(feature);
      fs.writeFileSync(path.join(feature, "note.txt"), "hello from feature");
      try {
        const c = await sessionAtWithRoot(ctx, "A", main, container);
        const rootList = await c.request<{
          ok: true;
          path: string;
          entries: { name: string; type: string }[];
        }>({ op: "fs_list", sid: "A" });
        expect(rootList.path).toBe("");
        expect(rootList.entries.map((e) => e.name).sort()).toEqual(["feature", "main"]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(container, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "不採用時は従来どおり cwd root のままで traversal が塞がっている",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = mkfixture();
      const unrelated = mkfixture();
      try {
        // repo_root announced but rejected (unrelated, not an ancestor of cwd) —
        // fs_list/fs_read must still resolve strictly against cwd, exactly as
        // if repo_root had never been sent at all.
        const c = await sessionAtWithRoot(ctx, "A", cwd, unrelated);
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: "../etc",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(unrelated, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "採用時でも repo_root の外への traversal は塞がっている",
    async () => {
      const ctx = await startTestDaemon();
      const container = mkfixture();
      const main = path.join(container, "main");
      fs.mkdirSync(main);
      try {
        const c = await sessionAtWithRoot(ctx, "A", main, container);
        // ".." from cwd ("main") lands exactly on the accepted root
        // (container) itself, which is a legitimate, in-root address — but
        // going one level further ("../..") must still escape and be
        // forbidden, proving containment tracks the *widened* root, not "no
        // containment at all".
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_list",
          sid: "A",
          path: "../../etc",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(container, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "採用時でも repo_root 内からの symlink 脱出は塞がっている",
    async () => {
      const ctx = await startTestDaemon();
      const container = mkfixture();
      const main = path.join(container, "main");
      const outside = mkfixture();
      fs.mkdirSync(main);
      fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(main, "link_out"));
      try {
        const c = await sessionAtWithRoot(ctx, "A", main, container);
        const res = await c.request<{ ok: false; error: { code: string } }>({
          op: "fs_read",
          sid: "A",
          path: "main/link_out",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(container, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    T,
  );
});

// validateRepoRoot デシジョンテーブルの欠け行 (hello 経由の統合テストでは
// 組みにくい/冗長になるケースを純関数への直接呼び出しで埋める)。
describe("validateRepoRoot decision table", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-validateroot-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // (a) repo_root candidate 自体が実在しないパス: fs.realpathSync が ENOENT で
  // 例外を投げ、catch で undefined に丸める (存在確認できない container を
  // 「container として widen する」のは無意味なので不採用)。
  test("repo_root candidate が実在しないパスなら不採用", () => {
    const cwd = path.join(dir, "main");
    fs.mkdirSync(cwd);
    const got = validateRepoRoot(cwd, path.join(dir, "does-not-exist"));
    expect(got).toBeUndefined();
  });

  // (b) cwd が実在しないパス: repo_root 自体は実在していても、widen 元となる
  // cwd を realpath できなければ「そもそも widen する意味がある anchor か」を
  // 確認できないので不採用 (fail-open: hello 自体は成功し、呼び出し元
  // resolveRoot は cwd をそのまま使う従来経路にフォールバックする — 検証する
  // のは validateRepoRoot 単体の戻り値であって resolveRoot の縮退動作ではない)。
  test("cwd が実在しないパスなら不採用", () => {
    const got = validateRepoRoot(path.join(dir, "no-such-cwd"), dir);
    expect(got).toBeUndefined();
  });

  // cwd が空文字の場合も同様に不採用 (typeof/空文字ガードで即座に弾かれる、
  // realpath すら呼ばれない経路)。
  test("cwd が空文字なら不採用", () => {
    const got = validateRepoRoot("", dir);
    expect(got).toBeUndefined();
  });

  // (c) repo_root candidate 自体が symlink: realpath で解決された実体パスが
  // 採用され、cwd (の実体) がその配下にあれば通る。symlink 越しに指定しても
  // containment root は実体パスに正規化される。
  test("repo_root candidate が symlink でも realpath 正規化されて採用される", () => {
    const container = path.join(dir, "container");
    const cwd = path.join(container, "main");
    fs.mkdirSync(cwd, { recursive: true });
    const link = path.join(dir, "container-link");
    fs.symlinkSync(container, link);

    const got = validateRepoRoot(cwd, link);
    expect(got).toBe(fs.realpathSync(container));
  });

  // (d) cwd から見て 2 階層以上離れた深い ancestor でも、strict ancestor
  // でありさえすれば仕様として採用される (kawaz 環境の repos ディレクトリ
  // 構成のような、cwd の直接の親より上位の container を container として
  // 指定するケースを想定した運用 knob。DR-0008 は「$HOME / "/" 自体を除く
  // strict ancestor なら widen 先として許容する」設計であり、階層数そのもの
  // には上限を設けていない — 意図的な許容であって見落としではない)。
  test("cwd の直接の親より深い ancestor でも strict ancestor なら採用される", () => {
    const shallow = path.join(dir, "repos"); // ~/.local/share/repos 相当
    const cwd = path.join(shallow, "github.com", "kawaz", "claude-ccmsg", "main");
    fs.mkdirSync(cwd, { recursive: true });

    const got = validateRepoRoot(cwd, shallow);
    expect(got).toBe(fs.realpathSync(shallow));
  });
});
