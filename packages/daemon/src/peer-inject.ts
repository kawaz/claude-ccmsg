// Delivery of a room message straight into a Claude Code session through the
// harness's own peer messaging socket, so the receiving session needs no
// `ccmsg subscribe` running to hear it.
//
// The session is found by its state file `<config dir>/sessions/<pid>.json`
// (`sessionId`, `pid`, `messagingSocketPath`, `peerProtocol`), authenticated
// with the `peerToken` of the `<pid>.<hex>.key` beside it, and handed two
// newline-delimited JSON frames: `auth`, then `user` carrying the envelope.
// The receiver answers nothing for a message it takes; it reports only a
// message it did not take, as `peer_message_status` on the socket the `user`
// frame names in `from`. Silence within the status window is delivery.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { chmod, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

export type InjectOutcome = "delivered" | "unavailable" | "refused";

/** The `peerProtocol` generation this speaks. */
export const PEER_PROTOCOL = 1;
/** Connect and flush both frames. */
export const INJECT_WRITE_MS = 2_000;
/** Watch the status socket for a refusal before taking the message as landed. */
export const INJECT_STATUS_MS = 250;
/** Read `sessions/` to find the target. */
export const INJECT_SCAN_MS = 1_000;

const REFUSING = new Set(["refused", "denied", "dropped", "expired", "held"]);

/** One message as the receiving model reads it. */
export interface InjectMessage {
  /** `<room>m<mid>`, e.g. `r353m1`. */
  mid: string;
  /** `"user"` for a person, the sender's session id otherwise. */
  from: string;
  fromLabel: string;
  text: string;
  /** The instruction line under the body, or nothing when no answer is wanted. */
  replyLine?: string;
}

export const ENVELOPE_TAG = "cross-session-message";

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The body is not escaped: what the model reads is these characters. */
export function renderEnvelope(m: InjectMessage): string {
  const attributes = [
    `from="ccmsg"`,
    `from-name="${escapeAttribute(m.fromLabel)}"`,
    `from-mode="prompting"`,
    `ccmsg-mid="${escapeAttribute(m.mid)}"`,
    `ccmsg-from="${escapeAttribute(m.from)}"`,
  ];
  const body = m.replyLine === undefined ? m.text : `${m.text}\n\n${m.replyLine}`;
  return `<${ENVELOPE_TAG} ${attributes.join(" ")}>\n${body}\n</${ENVELOPE_TAG}>`;
}

/** `session_id` rides along because the harness drops a frame whose id is not
 * its own: a state file read just before its pid was reused yields a message
 * nobody receives rather than one the wrong session does. */
export function injectFrames(sid: string, token: string, m: InjectMessage, from?: string): string {
  const auth = { type: "auth", token };
  const user = {
    type: "user",
    ...(from === undefined ? {} : { from }),
    session_id: sid,
    msg_id: m.mid,
    message: { content: renderEnvelope(m) },
  };
  return `${JSON.stringify(auth)}\n${JSON.stringify(user)}\n`;
}

/** The socket the receiving session reports refusals to. It sits beside the
 * target's own socket because the harness drops a reply address outside its
 * socket namespace. Bound once per directory for the life of the injector. */
class StatusInbox {
  readonly #waiting = new Map<string, (status: string) => void>();
  readonly #buffers = new Map<object, string>();
  #server: ReturnType<typeof Bun.listen> | undefined;
  readonly path: string;

