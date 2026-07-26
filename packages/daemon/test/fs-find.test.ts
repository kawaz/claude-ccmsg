// fs_find: recursive file-name search for the Files pane, exercised as the op
// itself over a real daemon + real fixture tree. What is worth proving here is
// that the search surface is exactly the browsable surface — nothing outside
// the containment root or the workspace allowlist can be enumerated, the role
// gate matches the other viewer-only fs ops, and .gitignore filtering prunes
// what it claims to. The query grammar those walks apply is a protocol-level
// contract shared with the client, tested in
// packages/protocol/test/file-search-query.test.ts.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FS_FIND_RESULT_MAX } from "@ccmsg/protocol";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

function mkfixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-fsfind-"));
}

async function sessionAt(ctx: DaemonCtx, sid: string, cwd: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: "r", ws: "w", cwd });
  return c;
}

async function userAt(ctx: DaemonCtx): Promise<TestClient> {
  const user = await connect(ctx.sock);
  await user.hello({ role: "user" });
  return user;
}

/** Session whose cwd carries a `.code-workspace`, so session_status folds a
 * workspace_folders allowlist for the kind:"workspace" branch to authorize
 * against (same setup fs-access.test.ts's DR-0026 block uses). */
async function sessionWithWorkspace(
  ctx: DaemonCtx,
  sid: string,
  cwd: string,
  workspaceContents: string,
): Promise<TestClient> {
  fs.writeFileSync(path.join(cwd, "test.code-workspace"), workspaceContents);
  const transcript = path.join(cwd, `${sid}.jsonl`);
  fs.writeFileSync(transcript, "");
  const session = await connect(ctx.sock);
  await session.request({
    op: "hello",
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd,
    transcript_path: transcript,
  });
  return session;
}

interface FindOk {
  ok: true;
  hits: { path: string; type: string }[];
  truncated: boolean;
}
interface FindErr {
  ok: false;
  error: { code: string; msg: string };
}

/** Builds the tree every op-level test searches:
 *   src/components/FileTree.tsx
 *   src/components/FileViewer.tsx
 *   src/utils.ts
 *   docs/README.md
 *   README.md
 */
function buildTree(root: string): void {
  fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "components", "FileTree.tsx"), "");
  fs.writeFileSync(path.join(root, "src", "components", "FileViewer.tsx"), "");
  fs.writeFileSync(path.join(root, "src", "utils.ts"), "");
  fs.writeFileSync(path.join(root, "docs", "README.md"), "");
  fs.writeFileSync(path.join(root, "README.md"), "");
}

