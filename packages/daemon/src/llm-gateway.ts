// Shared transport for the LLM gateway proxies (`llm_usage`, `llm_stats`).
//
// The gateway serves its JSON without CORS headers, so the webui cannot read
// it directly; the daemon fetches on its behalf. The two proxies differ only
// in the document they parse and the size they expect, so the fetch, the
// bounded read, and the collapse of every upstream failure into one
// actionable error live here once. Everything is async IO per DR-0029.
import {
  errorText,
  JsonValueSchema,
  jsonText,
  parseWith,
  type ErrorCode as ErrorCodeType,
  type JsonValue,
  type ParseFailure,
} from "@ccmsg/protocol";

/** A gateway document's text: any JSON, read by its endpoint's schema next. */
const GatewayDocumentTextSchema = jsonText(JsonValueSchema);

/** Just the call these modules make, rather than `typeof globalThis.fetch`:
 * the dependency is "fetch this URL", and narrowing it keeps a test stub from
 * having to reproduce the runtime's incidental extras (Bun's `preconnect`). */
export type GatewayFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface LlmGatewayDeps {
  /** Injected so tests exercise the parsing and the failure branches without
   * a live gateway. Defaults to the runtime's global fetch. */
  fetch: GatewayFetch;
}

export const productionGatewayDeps: LlmGatewayDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
};

export type GatewayFailure = { ok: false; code: ErrorCodeType; msg: string };

/** Buffer the body with a hard byte ceiling. `res.text()` would read an
 * unbounded stream into daemon memory before the size could be checked, and
 * content-length is advisory (absent under chunked encoding). */
async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  const body = res.body;
  if (!body) return "";
  // Through a typed pass-through: the body's own stream is typed `any` by the
  // runtime's declarations.
  const reader = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()).getReader();
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

export interface GatewayRequest {
  url: string;
  /** Names the endpoint in every error message ("usage endpoint returned
   * HTTP 502"). The operator's next step is to go look at that endpoint, so
   * the message has to say which one answered badly. */
  label: string;
  /** The single code every failure below collapses to — the caller's recovery
   * ("retry, or go fix the gateway") is the same whether the gateway refused
   * the connection, timed out, or answered with HTML. */
  code: ErrorCodeType;
  maxBytes: number;
  timeoutMs: number;
}

/** Fetch one gateway document and hand back its JSON, or the one error every
 * upstream failure mode collapses to. Its shape is read by the caller: what
 * the document is differs per endpoint (unreadable, below). */
export async function fetchGatewayJson(
  req: GatewayRequest,
  deps: LlmGatewayDeps = productionGatewayDeps,
): Promise<{ ok: true; document: JsonValue } | GatewayFailure> {
  const fail = (msg: string): GatewayFailure => ({ ok: false, code: req.code, msg });

  let res: Response;
  try {
    res = await deps.fetch(req.url, {
      signal: AbortSignal.timeout(req.timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return fail(
      timedOut
        ? `${req.label} endpoint did not respond within ${req.timeoutMs}ms`
        : `${req.label} endpoint unreachable: ${errorText(e)}`,
    );
  }
  if (!res.ok) return fail(`${req.label} endpoint returned HTTP ${res.status}`);

  let text: string | null;
  try {
    text = await readBounded(res, req.maxBytes);
  } catch (e) {
    return fail(`${req.label} endpoint response could not be read: ${errorText(e)}`);
  }
  if (text === null) return fail(`${req.label} endpoint response exceeds ${req.maxBytes} bytes`);

  const document = parseWith(GatewayDocumentTextSchema, text);
  return document.ok
    ? { ok: true, document: document.value }
    : fail(`${req.label} endpoint returned invalid JSON`);
}

/** The error for a document of the wrong shape, naming where it is wrong:
 * the gateway and ccmsg disagree about the document, and which field is the
 * place to start looking. */
export function unreadable(
  label: string,
  code: ErrorCodeType,
  failure: ParseFailure,
): GatewayFailure {
  return {
    ok: false,
    code,
    msg: `${label} endpoint returned a document ccmsg does not read: ${failure.summary}`,
  };
}

/** Put one query parameter on a configured URL. `set` rather than `append` so
 * a configured URL that already carries the parameter (the operator pasted the
 * one they were reading in a browser) is overridden by the caller's value
 * instead of sending two conflicting ones. Throws on a URL that cannot be
 * parsed, which the callers turn into their own unavailable error. */
export function withQueryParam(base: string, key: string, value: string): string {
  const url = new URL(base);
  url.searchParams.set(key, value);
  return url.toString();
}
