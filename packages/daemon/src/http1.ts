// The least of HTTP/1.1 that `POST /op` (op-http.ts, DR-0046) needs: read
// one request off the bytes a connection has sent, and write one response
// that closes the connection.
//
// Design rationale: hand-read rather than Bun's HTTP server. Bun.serve gives
// a handler no way to the connection's socket, and the endpoint names its
// caller by the process at the other end of that socket (peer-pid.ts), so it
// listens with Bun.listen and reads HTTP itself. It reads what a client of
// the endpoint sends (Claude Code's `$.http.fetch`, curl, Bun's fetch: a
// request line, headers, a body of `Content-Length` bytes) and refuses what
// it does not read rather than guessing: a chunked body, a head or body over
// the bounds. One request per connection: the response says
// `Connection: close` and the connection ends with it.

/** The longest head (request line and headers) read. */
export const HEAD_MAX_BYTES = 16 * 1024;
/** The longest body read. */
export const BODY_MAX_BYTES = 8 * 1024 * 1024;

/** One request, as far as the endpoint reads it. */
export interface Http1Request {
  method: string;
  path: string;
  body: string;
}

/** What the bytes so far make: not yet a whole request, one, or one that is
 * refused with `status` and the reason. */
export type Http1Read =
  | { kind: "incomplete" }
  | { kind: "request"; request: Http1Request }
  | { kind: "refused"; status: number; reason: string };

const HEAD_END = new TextEncoder().encode("\r\n\r\n");

function indexOfHeadEnd(bytes: Uint8Array): number {
  outer: for (let i = 0; i + HEAD_END.length <= bytes.length; i++) {
    for (let j = 0; j < HEAD_END.length; j++) {
      if (bytes[i + j] !== HEAD_END[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const REQUEST_LINE = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/;

/** Read the request in `bytes`, all a connection has sent so far. */
export function readHttp1(bytes: Uint8Array): Http1Read {
  const headEnd = indexOfHeadEnd(bytes);
  if (headEnd < 0) {
    return bytes.length > HEAD_MAX_BYTES
      ? { kind: "refused", status: 431, reason: `the head is over ${String(HEAD_MAX_BYTES)} bytes` }
      : { kind: "incomplete" };
  }
  if (headEnd > HEAD_MAX_BYTES) {
    return {
      kind: "refused",
      status: 431,
      reason: `the head is over ${String(HEAD_MAX_BYTES)} bytes`,
    };
  }
  const [requestLine = "", ...headerLines] = new TextDecoder()
    .decode(bytes.subarray(0, headEnd))
    .split("\r\n");
  const line = REQUEST_LINE.exec(requestLine);
  const method = line?.[1];
  const path = line?.[2];
  if (method === undefined || path === undefined) {
    return { kind: "refused", status: 400, reason: "not an HTTP/1.1 request line" };
  }
  let length = 0;
  for (const header of headerLines) {
    const colon = header.indexOf(":");
    if (colon <= 0) return { kind: "refused", status: 400, reason: "a header without a name" };
    const name = header.slice(0, colon).trim().toLowerCase();
    const value = header.slice(colon + 1).trim();
    if (name === "transfer-encoding") {
      return { kind: "refused", status: 501, reason: "a body is read by Content-Length alone" };
    }
    if (name === "content-length") {
      if (!/^\d+$/.test(value))
        return { kind: "refused", status: 400, reason: "a Content-Length that is not a number" };
      length = Number(value);
    }
  }
  if (length > BODY_MAX_BYTES) {
    return {
      kind: "refused",
      status: 413,
      reason: `the body is over ${String(BODY_MAX_BYTES)} bytes`,
    };
  }
  const bodyStart = headEnd + HEAD_END.length;
  if (bytes.length < bodyStart + length) return { kind: "incomplete" };
  const body = new TextDecoder().decode(bytes.subarray(bodyStart, bodyStart + length));
  return { kind: "request", request: { method, path, body } };
}

const REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  501: "Not Implemented",
};

/** One response that ends the connection. */
export interface Http1Response {
  status: number;
  contentType: "application/json" | "text/plain";
  body: string;
  /** Headers besides the ones every response has. */
  headers?: Readonly<Record<string, string>>;
}

/** `response` as the bytes to write. */
export function writeHttp1(response: Http1Response): Uint8Array {
  const body = new TextEncoder().encode(response.body);
  const headers = [
    `HTTP/1.1 ${String(response.status)} ${REASONS[response.status] ?? "Unknown"}`,
    `content-type: ${response.contentType}; charset=utf-8`,
    `content-length: ${String(body.length)}`,
    "connection: close",
    ...Object.entries(response.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ];
  const head = new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n`);
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  return bytes;
}
