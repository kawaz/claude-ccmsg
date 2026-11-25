// The sandbox grant that holds an svg's text instead of naming a file
// (DR-0067 §2, op `sandbox_grant_svg`). What it must keep is that nothing about
// the serving changes: the same origin scheme, the same four-step check, and
// response headers byte-for-byte those of a file grant for the same svg. Two
// layers, as sandbox.test.ts: the module against a fixture filesystem, then the
// real listener, where the op's role gate and the Host branch live.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FS_READ_MAX_BYTES, PROTOCOL_VERSION } from "@ccmsg/protocol";
import {
  compileSandboxOrigin,
  createSandboxGrants,
  handleSandboxRequest,
  mintSandboxGrant,
  mintSandboxSvgGrant,
  revokeSandboxGrant,
  sandboxGidFromHost,
  SANDBOX_GRANT_TTL_MS,
  type SandboxGrants,
  type SandboxOrigin,
} from "../src/sandbox.ts";
import type { SessionLookup } from "../src/fs-access.ts";
import { createSessionStatusStore } from "../src/session-status.ts";
import { connect, defined, spawnDaemonProc, waitConnectable, type TestClient } from "./helpers.ts";

const S1 = "53000000-0000-4000-8000-000000000003";
const TEMPLATE = "https://ccmsg-files-{gid}.sandbox.test";
const FRAME_ANCESTORS = ["https://ccmsg.apps.test"];
const FIGURE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>document.title="ran"</script></svg>';

// --- layer 1: mint + serve ----------------------------------------------

interface Fixture {
  root: string;
  grants: SandboxGrants;
  origin: SandboxOrigin;
  clock: { now: number };
  deps: Parameters<typeof handleSandboxRequest>[0];
  mintFile(reqPath: string): ReturnType<typeof mintSandboxGrant>;
  get(url: string, init?: RequestInit): Promise<Response>;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-sbxsvg-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  // The same svg as a file, to compare a file grant's answer with a content
  // grant's answer for the same bytes.
  fs.writeFileSync(path.join(root, "docs", "figure.svg"), FIGURE);
  const clock = { now: 2_000_000 };
  const grants = createSandboxGrants(() => clock.now);
  const origin = defined(compileSandboxOrigin(TEMPLATE), "origin");
  const sessions: SessionLookup = {
    get: (requested: string) => (requested === S1 ? { meta: { cwd: root } } : undefined),
  };
  const statusStore = createSessionStatusStore(path.join(root, "home"));
  const deps = {
    grants,
    origin,
    sessions,
    statusStore,
    frameAncestors: async () => FRAME_ANCESTORS,
  };
  return {
    root,
    grants,
    origin,
    clock,
    deps,
    mintFile: (reqPath: string) =>
      mintSandboxGrant(grants, origin, sessions, statusStore, S1, reqPath, "contained"),
    get(url: string, init?: RequestInit) {
      const gid = sandboxGidFromHost(origin, new URL(url).host);
      if (gid === null) throw new Error(`not a sandbox url: ${url}`);
      return handleSandboxRequest(deps, gid, new Request(url, init));
    },
  };
}

