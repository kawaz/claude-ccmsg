// Deriving repo/ws from cwd (repo-derive.ts) for hellos that announce neither.
// The fixtures are real on-disk layouts built with `git`/`git worktree` where
// git is what produces them, and hand-written `.jj` marker files for jj (the
// shapes are verified against this repo's own checkout: a secondary workspace's
// `.jj/repo` is a file holding `../../.jj/repo`, and the jj repo's
// `store/git_target` points at the bare git dir relative to `store/`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";
import {
  deriveRepoWs,
  parseGitConfigRemotes,
  remoteUrlSlug,
  selectRemoteUrl,
  slugFromCheckoutPath,
} from "../src/repo-derive.ts";

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-repo-derive-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

/** A git repo with one commit on `main` and an `origin` remote. */
function makeGitRepo(at: string, remote = "git@github.com:kawaz/demo.git"): string {
  fs.mkdirSync(at, { recursive: true });
  git(at, "init", "-q", "-b", "main");
  git(at, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(at, "f.txt"), "x");
  git(at, "add", "f.txt");
  git(at, "commit", "-qm", "init");
  return at;
}

describe("deriveRepoWs", () => {
  test("git 通常リポ: repo は origin slug、ws は HEAD のブランチ", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    expect(await deriveRepoWs(root)).toEqual({ repo: "kawaz/demo", ws: "main" });
  });

  test("git: サブディレクトリからでも上方向探索で同じ結果", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const sub = path.join(root, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    expect(await deriveRepoWs(sub)).toEqual({ repo: "kawaz/demo", ws: "main" });
  });

  test("git linked worktree: ws は worktree ディレクトリ名、repo は common dir の origin", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const wt = path.join(dir, "demo-pr1");
    git(root, "worktree", "add", "-q", "-b", "feature", wt);
    expect(await deriveRepoWs(wt)).toEqual({ repo: "kawaz/demo", ws: "demo-pr1" });
  });

  test("jj secondary workspace (bare git + .jj): ws は workspace ディレクトリ名", async () => {
    // <repo>/.git (bare) + <repo>/.jj/repo/store/git_target + <repo>/main/.jj/repo
    const repo = path.join(dir, "proj");
    const bare = path.join(repo, ".git");
    fs.mkdirSync(repo, { recursive: true });
    git(dir, "init", "-q", "--bare", bare);
    git(bare, "remote", "add", "origin", "https://github.com/kawaz/proj.git");
    const jjRepo = path.join(repo, ".jj", "repo");
    fs.mkdirSync(path.join(jjRepo, "store"), { recursive: true });
    fs.writeFileSync(path.join(jjRepo, "store", "git_target"), "../../../.git");
    const ws = path.join(repo, "main");
    fs.mkdirSync(path.join(ws, ".jj"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".jj", "repo"), "../../.jj/repo");
    expect(await deriveRepoWs(ws)).toEqual({ repo: "kawaz/proj", ws: "main" });
  });

  test("jj default workspace: ws は空 (bookmark はファイルから読めない)", async () => {
    const repo = path.join(dir, "proj");
    const bare = path.join(repo, ".git");
    fs.mkdirSync(repo, { recursive: true });
    git(dir, "init", "-q", "--bare", bare);
    git(bare, "remote", "add", "origin", "https://github.com/kawaz/proj.git");
    fs.mkdirSync(path.join(repo, ".jj", "repo", "store"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".jj", "repo", "store", "git_target"), "../../../.git");
    expect(await deriveRepoWs(repo)).toEqual({ repo: "kawaz/proj", ws: "" });
  });

  test("remote が無い時は repos/<host>/<owner>/<repo> のパス規約で補う", async () => {
    const root = path.join(dir, "repos", "github.com", "kawaz", "noremote", "main");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "trunk");
    expect(await deriveRepoWs(root)).toEqual({ repo: "kawaz/noremote", ws: "trunk" });
  });

  test("remote もパス規約も無ければ repo は空のまま (捏造しない)", async () => {
    const root = path.join(dir, "plain");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    expect(await deriveRepoWs(root)).toEqual({ repo: "", ws: "main" });
  });

  test("VCS 配下でないディレクトリは両方空", async () => {
    const plain = path.join(dir, "nothing");
    fs.mkdirSync(plain);
    expect(await deriveRepoWs(plain)).toEqual({ repo: "", ws: "" });
  });

  test("存在しない cwd / 空文字も throw せず空を返す", async () => {
    expect(await deriveRepoWs("")).toEqual({ repo: "", ws: "" });
    expect(await deriveRepoWs(path.join(dir, "absent", "deep"))).toEqual({ repo: "", ws: "" });
  });
});

