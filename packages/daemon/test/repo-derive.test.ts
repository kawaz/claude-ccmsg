// Deriving a session's location facts from cwd (repo-derive.ts): repo/ws for
// hellos that announce neither, and repo_url / vcs / repository.
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
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  defined,
} from "./helpers.ts";
import {
  deriveLocation,
  parseGitConfigRemotes,
  remoteRepository,
  remoteUrlSlug,
  remoteUrlWithoutCredentials,
  remoteWebUrl,
  repositoryFromCheckoutPath,
  selectRemoteUrl,
  slugFromCheckoutPath,
  webUrlFromCheckoutPath,
} from "../src/repo-derive.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

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
      // No background maintenance: `git commit` otherwise starts a detached
      // `git maintenance run --auto` (GIT_TRACE shows it with git 2.55), a
      // process no test waits for, which could write into the fixture after
      // the test removed it.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto",
      GIT_CONFIG_VALUE_1: "0",
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

const GITHUB_DEMO = {
  host: "github.com",
  owner: "kawaz",
  name: "demo",
  url: "https://github.com/kawaz/demo",
};

/** A bare git store holding an `origin`, with a jj repo beside it whose store
 * points at it: `<repo>/.git` (bare) + `<repo>/.jj/repo/store/git_target`. */
function makeJjRepo(repo: string): void {
  const bare = path.join(repo, ".git");
  fs.mkdirSync(repo, { recursive: true });
  git(dir, "init", "-q", "--bare", bare);
  git(bare, "remote", "add", "origin", "https://github.com/kawaz/proj.git");
  const jjRepo = path.join(repo, ".jj", "repo");
  fs.mkdirSync(path.join(jjRepo, "store"), { recursive: true });
  fs.writeFileSync(path.join(jjRepo, "store", "git_target"), "../../../.git");
}

/** A secondary jj workspace `<repo>/<name>` of makeJjRepo's repo. */
function addJjWorkspace(repo: string, name: string): string {
  const ws = path.join(repo, name);
  fs.mkdirSync(path.join(ws, ".jj"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".jj", "repo"), "../../.jj/repo");
  return ws;
}

const JJ_PROJ_ORIGIN = [{ name: "origin", url: "https://github.com/kawaz/proj.git" }];
const JJ_PROJ = {
  host: "github.com",
  owner: "kawaz",
  name: "proj",
  url: "https://github.com/kawaz/proj",
};

