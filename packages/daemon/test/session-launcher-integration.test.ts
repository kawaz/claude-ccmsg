// Wire integration for DR-0018 Phase 1: user-role authorization and the
// session_launch mock response over a real daemon/UDS connection.
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

async function startConfiguredDaemon(root: string): Promise<DaemonCtx> {
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
        command: 'run "$PROMPT"',
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

  // Phase 1 validates a user request and deliberately returns a stable mock body;
  // no process is executed until Phase 2 adds spawn/timeout/capture.
  test(
    "user role receives the Phase 1 session_launch mock response",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const ctx = await startConfiguredDaemon(root);
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
          model: "m",
          effort: "e",
          prompt: "p",
        });

        expect(response).toEqual({
          ok: true,
          stdout: "",
          stderr: "session_launch: not implemented yet (Phase 2)",
          exit_code: null,
          timed_out: false,
        });
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