interface PeerLite {
  sid: string;
  repo?: string;
  ws?: string;
}

/** Session hello over a real daemon (same UDS fixture pattern as
 *  branch.test.ts), announcing only what each case is about. */
async function sessionHello(
  ctx: DaemonCtx,
  sid: string,
  fields: { cwd: string; repo?: string; ws?: string },
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "session", sid, ...fields });
  return c;
}

describe("hello の repo/ws フォールバック", () => {
  test("申告が無ければ cwd から導出した値が peers に載る", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const ctx = await startTestDaemon();
    try {
      const c = await sessionHello(ctx, "A", { cwd: root });
      const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
      const me = peers.peers.find((p) => p.sid === "A")!;
      expect({ repo: me.repo, ws: me.ws }).toEqual({ repo: "kawaz/demo", ws: "main" });
    } finally {
      await stopTestDaemon(ctx);
    }
  }, 15000);

  test("申告があればそちらが勝つ (導出はフォールバックのみ)", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const ctx = await startTestDaemon();
    try {
      const c = await sessionHello(ctx, "A", { cwd: root, repo: "declared/repo", ws: "declared" });
      const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
      const me = peers.peers.find((p) => p.sid === "A")!;
      expect({ repo: me.repo, ws: me.ws }).toEqual({ repo: "declared/repo", ws: "declared" });
    } finally {
      await stopTestDaemon(ctx);
    }
  }, 15000);

  test("VCS 配下でない cwd でも hello は成功する (fail-open)", async () => {
    const plain = path.join(dir, "plain-cwd");
    fs.mkdirSync(plain);
    const ctx = await startTestDaemon();
    try {
      const c = await sessionHello(ctx, "A", { cwd: plain });
      const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
      const me = peers.peers.find((p) => p.sid === "A")!;
      expect(me.repo ?? "").toBe("");
      expect(me.ws ?? "").toBe("");
    } finally {
      await stopTestDaemon(ctx);
    }
  }, 15000);
});

describe("remoteUrlSlug", () => {
  test("forge URL の各形から owner/repo を取る", () => {
    expect(remoteUrlSlug("git@github.com:kawaz/demo.git")).toBe("kawaz/demo");
    expect(remoteUrlSlug("https://github.com/kawaz/demo.git")).toBe("kawaz/demo");
    expect(remoteUrlSlug("https://github.com/kawaz/demo/")).toBe("kawaz/demo");
    expect(remoteUrlSlug("ssh://git@github.com:22/kawaz/demo.git")).toBe("kawaz/demo");
    expect(remoteUrlSlug("https://gitlab.com/group/sub/demo.git")).toBe("group/sub/demo");
  });

  test("ローカルパス remote は slug を持たない", () => {
    expect(remoteUrlSlug("/srv/git/demo.git")).toBe("");
    expect(remoteUrlSlug("file:///srv/git/demo.git")).toBe("");
    expect(remoteUrlSlug("C:/repo")).toBe("");
    expect(remoteUrlSlug("./sub:dir/repo")).toBe("");
    expect(remoteUrlSlug("")).toBe("");
  });
});

describe("parseGitConfigRemotes / selectRemoteUrl", () => {
  test("remote セクションの url だけを拾う", () => {
    const remotes = parseGitConfigRemotes(
      [
        "[core]",
        "\turl = ignored",
        '[remote "origin"]',
        "\turl = A",
        "\tfetch = +x",
        '[remote "up"]',
        "\turl = B",
      ].join("\n"),
    );
    expect([...remotes]).toEqual([
      ["origin", "A"],
      ["up", "B"],
    ]);
  });

  test("origin 優先、単独なら採用、origin 無しの複数は曖昧として空", () => {
    expect(
      selectRemoteUrl(
        new Map([
          ["up", "B"],
          ["origin", "A"],
        ]),
      ),
    ).toBe("A");
    expect(selectRemoteUrl(new Map([["up", "B"]]))).toBe("B");
    expect(
      selectRemoteUrl(
        new Map([
          ["up", "B"],
          ["fork", "C"],
        ]),
      ),
    ).toBe("");
    expect(selectRemoteUrl(new Map())).toBe("");
  });
});

describe("slugFromCheckoutPath", () => {
  test("repos/<host>/<owner>/<repo> を拾う", () => {
    expect(slugFromCheckoutPath("/home/u/.local/share/repos/github.com/kawaz/demo/main")).toBe(
      "kawaz/demo",
    );
  });

  test("host らしくない (ドット無し) / 段数不足なら空", () => {
    expect(slugFromCheckoutPath("/home/u/repos/local/demo")).toBe("");
    expect(slugFromCheckoutPath("/home/u/projects/demo")).toBe("");
  });
});
