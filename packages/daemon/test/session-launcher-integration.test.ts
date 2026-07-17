// Wire integration for DR-0018: user-role authorization and real
// session_launch execution over a daemon/UDS connection.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  connect,
  spawnDaemonProc,
  startTestDaemon,
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
          { op: "session_launch", cwd: root, model: "m", effort: "e", prompt: "p" },
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

  // 2-phase reply contract: the direct reply is an immediate ack echoing the
  // client's request_id, and the executed command's real streams / non-zero
  // exit status arrive later as an ev:"session_launch_result" event carrying
  // the same request_id — never as a positional reply.
  test(
    "user role receives an immediate ack, then the executed result event",
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
        const ack = await client.request<{ ok: true; accepted: true; request_id: string }>({
          op: "session_launch",
          request_id: "launch-1",
          cwd: root,
          model: "wire-model",
          effort: "wire-effort",
          prompt: "wire-prompt",
        });
        expect(ack).toEqual({ ok: true, accepted: true, request_id: "launch-1" });

        const event = await client.readEvent<Record<string, unknown>>();
        expect(event).toEqual({
          ev: "session_launch_result",
          request_id: "launch-1",
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

  // A missing/empty request_id is a synchronous validation error: 2-phase
  // correlation is impossible without it, so the op is refused up front and
  // no command is executed (no result event will ever arrive).
  test(
    "session_launch without a request_id is rejected with invalid_args",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
      const ctx = await startConfiguredDaemon(root);
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        const response = await client.request<{ ok: false; error: { code: string } }>({
          op: "session_launch",
          cwd: root,
          model: "m",
          effort: "e",
          prompt: "p",
        });
        expect(response.ok).toBe(false);
        expect(response.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  // THE regression this 2-phase design exists for (kawaz r26 mid=108): a slow
  // launch used to defer its positional reply and hold back every later reply
  // on the same connection (the webui's single WS connection stalled all
  // panes). Now the connection's positional stream must carry the launch ack
  // and then the ping reply IMMEDIATELY — i.e. before the slow command
  // finishes — and the launch outcome arrives last as the correlated event.
  test(
    "a later op's reply arrives before a slow session_launch's result event",
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
          model: "m",
          effort: "e",
          prompt: "p",
        });
        client.write({ op: "ping" });

        const first = JSON.parse((await client.readLine())!) as Record<string, unknown>;
        const second = JSON.parse((await client.readLine())!) as Record<string, unknown>;
        const third = JSON.parse((await client.readLine())!) as Record<string, unknown>;
        expect(first).toEqual({ ok: true, accepted: true, request_id: "slow-launch" });
        expect(second).toMatchObject({ ok: true, pong: true });
        expect(third).toMatchObject({
          ev: "session_launch_result",
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

  // The webui's SessionCreator/CwdTree need root_dirs (initial dir_tree fetch)
  // and default_prompt (the "default" button) before the user has picked
  // anything — session_launcher_config is the read-only projection that fills
  // that gap (see its protocol doc comment).
  test(
    "user role receives root_dirs and default_prompt",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-root-"));
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
            default_prompt: "hello default",
            shell: "bash",
            command: "printf configured",
          },
        }),
      );
      const proc = spawnDaemonProc(stateDir, dataDir);
      const sock = path.join(stateDir, "daemon.sock");
      await waitConnectable(sock);
      const ctx: DaemonCtx = {
        base,
        stateDir,
        dataDir,
        roomsDir: path.join(dataDir, "rooms"),
        sock,
        proc,
        env: { CCMSG_STATE_DIR: stateDir, CCMSG_DATA_DIR: dataDir, CCMSG_HTTP_BIND: "off" },
      };
      try {
        const client = await connect(ctx.sock);
        await client.hello({ role: "user" });
        const response = await client.request<{
          ok: true;
          root_dirs: string[];
          default_prompt: string;
        }>({ op: "session_launcher_config" });
        expect(response.ok).toBe(true);
        expect(response).toMatchObject({ default_prompt: "hello default" });
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
});