function headersOf(res: Response): Record<string, string> {
  return Object.fromEntries([...res.headers.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
}

describe("sandbox_grant_svg mint (DR-0067 §2)", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  test("a grant names the figure under its own origin and token, for 30 minutes", () => {
    const res = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.grant.gid).toMatch(/^[a-z2-7]+$/);
    expect(res.grant.token).toMatch(/^[a-z2-7]+$/);
    expect(res.url).toBe(
      `https://ccmsg-files-${res.grant.gid}.sandbox.test/${res.grant.token}/figure.svg`,
    );
    expect(res.grant.exp).toBe(fx.clock.now + SANDBOX_GRANT_TTL_MS);
  });

  test("every mint is a new origin, even for the same text", () => {
    const a = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    const b = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    if (!a.ok || !b.ok) throw new Error("mint failed");
    expect(b.grant.gid).not.toBe(a.grant.gid);
    expect(b.grant.token).not.toBe(a.grant.token);
    expect(fx.grants.byGid.size).toBe(2);
  });

  test("text over FS_READ_MAX_BYTES (as UTF-8 bytes) is refused and leaves no grant", () => {
    // Exactly the limit is accepted.
    const atLimit = mintSandboxSvgGrant(fx.grants, fx.origin, "a".repeat(FS_READ_MAX_BYTES));
    expect(atLimit.ok).toBe(true);
    // Under the limit in characters, over it in UTF-8 bytes (3 bytes each).
    const wide = "あ".repeat(Math.floor(FS_READ_MAX_BYTES / 3) + 1);
    expect(wide.length).toBeLessThan(FS_READ_MAX_BYTES);
    const over = mintSandboxSvgGrant(fx.grants, fx.origin, wide);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("invalid_args");
    expect(fx.grants.byGid.size).toBe(1);
  });

  test("an unconfigured origin refuses to mint", () => {
    const res = mintSandboxSvgGrant(createSandboxGrants(), null, FIGURE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("sandbox_not_configured");
  });
});

describe("sandbox_grant_svg serve (DR-0067 §2, §4)", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  test("the figure is served as image/svg+xml with exactly a file grant's headers", async () => {
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    const file = await fx.mintFile("docs/figure.svg");
    if (!svg.ok || !file.ok) throw new Error("mint failed");
    const fromText = await fx.get(svg.url);
    const fromFile = await fx.get(file.url);
    expect(fromText.status).toBe(200);
    expect(fromText.headers.get("content-type")).toBe("image/svg+xml");
    // The same svg as a file and as text: every header the same, CSP included.
    expect(headersOf(fromText)).toEqual(headersOf(fromFile));
    expect(await fromText.text()).toBe(FIGURE);
    expect(await fromFile.text()).toBe(FIGURE);
  });

  test("the download mode answers as a file grant's does", async () => {
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    const file = await fx.mintFile("docs/figure.svg");
    if (!svg.ok || !file.ok) throw new Error("mint failed");
    const fromText = await fx.get(`${svg.url}?dl=1`);
    const fromFile = await fx.get(`${file.url}?dl=1`);
    expect(fromText.status).toBe(200);
    expect(headersOf(fromText)).toEqual(headersOf(fromFile));
  });

  test("the text is non-ASCII safe: content-length counts UTF-8 bytes", async () => {
    const text = '<svg xmlns="http://www.w3.org/2000/svg"><title>図</title></svg>';
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, text);
    if (!svg.ok) throw new Error("mint failed");
    const res = await fx.get(svg.url);
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(text, "utf-8")));
    expect(await res.text()).toBe(text);
  });

  test("an unknown gid, a wrong token and any other name are 404", async () => {
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    if (!svg.ok) throw new Error("mint failed");
    const { gid, token } = svg.grant;
    const base = `https://ccmsg-files-${gid}.sandbox.test`;
    const sameLength = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    for (const url of [
      `https://ccmsg-files-zzzzzz.sandbox.test/${token}/figure.svg`,
      `${base}/${sameLength}/figure.svg`,
      `${base}/${token}/`,
      `${base}/${token}/other.svg`,
      `${base}/${token}/figure.svg/x`,
      `${base}/${token}/sub/figure.svg`,
      `${base}/${token}/../figure.svg`,
    ]) {
      const res = await fx.get(url);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("<svg");
    }
  });

  test("an expired grant is 410 Gone, then forgotten", async () => {
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    if (!svg.ok) throw new Error("mint failed");
    expect((await fx.get(svg.url)).status).toBe(200);
    fx.clock.now += SANDBOX_GRANT_TTL_MS;
    expect((await fx.get(svg.url)).status).toBe(410);
    expect(fx.grants.byGid.size).toBe(0);
    expect((await fx.get(svg.url)).status).toBe(404);
  });

  test("an expired grant is pruned by the next mint", () => {
    const first = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    if (!first.ok) throw new Error("mint failed");
    fx.clock.now += SANDBOX_GRANT_TTL_MS;
    mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    expect(fx.grants.byGid.has(first.grant.gid)).toBe(false);
    expect(fx.grants.byGid.size).toBe(1);
  });

  test("a revoked grant stops serving at once", async () => {
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    if (!svg.ok) throw new Error("mint failed");
    expect(revokeSandboxGrant(fx.grants, svg.grant.gid)).toBe(true);
    expect((await fx.get(svg.url)).status).toBe(404);
    expect(revokeSandboxGrant(fx.grants, svg.grant.gid)).toBe(false);
  });

  test("only GET/HEAD reach the figure", async () => {
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    if (!svg.ok) throw new Error("mint failed");
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await fx.get(svg.url, { method })).status).toBe(405);
    }
    const head = await fx.get(svg.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(FIGURE, "utf-8")));
    expect(await head.text()).toBe("");
  });

  test("a content grant and a file grant live side by side without touching each other", async () => {
    const file = await fx.mintFile("docs/figure.svg");
    const svg = mintSandboxSvgGrant(fx.grants, fx.origin, FIGURE);
    if (!svg.ok || !file.ok) throw new Error("mint failed");
    // Re-minting the file scope still reuses its own gid (DR-0030 §4.1.2).
    const again = await fx.mintFile("docs/figure.svg");
    if (!again.ok) throw new Error("mint failed");
    expect(again.grant.gid).toBe(file.grant.gid);
    // A content grant's token does not open the file grant's origin.
    const crossed = await fx.get(
      `https://ccmsg-files-${file.grant.gid}.sandbox.test/${svg.grant.token}/figure.svg`,
    );
    expect(crossed.status).toBe(404);
  });
});

