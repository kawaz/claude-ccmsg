// What the webui's real-browser tests (`just e2e`) share: an isolated daemon
// serving the webui, the browsers they run in, and sessions put into the page
// without a Claude Code session behind them.
//
// The daemon is a test daemon (packages/daemon/test/helpers.ts's
// spawnDaemonProc): its state, config and data dirs and its HOME are under the
// run's temp dir, and it listens for HTTP on an ephemeral loopback port. Where
// its UNIX sockets go is decided in one place, `socketDir` below.
//
// The sessions the list shows are written into the daemon's `peers` frames on
// their way to the page (Playwright's WebSocket routing): the daemon itself has
// none, so nothing a test does can reach a session someone is using.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import { jsonText, parseWith, PeerInfoSchema, type PeerInfo } from "@ccmsg/protocol";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import type { CcmsgConfig } from "../../daemon/src/config.ts";
import {
  daemonLogAfterStart,
  spawnDaemonProc,
  stopTestDaemon,
  testConfigDir,
  testHomeEnv,
  waitConnectable,
  type DaemonCtx,
} from "../../daemon/test/helpers.ts";

/** The browsers every e2e test runs in. */
export const BROWSERS: readonly BrowserType[] = [chromium, webkit];

/** How long one e2e test may take: a browser's first page load includes the
 * daemon's serve-time build of the webui (seconds), far past the preload's
 * default timeout for unit tests. */
export const E2E_TIMEOUT_MS = 60_000;

export interface Webui {
  /** The webui's page, `http://127.0.0.1:<port>/`. */
  url: string;
  /** The daemon's UNIX socket, for a test that says hello to it as a
   * session of its own. */
  sock: string;
  /** The daemon's HOME, under which a test puts a config dir of its own
   * (`<home>/.claude-…`). */
  home: string;
  stop: () => Promise<void>;
}

/** The daemon's line for an HTTP listener (`http listening on 127.0.0.1:<port>`),
 * not the op socket's (`op http listening on /…/http.sock`). */
const HTTP_LISTENING = /\bhttp listening on (\d\S*)/;

/** A directory to give a process that binds UNIX sockets in it, standing for
 * `realDir`, and what to call when the process is done with it. The one place
 * where the e2e run decides the paths of the sockets its code binds.
 *
 * Design rationale: `sun_path` holds 104 bytes on macOS, and the run's temp dir
 * can be deep, so the daemon is not handed `realDir` itself: it is handed a
 * short symlink to it under /tmp (a sticky dir), and the socket files land in
 * `realDir` through it (reference `unix-socket-path`, "開く側が長いパスを扱えない
 * 時"). The symlink's name is random, so runs side by side never meet. A
 * TypeScript version of sockat would take this function's place. */
export function socketDir(realDir: string): { dir: string; release: () => void } {
  const link = path.join("/tmp", `ccmsg-e2e-sock.${Math.random().toString(36).slice(2, 10)}`);
  fs.symlinkSync(realDir, link);
  return {
    dir: link,
    release: () => {
      fs.rmSync(link, { force: true });
    },
  };
}

/** A test daemon serving the webui on an ephemeral loopback port, for the
 * tests of one file (its `stop` in the file's afterAll, after the browsers
 * have closed). `config` is the daemon's configuration (`config.json`), none
 * when left out. */
export async function startWebui(options: { config?: CcmsgConfig } = {}): Promise<Webui> {
  // Playwright's own UNIX sockets (a browser server, its CLI's daemon) go under
  // PWTEST_SOCKETS_DIR, else under the temp dir, and it refuses a dir too deep
  // for sun_path. A launched browser talks over pipes and makes none; a short
  // dir directly under /tmp keeps any it makes within the limit whatever
  // TMPDIR is. Playwright binds these itself, so they are not socketDir's.
  const playwrightSockets = shortTmpDir("ccmsg-e2e-pw-");
  process.env.PWTEST_SOCKETS_DIR = playwrightSockets;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-e2e-"));
  const realStateDir = path.join(base, "state");
  const dataDir = path.join(base, "data");
  fs.mkdirSync(realStateDir);
  fs.mkdirSync(dataDir);
  if (options.config !== undefined) {
    const configDir = testConfigDir(dataDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(options.config));
  }
  const sockets = socketDir(realStateDir);
  const env = {
    CCMSG_HTTP_BIND: "127.0.0.1:0",
    // No tailscale: the daemon asks it about the bound ports at start.
    CCMSG_TAILSCALE_BIN: "/nonexistent/no-tailscale-for-e2e",
  };
  const ctx: DaemonCtx = {
    base,
    stateDir: sockets.dir,
    configDir: testConfigDir(dataDir),
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock: path.join(sockets.dir, "daemon.sock"),
    proc: spawnDaemonProc(sockets.dir, dataDir, env),
    env,
  };
  const stop = async (): Promise<void> => {
    // The daemon is asked to shut down through the symlink, so it goes after;
    // stopTestDaemon also removes `base` (the real dirs).
    await stopTestDaemon(ctx);
    sockets.release();
    delete process.env.PWTEST_SOCKETS_DIR;
    fs.rmSync(playwrightSockets, { recursive: true, force: true });
  };
  try {
    await waitConnectable(ctx.sock);
    const address = HTTP_LISTENING.exec(await daemonLogAfterStart(ctx))?.[1];
    if (address === undefined) throw new Error("the daemon did not say where it listens for HTTP");
    return { url: `http://${address}/`, sock: ctx.sock, home: testHomeEnv(dataDir).HOME, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A session in the list: `repo` is `owner/name`, or "" for one with no
 * repository. Each gets its own sid and workspace. */
export function fixturePeers(sessions: readonly { repo: string; ws: string }[]): PeerInfo[] {
  const at = Date.parse("2026-11-21T03:00:00.000Z");
  return sessions.map(({ repo, ws }, i) => {
    const sid = `e2e00000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const time = new Date(at - i * 60_000).toISOString();
    const cut = repo.lastIndexOf("/");
    const base: PeerInfo = {
      sid,
      cwd: `/e2e/${repo === "" ? sid : repo}/${ws}`,
      connected_at: time,
      last_activity_at: time,
      last_user_input_at: time,
      transcript_path: `/e2e/${sid}.jsonl`,
    };
    if (repo === "") return base;
    const owner = repo.slice(0, cut);
    const name = repo.slice(cut + 1);
    return {
      ...base,
      repository: { host: "github.com", owner, name, url: `https://github.com/${repo}` },
      vcs: { type: "jj", workspace: ws, remotes: [] },
    };
  });
}

/** A line of the daemon's that carries the session list: the `peers` reply
 * and the `ev:"peers"` push. Everything else in the line is kept as is. */
const PeersLineSchema = jsonText(v.looseObject({ peers: v.array(PeerInfoSchema) }));

/** Routes the page's WebSocket to the daemon, adding `peers` to every session
 * list on its way to the page. Call before the page loads the webui. */
export async function routePeers(page: Page, peers: readonly PeerInfo[]): Promise<void> {
  const withPeers = (text: string): string =>
    text
      .split("\n")
      .map((line) => {
        const read = parseWith(PeersLineSchema, line);
        return read.ok
          ? JSON.stringify({ ...read.value, peers: [...read.value.peers, ...peers] })
          : line;
      })
      .join("\n");
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) =>
      ws.send(typeof message === "string" ? withPeers(message) : message),
    );
  });
}
