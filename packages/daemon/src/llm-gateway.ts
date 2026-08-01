// Shared transport for the LLM gateway proxies (`llm_usage`, `llm_stats`).
//
// The gateway serves its JSON without CORS headers, so the webui cannot read
// it directly; the daemon fetches on its behalf. The two proxies differ only
// in the document they parse and the size they expect, so the fetch, the
// bounded read, and the collapse of every upstream failure into one
// actionable error live here once. Everything is async IO per DR-0029.
import type { ErrorCode as ErrorCodeType } from "@ccmsg/protocol";

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

/** Fetch one gateway document and hand back its parsed JSON, or the one error
 * every upstream failure mode collapses to. Shape validation is the caller's:
 * what counts as a usable document differs per endpoint. */
export async function fetchGatewayJson(
  req: GatewayRequest,
  deps: LlmGatewayDeps = productionGatewayDeps,
): Promise<{ ok: true; parsed: unknown } | GatewayFailure> {
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
        : `${req.label} endpoint unreachable: ${String(e)}`,
    );
  }
  if (!res.ok) return fail(`${req.label} endpoint returned HTTP ${res.status}`);

  let text: string | null;
  try {
    text = await readBounded(res, req.maxBytes);
  } catch (e) {
    return fail(`${req.label} endpoint response could not be read: ${String(e)}`);
  }
  if (text === null) return fail(`${req.label} endpoint response exceeds ${req.maxBytes} bytes`);

  try {
    return { ok: true, parsed: JSON.parse(text) };
  } catch {
    return fail(`${req.label} endpoint returned invalid JSON`);
  }
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