// --- layer 2: the real listener -----------------------------------------

const ADDR = "127.0.0.1:18994";

async function startSandboxDaemon(
  config: Record<string, unknown>,
): Promise<{ base: string; sock: string; proc: Bun.Subprocess }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-sbxsvgd-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
  const proc = spawnDaemonProc(stateDir, dataDir, { CCMSG_HTTP_BIND: ADDR });
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  return { base, sock, proc };
}

async function stopSandboxDaemon(ctx: { base: string; sock: string; proc: Bun.Subprocess }) {
  try {
    const c = await connect(ctx.sock);
    await c.request({ op: "shutdown" });
    c.close();
  } catch {
    // fall back to the signal below
  }
  try {
    ctx.proc.kill();
  } catch {
    // already gone
  }
  await ctx.proc.exited;
  fs.rmSync(ctx.base, { recursive: true, force: true });
}

describe("sandbox_grant_svg on the real listener (DR-0067 §2, §4)", () => {
  let ctx: Awaited<ReturnType<typeof startSandboxDaemon>>;
  let session: TestClient;
  let user: TestClient;
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-sbxsvgroot-"));
    ctx = await startSandboxDaemon({ sandbox_origin_template: TEMPLATE });
    session = await connect(ctx.sock);
    await session.request({
      op: "hello",
      protocol: PROTOCOL_VERSION,
      role: "session",
      sid: S1,
      cwd: root,
    });
    user = await connect(ctx.sock);
    await user.hello({ role: "user" });
  });

  afterEach(async () => {
    session.close();
    user.close();
    await stopSandboxDaemon(ctx);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a user mints the figure and the listener serves it, until revoked", async () => {
    const grant = await user.requestOk({ op: "sandbox_grant_svg", content: FIGURE });
    const url = new URL(grant.url);
    expect(url.pathname).toBe(`/${grant.token}/figure.svg`);
    const res = await fetch(`http://${ADDR}${url.pathname}`, { headers: { Host: url.host } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts allow-same-origin",
    );
    expect(await res.text()).toBe(FIGURE);
    await user.requestOk({ op: "sandbox_revoke", gid: grant.gid });
    const after = await fetch(`http://${ADDR}${url.pathname}`, { headers: { Host: url.host } });
    expect(after.status).toBe(404);
  });

  test("the op is user-role only", async () => {
    const res = await session.requestError({ op: "sandbox_grant_svg", content: FIGURE });
    expect(res.ok).toBe(false);
    expect(res.error?.msg).toContain("user role");
  });

  test("text over FS_READ_MAX_BYTES is refused", async () => {
    const res = await user.requestError({
      op: "sandbox_grant_svg",
      content: "a".repeat(FS_READ_MAX_BYTES + 1),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });

  test("the figure's Host never reaches /ws, /attachment, /fs-serve or the webui", async () => {
    const grant = await user.requestOk({ op: "sandbox_grant_svg", content: FIGURE });
    const host = new URL(grant.url).host;
    for (const pathname of [
      "/ws",
      "/attachment/x.png",
      "/fs-serve",
      "/",
      "/index.html",
      `/${grant.token}/ws`,
    ]) {
      const res = await fetch(`http://${ADDR}${pathname}`, { headers: { Host: host } });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).not.toContain("text/html");
    }
    const upgrade = await fetch(`http://${ADDR}/ws`, {
      headers: {
        Host: host,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(upgrade.status).toBe(404);
  });
});

describe("sandbox_grant_svg when the sandbox origin is unconfigured (DR-0030 §7.1)", () => {
  test("the op answers sandbox_not_configured", async () => {
    const ctx = await startSandboxDaemon({});
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const res = await user.requestError({ op: "sandbox_grant_svg", content: FIGURE });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("sandbox_not_configured");
      user.close();
    } finally {
      await stopSandboxDaemon(ctx);
    }
  });
});
