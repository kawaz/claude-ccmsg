// fs_list / fs_read (DR-0008): containment-checked workspace file browsing.
// Each test starts a daemon in this process, talks to it over UDS, and makes a
// separate real filesystem fixture directory (distinct from the daemon's own state dir) that plays
// the role of a connected session's project root.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FS_READ_MAX_BYTES, type JsonObject } from "@ccmsg/protocol";
import { validateRepoRoot } from "../src/fs-access.ts";
import {
  assistantContentRow,
  attachmentRow,
  line,
  toolUseBlock,
} from "../../protocol/test/transcript-rows.ts";
import {
  connect,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  defined,
  sessionConn,
  userConn,
  fixtureDir,
} from "./helpers.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";

/** Connected session with a hello-validated transcript. The transcript is a
 * real `<sid>.jsonl` below cwd so fs_read_external can rebuild its DR-0024
 * allowlist without any test-only store mutation. */
async function sessionAtWithTranscript(
  ctx: InProcessDaemon,
  sid: string,
  cwd: string,
  transcriptLines: string[],
): Promise<{ session: TestClient; transcript: string }> {
  const transcript = path.join(cwd, `${sid}.jsonl`);
  fs.writeFileSync(transcript, transcriptLines.map((line) => `${line}\n`).join(""));
  const session = await sessionConn(ctx, sid, { cwd, transcript_path: transcript });
  return { session, transcript };
}

function externalAttachmentRow(filePath: string): string {
  return line(
    attachmentRow(
      { type: "edited_text_file", filename: filePath, snippet: "1\tedited" },
      { timestamp: "2026-07-17T00:00:00.000Z" },
    ),
  );
}

/** A Read of `filePath`, or a Write of it. */
function externalToolUse(id: string, name: "Read" | "Write", filePath: string): string {
  const input: JsonObject =
    name === "Write" ? { file_path: filePath, content: "x" } : { file_path: filePath };
  return line(
    assistantContentRow([toolUseBlock(name, input, id)], {
      timestamp: "2026-07-17T00:00:00.000Z",
    }),
  );
}