describe("deriveLocation", () => {
  test("git 通常リポ: repo は origin slug、ws は HEAD のブランチ、vcs は workspace 無しで branch と remote", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    expect(await deriveLocation(root)).toEqual({
      repo: "kawaz/demo",
      ws: "main",
      repo_url: "https://github.com/kawaz/demo",
      vcs: {
        type: "git",
        branch: "main",
        remotes: [{ name: "origin", url: "git@github.com:kawaz/demo.git" }],
      },
      repository: GITHUB_DEMO,
    });
  });

  test("git: サブディレクトリからでも上方向探索で同じ結果", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const sub = path.join(root, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    expect(await deriveLocation(sub)).toEqual({
      repo: "kawaz/demo",
      ws: "main",
      repo_url: "https://github.com/kawaz/demo",
      vcs: {
        type: "git",
        branch: "main",
        remotes: [{ name: "origin", url: "git@github.com:kawaz/demo.git" }],
      },
      repository: GITHUB_DEMO,
    });
  });

  test("git linked worktree: ws と vcs.workspace は worktree ディレクトリ名、vcs.branch は worktree の HEAD", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const wt = path.join(dir, "demo-pr1");
    git(root, "worktree", "add", "-q", "-b", "feature", wt);
    expect(await deriveLocation(wt)).toEqual({
      repo: "kawaz/demo",
      ws: "demo-pr1",
      repo_url: "https://github.com/kawaz/demo",
      vcs: {
        type: "git",
        workspace: "demo-pr1",
        branch: "feature",
        remotes: [{ name: "origin", url: "git@github.com:kawaz/demo.git" }],
      },
      repository: GITHUB_DEMO,
    });
  });

  test("git detached HEAD: vcs.branch は無い", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    git(root, "checkout", "-q", "--detach");
    const got = await deriveLocation(root);
    expect(got.vcs).toEqual({
      type: "git",
      remotes: [{ name: "origin", url: "git@github.com:kawaz/demo.git" }],
    });
  });

  test("jj secondary workspace (bare git + .jj): ws と vcs.workspace は workspace ディレクトリ名", async () => {
    const repo = path.join(dir, "proj");
    makeJjRepo(repo);
    const ws = addJjWorkspace(repo, "main");
    expect(await deriveLocation(ws)).toEqual({
      repo: "kawaz/proj",
      ws: "main",
      repo_url: "https://github.com/kawaz/proj",
      vcs: { type: "jj", workspace: "main", remotes: JJ_PROJ_ORIGIN },
      repository: JJ_PROJ,
    });
  });

  test("jj default workspace: ws は空、vcs に workspace も branch も無い (bookmark はファイルから読めない)", async () => {
    const repo = path.join(dir, "proj");
    makeJjRepo(repo);
    expect(await deriveLocation(repo)).toEqual({
      repo: "kawaz/proj",
      ws: "",
      repo_url: "https://github.com/kawaz/proj",
      vcs: { type: "jj", remotes: JJ_PROJ_ORIGIN },
      repository: JJ_PROJ,
    });
  });

  test("GitLab の多段の owner: repository は最後の段が name、その前が owner", async () => {
    const root = makeGitRepo(path.join(dir, "gl"), "git@gitlab.com:group/sub/gl.git");
    expect(await deriveLocation(root)).toEqual({
      repo: "group/sub/gl",
      ws: "main",
      repo_url: "https://gitlab.com/group/sub/gl",
      vcs: {
        type: "git",
        branch: "main",
        remotes: [{ name: "origin", url: "git@gitlab.com:group/sub/gl.git" }],
      },
      repository: {
        host: "gitlab.com",
        owner: "group/sub",
        name: "gl",
        url: "https://gitlab.com/group/sub/gl",
      },
    });
  });

  test("remote が複数: vcs.remotes は設定の順に全部、認証情報は落とし、repository は origin から", async () => {
    const root = makeGitRepo(
      path.join(dir, "app"),
      "https://someone:s3cr3t-token@git.example.com:8443/team/app.git",
    );
    git(root, "remote", "add", "upstream", "ssh://git:hunter2@git.example.org:2222/team/app.git");
    git(root, "remote", "add", "fork", "git@github.com:me/app.git");
    const got = await deriveLocation(root);
    expect(got).toEqual({
      repo: "team/app",
      ws: "main",
      repo_url: "https://git.example.com:8443/team/app",
      vcs: {
        type: "git",
        branch: "main",
        remotes: [
          { name: "origin", url: "https://git.example.com:8443/team/app.git" },
          { name: "upstream", url: "ssh://git@git.example.org:2222/team/app.git" },
          { name: "fork", url: "git@github.com:me/app.git" },
        ],
      },
      repository: {
        host: "git.example.com",
        owner: "team",
        name: "app",
        url: "https://git.example.com:8443/team/app",
      },
    });
    const text = JSON.stringify(got);
    expect(text).not.toContain("s3cr3t-token");
    expect(text).not.toContain("someone");
    expect(text).not.toContain("hunter2");
  });

  test("origin の無い複数の remote: 全部載るが、どれの repository かは決めない", async () => {
    const root = path.join(dir, "two");
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "up", "git@github.com:kawaz/two.git");
    git(root, "remote", "add", "fork", "git@github.com:me/two.git");
    expect(await deriveLocation(root)).toEqual({
      repo: "",
      ws: "main",
      repo_url: "",
      vcs: {
        type: "git",
        branch: "main",
        remotes: [
          { name: "up", url: "git@github.com:kawaz/two.git" },
          { name: "fork", url: "git@github.com:me/two.git" },
        ],
      },
    });
  });

  test("remote が無い時は repos/<host>/<owner>/<repo> のパス規約で補い、vcs.remotes は空", async () => {
    const root = path.join(dir, "repos", "github.com", "kawaz", "noremote", "main");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "trunk");
    expect(await deriveLocation(root)).toEqual({
      repo: "kawaz/noremote",
      ws: "trunk",
      repo_url: "https://github.com/kawaz/noremote",
      vcs: { type: "git", branch: "trunk", remotes: [] },
      repository: {
        host: "github.com",
        owner: "kawaz",
        name: "noremote",
        url: "https://github.com/kawaz/noremote",
      },
    });
  });

  test("remote もパス規約も無ければ repo は空、repository は無い (捏造しない)", async () => {
    const root = path.join(dir, "plain");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    expect(await deriveLocation(root)).toEqual({
      repo: "",
      ws: "main",
      repo_url: "",
      vcs: { type: "git", branch: "main", remotes: [] },
    });
  });

  test("VCS 配下でないディレクトリは vcs ごと無い", async () => {
    const plain = path.join(dir, "nothing");
    fs.mkdirSync(plain);
    expect(await deriveLocation(plain)).toEqual({ repo: "", ws: "", repo_url: "" });
  });

  test("存在しない cwd / 空文字も throw せず空を返す", async () => {
    expect(await deriveLocation("")).toEqual({ repo: "", ws: "", repo_url: "" });
    expect(await deriveLocation(path.join(dir, "absent", "deep"))).toEqual({
      repo: "",
      ws: "",
      repo_url: "",
    });
  });
});