  constructor(directory: string) {
    this.path = path.join(directory, `${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  }

  async bind(): Promise<boolean> {
    if (this.#server !== undefined) return true;
    try {
      this.#server = Bun.listen({
        unix: this.path,
        socket: {
          data: (socket, chunk) => this.#read(socket, chunk),
          open: () => {},
          close: (socket) => {
            this.#buffers.delete(socket);
          },
          error: () => {},
        },
      });
    } catch {
      return false;
    }
    try {
      await chmod(this.path, 0o600);
    } catch {
      // The socket is bound and usable without the mode.
    }
    return true;
  }

  status(mid: string, withinMs: number): Promise<string | undefined> {
    const settled = Promise.withResolvers<string | undefined>();
    this.#waiting.set(mid, settled.resolve);
    const deadline = setTimeout(() => settled.resolve(undefined), withinMs);
    return settled.promise.finally(() => {
      clearTimeout(deadline);
      this.#waiting.delete(mid);
    });
  }

  close(): void {
    this.#server?.stop(true);
    this.#server = undefined;
    try {
      fs.unlinkSync(this.path);
    } catch {
      // Already gone.
    }
  }

  #read(socket: object, chunk: Uint8Array): void {
    const parts = ((this.#buffers.get(socket) ?? "") + Buffer.from(chunk).toString("utf8")).split(
      "\n",
    );
    this.#buffers.set(socket, parts.pop() ?? "");
    for (const line of parts) this.#line(line);
  }

  #line(line: string): void {
    if (line.trim() === "") return;
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame["action"] !== "peer_message_status") return;
    const status = frame["status"];
    if (typeof status !== "string") return;
    const original = frame["orig_msg_id"];
    const dropped = frame["dropped_msg_ids"];
    const named = [
      ...(typeof original === "string" ? [original] : []),
      ...(Array.isArray(dropped)
        ? dropped.filter((id): id is string => typeof id === "string")
        : []),
    ];
    for (const mid of named) this.#waiting.get(mid)?.(status);
  }
}

export interface PeerInjectorOptions {
  writeMs?: number;
  statusMs?: number;
  scanMs?: number;
}

export class PeerInjector {
  readonly #writeMs: number;
  readonly #statusMs: number;
  readonly #scanMs: number;
  readonly #inboxes = new Map<string, Promise<StatusInbox | undefined>>();
  readonly #bound = new Set<StatusInbox>();
  #closed = false;

  constructor(options: PeerInjectorOptions = {}) {
    this.#writeMs = options.writeMs ?? INJECT_WRITE_MS;
    this.#statusMs = options.statusMs ?? INJECT_STATUS_MS;
    this.#scanMs = options.scanMs ?? INJECT_SCAN_MS;
  }

  /** `configDir` is the CLAUDE_CONFIG_DIR the target session runs under. */
  async send(configDir: string, sid: string, m: InjectMessage): Promise<InjectOutcome> {
    const sessionsDir = path.join(configDir, "sessions");
    const target = await this.#target(sessionsDir, sid);
    if (target === undefined) return "unavailable";
    const token = await this.#token(sessionsDir, target.pid);
    if (token === undefined) return "unavailable";
    const inbox = await this.#inbox(target.socketPath);
    const watching = inbox?.status(m.mid, this.#statusMs);
    const from = inbox === undefined ? undefined : `uds:${inbox.path}`;
    const written = await write(
      target.socketPath,
      injectFrames(sid, token, m, from),
      this.#writeMs,
    );
    if (written !== "delivered") return written;
    const status = await watching;
    return status !== undefined && REFUSING.has(status) ? "refused" : "delivered";
  }

  close(): void {
    this.#closed = true;
    for (const inbox of this.#bound) inbox.close();
    this.#bound.clear();
    this.#inboxes.clear();
  }

  async #inbox(socketPath: string): Promise<StatusInbox | undefined> {
    const directory = path.dirname(socketPath);
    const held = this.#inboxes.get(directory);
    if (held !== undefined) return await held;
    const opening = (async (): Promise<StatusInbox | undefined> => {
      const inbox = new StatusInbox(directory);
      if (!(await inbox.bind())) return undefined;
      if (this.#closed) {
        inbox.close();
        return undefined;
      }
      this.#bound.add(inbox);
      return inbox;
    })();
    this.#inboxes.set(directory, opening);
    const inbox = await opening;
    if (inbox === undefined && this.#inboxes.get(directory) === opening) {
      this.#inboxes.delete(directory);
    }
    return inbox;
  }

  async #target(
    sessionsDir: string,
    sid: string,
  ): Promise<{ pid: number; socketPath: string } | undefined> {
    const rows = await this.#rows(sessionsDir, /^\d+\.json$/);
    for (const row of rows ?? []) {
      if (row === undefined || row["sessionId"] !== sid) continue;
      const pid = row["pid"];
      const socketPath = row["messagingSocketPath"];
      if (typeof pid !== "number" || typeof socketPath !== "string" || socketPath === "") {
        return undefined;
      }
      return row["peerProtocol"] === PEER_PROTOCOL ? { pid, socketPath } : undefined;
    }
    return undefined;
  }

  /** Found by the pid the key is named after: the digest part of
   * `<pid>.<hex>.key` is not rebuilt here. */
  async #token(sessionsDir: string, pid: number): Promise<string | undefined> {
    const rows = await this.#rows(sessionsDir, new RegExp(`^${pid}\\.[0-9a-f]+\\.key$`));
    for (const row of rows ?? []) {
      const token = row?.["peerToken"];
      if (typeof token === "string" && token !== "") return token;
    }
    return undefined;
  }

  async #rows(
    sessionsDir: string,
    pattern: RegExp,
  ): Promise<(Record<string, unknown> | undefined)[] | undefined> {
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch {
      return undefined;
    }
    const wanted = names.filter((name) => pattern.test(name));
    const late = Promise.withResolvers<undefined>();
    const deadline = setTimeout(() => late.resolve(undefined), this.#scanMs);
    try {
      return await Promise.race([
        Promise.all(wanted.map((name) => readJson(path.join(sessionsDir, name)))),
        late.promise,
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }
}

/** Connect and flush. The connection carries nothing back, so the budget covers
 * connect and flush only. */
async function write(socketPath: string, payload: string, ms: number): Promise<InjectOutcome> {
  const started = Date.now();
  const settled = Promise.withResolvers<InjectOutcome>();
  const bytes = Buffer.from(payload, "utf8");
  let written = 0;
  let flushed = false;

  const push = (socket: { write(data: Uint8Array): number }): void => {
    written += socket.write(bytes.subarray(written));
    if (written >= bytes.length && !flushed) {
      flushed = true;
      settled.resolve(Date.now() - started >= ms ? "unavailable" : "delivered");
    }
  };

  let socket: Awaited<ReturnType<typeof Bun.connect>>;
  try {
    socket = await Bun.connect({
      unix: socketPath,
      socket: {
        open: push,
        drain: (conn) => {
          if (!flushed) push(conn);
        },
        data: () => {},
        close: () => settled.resolve(flushed ? "delivered" : "unavailable"),
        error: () => settled.resolve("unavailable"),
      },
    });
  } catch {
    return "unavailable";
  }

  const deadline = setTimeout(
    () => settled.resolve("unavailable"),
    Math.max(0, ms - (Date.now() - started)),
  );
  try {
    return await settled.promise;
  } finally {
    clearTimeout(deadline);
    socket.end();
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const document: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof document !== "object" || document === null) return undefined;
    return document as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The launcher a recipient runs to answer: `bin/ccmsg` of the tree this
 * daemon runs from, or the bare name when that tree has none. */
export function resolveLauncher(main: string = Bun.main): string {
  const candidate = path.resolve(path.dirname(main), "../../../bin/ccmsg");
  return fs.existsSync(candidate) ? candidate : "ccmsg";
}