describe("fs_list / fs_read", () => {
  test("hello_required: fs_list without hello is rejected before touching any session", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await connect(ctx.sock);
      const res = await c.requestError({
        op: "fs_list",
        sid: "whatever",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("hello_required");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("session_not_found: an sid with no live connection can't be browsed", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A, { cwd: fixtureDir("fsroot") });
      const res = await c.requestError({
        op: "fs_list",
        sid: "no-such-sid",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("session_not_found");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("root listing: file/dir entries, sizes, dir-first name-ascending order", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      // Deliberately created out of the expected final order so the sort
      // in fs-access.ts (not fixture creation order) is what's asserted.
      fs.writeFileSync(path.join(root, "b.txt"), "bb");
      fs.writeFileSync(path.join(root, "a.txt"), "a");
      fs.mkdirSync(path.join(root, "z_dir"));
      fs.mkdirSync(path.join(root, "m_dir"));

      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestOk({ op: "fs_list", sid: A });

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
      const aTxt = defined(
        res.entries.find((e) => e.name === "a.txt"),
        "aTxt",
      );
      expect(aTxt.size).toBe(1);
      const mDir = defined(
        res.entries.find((e) => e.name === "m_dir"),
        "mDir",
      );
      expect(mDir.size).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("subdirectory listing and file read round-trip content exactly", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.mkdirSync(path.join(root, "sub"));
      fs.writeFileSync(path.join(root, "sub", "hello.txt"), "hello world");

      const c = await sessionConn(ctx, A, { cwd: root });
      const listed = await c.requestOk({
        op: "fs_list",
        sid: A,
        path: "sub",
      });
      expect(listed.path).toBe("sub");
      expect(listed.entries.map((e) => e.name)).toEqual(["hello.txt"]);

      const read = await c.requestOk({ op: "fs_read", sid: A, path: "sub/hello.txt" });
      expect(read.path).toBe(path.join("sub", "hello.txt"));
      expect(read.content).toBe("hello world");
      expect(read.size).toBe(11);
      expect(read.truncated).toBe(false);
      expect(read.binary).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty directory lists as an empty entries array", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.mkdirSync(path.join(root, "empty"));
      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestOk({
        op: "fs_list",
        sid: A,
        path: "empty",
      });
      expect(res.entries).toEqual([]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('"" (absent), "." and explicit "" all address the root identically', async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.writeFileSync(path.join(root, "only.txt"), "x");
      const c = await sessionConn(ctx, A, { cwd: root });

      const noPath = await c.requestOk({
        op: "fs_list",
        sid: A,
      });
      const dotPath = await c.requestOk({
        op: "fs_list",
        sid: A,
        path: ".",
      });
      const emptyPath = await c.requestOk({
        op: "fs_list",
        sid: A,
        path: "",
      });

      for (const res of [noPath, dotPath, emptyPath]) {
        expect(res.path).toBe("");
        expect(res.entries.map((e) => e.name)).toEqual(["only.txt"]);
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("security: absolute path is path_forbidden even when it happens to point inside root", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.writeFileSync(path.join(root, "only.txt"), "x");
      const c = await sessionConn(ctx, A, { cwd: root });
      // The wire contract says path is always relative to the session root;
      // an absolute path — even one that literally *is* inside root — is a
      // contract violation, not something clients have a legitimate way to
      // construct (they never learn the root's absolute filesystem path).
      const res = await c.requestError({
        op: "fs_list",
        sid: A,
        path: root, // absolute, coincidentally == root
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('security: ".." traversal out of root is path_forbidden (fs_list and fs_read)', async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const c = await sessionConn(ctx, A, { cwd: root });
      const list = await c.requestError({
        op: "fs_list",
        sid: A,
        path: "../etc",
      });
      expect(list.ok).toBe(false);
      expect(list.error.code).toBe("path_forbidden");

      const read = await c.requestError({
        op: "fs_read",
        sid: A,
        path: "../etc/passwd",
      });
      expect(read.ok).toBe(false);
      expect(read.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("security: a symlink whose target is outside root is path_forbidden to read/list, even though the link itself is a root-relative name", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
      fs.mkdirSync(path.join(outside, "secret_dir"));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link_out_file"));
      fs.symlinkSync(path.join(outside, "secret_dir"), path.join(root, "link_out_dir"));

      const c = await sessionConn(ctx, A, { cwd: root });
      const read = await c.requestError({
        op: "fs_read",
        sid: A,
        path: "link_out_file",
      });
      expect(read.ok).toBe(false);
      expect(read.error.code).toBe("path_forbidden");

      const list = await c.requestError({
        op: "fs_list",
        sid: A,
        path: "link_out_dir",
      });
      expect(list.ok).toBe(false);
      expect(list.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("security: a symlink that stays inside root is followed normally, and reported as type:symlink in listings", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.mkdirSync(path.join(root, "real_dir"));
      fs.writeFileSync(path.join(root, "real_dir", "hello.txt"), "hi");
      fs.symlinkSync(path.join(root, "real_dir"), path.join(root, "link_in"));

      const c = await sessionConn(ctx, A, { cwd: root });

      // listing root: link_in must show up with type "symlink" (never
      // promoted to "dir" just because its target is a directory)
      const rootList = await c.requestOk({
        op: "fs_list",
        sid: A,
      });
      const linkEntry = defined(
        rootList.entries.find((e) => e.name === "link_in"),
        "linkEntry",
      );
      expect(linkEntry.type).toBe("symlink");

      // but traversing *through* it works: fs_list("link_in") and
      // fs_read("link_in/hello.txt") both succeed against the real target
      const listed = await c.requestOk({
        op: "fs_list",
        sid: A,
        path: "link_in",
      });
      expect(listed.entries.map((e) => e.name)).toEqual(["hello.txt"]);

      const read = await c.requestOk({
        op: "fs_read",
        sid: A,
        path: "link_in/hello.txt",
      });
      expect(read.content).toBe("hi");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("not_found: a missing path under an existing (in-root) directory is not_found, not path_forbidden", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestError({
        op: "fs_read",
        sid: A,
        path: "does/not/exist.txt",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_found");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid_args: fs_list on a file path, fs_read on a directory path", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.writeFileSync(path.join(root, "a_file.txt"), "x");
      fs.mkdirSync(path.join(root, "a_dir"));
      const c = await sessionConn(ctx, A, { cwd: root });

      const listFile = await c.requestError({
        op: "fs_list",
        sid: A,
        path: "a_file.txt",
      });
      expect(listFile.ok).toBe(false);
      expect(listFile.error.code).toBe("invalid_args");

      const readDir = await c.requestError({
        op: "fs_read",
        sid: A,
        path: "a_dir",
      });
      expect(readDir.ok).toBe(false);
      expect(readDir.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("binary detection: a NUL byte in the first 8 KiB suppresses content", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      // NUL at the very start guarantees it's within the 8 KiB sniff window
      // regardless of surrounding content.
      const buf = Buffer.concat([Buffer.from([0]), Buffer.from("rest of file")]);
      fs.writeFileSync(path.join(root, "bin.dat"), buf);

      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestOk({
        op: "fs_read",
        sid: A,
        path: "bin.dat",
      });
      expect(res.binary).toBe(true);
      expect(res.content).toBe(""); // DR-0008: content omitted for binaries
      expect(res.size).toBe(buf.length);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncation: a file larger than FS_READ_MAX_BYTES comes back truncated with only the head", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      // FS_READ_MAX_BYTES is 512 KiB; write distinguishable head/tail bytes
      // ('h' vs 't') so we can assert exactly FS_READ_MAX_BYTES worth of
      // head content came back and nothing from the tail leaked in.
      const extra = 1024;
      const full = Buffer.alloc(FS_READ_MAX_BYTES + extra);
      full.fill("h".charCodeAt(0), 0, FS_READ_MAX_BYTES);
      full.fill("t".charCodeAt(0), FS_READ_MAX_BYTES);
      fs.writeFileSync(path.join(root, "big.txt"), full);

      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestOk({ op: "fs_read", sid: A, path: "big.txt" });

      expect(res.size).toBe(FS_READ_MAX_BYTES + extra); // true on-disk size, not the capped read
      expect(res.truncated).toBe(true);
      expect(res.binary).toBe(false);
      expect(res.content.length).toBe(FS_READ_MAX_BYTES);
      expect(res.content).toBe("h".repeat(FS_READ_MAX_BYTES));
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(// Regression: resolveContained used to build the containment prefix as
  // `root + path.sep`, which for root === "/" produced "//" — no real
  // child path starts with "//", so every fs_list under a cwd of "/" was
  // misclassified as path_forbidden. We don't assert on the real /tmp's
  // entries (it's live filesystem state), only that containment itself
  // doesn't reject a direct child of "/".
  "root='/': a direct child of the filesystem root is not misclassified as path_forbidden", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A, { cwd: "/" });
      const res = await c.request({
        op: "fs_list",
        sid: A,
        path: "tmp",
      });
      if (!res.ok) {
        expect(res.error?.code).not.toBe("path_forbidden");
      }
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("invalid_args: fs_list with a non-string path is refused under its request_id", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestRefusal({ op: "fs_list", sid: A, path: 123 });
      expect(res).toEqual({
        ok: false,
        error: {
          code: "invalid_args",
          msg: "path: Invalid type: Expected string but received 123",
        },
      });
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("security: a missing leaf under a root-escaping symlink directory is path_forbidden, not not_found (existence not leaked)", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      fs.mkdirSync(path.join(outside, "secret_dir"));
      fs.symlinkSync(path.join(outside, "secret_dir"), path.join(root, "lnk_out_dir"));

      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestError({
        op: "fs_read",
        sid: A,
        path: "lnk_out_dir/missing",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("invalid_args: fs_read with an empty path string", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const c = await sessionConn(ctx, A, { cwd: root });
      const res = await c.requestError({
        op: "fs_read",
        sid: A,
        path: "",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fs_read_external (DR-0024)", () => {
  test("an attachment-named file is readable through the same allowlist", async () => {
    // the timeline previews file attachments, and the path it
    // links must open in Files. Authorization does not branch on origin — an
    // attachment entry is the same exact-path grant a Read entry is.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const target = path.join(outside, "attached.txt");
      fs.writeFileSync(target, "attached content");
      const canonicalTarget = fs.realpathSync(target);
      await sessionAtWithTranscript(ctx, A, root, [externalAttachmentRow(target)]);
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_read_external",
        sid: A,
        path: canonicalTarget,
      });
      expect(res.path).toBe(canonicalTarget);
      expect(res.content).toBe("attached content");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("allowlist exact entry is readable and returns the requested absolute path", async () => {
    // A transcript-observed existing file is canonicalized into external_files;
    // the new op reuses fs_read's content contract without widening its root.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const target = path.join(outside, "allowed.txt");
      fs.writeFileSync(target, "allowed content");
      const canonicalTarget = fs.realpathSync(target);
      await sessionAtWithTranscript(ctx, A, root, [externalToolUse("r1", "Read", target)]);
      const user = await userConn(ctx);
      const res = await user.requestOk({ op: "fs_read_external", sid: A, path: canonicalTarget });
      expect(res.path).toBe(canonicalTarget);
      expect(res.content).toBe("allowed content");
      expect(res.truncated).toBe(false);
      expect(res.binary).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("either spelling of one allowlisted file is readable across a symlinked ancestor", async () => {
    // The webui links a path exactly as the transcript spelled it, and on
    // macOS a tool call under os.tmpdir() spells /var/... while the file's
    // realpath spells /private/var/... . Both directions must land on the
    // single allowlist entry, or the viewer 403s on the very file it just
    // rendered from the same transcript row.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const realDir = path.join(fs.realpathSync(outside), "real");
      const linkDir = path.join(fs.realpathSync(outside), "link");
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, linkDir);
      fs.writeFileSync(path.join(realDir, "shot.png"), "bytes");
      const viaReal = path.join(realDir, "shot.png");
      const viaLink = path.join(linkDir, "shot.png");

      // Folded from the symlinked spelling — the one a tool call records.
      await sessionAtWithTranscript(ctx, A, root, [externalToolUse("r1", "Read", viaLink)]);
      const user = await userConn(ctx);
      for (const candidate of [viaLink, viaReal]) {
        const res = await user.requestOk({
          op: "fs_read_external",
          sid: A,
          path: candidate,
        });
        expect(res.content).toBe("bytes");
        expect(res.path).toBe(candidate);
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("security: any existing absolute path outside the allowlist is path_forbidden", async () => {
    // Existence is not a grant: another real file beside the recorded one must
    // be refused with path_forbidden rather than leaking its readable content.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const allowed = path.join(outside, "allowed.txt");
      const secret = path.join(outside, "secret.txt");
      fs.writeFileSync(allowed, "allowed");
      fs.writeFileSync(secret, "secret");
      await sessionAtWithTranscript(ctx, A, root, [externalToolUse("r1", "Read", allowed)]);
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_read_external",
        sid: A,
        path: secret,
      });
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("security: traversal normalization and prefix/directory abuse do not inherit a file grant", async () => {
    // The grant is one normalized full path, never its parent or descendants;
    // `..` spellings that normalize to a different file are checked as that
    // different file before any realpath/open.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const allowedDir = path.join(outside, "allowed");
      const allowed = path.join(allowedDir, "file.txt");
      const secret = path.join(outside, "secret.txt");
      fs.mkdirSync(allowedDir);
      fs.writeFileSync(allowed, "allowed");
      fs.writeFileSync(secret, "secret");
      await sessionAtWithTranscript(ctx, A, root, [externalToolUse("r1", "Read", allowed)]);
      const user = await userConn(ctx);
      for (const candidate of [
        path.join(allowed, "..", "..", "secret.txt"),
        path.join(allowedDir, "file.txt", "..", "..", "secret.txt"),
        allowedDir,
      ]) {
        const res = await user.requestError({
          op: "fs_read_external",
          sid: A,
          path: candidate,
        });
        expect(res.error.code).toBe("path_forbidden");
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("relative and empty paths are invalid_args, a non-string path too", async () => {
    // fs_read_external's wire shape is absolute-only; malformed shapes fail
    // before transcript scanning or filesystem existence checks.
    const ctx = await startInProcessDaemon();
    try {
      const user = await userConn(ctx);
      for (const candidate of ["relative.txt", ""]) {
        const res = await user.requestError({
          op: "fs_read_external",
          sid: A,
          path: candidate,
        });
        expect(res.error.code).toBe("invalid_args");
      }
      const res = await user.requestRefusal({ op: "fs_read_external", sid: A, path: 42 });
      expect(res.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("security: allowlisted path ancestor replaced by a symlink is rejected on read-time realpath", async () => {
    // Build a live fold before mutation so the test exercises the second
    // realpath check, not a fresh transcript scan that sees only the new link.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    const replacement = fixtureDir("fsroot");
    try {
      const parent = path.join(outside, "x");
      const target = path.join(parent, "target.txt");
      fs.mkdirSync(parent);
      fs.writeFileSync(target, "original");
      const canonicalTarget = fs.realpathSync(target);
      fs.writeFileSync(path.join(replacement, "target.txt"), "replacement");
      await sessionAtWithTranscript(ctx, A, root, [externalToolUse("r1", "Read", target)]);
      const user = await userConn(ctx);
      await user.request({ op: "session_status_subscribe", sid: A });

      fs.rmSync(parent, { recursive: true, force: true });
      fs.symlinkSync(replacement, parent);
      const res = await user.requestError({
        op: "fs_read_external",
        sid: A,
        path: canonicalTarget,
      });
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(replacement, { recursive: true, force: true });
    }
  });

  test("security: allowlisted file itself replaced by a symlink is rejected", async () => {
    // A final-component swap is the sibling attack to the ancestor swap:
    // normalized request still matches, but fresh realpath must not.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    const replacement = fixtureDir("fsroot");
    try {
      const target = path.join(outside, "target.txt");
      const secret = path.join(replacement, "secret.txt");
      fs.writeFileSync(target, "original");
      const canonicalTarget = fs.realpathSync(target);
      fs.writeFileSync(secret, "secret");
      await sessionAtWithTranscript(ctx, A, root, [externalToolUse("r1", "Read", target)]);
      const user = await userConn(ctx);
      await user.request({ op: "session_status_subscribe", sid: A });

      fs.unlinkSync(target);
      fs.symlinkSync(secret, target);
      const res = await user.requestError({
        op: "fs_read_external",
        sid: A,
        path: canonicalTarget,
      });
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(replacement, { recursive: true, force: true });
    }
  });

  test("allowlisted missing target is not_found and allowlisted directory is invalid_args", async () => {
    // Transcript folding may retain a Write-before-create path, while file
    // tools may also point at a directory; exact authorization succeeds in
    // both cases, then the shared fs_read file contract distinguishes them.
    // A missing target is canonicalized through its nearest existing ancestor
    // on both sides, so the tool call's own spelling through a symlinked
    // tmpdir reaches the same entry as the ancestor-realpath spelling.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const missing = path.join(outside, "future.md");
      const missingCanonical = path.join(fs.realpathSync(outside), "future.md");
      const dir = path.join(outside, "dir");
      fs.mkdirSync(dir);
      await sessionAtWithTranscript(ctx, A, root, [
        externalToolUse("w1", "Write", missing),
        externalToolUse("r1", "Read", dir),
      ]);
      const user = await userConn(ctx);
      for (const candidate of [missingCanonical, missing]) {
        const missingRes = await user.requestError({
          op: "fs_read_external",
          sid: A,
          path: candidate,
        });
        expect(missingRes.error.code).toBe("not_found");
      }
      const dirRes = await user.requestError({
        op: "fs_read_external",
        sid: A,
        path: fs.realpathSync(dir),
      });
      expect(dirRes.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("session/transcript lookup failures preserve the existing error categories", async () => {
    // No live sid is session_not_found; a connected sid without an accepted
    // transcript is not_found. Neither case falls back to arbitrary paths.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const user = await userConn(ctx);
      const missingSession = await user.requestError({
        op: "fs_read_external",
        sid: "missing",
        path: "/absolute/file",
      });
      expect(missingSession.error.code).toBe("session_not_found");
      await sessionConn(ctx, A, { cwd: root });
      const missingTranscript = await user.requestError({
        op: "fs_read_external",
        sid: A,
        path: "/absolute/file",
      });
      expect(missingTranscript.error.code).toBe("not_found");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("role gate and hello gate: only an identified user connection can call fs_read_external", async () => {
    // The op is a webui viewer surface like session_status: unauthenticated
    // callers get hello_required and session identities get bad_request.
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const anonymous = await connect(ctx.sock);
      const noHello = await anonymous.requestError({
        op: "fs_read_external",
        sid: A,
        path: "/absolute/file",
      });
      expect(noHello.error.code).toBe("hello_required");
      const session = await sessionConn(ctx, A, { cwd: root });
      const denied = await session.requestError({
        op: "fs_read_external",
        sid: A,
        path: "/absolute/file",
      });
      expect(denied.error.code).toBe("bad_request");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fs_list_workspace / fs_read_workspace (DR-0026)", () => {
  /** Session helper that plants a `.code-workspace` file at cwd's top level
   * before saying hello, so the first session_status snapshot the daemon
   * computes already carries workspace_folders — the two ops read that
   * snapshot for their allowlist and would otherwise reject every path. */
  async function sessionWithWorkspace(
    ctx: InProcessDaemon,
    sid: string,
    cwd: string,
    workspaceContents: string,
  ): Promise<TestClient> {
    fs.writeFileSync(path.join(cwd, "test.code-workspace"), workspaceContents);
    // A transcript is required for session_status to fold (getSessionStatus
    // resolves the transcript first); an empty one is enough here since we
    // don't need any external_files.
    const transcript = path.join(cwd, `${sid}.jsonl`);
    fs.writeFileSync(transcript, "");
    const session = await sessionConn(ctx, sid, { cwd, transcript_path: transcript });
    return session;
  }

  test("session_status snapshot exposes discovered workspace_folders", async () => {
    // Round-trip check that the daemon publishes what workspace-folders.ts
    // discovered — this is the wire the two ops read their allowlist from.
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    const cwd = path.join(parent, "cwd");
    const sibling = path.join(parent, "sibling");
    fs.mkdirSync(cwd);
    fs.mkdirSync(sibling);
    try {
      await sessionWithWorkspace(
        ctx,
        A,
        cwd,
        JSON.stringify({
          folders: [
            { name: "self", path: "." },
            { name: "sib", path: "../sibling" },
          ],
        }),
      );
      const user = await userConn(ctx);
      const res = await user.requestOk({ op: "session_status", sid: A });
      expect(res.workspace_folders).toEqual([
        { name: "self", path: cwd },
        { name: "sib", path: sibling },
      ]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fs_list_workspace returns entries for a folder root and descendants", async () => {
    // Verifies the happy path: an absolute path exactly matching a
    // workspace_folders entry lists, and a descendant of that entry also
    // lists (directory-prefix grant, unlike fs_read_external's exact grant).
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    const cwd = path.join(parent, "cwd");
    const sibling = path.join(parent, "sibling");
    fs.mkdirSync(cwd);
    fs.mkdirSync(sibling);
    fs.mkdirSync(path.join(sibling, "sub"));
    fs.writeFileSync(path.join(sibling, "root.txt"), "at root");
    fs.writeFileSync(path.join(sibling, "sub", "child.txt"), "nested");
    try {
      await sessionWithWorkspace(
        ctx,
        A,
        cwd,
        JSON.stringify({ folders: [{ path: "../sibling" }] }),
      );
      const user = await userConn(ctx);

      // (a) list the folder root itself
      const rootRes = await user.requestOk({ op: "fs_list_workspace", sid: A, path: sibling });
      expect(rootRes.path).toBe(sibling);
      expect(rootRes.entries.map((e) => [e.name, e.type])).toEqual([
        ["sub", "dir"],
        ["root.txt", "file"],
      ]);

      // (b) list a descendant of the folder root
      const subRes = await user.requestOk({
        op: "fs_list_workspace",
        sid: A,
        path: path.join(sibling, "sub"),
      });
      expect(subRes.entries.map((e) => e.name)).toEqual(["child.txt"]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fs_read_workspace returns content for a file under a folder root", async () => {
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    const cwd = path.join(parent, "cwd");
    const sibling = path.join(parent, "sibling");
    fs.mkdirSync(cwd);
    fs.mkdirSync(sibling);
    const target = path.join(sibling, "note.txt");
    fs.writeFileSync(target, "workspace content");
    try {
      await sessionWithWorkspace(
        ctx,
        A,
        cwd,
        JSON.stringify({ folders: [{ path: "../sibling" }] }),
      );
      const user = await userConn(ctx);
      const res = await user.requestOk({ op: "fs_read_workspace", sid: A, path: target });
      expect(res.content).toBe("workspace content");
      expect(res.binary).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("security: an absolute path outside every workspace folder is path_forbidden", async () => {
    // The allowlist is prefix-scoped; a sibling directory not listed in the
    // workspace file must be refused, not silently accepted because it
    // happens to sit next to a listed folder.
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    const cwd = path.join(parent, "cwd");
    const listed = path.join(parent, "listed");
    const secret = path.join(parent, "secret");
    fs.mkdirSync(cwd);
    fs.mkdirSync(listed);
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, "s.txt"), "secret");
    try {
      await sessionWithWorkspace(ctx, A, cwd, JSON.stringify({ folders: [{ path: "../listed" }] }));
      const user = await userConn(ctx);
      for (const bad of [secret, path.join(secret, "s.txt")]) {
        const listRes = await user.requestError({
          op: "fs_list_workspace",
          sid: A,
          path: bad,
        });
        expect(listRes.error.code).toBe("path_forbidden");
      }
      const readRes = await user.requestError({
        op: "fs_read_workspace",
        sid: A,
        path: path.join(secret, "s.txt"),
      });
      expect(readRes.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("security: `..` traversal out of a folder root normalizes and is refused", async () => {
    // The daemon normalizes the request path before realpath, so a `..`
    // spelling that would break out of the folder root gets caught before
    // any filesystem access — same posture as fs_read_external.
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    const cwd = path.join(parent, "cwd");
    const listed = path.join(parent, "listed");
    const secret = path.join(parent, "secret.txt");
    fs.mkdirSync(cwd);
    fs.mkdirSync(listed);
    fs.writeFileSync(secret, "secret");
    try {
      await sessionWithWorkspace(ctx, A, cwd, JSON.stringify({ folders: [{ path: "../listed" }] }));
      const user = await userConn(ctx);
      const traversal = path.join(listed, "..", "secret.txt");
      const res = await user.requestError({
        op: "fs_read_workspace",
        sid: A,
        path: traversal,
      });
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("security: symlink escape from within a folder root is rejected by realpath", async () => {
    // A symlink placed inside the listed folder that points outside it
    // must not become a browsable escape. The daemon realpaths the request
    // before checking the allowlist prefix; the resolved target lands
    // outside every folder root and comes back path_forbidden.
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    const cwd = path.join(parent, "cwd");
    const listed = path.join(parent, "listed");
    const outsideTree = path.join(parent, "outside");
    const escape = path.join(listed, "escape-link");
    fs.mkdirSync(cwd);
    fs.mkdirSync(listed);
    fs.mkdirSync(outsideTree);
    fs.writeFileSync(path.join(outsideTree, "target.txt"), "outside");
    fs.symlinkSync(outsideTree, escape);
    try {
      await sessionWithWorkspace(ctx, A, cwd, JSON.stringify({ folders: [{ path: "../listed" }] }));
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_read_workspace",
        sid: A,
        path: path.join(escape, "target.txt"),
      });
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("invalid_args: relative or empty paths are rejected before any filesystem access", async () => {
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    const cwd = path.join(parent, "cwd");
    const sibling = path.join(parent, "sibling");
    fs.mkdirSync(cwd);
    fs.mkdirSync(sibling);
    try {
      await sessionWithWorkspace(
        ctx,
        A,
        cwd,
        JSON.stringify({ folders: [{ path: "../sibling" }] }),
      );
      const user = await userConn(ctx);
      for (const bad of ["relative/path", ""]) {
        const res = await user.requestError({
          op: "fs_list_workspace",
          sid: A,
          path: bad,
        });
        expect(res.error.code).toBe("invalid_args");
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("empty allowlist (no workspace file) refuses every absolute path", async () => {
    // A session with no `.code-workspace` file must not accidentally grant
    // fs_list_workspace access to anything — empty workspace_folders means
    // the whole op surface is unusable.
    const ctx = await startInProcessDaemon();
    const cwd = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      // sessionAtWithTranscript avoids creating a workspace file
      await sessionAtWithTranscript(ctx, A, cwd, []);
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_list_workspace",
        sid: A,
        path: outside,
      });
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("role gate: session role cannot call fs_list_workspace / fs_read_workspace", async () => {
    // Same posture as fs_read_external — the workspace ops are a webui
    // viewer feature, not something an AI session should reach through.
    const ctx = await startInProcessDaemon();
    const cwd = fixtureDir("fsroot");
    try {
      const session = await sessionConn(ctx, A, { cwd });
      for (const op of ["fs_list_workspace", "fs_read_workspace"] as const) {
        const res = await session.requestError({
          op,
          sid: A,
          path: "/tmp",
        });
        expect(res.error.code).toBe("bad_request");
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("fs_write (DR-0019 Phase W1)", () => {
  // fs_write is a webui-only mutation surface: a session identity must be
  // rejected before it can create anything in its own or another session's root.
  test("role gate: session role cannot call fs_write", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const session = await sessionConn(ctx, A, { cwd: root });
      const res = await session.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/denied.md",
        content: "must not be written",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      expect(fs.existsSync(path.join(root, "docs", "inbox", "denied.md"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Absolute paths are outside the relative-path wire contract even when the
  // caller knows a real host path; rejecting them preserves the session-root boundary.
  test("containment: an absolute path outside the session root is path_forbidden", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const outsidePath = path.join(outside, "escaped.md");
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: outsidePath,
        content: "must stay contained",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
      expect(fs.existsSync(outsidePath)).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A lexical docs/inbox prefix must not hide traversal that normalizes beyond
  // the session root; containment is checked on the normalized candidate first.
  test('containment: ".." traversal out of the session root is path_forbidden', async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/../../../escaped.md",
        content: "must stay contained",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A root-relative docs/inbox name is not sufficient when an existing symlink
  // redirects that directory outside the root; realpath containment must win.
  test("containment: a docs/inbox symlink escaping the root is path_forbidden", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      fs.mkdirSync(path.join(root, "docs"));
      fs.symlinkSync(outside, path.join(root, "docs", "inbox"));
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/escaped.md",
        content: "must stay contained",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
      expect(fs.existsSync(path.join(outside, "escaped.md"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // Containment alone is not enough for the write policy: docs/inbox may be a
  // symlink to another directory INSIDE the root (e.g. -> src/). That passes
  // realpath containment, so the inbox prefix must be judged on the resolved
  // realpath — a lexical "docs/inbox/…" request must not smuggle a new file
  // into src/. Regression test for the in-root redirect found in review.
  test("write policy: docs/inbox symlinked to another in-root dir is path_not_writable", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.mkdirSync(path.join(root, "docs"));
      fs.symlinkSync(path.join(root, "src"), path.join(root, "docs", "inbox"));
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/evil.md",
        content: "must not land in src/",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_not_writable");
      expect(fs.existsSync(path.join(root, "src", "evil.md"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The wire contract requires a non-empty relative path; an empty string has
  // no leaf to create and is rejected as malformed input, not as a policy miss.
  test("invalid_args: fs_write with an empty path string", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "",
        content: "no destination",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The allowed prefix is "docs/inbox/" WITH the separator: a sibling name that
  // merely starts with the same characters (docs/inboxx/) is a different
  // directory and must be refused — classic startsWith-without-separator trap.
  test("write policy: sibling directory docs/inboxx is path_not_writable", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/inboxx/memo.md",
        content: "prefix trap",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_not_writable");
      expect(fs.existsSync(path.join(root, "docs", "inboxx"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // "docs/inbox" itself (no leaf under it) is the directory, not a memo: the
  // grant is strictly for descendants, so the bare directory path is refused.
  test("write policy: docs/inbox itself (no filename under it) is path_not_writable", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/inbox",
        content: "not a memo",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_not_writable");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Phase W1 grants exactly docs/inbox descendants, so another in-root path is
  // refused with the write-policy error rather than the containment error.
  test("write policy: a path outside docs/inbox is path_not_writable", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/note.md",
        content: "wrong directory",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_not_writable");
      expect(fs.existsSync(path.join(root, "docs", "note.md"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Inbox writes are create-only: an existing path must be rejected and its
  // original bytes must remain unchanged rather than being truncated or replaced.
  test("create-only: an existing file is file_exists and remains unchanged", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const target = path.join(root, "docs", "inbox", "existing.md");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "original");
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/existing.md",
        content: "replacement",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("file_exists");
      expect(fs.readFileSync(target, "utf-8")).toBe("original");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // In a repo-container session, the request path is relative to the session's
  // own cwd, while the response path stays relative to the browsable root so
  // FileTree/FileViewer can immediately address the created file. This is the
  // jj-workspace invariant: the memo must land in the working copy where
  // `jj status` can see it, never in the container directory beside every
  // workspace.
  test("repo_root session: writes under cwd and returns the root-relative created path", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const cwd = path.join(root, "main");
    const target = path.join(cwd, "docs", "inbox", "memo.md");
    const oldContainerTarget = path.join(root, "docs", "inbox", "memo.md");
    try {
      fs.mkdirSync(cwd);
      await sessionConn(ctx, A, { cwd, repo_root: root });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/memo.md",
        content: "working-copy memo",
      });
      expect(res).toEqual({
        ok: true,
        sid: A,
        path: path.join("main", "docs", "inbox", "memo.md"),
      });
      expect(fs.readFileSync(target, "utf-8")).toBe("working-copy memo");
      expect(fs.existsSync(oldContainerTarget)).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // An inbox-less working copy is a supported starting state: fs_write creates
  // docs/inbox recursively below cwd before creating the requested new memo.
  test("parent creation: missing docs/inbox is created recursively", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const target = path.join(root, "docs", "inbox", "created.md");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/created.md",
        content: "created with parents",
      });
      expect(res).toEqual({ ok: true, sid: A, path: path.join("docs", "inbox", "created.md") });
      expect(fs.readFileSync(target, "utf-8")).toBe("created with parents");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // With docs/inbox already present, a normal request writes the exact UTF-8
  // content and returns the normalized root-relative path of the created file.
  test("normal write: creates a new UTF-8 memo and returns sid/path", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const inbox = path.join(root, "docs", "inbox");
    const target = path.join(inbox, "memo.md");
    try {
      fs.mkdirSync(inbox, { recursive: true });
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_write",
        sid: A,
        path: "docs/inbox/memo.md",
        content: "日本語のメモ\n",
      });
      expect(res).toEqual({ ok: true, sid: A, path: path.join("docs", "inbox", "memo.md") });
      expect(fs.readFileSync(target, "utf-8")).toBe("日本語のメモ\n");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// fs_edit (in-place overwrite of an existing text file). Reuses the same
// containment / allowlist checks fs_read enforces (via fsResolveForServe),
// so the containment corner cases are covered by the fs_read/fs_write
// suites; this describe focuses on the edit-specific behavior: role gate,
// optimistic-lock conflict, binary refusal, and the happy-path overwrite.
describe("fs_edit (viewer text edit)", () => {
  test("role gate: session role cannot call fs_edit", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const target = path.join(root, "hello.txt");
      fs.writeFileSync(target, "before\n");
      const stat = fs.lstatSync(target);
      const session = await sessionConn(ctx, A, { cwd: root });
      const res = await session.requestError({
        op: "fs_edit",
        sid: A,
        path: "hello.txt",
        kind: "contained",
        content: "after\n",
        expected_mtime: stat.mtime.toISOString(),
        expected_size: stat.size,
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      expect(fs.readFileSync(target, "utf-8")).toBe("before\n");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("happy path: overwrites an existing text file and reports post-write mtime/size", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const target = path.join(root, "note.md");
      fs.writeFileSync(target, "old content\n");
      const before = fs.lstatSync(target);
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_edit",
        sid: A,
        path: "note.md",
        kind: "contained",
        content: "new content 日本語\n",
        expected_mtime: before.mtime.toISOString(),
        expected_size: before.size,
      });
      expect(res.ok).toBe(true);
      expect(res.path).toBe("note.md");
      expect(fs.readFileSync(target, "utf-8")).toBe("new content 日本語\n");
      expect(res.size).toBe(Buffer.byteLength("new content 日本語\n", "utf-8"));
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("conflict: mtime/size mismatch is file_conflict and does not overwrite", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const target = path.join(root, "note.md");
      fs.writeFileSync(target, "original\n");
      const stale = fs.lstatSync(target);
      // Simulate a concurrent external edit between the viewer's read and
      // the fs_edit call: bump the file's mtime by rewriting it.
      await new Promise((r) => setTimeout(r, 15));
      fs.writeFileSync(target, "external edit\n");
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_edit",
        sid: A,
        path: "note.md",
        kind: "contained",
        content: "clobber attempt\n",
        expected_mtime: stale.mtime.toISOString(),
        expected_size: stale.size,
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("file_conflict");
      expect(fs.readFileSync(target, "utf-8")).toBe("external edit\n");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("binary refusal: on-disk NUL byte in the head is not_a_text_file", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const target = path.join(root, "blob.bin");
      // Deliberate NUL in the first 8 KiB — matches the daemon's binary sniff.
      fs.writeFileSync(target, Buffer.from([0x68, 0x00, 0x69]));
      const stat = fs.lstatSync(target);
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_edit",
        sid: A,
        path: "blob.bin",
        kind: "contained",
        content: "text",
        expected_mtime: stat.mtime.toISOString(),
        expected_size: stat.size,
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_a_text_file");
      // Original binary bytes untouched.
      expect(fs.readFileSync(target)).toEqual(Buffer.from([0x68, 0x00, 0x69]));
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("containment: an absolute path outside the session root is path_forbidden", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const escaped = path.join(outside, "escape.txt");
      fs.writeFileSync(escaped, "outside\n");
      const stat = fs.lstatSync(escaped);
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_edit",
        sid: A,
        path: escaped,
        kind: "contained",
        content: "should not land",
        expected_mtime: stat.mtime.toISOString(),
        expected_size: stat.size,
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
      expect(fs.readFileSync(escaped, "utf-8")).toBe("outside\n");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("not_found: target does not exist replies not_found (fs_edit never creates)", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_edit",
        sid: A,
        path: "missing.txt",
        kind: "contained",
        content: "no create\n",
        expected_mtime: "2026-01-01T00:00:00.000Z",
        expected_size: 0,
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_found");
      expect(fs.existsSync(path.join(root, "missing.txt"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// fs_create (symmetric partner of fs_edit): create a new
// file under fs_read's containment surface. Reuses resolveContained /
// resolveWorkspaceContained-equivalent walks, so the containment corner cases
// are covered by fs_list/fs_read/fs_write; this describe focuses on the
// create-specific behavior: role gate, existing conflict, missing parent,
// path traversal refusal.
describe("fs_create", () => {
  test("role gate: session role cannot call fs_create", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const session = await sessionConn(ctx, A, { cwd: root });
      const res = await session.requestError({
        op: "fs_create",
        sid: A,
        path: "new.txt",
        kind: "contained",
        content: "",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("happy path: creates an empty text file at a fresh path in root", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_create",
        sid: A,
        path: "new.txt",
        kind: "contained",
        content: "",
      });
      expect(res.ok).toBe(true);
      expect(res.path).toBe("new.txt");
      expect(fs.readFileSync(path.join(root, "new.txt"), "utf-8")).toBe("");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("happy path: creates a file inside an existing subdirectory (mirrors what the FileTree '+' does)", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.mkdirSync(path.join(root, "sub"));
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_create",
        sid: A,
        path: "sub/hello.md",
        kind: "contained",
        content: "hi\n",
      });
      expect(res.ok).toBe(true);
      expect(res.path).toBe("sub/hello.md");
      expect(fs.readFileSync(path.join(root, "sub/hello.md"), "utf-8")).toBe("hi\n");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("file_exists: refuses to overwrite an existing file", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      fs.writeFileSync(path.join(root, "dup.txt"), "original\n");
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_create",
        sid: A,
        path: "dup.txt",
        kind: "contained",
        content: "clobber\n",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("file_exists");
      // Original bytes preserved: create must never overwrite.
      expect(fs.readFileSync(path.join(root, "dup.txt"), "utf-8")).toBe("original\n");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("not_found: refuses to create when the parent directory does not exist (never mkdir)", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_create",
        sid: A,
        path: "missing/leaf.txt",
        kind: "contained",
        content: "",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_found");
      expect(fs.existsSync(path.join(root, "missing"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("containment: an absolute path outside the session root is path_forbidden", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_create",
        sid: A,
        path: path.join(outside, "escape.txt"),
        kind: "contained",
        content: "should not land",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
      expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("containment: a ../ escape is path_forbidden even with a real ancestor sibling", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      // Sibling of root that a naive lexical join would reach via "../".
      const sibling = path.join(path.dirname(root), "sibling");
      fs.mkdirSync(sibling, { recursive: true });
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_create",
        sid: A,
        path: "../sibling/escape.txt",
        kind: "contained",
        content: "no",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
      expect(fs.existsSync(path.join(sibling, "escape.txt"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// fs_delete (symmetric partner of fs_create on the destructive
// side): unlink a regular file under fs_edit's authorization surfaces. Reuses
// fsResolveForServe so the containment corner cases are covered by the
// fs_read/fs_edit suites; this describe focuses on the delete-specific
// behavior: role gate, happy path, directory refusal, authorization refusal.
describe("fs_delete", () => {
  test("role gate: session role cannot call fs_delete", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const target = path.join(root, "keep.txt");
      fs.writeFileSync(target, "keep\n");
      const session = await sessionConn(ctx, A, { cwd: root });
      const res = await session.requestError({
        op: "fs_delete",
        sid: A,
        path: "keep.txt",
        kind: "contained",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("happy path: deletes an existing regular file", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const target = path.join(root, "gone.txt");
      fs.writeFileSync(target, "bye\n");
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_delete",
        sid: A,
        path: "gone.txt",
        kind: "contained",
      });
      expect(res.ok).toBe(true);
      expect(res.path).toBe("gone.txt");
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("directory refusal: fs_delete refuses to unlink a directory", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      const dir = path.join(root, "keepdir");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "child.txt"), "child\n");
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_delete",
        sid: A,
        path: "keepdir",
        kind: "contained",
      });
      expect(res.ok).toBe(false);
      // fsResolveForServe rejects non-files with invalid_args; the message
      // may originate from either the resolver or fs_delete's own re-check,
      // but the outcome is the same: no unlink.
      expect(res.error.code).toBe("invalid_args");
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(true);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("containment: an absolute path outside the session root is path_forbidden and does not unlink", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    const outside = fixtureDir("fsroot");
    try {
      const outsideFile = path.join(outside, "safe.txt");
      fs.writeFileSync(outsideFile, "safe\n");
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_delete",
        sid: A,
        path: outsideFile,
        kind: "contained",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("safe\n");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("not_found: deleting a missing path replies not_found", async () => {
    const ctx = await startInProcessDaemon();
    const root = fixtureDir("fsroot");
    try {
      await sessionConn(ctx, A, { cwd: root });
      const user = await userConn(ctx);
      const res = await user.requestError({
        op: "fs_delete",
        sid: A,
        path: "missing.txt",
        kind: "contained",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_found");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// repo_root containment (DR-0008 addendum): a session's self-declared
// repo_root, once hello-time-validated (fs-access.ts's validateRepoRoot),
// widens fs_list/fs_read's containment root from "just this session's cwd" to
// "the whole repo container" — sibling workspaces/worktrees become browsable.
// An unvalidated/rejected repo_root is a silent no-op: root stays cwd exactly
// as if repo_root had never been announced (fail-open).
describe("repo_root containment (DR-0008 addendum)", () => {
  test("採用時: sibling workspace のファイルが fs_list/fs_read で読める", async () => {
    const ctx = await startInProcessDaemon();
    const container = fixtureDir("fsroot"); // plays the role of repo_root
    const main = path.join(container, "main");
    const feature = path.join(container, "feature");
    fs.mkdirSync(main);
    fs.mkdirSync(feature);
    fs.writeFileSync(path.join(feature, "note.txt"), "hello from feature");
    try {
      // session's own cwd is "main"; repo_root announces the container
      // that also holds the sibling "feature" workspace.
      const c = await sessionConn(ctx, A, { cwd: main, repo_root: container });

      // root listing now shows the *container's* children (main, feature),
      // not main's own (empty) children — proof the root actually widened.
      const rootList = await c.requestOk({ op: "fs_list", sid: A });
      expect(rootList.path).toBe("");
      expect(rootList.entries.map((e) => e.name).sort()).toEqual(["feature", "main"]);

      // sibling workspace is listable...
      const listed = await c.requestOk({
        op: "fs_list",
        sid: A,
        path: "feature",
      });
      expect(listed.entries.map((e) => e.name)).toEqual(["note.txt"]);

      // ...and its file is readable, despite living outside cwd entirely.
      const read = await c.requestOk({
        op: "fs_read",
        sid: A,
        path: "feature/note.txt",
      });
      expect(read.content).toBe("hello from feature");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(container, { recursive: true, force: true });
    }
  });

  test("検証輪郭: 相対パスの repo_root は不採用 (peers に現れない)", async () => {
    const ctx = await startInProcessDaemon();
    const cwd = fixtureDir("fsroot");
    try {
      const c = await sessionConn(ctx, A, { cwd, repo_root: "relative/not-allowed" });
      const peers = await c.requestOk({
        op: "peers",
      });
      expect(
        defined(
          peers.peers.find((p) => p.sid === A),
          "self",
        ).repo_root,
      ).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("検証輪郭: cwd の ancestor でない (無関係な兄弟パス) repo_root は不採用", async () => {
    const ctx = await startInProcessDaemon();
    const cwd = fixtureDir("fsroot");
    const unrelated = fixtureDir("fsroot"); // a sibling tmpdir, NOT an ancestor of cwd
    try {
      const c = await sessionConn(ctx, A, { cwd, repo_root: unrelated });
      const peers = await c.requestOk({
        op: "peers",
      });
      expect(
        defined(
          peers.peers.find((p) => p.sid === A),
          "self",
        ).repo_root,
      ).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(unrelated, { recursive: true, force: true });
    }
  });

  test("検証輪郭: cwd 自身を repo_root に指定しても不採用 (strict ancestor 違反)", async () => {
    const ctx = await startInProcessDaemon();
    const cwd = fixtureDir("fsroot");
    try {
      const c = await sessionConn(ctx, A, { cwd, repo_root: cwd });
      const peers = await c.requestOk({
        op: "peers",
      });
      expect(
        defined(
          peers.peers.find((p) => p.sid === A),
          "self",
        ).repo_root,
      ).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('検証輪郭: repo_root="/" は不採用 (cwd がその strict ancestor であっても)', async () => {
    const ctx = await startInProcessDaemon();
    const cwd = fixtureDir("fsroot"); // any tmpdir is trivially a strict descendant of "/"
    try {
      const c = await sessionConn(ctx, A, { cwd, repo_root: "/" });
      const peers = await c.requestOk({
        op: "peers",
      });
      expect(
        defined(
          peers.peers.find((p) => p.sid === A),
          "self",
        ).repo_root,
      ).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("検証輪郭: repo_root=$HOME は不採用 (cwd が $HOME 配下であっても)", async () => {
    const ctx = await startInProcessDaemon();
    const home = os.homedir();
    // cwd must genuinely be a descendant of $HOME for this to isolate the
    // $HOME-exclusion branch (condition 5) from the ancestor check
    // (condition 4) — a tmpdir under os.tmpdir() usually isn't under $HOME.
    const cwd = fs.mkdtempSync(path.join(home, ".ccmsg-fsroot-home-test-"));
    try {
      const c = await sessionConn(ctx, A, { cwd, repo_root: home });
      const peers = await c.requestOk({
        op: "peers",
      });
      expect(
        defined(
          peers.peers.find((p) => p.sid === A),
          "self",
        ).repo_root,
      ).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("検証輪郭: repo_root が $HOME の ancestor (例: /Users) でも不採用 (完全一致だけでなく祖先も塞ぐ)", async () => {
    const ctx = await startInProcessDaemon();
    const home = os.homedir();
    const homeAncestor = path.dirname(home);
    // homeAncestor が "/" になる環境 (home 自体が "/" 直下、例: CI の
    // "/root") では realRoot==="/" の既存チェックが先に効いてしまい、
    // 本テストが検証したい「home の ancestor-or-self」分岐を通らない
    // ("/" チェックとの重複になるだけで、期待する不採用の結論自体は
    // どのみち成立するため test 自体は skip せず進める)。
    const cwd = fs.mkdtempSync(path.join(home, ".ccmsg-fsroot-homeanc-test-"));
    try {
      const c = await sessionConn(ctx, A, { cwd, repo_root: homeAncestor });
      const peers = await c.requestOk({
        op: "peers",
      });
      expect(
        defined(
          peers.peers.find((p) => p.sid === A),
          "self",
        ).repo_root,
      ).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("回帰確認: $HOME 配下の通常 container (= $HOME 自身でもその ancestor でもない) は採用される", async () => {
    const ctx = await startInProcessDaemon();
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
      const c = await sessionConn(ctx, A, { cwd: main, repo_root: container });
      const rootList = await c.requestOk({ op: "fs_list", sid: A });
      expect(rootList.path).toBe("");
      expect(rootList.entries.map((e) => e.name).sort()).toEqual(["feature", "main"]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(container, { recursive: true, force: true });
    }
  });

  test("不採用時は従来どおり cwd root のままで traversal が塞がっている", async () => {
    const ctx = await startInProcessDaemon();
    const cwd = fixtureDir("fsroot");
    const unrelated = fixtureDir("fsroot");
    try {
      // repo_root announced but rejected (unrelated, not an ancestor of cwd) —
      // fs_list/fs_read must still resolve strictly against cwd, exactly as
      // if repo_root had never been sent at all.
      const c = await sessionConn(ctx, A, { cwd, repo_root: unrelated });
      const res = await c.requestError({
        op: "fs_list",
        sid: A,
        path: "../etc",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(unrelated, { recursive: true, force: true });
    }
  });

  test("採用時でも repo_root の外への traversal は塞がっている", async () => {
    const ctx = await startInProcessDaemon();
    const container = fixtureDir("fsroot");
    const main = path.join(container, "main");
    fs.mkdirSync(main);
    try {
      const c = await sessionConn(ctx, A, { cwd: main, repo_root: container });
      // ".." from cwd ("main") lands exactly on the accepted root
      // (container) itself, which is a legitimate, in-root address — but
      // going one level further ("../..") must still escape and be
      // forbidden, proving containment tracks the *widened* root, not "no
      // containment at all".
      const res = await c.requestError({
        op: "fs_list",
        sid: A,
        path: "../../etc",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(container, { recursive: true, force: true });
    }
  });

  test("採用時でも repo_root 内からの symlink 脱出は塞がっている", async () => {
    const ctx = await startInProcessDaemon();
    const container = fixtureDir("fsroot");
    const main = path.join(container, "main");
    const outside = fixtureDir("fsroot");
    fs.mkdirSync(main);
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(main, "link_out"));
    try {
      const c = await sessionConn(ctx, A, { cwd: main, repo_root: container });
      const res = await c.requestError({
        op: "fs_read",
        sid: A,
        path: "main/link_out",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("path_forbidden");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(container, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
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
  test("repo_root candidate が実在しないパスなら不採用", async () => {
    const cwd = path.join(dir, "main");
    fs.mkdirSync(cwd);
    const got = await validateRepoRoot(cwd, path.join(dir, "does-not-exist"));
    expect(got).toBeUndefined();
  });

  // (b) cwd が実在しないパス: repo_root 自体は実在していても、widen 元となる
  // cwd を realpath できなければ「そもそも widen する意味がある anchor か」を
  // 確認できないので不採用 (fail-open: hello 自体は成功し、呼び出し元
  // resolveRoot は cwd をそのまま使う従来経路にフォールバックする — 検証する
  // のは validateRepoRoot 単体の戻り値であって resolveRoot の縮退動作ではない)。
  test("cwd が実在しないパスなら不採用", async () => {
    const got = await validateRepoRoot(path.join(dir, "no-such-cwd"), dir);
    expect(got).toBeUndefined();
  });

  // cwd が空文字の場合も同様に不採用 (typeof/空文字ガードで即座に弾かれる、
  // realpath すら呼ばれない経路)。
  test("cwd が空文字なら不採用", async () => {
    const got = await validateRepoRoot("", dir);
    expect(got).toBeUndefined();
  });

  // (c) repo_root candidate 自体が symlink: realpath で解決された実体パスが
  // 採用され、cwd (の実体) がその配下にあれば通る。symlink 越しに指定しても
  // containment root は実体パスに正規化される。
  test("repo_root candidate が symlink でも realpath 正規化されて採用される", async () => {
    const container = path.join(dir, "container");
    const cwd = path.join(container, "main");
    fs.mkdirSync(cwd, { recursive: true });
    const link = path.join(dir, "container-link");
    fs.symlinkSync(container, link);

    const got = await validateRepoRoot(cwd, link);
    expect(got).toBe(fs.realpathSync(container));
  });

  // (d) cwd から見て 2 階層以上離れた深い ancestor でも、strict ancestor
  // でありさえすれば仕様として採用される (kawaz 環境の repos ディレクトリ
  // 構成のような、cwd の直接の親より上位の container を container として
  // 指定するケースを想定した運用 knob。DR-0008 は「$HOME / "/" 自体を除く
  // strict ancestor なら widen 先として許容する」設計であり、階層数そのもの
  // には上限を設けていない — 意図的な許容であって見落としではない)。
  test("cwd の直接の親より深い ancestor でも strict ancestor なら採用される", async () => {
    const shallow = path.join(dir, "repos"); // ~/.local/share/repos 相当
    const cwd = path.join(shallow, "github.com", "kawaz", "claude-ccmsg", "main");
    fs.mkdirSync(cwd, { recursive: true });

    const got = await validateRepoRoot(cwd, shallow);
    expect(got).toBe(fs.realpathSync(shallow));
  });
});

describe("fs_stat_batch (message-body path linkifier)", () => {
  /** Session helper that plants a `.code-workspace` file at cwd (workspace
   * kind), an outside file referenced via a Read tool_use (external kind),
   * and one file inside cwd (contained kind), so a single batch can exercise
   * all three authorization surfaces in one round-trip. */
  /** Set up a session that has all three authorization surfaces populated
   * with **disjoint** filesystem regions (contained: files inside cwd,
   * workspace: files under a sibling directory registered via `.code-workspace`,
   * external: a transcript-observed file elsewhere). Disjoint on purpose —
   * the resolver order (contained → workspace → external) is only meaningfully
   * tested when a workspace-kind path can't also masquerade as contained,
   * which requires the workspace folder to live outside cwd. */
  async function sessionWithAllThreeKinds(
    ctx: InProcessDaemon,
    sid: string,
    parent: string,
  ): Promise<{
    session: TestClient;
    cwd: string;
    containedRel: string;
    workspaceAbs: string;
    externalAbs: string;
    unrelatedAbs: string;
  }> {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(parent, "cwd-")));
    const sibling = fs.realpathSync(fs.mkdtempSync(path.join(parent, "sibling-")));
    const externalDir = fs.realpathSync(fs.mkdtempSync(path.join(parent, "external-")));

    const insideFile = "sub/inside.md";
    fs.mkdirSync(path.join(cwd, "sub"));
    fs.writeFileSync(path.join(cwd, insideFile), "inside");

    const workspaceFile = path.join(sibling, "ws.md");
    fs.writeFileSync(workspaceFile, "ws");
    // .code-workspace's `folders[].path` is resolved relative to the
    // .code-workspace file's own directory (cwd here). Registering `../sibling-…`
    // adds an external directory to workspace_folders without adding cwd.
    fs.writeFileSync(
      path.join(cwd, "test.code-workspace"),
      JSON.stringify({
        folders: [{ name: "sib", path: path.relative(cwd, sibling) }],
      }),
    );

    const externalTarget = path.join(externalDir, "external.md");
    fs.writeFileSync(externalTarget, "external");

    const unrelatedTarget = path.join(externalDir, "unrelated.md");
    fs.writeFileSync(unrelatedTarget, "unrelated");

    const transcript = path.join(cwd, `${sid}.jsonl`);
    fs.writeFileSync(transcript, `${externalToolUse("r1", "Read", externalTarget)}\n`);

    const session = await sessionConn(ctx, sid, { cwd, transcript_path: transcript });
    return {
      session,
      cwd,
      containedRel: insideFile,
      workspaceAbs: workspaceFile,
      externalAbs: fs.realpathSync(externalTarget),
      unrelatedAbs: unrelatedTarget,
    };
  }

  test("3-kind happy path: contained/workspace/external all resolve, unrelated absolute path resolves to null", async () => {
    // Single batch across the three authorization surfaces establishes that
    // the resolver order is real (contained tried first for a repo-relative
    // absolute), and that a path outside every surface returns null rather
    // than an error — the response shape stays parallel to `paths`.
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    try {
      const { cwd, containedRel, workspaceAbs, externalAbs, unrelatedAbs } =
        await sessionWithAllThreeKinds(ctx, A, parent);
      const containedAbs = path.join(cwd, containedRel);

      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_stat_batch",
        sid: A,
        paths: [containedAbs, workspaceAbs, externalAbs, unrelatedAbs],
      });
      expect(res.results).toEqual([
        { kind: "contained", path: containedRel },
        // workspace / external echo the absolute path as it was found on
        // disk — FileViewer's fs_read_workspace / fs_read_external dispatch
        // takes absolute strings directly.
        { kind: "workspace", path: workspaceAbs },
        { kind: "external", path: externalAbs },
        null,
      ]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("directory targets resolve to null (not a regular file), even when inside containment", async () => {
    // The whole point of the op vs a "path shape guess" is that directories
    // (branch-name-shaped tokens that happen to exist on disk as dirs) are
    // rejected so the client never turns them into broken FileViewer links.
    const ctx = await startInProcessDaemon();
    const cwd = fs.realpathSync(fixtureDir("fsroot"));
    try {
      const subdir = path.join(cwd, "subdir");
      fs.mkdirSync(subdir);
      await sessionConn(ctx, A, { cwd });
      const user = await userConn(ctx);
      const res = await user.requestOk({ op: "fs_stat_batch", sid: A, paths: [subdir, cwd] });
      expect(res.results).toEqual([null, null]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("malformed path entries (empty / relative) become null; batch still returns results for the rest", async () => {
    // One bad token in the middle of an otherwise-valid list must not
    // abort the whole batch — the response is a parallel array with null
    // slots for the offenders and real entries for the valid ones.
    const ctx = await startInProcessDaemon();
    const cwd = fs.realpathSync(fixtureDir("fsroot"));
    try {
      fs.writeFileSync(path.join(cwd, "ok.md"), "ok");
      await sessionConn(ctx, A, { cwd });
      const user = await userConn(ctx);
      const okAbs = path.join(cwd, "ok.md");
      const res = await user.requestOk({
        op: "fs_stat_batch",
        sid: A,
        paths: [okAbs, "", "relative.md", okAbs],
      });
      expect(res.results[0]).toEqual({ kind: "contained", path: "ok.md" });
      expect(res.results[1]).toBeNull();
      expect(res.results[2]).toBeNull();
      expect(res.results[3]).toEqual({ kind: "contained", path: "ok.md" });
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("security: existence outside external allowlist collapses to null (no oracle)", async () => {
    // Same posture as fs_read_external's path_forbidden case — a real file
    // that isn't in the transcript-derived allowlist looks identical to a
    // nonexistent one from the response shape, so an attacker cannot
    // probe "does /etc/passwd exist" via fs_stat_batch.
    const ctx = await startInProcessDaemon();
    const cwd = fs.realpathSync(fixtureDir("fsroot"));
    const outside = fs.realpathSync(fixtureDir("fsroot"));
    try {
      const allowed = path.join(outside, "allowed.md");
      const secret = path.join(outside, "secret.md");
      const nonexistent = path.join(outside, "missing.md");
      fs.writeFileSync(allowed, "a");
      fs.writeFileSync(secret, "s");
      await sessionAtWithTranscript(ctx, A, cwd, [externalToolUse("r1", "Read", allowed)]);
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_stat_batch",
        sid: A,
        paths: [allowed, secret, nonexistent],
      });
      expect(res.results[0]).toEqual({ kind: "external", path: fs.realpathSync(allowed) });
      expect(res.results[1]).toBeNull();
      expect(res.results[2]).toBeNull();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("user-role only: session-role callers get bad_request", async () => {
    // Matches fs_read_external / fs_read_workspace's role gate — sessions
    // (AI) can already reach the filesystem directly, so they have no
    // reason to consume this viewer-only op.
    const ctx = await startInProcessDaemon();
    const cwd = fs.realpathSync(fixtureDir("fsroot"));
    try {
      const session = await sessionConn(ctx, A, { cwd });
      const res = await session.requestError({
        op: "fs_stat_batch",
        sid: A,
        paths: [path.join(cwd, "any.md")],
      });
      expect(res.error.code).toBe("bad_request");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("symlink 綴りの絶対パスも contained になる (containment root は realpath 済み)", async () => {
    // A session's cwd spelling comes from its shell, so it can reach the
    // real directory through a symlink (`/tmp` -> `/private/tmp` on macOS).
    // The containment root is realpath-resolved, so the probe input has to
    // be too — otherwise the string compare fails and a perfectly readable
    // file degrades to `null` (no FileViewer link) for every session whose
    // cwd is spelled that way.
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    try {
      const real = path.join(parent, "real");
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, "note.md"), "note");
      const link = path.join(parent, "link");
      fs.symlinkSync(real, link);

      await sessionConn(ctx, A, { cwd: link });
      const user = await userConn(ctx);
      const res = await user.requestOk({
        op: "fs_stat_batch",
        sid: A,
        paths: [path.join(link, "note.md"), path.join(real, "note.md")],
      });
      // Both spellings answer contained, and both report the same root-relative
      // path — the response never carries the symlinked spelling onward.
      expect(res.results).toEqual([
        { kind: "contained", path: "note.md" },
        { kind: "contained", path: "note.md" },
      ]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a paths list that is not of strings is not a request, an oversized one invalid_args", async () => {
    // Whole-request contract violations fail the batch — the caller is
    // doing something structurally wrong, so a single error keeps the
    // failure loud.
    const ctx = await startInProcessDaemon();
    const cwd = fs.realpathSync(fixtureDir("fsroot"));
    try {
      await sessionConn(ctx, A, { cwd });
      const user = await userConn(ctx);
      for (const paths of ["not-an-array", ["/abs/a", 42]]) {
        const res1 = await user.requestRefusal({ op: "fs_stat_batch", sid: A, paths });
        expect(res1.error.code).toBe("invalid_args");
      }
      const oversized = Array.from({ length: 257 }, (_, i) => `/abs/${i}`);
      const res2 = await user.requestError({
        op: "fs_stat_batch",
        sid: A,
        paths: oversized,
      });
      expect(res2.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// hello 時の cwd 正規化: peers が配る cwd は realpath 済み。repo_root だけが
// 正規化され cwd は生綴りのまま、という非対称を無くすための保証
// (webui は repo_root 未申告セッションで cwd をそのまま containment root
// として daemon に投げ返すため、綴りがずれると同種の 403 が再発する)。
describe("session cwd canonicalization (hello)", () => {
  test("repo_root 未申告でも peers.cwd は realpath 済み、その綴りで fs_read が通る", async () => {
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    try {
      const real = path.join(parent, "real");
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, "note.md"), "note");
      const link = path.join(parent, "link");
      fs.symlinkSync(real, link);

      const session = await sessionConn(ctx, A, { cwd: link });
      const peers = await session.requestOk({ op: "peers" });
      const self = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(self.repo_root).toBeUndefined();
      expect(self.cwd).toBe(real);

      // The advertised cwd is the client's containment root here, so it must
      // be the same spelling the daemon checks against.
      const read = await session.requestOk({
        op: "fs_read",
        sid: A,
        path: "note.md",
      });
      expect(read.content).toBe("note");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("symlink 綴りの cwd でも repo_root (container) は採用される", async () => {
    // validateRepoRoot's strict-ancestor check already realpath'd both
    // sides, so adoption was never the broken half — this pins that
    // canonicalizing cwd earlier doesn't regress it.
    const ctx = await startInProcessDaemon();
    const parent = fs.realpathSync(fixtureDir("fsroot"));
    try {
      const container = path.join(parent, "container");
      const main = path.join(container, "main");
      fs.mkdirSync(main, { recursive: true });
      const link = path.join(parent, "link-to-main");
      fs.symlinkSync(main, link);

      const session = await sessionConn(ctx, A, { cwd: link, repo_root: container });
      const peers = await session.requestOk({ op: "peers" });
      const self = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(self.cwd).toBe(main);
      expect(self.repo_root).toBe(container);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
