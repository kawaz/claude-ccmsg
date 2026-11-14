// A run's sidecar as a test stands it in (DR-0035 §3, DR-0046): it binds
// where the daemon writes requests for the run, names the run to the daemon,
// and hands the test each line the daemon wrote; and the module's replies, as
// the daemon takes them.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  jsonText,
  parseWith,
  type RequestInput,
  resolvePaths,
  type SidecarReply,
  type SidecarRequest,
  SidecarRequestSchema,
  sidecarSocketName,
} from "@ccmsg/protocol";
import { connect, type TestClient } from "./helpers.ts";

const RequestTextSchema = jsonText(SidecarRequestSchema);

/** A line the daemon wrote to a sidecar, read as the request it must be. */
export function requestIn(line: string): SidecarRequest {
  const read = parseWith(RequestTextSchema, line);
  if (!read.ok) throw new Error(`not a sidecar request: ${read.failure.summary}`);
  return read.value;
}

/** Stand in for a run's sidecar: bind where the daemon writes for this run,
 * hand over each line it is written, and name the run to the daemon on a
 * session connection of its own (sidecar_hello), as `ccmsg sidecar` does.
 * `leave` closes that connection — the run is gone — and resolves once the
 * daemon has let go of it. */
export async function fakeSidecar(
  ctx: { sock: string; stateDir: string },
  sid: string,
  runId: string,
  hyouiSessionId?: string,
): Promise<{ lines: AsyncGenerator<string, void>; leave(): Promise<void>; close(): void }> {
  const dir = resolvePaths({ CCMSG_STATE_DIR: ctx.stateDir }).sidecars;
  fs.mkdirSync(dir, { recursive: true });
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const server = Bun.listen({
    unix: path.join(dir, sidecarSocketName(sid, runId)),
    socket: {
      data: (_s, chunk) => {
        for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
          if (line !== "") queue.push(line);
        }
        wake?.();
      },
    },
  });
  async function* lines(): AsyncGenerator<string, void> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  const naming: TestClient = await connect(ctx.sock);
  await naming.hello({ role: "session", sid });
  await naming.requestOk({
    op: "sidecar_hello",
    run_id: runId,
    started_at: Date.now(),
    ...(hyouiSessionId !== undefined ? { hyoui_session_id: hyouiSessionId } : {}),
  });
  return {
    lines: lines(),
    leave: () => naming.end(),
    close: () => {
      naming.close();
      server.stop(true);
    },
  };
}

/** The next request the daemon wrote to `sidecar`, past the `session.facts`
 * it asks each run that names itself (session-facts.test.ts). */
export async function nextRequest(sidecar: {
  lines: AsyncGenerator<string, void>;
}): Promise<SidecarRequest> {
  for (;;) {
    const next = await sidecar.lines.next();
    if (next.done === true) throw new Error("the sidecar closed");
    const request = requestIn(next.value);
    if (request.op !== "session.facts") return request;
  }
}

/** A module's reply as the daemon takes it (sidecar_reply). */
export function sidecarReply(reply: SidecarReply): Extract<RequestInput, { op: "sidecar_reply" }> {
  return { op: "sidecar_reply", reply };
}
