// Inbound webhook endpoint: `POST /webhook/<source>`.
//
// One route serving many producers, each identified by the path segment and
// authenticated by its own bearer token. Today the only registered source is
// the LLM gateway posting request events (see server.ts for the registration
// and llm-events.ts for what it does with them), but the shape — per-source
// token, per-source handler — is what makes the second producer a config entry
// rather than a new endpoint.
//
// Fire-and-forget by design: a producer must not be made to care whether this
// daemon liked its payload. Anything structurally readable answers 204 and
// individually bad items are logged and dropped, because a producer that
// retries on 4xx would hammer the daemon over an event nobody can use. Only a
// body that cannot be read at all is worth telling the sender about.
//
// Everything is async IO per DR-0029, and the body is read with a hard ceiling
// rather than buffered on trust — this endpoint shares the event loop with
// every WS client.
import { timingSafeEqual } from "node:crypto";

/** Cap on one posted body. The gateway sends single events or small batches of
 * them (a few hundred bytes each); a megabyte is already thousands of events,
 * so anything past it is a bug or an attack, not a busy minute. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

/** Path segment naming a producer. Deliberately narrow: this segment picks a
 * config entry, so it must not be able to express traversal or case tricks. */
const SOURCE_PATTERN = /^[a-z0-9-]{1,64}$/;

export interface WebhookSource {
  /** Shared secret this producer must present as `Authorization: Bearer`. */
  token: string;
  /** Handle one posted batch. Items are raw JSON values: validating them is
   * the source's own business, and one bad item must not fail the request. */
  handle(items: unknown[]): void;
}

export interface WebhookLog {
  error(msg: string): void;
}

/** True when the request presents exactly this source's token. Compared in
 * constant time: the endpoint is loopback-only today, but a token comparison
 * that leaks its prefix through timing is the kind of thing that quietly
 * stops being fine when a tunnel is pointed at the daemon later. */
function isAuthorized(header: string | null, token: string): boolean {
  if (header === null) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  // timingSafeEqual throws on a length mismatch, which is itself a (harmless,
  // unavoidable) length oracle — the token length is not the secret.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** Read the body with a hard byte ceiling. `req.json()` would buffer an
 * unbounded stream into daemon memory before any limit could apply, and
 * content-length is advisory (absent under chunked encoding). Returns null
 * when the ceiling is crossed. */
async function readBounded(req: Request, maxBytes: number): Promise<string | null> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/** Serve one `POST /webhook/<source>`. `source` is the raw path segment.
 *
 * 404 covers both an unknown name and a known one this daemon has no token
 * for: an unconfigured webhook does not exist as far as a caller can tell,
 * which is also what keeps the reply from enumerating what could be enabled.
 */
export async function handleWebhookRequest(
  req: Request,
  source: string,
  sources: Map<string, WebhookSource>,
  log: WebhookLog,
): Promise<Response> {
  if (!SOURCE_PATTERN.test(source)) return new Response("Not Found", { status: 404 });
  const registered = sources.get(source);
  if (!registered) return new Response("Not Found", { status: 404 });
  if (!isAuthorized(req.headers.get("Authorization"), registered.token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) {
      return new Response(`payload too large (max ${WEBHOOK_MAX_BYTES} bytes)`, { status: 413 });
    }
  }

  let text: string | null;
  try {
    text = await readBounded(req, WEBHOOK_MAX_BYTES);
  } catch (e) {
    return new Response(`body could not be read: ${String(e)}`, { status: 400 });
  }
  if (text === null) {
    return new Response(`payload too large (max ${WEBHOOK_MAX_BYTES} bytes)`, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // The one failure the sender can actually act on, so the one it hears about.
    log.error(`webhook ${source}: invalid JSON body (${String(e)})`);
    return new Response("invalid JSON body", { status: 400 });
  }

  // A bare event and a batch of them are the same thing to a handler.
  const items = Array.isArray(parsed) ? parsed : [parsed];
  try {
    registered.handle(items);
  } catch (e) {
    // A handler that throws is a ccmsg bug, not the sender's problem: log it
    // and still answer 204 rather than provoking a retry loop.
    log.error(`webhook ${source}: handler failed (${String(e)})`);
  }
  return new Response(null, { status: 204 });
}
