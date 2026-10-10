// Content-coding for the webui's own text assets (HTML shell, CSS, client
// bundle). Each asset is compressed once, when it is loaded, into every coding
// this server offers; a request only picks one of the ready bodies by its
// Accept-Encoding, so no request pays for compression. Uncompressed, the
// client bundle is ~1.5MB, which a slow path (a phone on the tailnet) did not
// finish downloading at all; brotli brings it to ~250KB.
import { brotliCompress, constants, gzip } from "node:zlib";

export type ContentCoding = "br" | "gzip" | "identity";

export interface EncodedAsset {
  readonly bodies: Readonly<Record<ContentCoding, Uint8Array<ArrayBuffer>>>;
  /** sha256 hex of the uncompressed bytes; the ETag of each coding is derived from it. */
  readonly digest: string;
}

// Compression runs on the zlib thread pool (the callback forms), not the event
// loop: brotli at quality 11 takes ~1.7s on the client bundle, and the daemon
// serving this app delivers messages on that same loop. Bun's own gzipSync is
// synchronous and Bun has no brotli of its own, so both go through node:zlib.
function brotli(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    brotliCompress(
      data,
      {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
        },
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
}

function gzipped(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    gzip(data, { level: constants.Z_BEST_COMPRESSION }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
}

export async function encodeAsset(text: string): Promise<EncodedAsset> {
  const identity = new TextEncoder().encode(text);
  const [br, gz] = await Promise.all([brotli(identity), gzipped(identity)]);
  return {
    bodies: { identity, br, gzip: gz },
    digest: new Bun.CryptoHasher("sha256").update(identity).digest("hex"),
  };
}

/** Strongest first: on equal weights the smaller body wins. */
const OFFERED: readonly Exclude<ContentCoding, "identity">[] = ["br", "gzip"];

/**
 * The coding to answer with for an `Accept-Encoding` header (RFC 9110 §12.5.3).
 * Of the offered codings the client accepts (weight above 0, given by name or
 * by `*`), the highest weight wins. Identity is what is left when the client
 * accepts neither: it is never excluded, because this server would rather send
 * an uncompressed body than refuse the request.
 */
export function negotiateCoding(acceptEncoding: string | null | undefined): ContentCoding {
  if (acceptEncoding == null) return "identity";
  const weights = new Map<string, number>();
  for (const entry of acceptEncoding.split(",")) {
    const [rawName = "", ...params] = entry.split(";");
    const name = rawName.trim().toLowerCase();
    if (name === "") continue;
    let weight = 1;
    for (const param of params) {
      const q = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)?.[1];
      if (q !== undefined) weight = Number(q);
    }
    // x-gzip is gzip under its old name (RFC 9110 §8.4.1.3).
    weights.set(name === "x-gzip" ? "gzip" : name, Number.isFinite(weight) ? weight : 0);
  }
  let best: ContentCoding = "identity";
  let bestWeight = 0;
  for (const coding of OFFERED) {
    const weight = weights.get(coding) ?? weights.get("*") ?? 0;
    if (weight > bestWeight) {
      best = coding;
      bestWeight = weight;
    }
  }
  return best;
}

function etagFor(asset: EncodedAsset, coding: ContentCoding): string {
  return coding === "identity" ? `"${asset.digest}"` : `"${asset.digest}-${coding}"`;
}

/** If-None-Match uses the weak comparison (RFC 9110 §13.1.2): `W/` is ignored. */
function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((tag) => {
    const trimmed = tag.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === etag;
  });
}

/**
 * The response for `asset` in the coding `req` accepts. `headers` carries what
 * does not depend on the coding (content-type, cache-control); the coding's
 * own headers are added here. With `etag`, a matching If-None-Match gets a 304.
 */
export function encodedResponse(
  asset: EncodedAsset,
  req: Request,
  headers: Readonly<Record<string, string>>,
  options: { etag: boolean },
): Response {
  const coding = negotiateCoding(req.headers.get("accept-encoding"));
  const out = new Headers(headers);
  out.set("vary", "accept-encoding");
  if (options.etag) {
    const etag = etagFor(asset, coding);
    out.set("etag", etag);
    if (matchesIfNoneMatch(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: out });
    }
  }
  if (coding !== "identity") out.set("content-encoding", coding);
  const body = asset.bodies[coding];
  out.set("content-length", String(body.byteLength));
  return new Response(body, { headers: out });
}
