// Wire integration for DR-0018: user-role authorization and real
// session_launch execution over a daemon/UDS connection.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  connect,
  spawnDaemonProc,
  testConfigDir,
  startTestDaemon,
  stopTestDaemon,
  waitConnectable,
  type DaemonCtx,
} from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

const T = 15000;

async function startConfiguredDaemon(
  root: string,
  command = "printf configured",
): Promise<DaemonCtx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-integration-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(testConfigDir(dataDir));
  fs.writeFileSync(
    path.join(testConfigDir(dataDir), "config.json"),
    JSON.stringify({
      session_launcher: {
        root_dirs: [root],
        shell: "bash",
        templates: [
          {
            name: "default",
            command,
            params: { CWD: "", MODEL: "", EFFORT: "", PROMPT: "" },
          },
        ],
      },
    }),
  );
  const env = {
    CCMSG_STATE_DIR: stateDir,
    CCMSG_CONFIG_DIR: testConfigDir(dataDir),
    CCMSG_DATA_DIR: dataDir,
    CCMSG_HTTP_BIND: "off",
  };
  const proc = spawnDaemonProc(stateDir, dataDir);
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  return {
    base,
    stateDir,
    configDir: testConfigDir(dataDir),
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock,
    proc,
    env,
  };
}

describe("session launcher wire ops", () => {
  // All three launcher ops expose host filesystem/command-launching surfaces
  // (or, for session_launcher_config, the config values that feed those
  // surfaces) intended only for the human webui identity, so a session
  // identity is rejected equally.
  test(
    "session role cannot call dir_tree, session_launch, or session_launcher_config",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const ctx = await startConfiguredDaemon(root);
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "session", sid: "A", cwd: root });

        for (const req of [
          { op: "dir_tree", roots: [root] },
          { op: "session_launch", cwd: root, params: { PROMPT: "p" } },
          { op: "session_launcher_config" },
        ]) {
          const response = await client.request<{ ok: false; error: { code: string } }>(req);
          expect(response.ok).toBe(false);
          expect(response.error.code).toBe("bad_request");
        }
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // One correlated reply carries the executed command's real streams and
  // non-zero exit status, once the run finishes.
  test(
    "user role receives the executed result as one correlated reply",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const ctx = await startConfiguredDaemon(
        root,
        `printf 'model=%s;effort=%s;prompt=%s' "$MODEL" "$EFFORT" "$PROMPT"; ` +
          `printf 'cwd=%s' "$CWD" >&2; exit 9`,
      );
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        const reply = await client.request<Record<string, unknown>>({
          op: "session_launch",
          request_id: "launch-1",
          cwd: root,
          params: { MODEL: "wire-model", EFFORT: "wire-effort", PROMPT: "wire-prompt" },
        });
        expect(reply).toEqual({
          ok: true,
          stdout: "model=wire-model;effort=wire-effort;prompt=wire-prompt",
          stderr: `cwd=${fs.realpathSync(root)}`,
          exit_code: 9,
          timed_out: false,
        });
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // A missing/empty request_id is refused before dispatch (a reply could not
  // be paired with anything), so no command is executed.
  test(
    "session_launch without a request_id is rejected with bad_request",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const ctx = await startConfiguredDaemon(root);
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        const response = await client.requestRaw<{ ok: false; error: { code: string } }>({
          op: "session_launch",
          cwd: root,
          params: { PROMPT: "p" },
        });
        expect(response.ok).toBe(false);
        expect(response.error.code).toBe("bad_request");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // THE regression correlated replies fix (kawaz r26 mid=108): a slow launch
  // used to hold back every later reply on the same connection (the webui's
  // single WS connection stalled all panes). The ping reply must come back
  // IMMEDIATELY — i.e. before the slow command finishes — and the launch's own
  // reply arrives after it.
  test(
    "a later op's reply arrives before a slow session_launch's reply",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      // The command is slow enough (200ms) that the ping reply arriving before
      // the result event proves the connection was not gated on the launch.
      const ctx = await startConfiguredDaemon(root, "sleep 0.2; printf slow-done");
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        client.write({
          op: "session_launch",
          request_id: "slow-launch",
          cwd: root,
          params: { PROMPT: "p" },
        });
        client.write({ op: "ping", request_id: "slow-ping" });

        const first = JSON.parse((await client.readLine())!) as Record<string, unknown>;
        const second = JSON.parse((await client.readLine())!) as Record<string, unknown>;
        expect(first).toMatchObject({ ok: true, pong: true, request_id: "slow-ping" });
        expect(second).toMatchObject({
          request_id: "slow-launch",
          ok: true,
          stdout: "slow-done",
          exit_code: 0,
        });
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // Installs that predate the config/ split still have their config.json in
  // data/; the daemon moves it on startup, so the launcher they configured
  // keeps working across the upgrade with no user action.
  test("a config.json left in the legacy data dir is migrated and takes effect", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-legacy-"));
    const stateDir = path.join(base, "s");
    const dataDir = path.join(base, "d");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(dataDir);
    const legacy = path.join(dataDir, "config.json");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        session_launcher: {
          root_dirs: [root],
          shell: "bash",
          templates: [{ name: "default", command: "printf legacy", params: { CWD: "" } }],
        },
      }),
    );
    const proc = spawnDaemonProc(stateDir, dataDir);
    const sock = path.join(stateDir, "daemon.sock");
    await waitConnectable(sock);
    try {
      const client = await connect(sock);
      await client.hello({ role: "user" });
      const response = await client.request<{ ok: true; root_dirs: string[] }>({
        op: "session_launcher_config",
      });
      expect(response.ok).toBe(true);
      if (response.ok) expect(response.root_dirs).toEqual([path.resolve(root)]);
      client.close();
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(path.join(testConfigDir(dataDir), "config.json"))).toBe(true);
    } finally {
      proc.kill();
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  // LN-Q4 makes config a startup snapshot: editing config.json cannot silently
  // widen or replace launcher roots until an explicit daemon restart.
  test(
    "config changes are not reloaded while the daemon is running",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const replacement = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-replacement-"));
      const ctx = await startConfiguredDaemon(root);
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        fs.writeFileSync(
          path.join(ctx.configDir, "config.json"),
          JSON.stringify({
            session_launcher: {
              root_dirs: [replacement],
              shell: "bash",
              command: "replacement",
            },
          }),
        );

        const original = await client.request<{ ok: boolean }>({
          op: "dir_tree",
          roots: [root],
          depth: 1,
        });
        expect(original.ok).toBe(true);
        const newlyWritten = await client.request<{ ok: false; error: { code: string } }>({
          op: "dir_tree",
          roots: [replacement],
          depth: 1,
        });
        expect(newlyWritten.error.code).toBe("path_forbidden");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(replacement, { recursive: true, force: true });
      }
    },
    T,
  );

  // The webui's SessionCreator/CwdTree need root_dirs (initial dir_tree fetch)
  // and the templates' parameter declarations (which ARE the form) before the
  // user has picked anything — session_launcher_config is the read-only projection that fills
  // that gap (see its protocol doc comment).
  test(
    "user role receives root_dirs and the template list",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-integration-"));
      const stateDir = path.join(base, "s");
      const dataDir = path.join(base, "d");
      fs.mkdirSync(stateDir);
      fs.mkdirSync(dataDir);
      fs.mkdirSync(testConfigDir(dataDir));
      fs.writeFileSync(
        path.join(testConfigDir(dataDir), "config.json"),
        JSON.stringify({
          session_launcher: {
            root_dirs: [root],
            shell: "bash",
            templates: [
              {
                name: "new",
                command: "printf configured",
                params: { CWD: "", PROMPT: "hello default" },
              },
            ],
          },
        }),
      );
      const proc = spawnDaemonProc(stateDir, dataDir);
      const sock = path.join(stateDir, "daemon.sock");
      await waitConnectable(sock);
      const ctx: DaemonCtx = {
        base,
        stateDir,
        configDir: testConfigDir(dataDir),
        dataDir,
        roomsDir: path.join(dataDir, "rooms"),
        sock,
        proc,
        env: {
          CCMSG_STATE_DIR: stateDir,
          CCMSG_CONFIG_DIR: testConfigDir(dataDir),
          CCMSG_DATA_DIR: dataDir,
          CCMSG_HTTP_BIND: "off",
        },
      };
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        const response = await client.request<{
          ok: true;
          root_dirs: string[];
          templates: {
            name: string;
            command: string;
            params: { name: string; default: string }[];
          }[];
        }>({ op: "session_launcher_config" });
        expect(response.ok).toBe(true);
        // DR-0018 §3.2 addendum 2026-07-17: the raw command template is part
        // of the read-only projection (webui uses it as SessionCreator's
        // textarea initial value + "default" button target), alongside the
        // parameter declaration the form renders from.
        expect(response).toMatchObject({
          templates: [
            {
              name: "new",
              command: "printf configured",
              params: [
                { name: "CWD", default: "" },
                { name: "PROMPT", default: "hello default" },
              ],
            },
          ],
        });
        if (response.ok) expect(response.root_dirs).toEqual([path.resolve(root)]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "an unconfigured launcher returns launcher_not_configured for session_launcher_config",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        const response = await client.request<{ ok: false; error: { code: string; msg: string } }>({
          op: "session_launcher_config",
        });
        expect(response).toEqual({
          ok: false,
          error: { code: "launcher_not_configured", msg: "session launcher is not configured" },
        });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // hello の fork_available は「launcher があるか」だけを見る。fork は
  // launcher テンプレの起動そのものなので、未設定 daemon で導線を出しても
  // 押した先は上のテストの launcher_not_configured にしかならない。
  test(
    "hello reports fork_available only where a launcher is configured",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const configured = await startConfiguredDaemon(root);
      try {
        const client = await connect(configured.sock);
        const hello = await client.request<{ fork_available?: boolean }>({
          op: "hello",
          protocol: PROTOCOL_VERSION,
          role: "user",
        });
        expect(hello.fork_available).toBe(true);
      } finally {
        await stopTestDaemon(configured);
      }

      const bare = await startTestDaemon();
      try {
        const client = await connect(bare.sock);
        const hello = await client.request<{ fork_available?: boolean }>({
          op: "hello",
          protocol: PROTOCOL_VERSION,
          role: "user",
        });
        expect(hello.fork_available).toBeUndefined();
      } finally {
        await stopTestDaemon(bare);
      }
    },
    T,
  );
});