const A = "aaaaaaaa-0000-4000-8000-000000000001";

/** Session hello over a real daemon (same UDS fixture pattern as
 *  branch.test.ts), announcing only what each case is about. */
async function sessionHello(
  ctx: InProcessDaemon,
  sid: string,
  fields: { cwd: string; repo?: string; ws?: string; branch?: string },
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "session", protocol: PROTOCOL_VERSION, sid, ...fields });
  return c;
}

describe("hello の repo/ws フォールバック", () => {
  test("申告が無ければ cwd から導出した値が peers に載る", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionHello(ctx, A, { cwd: root });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect({ repo: me.repo, ws: me.ws }).toEqual({ repo: "kawaz/demo", ws: "main" });
      expect(me.repo_url).toBe("https://github.com/kawaz/demo");
      expect(me.vcs).toEqual({
        type: "git",
        branch: "main",
        remotes: [{ name: "origin", url: "git@github.com:kawaz/demo.git" }],
      });
      expect(me.repository).toEqual(GITHUB_DEMO);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  }, 15000);

  test("申告があればそちらが勝つ (導出はフォールバックのみ)", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionHello(ctx, A, { cwd: root, repo: "declared/repo", ws: "declared" });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect({ repo: me.repo, ws: me.ws }).toEqual({ repo: "declared/repo", ws: "declared" });
      // repo_url is never announced: the cwd's remote gives it even here.
      expect(me.repo_url).toBe("https://github.com/kawaz/demo");
      // Nor are repository and vcs (the announced ws is not a workspace).
      expect(me.repository).toEqual(GITHUB_DEMO);
      expect(me.vcs).toEqual({
        type: "git",
        branch: "main",
        remotes: [{ name: "origin", url: "git@github.com:kawaz/demo.git" }],
      });
    } finally {
      await stopInProcessDaemon(ctx);
    }
  }, 15000);

  test("申告された branch は vcs.branch にも勝つ (jj の bookmark はそれしか源が無い)", async () => {
    const repo = path.join(dir, "proj");
    makeJjRepo(repo);
    const ws = addJjWorkspace(repo, "stage1");
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionHello(ctx, A, { cwd: ws, branch: "feature-x" });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.vcs).toEqual({
        type: "jj",
        workspace: "stage1",
        branch: "feature-x",
        remotes: JJ_PROJ_ORIGIN,
      });
      expect(me.branch).toBe("feature-x");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  }, 15000);

  test("cwd を名乗らない hello は vcs / repository も保つ", async () => {
    const root = makeGitRepo(path.join(dir, "demo"));
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionHello(ctx, A, { cwd: root });
      await c.request({
        op: "hello",
        role: "session",
        protocol: PROTOCOL_VERSION,
        sid: A,
        cwd: "",
      });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.vcs?.type).toBe("git");
      expect(me.repository).toEqual(GITHUB_DEMO);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  }, 15000);

  test("VCS 配下でない cwd でも hello は成功する (fail-open)", async () => {
    const plain = path.join(dir, "plain-cwd");
    fs.mkdirSync(plain);
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionHello(ctx, A, { cwd: plain });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.repo ?? "").toBe("");
      expect(me.ws ?? "").toBe("");
      expect(me.repo_url).toBeUndefined();
      expect(me.vcs).toBeUndefined();
      expect(me.repository).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
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

describe("remoteWebUrl", () => {
  test("forge を問わず https://<host>/<path> にする", () => {
    expect(remoteWebUrl("git@github.com:kawaz/demo.git")).toBe("https://github.com/kawaz/demo");
    expect(remoteWebUrl("https://github.com/kawaz/demo/")).toBe("https://github.com/kawaz/demo");
    expect(remoteWebUrl("git@gitlab.com:group/sub/demo.git")).toBe(
      "https://gitlab.com/group/sub/demo",
    );
    expect(remoteWebUrl("git@bitbucket.org:team/demo.git")).toBe("https://bitbucket.org/team/demo");
    expect(remoteWebUrl("git://example.org/demo.git")).toBe("https://example.org/demo");
  });

  test("ssh の port は落とし、http(s) の scheme と port は残す", () => {
    expect(remoteWebUrl("ssh://git@github.com:22/kawaz/demo.git")).toBe(
      "https://github.com/kawaz/demo",
    );
    expect(remoteWebUrl("http://git.local:8080/team/demo.git")).toBe(
      "http://git.local:8080/team/demo",
    );
  });

  test("URL の認証情報は出さない", () => {
    expect(remoteWebUrl("https://user:secret@github.com/kawaz/demo.git")).toBe(
      "https://github.com/kawaz/demo",
    );
    expect(remoteWebUrl("https://ghp_token@github.com/kawaz/demo.git")).toBe(
      "https://github.com/kawaz/demo",
    );
  });

  test("ssh config の host の別名はそのまま", () => {
    expect(remoteWebUrl("git@github.com-work:team/demo.git")).toBe(
      "https://github.com-work/team/demo",
    );
  });

  test("ローカルパス remote・path の無い remote は空", () => {
    expect(remoteWebUrl("/srv/git/demo.git")).toBe("");
    expect(remoteWebUrl("file:///srv/git/demo.git")).toBe("");
    expect(remoteWebUrl("C:/repo")).toBe("");
    expect(remoteWebUrl("./sub:dir/repo")).toBe("");
    expect(remoteWebUrl("https://github.com/")).toBe("");
    expect(remoteWebUrl("")).toBe("");
  });
});

describe("webUrlFromCheckoutPath", () => {
  test("repos/<host>/<owner>/<repo> をそのページにする", () => {
    expect(webUrlFromCheckoutPath("/home/u/.local/share/repos/gitlab.com/g/demo/main")).toBe(
      "https://gitlab.com/g/demo",
    );
  });

  test("host らしくない / 段数不足なら空", () => {
    expect(webUrlFromCheckoutPath("/home/u/repos/local/demo")).toBe("");
    expect(webUrlFromCheckoutPath("/home/u/projects/demo")).toBe("");
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

describe("remoteRepository", () => {
  test("GitHub の scp 形式・https・ssh:// (port 付き) から host / owner / name / url", () => {
    for (const url of [
      "git@github.com:kawaz/demo.git",
      "https://github.com/kawaz/demo.git",
      "ssh://git@github.com:22/kawaz/demo.git",
    ]) {
      expect(remoteRepository(url)).toEqual(GITHUB_DEMO);
    }
  });

  test("owner が多段なら最後の段が name、その前が owner", () => {
    expect(remoteRepository("https://gitlab.com/group/sub/demo.git")).toEqual({
      host: "gitlab.com",
      owner: "group/sub",
      name: "demo",
      url: "https://gitlab.com/group/sub/demo",
    });
  });

  test("GitHub 以外の host: Bitbucket、http の自前 forge (host に port は入れず url には残す)", () => {
    expect(remoteRepository("git@bitbucket.org:team/demo.git")).toEqual({
      host: "bitbucket.org",
      owner: "team",
      name: "demo",
      url: "https://bitbucket.org/team/demo",
    });
    expect(remoteRepository("http://git.local:8080/team/demo.git")).toEqual({
      host: "git.local",
      owner: "team",
      name: "demo",
      url: "http://git.local:8080/team/demo",
    });
  });

  test("ssh config の host の別名はそのまま host になる", () => {
    expect(remoteRepository("git@github.com-work:team/demo.git")?.host).toBe("github.com-work");
  });

  test("URL の認証情報は repository に出ない", () => {
    expect(remoteRepository("https://user:secret@github.com/kawaz/demo.git")).toEqual(GITHUB_DEMO);
  });

  test("owner の段が無い・ローカルパス・path の無い remote は undefined", () => {
    expect(remoteRepository("git@example.org:demo.git")).toBeUndefined();
    expect(remoteRepository("/srv/git/demo.git")).toBeUndefined();
    expect(remoteRepository("file:///srv/git/demo.git")).toBeUndefined();
    expect(remoteRepository("https://github.com/")).toBeUndefined();
    expect(remoteRepository("")).toBeUndefined();
  });
});

describe("remoteUrlWithoutCredentials", () => {
  test("http(s) の userinfo は丸ごと落とす (token だけの user も)", () => {
    expect(remoteUrlWithoutCredentials("https://user:secret@github.com/kawaz/demo.git")).toBe(
      "https://github.com/kawaz/demo.git",
    );
    expect(remoteUrlWithoutCredentials("https://ghp_token@github.com/kawaz/demo.git")).toBe(
      "https://github.com/kawaz/demo.git",
    );
    expect(remoteUrlWithoutCredentials("http://u:p@git.local:8080/team/demo.git")).toBe(
      "http://git.local:8080/team/demo.git",
    );
  });

  test("ssh の scheme は user 名を残し password だけ落とす", () => {
    expect(remoteUrlWithoutCredentials("ssh://git@github.com:22/kawaz/demo.git")).toBe(
      "ssh://git@github.com:22/kawaz/demo.git",
    );
    expect(remoteUrlWithoutCredentials("ssh://git:pw@github.com/kawaz/demo.git")).toBe(
      "ssh://git@github.com/kawaz/demo.git",
    );
    expect(remoteUrlWithoutCredentials("git+ssh://me:pw@host.example/r.git")).toBe(
      "git+ssh://me@host.example/r.git",
    );
  });

  test("scp 形式・ローカルパス・userinfo の無い URL はそのまま", () => {
    for (const url of [
      "git@github.com:kawaz/demo.git",
      "/srv/git/demo.git",
      "file:///srv/git/demo.git",
      "https://github.com/kawaz/demo.git",
      // An `@` past the authority is part of the path, not a userinfo.
      "https://example.org/team/demo@v2.git",
    ]) {
      expect(remoteUrlWithoutCredentials(url)).toBe(url);
    }
  });
});

describe("repositoryFromCheckoutPath", () => {
  test("repos/<host>/<owner>/<repo> を repository にする", () => {
    expect(repositoryFromCheckoutPath("/home/u/.local/share/repos/gitlab.com/g/demo/main")).toEqual(
      {
        host: "gitlab.com",
        owner: "g",
        name: "demo",
        url: "https://gitlab.com/g/demo",
      },
    );
  });

  test("host らしくない / 段数不足なら undefined", () => {
    expect(repositoryFromCheckoutPath("/home/u/repos/local/demo")).toBeUndefined();
    expect(repositoryFromCheckoutPath("/home/u/projects/demo")).toBeUndefined();
  });
});