describe("fs_find (contained)", () => {
  test(
    "finds matches in directories the client never listed, AND-ing words",
    async () => {
      // The point of the op: src/components was never fs_list'd by this
      // client, yet its files are reachable by name.
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "compo tsx",
        });
        expect(res.ok).toBe(true);
        expect(res.hits.map((h) => h.path).sort()).toEqual([
          "src/components/FileTree.tsx",
          "src/components/FileViewer.tsx",
        ]);
        expect(res.truncated).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "paths are root-relative and directories are matchable targets too",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "components",
        });
        // Typing a directory name lists what is inside it — "components" is a
        // substring of every child's path too. The directory entry itself is
        // NOT a hit (kawaz r55m76): FileViewer cannot open one, so it would be
        // an unselectable row that only eats into the result cap. The walk
        // still descends into it, which is why the children are here.
        expect(res.hits).toEqual([
          { path: "src/components/FileTree.tsx", type: "file" },
          { path: "src/components/FileViewer.tsx", type: "file" },
        ]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "shallower matches come first (breadth-first walk order)",
    async () => {
      // Ordering is load-bearing: it decides which matches survive the result
      // cap, and vendored/deep noise must not crowd out the user's own files.
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "readme",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["README.md", "docs/README.md"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "an empty query returns nothing rather than the whole tree",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "   ",
        });
        expect(res.hits).toEqual([]);
        expect(res.truncated).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "caps results and reports truncated",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      const many = path.join(cwd, "many");
      fs.mkdirSync(many);
      for (let i = 0; i < FS_FIND_RESULT_MAX + 25; i++) {
        fs.writeFileSync(path.join(many, `match-${i}.txt`), "");
      }
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "match-",
        });
        expect(res.hits.length).toBe(FS_FIND_RESULT_MAX);
        expect(res.truncated).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a sub-root confines the walk to that subtree",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          root: "docs",
          query: "readme",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["docs/README.md"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("fs_find authorization", () => {
  test(
    "requires user role — a session cannot walk another session's tree",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        const session = await sessionAt(ctx, "A", cwd);
        const res = await session.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "readme",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("bad_request");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "rejects fs_find without hello",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await connect(ctx.sock);
        const res = await c.request<FindErr>({
          op: "fs_find",
          sid: "whatever",
          kind: "contained",
          query: "x",
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
    "an absolute root is refused for kind:'contained' (fs_list's path contract)",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          root: cwd,
          query: "readme",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a '..' root escaping the containment root is refused",
    async () => {
      const ctx = await startTestDaemon();
      const parent = fs.realpathSync(mkfixture());
      const cwd = path.join(parent, "cwd");
      fs.mkdirSync(cwd);
      buildTree(cwd);
      fs.writeFileSync(path.join(parent, "OUTSIDE-README.md"), "");
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          root: "..",
          query: "readme",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "never returns paths from outside the root reached via a symlinked directory",
    async () => {
      // A symlink to an out-of-root directory is listed (matching fs_list,
      // which reports links as-is) but is NOT descended into, so the secret
      // outside can never appear as a hit.
      const ctx = await startTestDaemon();
      const parent = fs.realpathSync(mkfixture());
      const cwd = path.join(parent, "cwd");
      const outside = path.join(parent, "outside");
      fs.mkdirSync(cwd);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret-README.md"), "");
      fs.symlinkSync(outside, path.join(cwd, "escape"));
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "readme",
        });
        expect(res.ok).toBe(true);
        expect(res.hits).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a symlink cycle terminates instead of walking forever",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      const loop = path.join(cwd, "loop");
      fs.mkdirSync(loop);
      fs.writeFileSync(path.join(loop, "target-README.md"), "");
      fs.symlinkSync(loop, path.join(loop, "self"));
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "readme",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["loop/target-README.md"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("fs_find (workspace, DR-0026)", () => {
  test(
    "walks an allowlisted folder and returns absolute paths",
    async () => {
      const ctx = await startTestDaemon();
      const parent = fs.realpathSync(mkfixture());
      const cwd = path.join(parent, "cwd");
      const sibling = path.join(parent, "sibling");
      fs.mkdirSync(cwd);
      fs.mkdirSync(path.join(sibling, "nested"), { recursive: true });
      fs.writeFileSync(path.join(sibling, "nested", "README.md"), "");
      try {
        await sessionWithWorkspace(
          ctx,
          "A",
          cwd,
          JSON.stringify({ folders: [{ path: "../sibling" }] }),
        );
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "workspace",
          root: sibling,
          query: "readme",
        });
        expect(res.hits).toEqual([
          { path: path.join(sibling, "nested", "README.md"), type: "file" },
        ]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "refuses a root outside the workspace allowlist",
    async () => {
      const ctx = await startTestDaemon();
      const parent = fs.realpathSync(mkfixture());
      const cwd = path.join(parent, "cwd");
      const sibling = path.join(parent, "sibling");
      const other = path.join(parent, "other");
      fs.mkdirSync(cwd);
      fs.mkdirSync(sibling);
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, "README.md"), "");
      try {
        await sessionWithWorkspace(
          ctx,
          "A",
          cwd,
          JSON.stringify({ folders: [{ path: "../sibling" }] }),
        );
        const user = await userAt(ctx);
        const res = await user.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "workspace",
          root: other,
          query: "readme",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "requires a root for kind:'workspace' (there is no single default folder)",
    async () => {
      const ctx = await startTestDaemon();
      const parent = fs.realpathSync(mkfixture());
      const cwd = path.join(parent, "cwd");
      const sibling = path.join(parent, "sibling");
      fs.mkdirSync(cwd);
      fs.mkdirSync(sibling);
      try {
        await sessionWithWorkspace(
          ctx,
          "A",
          cwd,
          JSON.stringify({ folders: [{ path: "../sibling" }] }),
        );
        const user = await userAt(ctx);
        const res = await user.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "workspace",
          query: "readme",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a session with no workspace folders cannot reach anything via kind:'workspace'",
    async () => {
      const ctx = await startTestDaemon();
      const parent = fs.realpathSync(mkfixture());
      const cwd = path.join(parent, "cwd");
      const other = path.join(parent, "other");
      fs.mkdirSync(cwd);
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, "README.md"), "");
      try {
        // A transcript but deliberately no `.code-workspace`, so session_status
        // folds successfully with an EMPTY workspace_folders — that is the
        // case worth pinning (an allowlist of zero folders grants nothing).
        // Without a transcript the status lookup fails first and the test
        // would pass for the wrong reason.
        const transcript = path.join(cwd, "A.jsonl");
        fs.writeFileSync(transcript, "");
        const session = await connect(ctx.sock);
        await session.request({
          op: "hello",
          role: "session",
          sid: "A",
          repo: "r",
          ws: "w",
          cwd,
          transcript_path: transcript,
        });
        const user = await userAt(ctx);
        const res = await user.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "workspace",
          root: other,
          query: "readme",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "rejects an unknown kind",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "external",
          query: "readme",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("fs_find query grammar at the op level", () => {
  // The grammar itself is covered exhaustively in protocol's own test; what
  // these prove is that the op actually applies it to the walk rather than
  // falling back to a plain substring filter.
  test(
    "a -term excludes matching paths from the walk's results",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "readme -docs",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["README.md"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "an exclusion-only query returns nothing rather than the whole tree minus a few",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "-docs",
        });
        expect(res.hits).toEqual([]);
        expect(res.truncated).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "+- searches a literal hyphen instead of excluding",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      fs.writeFileSync(path.join(cwd, "file-search.ts"), "");
      fs.writeFileSync(path.join(cwd, "filesearch.ts"), "");
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "file +-search",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["file-search.ts"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("fs_find .gitignore filtering", () => {
  /** Repo-shaped fixture: a vendored tree the user never searches for, hidden
   * by a .gitignore, holding a file whose name collides with a real one. */
  function buildIgnoredTree(root: string): void {
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n*.log\n");
    fs.writeFileSync(path.join(root, "package.json"), "");
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "package.json"), "");
    fs.writeFileSync(path.join(root, "debug.log"), "");
  }

  test(
    "ignored paths are absent by default, and .git is pruned unconditionally",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildIgnoredTree(cwd);
      fs.mkdirSync(path.join(cwd, ".git"));
      fs.writeFileSync(path.join(cwd, ".git", "package.json"), "");
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "package.json",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["package.json"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "respect_gitignore:false restores the unfiltered walk (but still skips .git)",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildIgnoredTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "package.json",
          respect_gitignore: false,
        });
        expect(res.hits.map((h) => h.path)).toEqual([
          "package.json",
          "node_modules/dep/package.json",
        ]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a .gitignore between the containment root and the walk root still applies",
    async () => {
      // The Files tree passes its own browsing origin as `root`, which sits
      // below the containment root — the rules hiding vendored trees inside it
      // typically live in a .gitignore at the repo root, above where the walk
      // starts.
      const ctx = await startTestDaemon();
      const repo = fs.realpathSync(mkfixture());
      fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
      const pkg = path.join(repo, "pkg");
      fs.mkdirSync(path.join(pkg, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), "");
      fs.writeFileSync(path.join(pkg, "node_modules", "package.json"), "");
      try {
        await sessionAt(ctx, "A", repo);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          root: "pkg",
          query: "package.json",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["pkg/package.json"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "the ancestor scan stops at the containment root",
    async () => {
      // A .gitignore above the authorized surface must not shape the reply:
      // filtering may only use files the op was already allowed to read.
      const ctx = await startTestDaemon();
      const outside = fs.realpathSync(mkfixture());
      fs.writeFileSync(path.join(outside, ".gitignore"), "secret.txt\n");
      const cwd = path.join(outside, "repo");
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, "secret.txt"), "");
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "secret",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["secret.txt"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a nested .gitignore's negation re-includes what the root hid",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      fs.writeFileSync(path.join(cwd, ".gitignore"), "*.log\n");
      fs.mkdirSync(path.join(cwd, "keep"));
      fs.writeFileSync(path.join(cwd, "keep", ".gitignore"), "!*.log\n");
      fs.writeFileSync(path.join(cwd, "drop.log"), "");
      fs.writeFileSync(path.join(cwd, "keep", "kept.log"), "");
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindOk>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: ".log",
        });
        expect(res.hits.map((h) => h.path)).toEqual(["keep/kept.log"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a non-boolean respect_gitignore is rejected rather than coerced",
    async () => {
      const ctx = await startTestDaemon();
      const cwd = fs.realpathSync(mkfixture());
      buildTree(cwd);
      try {
        await sessionAt(ctx, "A", cwd);
        const user = await userAt(ctx);
        const res = await user.request<FindErr>({
          op: "fs_find",
          sid: "A",
          kind: "contained",
          query: "readme",
          respect_gitignore: "yes",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
