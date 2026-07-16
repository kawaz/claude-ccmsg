// Wire integration for DR-0018: user-role authorization and real
// session_launch execution over a daemon/UDS connection.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  connect,
  spawnDaemonProc,
  stopTestDaemon,
  waitConnectable,
  type DaemonCtx,
} from "./helpers.ts";

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
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      session_launcher: {
        root_dirs: [root],
        shell: "bash",
        command,
      },
    }),
  );
  const env = {
    CCMSG_STATE_DIR: stateDir,
    CCMSG_DATA_DIR: dataDir,
    CCMSG_HTTP_BIND: "off",
  };
  const proc = spawnDaemonProc(stateDir, dataDir);
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  return { base, stateDir, dataDir, roomsDir: path.join(dataDir, "rooms"), sock, proc, env };
}

describe("session launcher wire ops", () => {
  // Both launcher ops expose host filesystem/command-launching surfaces intended
  // only for the human webui identity, so a session identity is rejected equally.
  test(
    "session role cannot call dir_tree or session_launch",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const ctx = await startConfiguredDaemon(root);
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "session", sid: "A", cwd: root });

        for (const req of [
          { op: "dir_tree", roots: [root] },
          { op: "session_launch", cwd: root, model: "m", effort: "e", prompt: "p" },
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

  // The wire op awaits the configured command and returns its real streams and
  // non-zero exit status as one session_launch response.
  test(
    "user role receives the executed session_launch result",
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
        const response = await client.request<{
          ok: true;
          stdout: string;
          stderr: string;
          exit_code: number | null;
          timed_out: boolean;
        }>({
          op: "session_launch",
          cwd: root,
          model: "wire-model",
          effort: "wire-effort",
          prompt: "wire-prompt",
        });

        expect(response).toEqual({
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

  // The wire protocol has no request ids: every client (webui ws.ts, cli
  // client.ts, TestClient here) pairs replies to requests by arrival order.
  // session_launch is the only deferred reply in the daemon, so while one is
  // in flight the SAME connection's later requests must not have their replies
  // overtake it — otherwise the client would hand the ping reply to the
  // session_launch caller and vice versa. Send launch + ping back-to-back and
  // assert the replies come back in request order.
  test(
    "a reply to a later op never overtakes an in-flight session_launch reply",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      // The command is slow enough (200ms) that the ping would easily win a
      // race if the daemon didn't gate the connection.
      const ctx = await startConfiguredDaemon(root, "sleep 0.2; printf slow-done");
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        client.write({
          op: "session_launch",
          cwd: root,
          model: "m",
          effort: "e",
          prompt: "p",
        });
        client.write({ op: "ping" });

        const first = JSON.parse((await client.readLine())!) as Record<string, unknown>;
        const second = JSON.parse((await client.readLine())!) as Record<string, unknown>;
        expect(first).toMatchObject({ ok: true, stdout: "slow-done", exit_code: 0 });
        expect(second).toMatchObject({ ok: true, pong: true });
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

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
          path.join(ctx.dataDir, "config.json"),
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
});
