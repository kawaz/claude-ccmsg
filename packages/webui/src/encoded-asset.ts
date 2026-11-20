// Content-coding for the webui's own text assets (HTML shell, CSS, client
// bundle). Each asset is compressed ahead of the requests, so no request pays
// for compression: gzip as it is loaded, brotli later (withBrotli), and a
// request picks one of the bodies there are by its Accept-Encoding.
// Uncompressed, the client bundle is ~1.5MB, which a slow path (a phone on the
// tailnet) did not finish downloading at all; gzip brings it to ~300KB,
// brotli to ~250KB.
import { brotliCompress, constants, gzip } from "node:zlib";

export type ContentCoding = "br" | "gzip" | "identity";

export interface EncodedAsset {
  /** Identity and gzip from the start; br once withBrotli has made it. */
  readonly bodies: Readonly<
    Record<"identity" | "gzip", Uint8Array<ArrayBuffer>> & { br?: Uint8Array<ArrayBuffer> }
  >;
  /** sha256 hex of the uncompressed bytes; the ETag of each coding is derived from it. */
  readonly digest: string;
}

// Compression runs on the process's pool of threads (node:zlib's callback
// forms), not the event loop: the daemon serving this app delivers messages on
// that loop. Bun's own gzipSync is synchronous, and its CompressionStream's
// brotli takes no quality (the highest would be its default's say), so both
// go through node:zlib.
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

/** `text` as identity and gzip: what is served until withBrotli has made br. */
export async function encodeAsset(text: string): Promise<EncodedAsset> {
  const identity = new TextEncoder().encode(text);
  return {
    bodies: { identity, gzip: await gzipped(identity) },
    digest: new Bun.CryptoHasher("sha256").update(identity).digest("hex"),
  };
}

/** `asset` with its br body made too (brotli at the highest quality, ~0.8s
 * on the client bundle's entry). The caller decides when, and how many at
 * once. */
export async function withBrotli(asset: EncodedAsset): Promise<EncodedAsset> {
  return { ...asset, bodies: { ...asset.bodies, br: await brotli(asset.bodies.identity) } };
}

type Compressed = Exclude<ContentCoding, "identity">;

/** Strongest first: on equal weights the smaller body wins. */
const OFFERED: readonly Compressed[] = ["br", "gzip"];

/**
 * Of `offers` (strongest first), the one to answer with for an
 * `Accept-Encoding` header (RFC 9110 §12.5.3): of those the client accepts
 * (weight above 0, given by name or by `*`), the highest weight wins. Null is
 * identity, what is left when the client accepts none of them: it is never
 * excluded, because this server would rather send an uncompressed body than
 * refuse the request.
 */
function pickOffer<T extends { coding: Compressed }>(
  acceptEncoding: string | null | undefined,
  offers: readonly T[],
): T | null {
  if (acceptEncoding == null) return null;
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
  let best: T | null = null;
  let bestWeight = 0;
  for (const offer of offers) {
    const weight = weights.get(offer.coding) ?? weights.get("*") ?? 0;
    if (weight > bestWeight) {
      best = offer;
      bestWeight = weight;
    }
  }
  return best;
}

/** The coding to answer with for an `Accept-Encoding` header when both br and
 * gzip are offered (pickOffer). */
export function negotiateCoding(acceptEncoding: string | null | undefined): ContentCoding {
  return (
    pickOffer(
      acceptEncoding,
      OFFERED.map((coding) => ({ coding })),
    )?.coding ?? "identity"
  );
}

/** The compressed bodies `asset` has, strongest first. */
function offersOf(asset: EncodedAsset): { coding: Compressed; body: Uint8Array<ArrayBuffer> }[] {
  return OFFERED.flatMap((coding) => {
    const body = asset.bodies[coding];
    return body === undefined ? [] : [{ coding, body }];
  });
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
 * The ETag names the coding, so a validator for the gzip body does not match
 * once the same request is answered in br (a 200 with the br body, RFC 9110
 * §8.8.3: each content-coding is its own representation).
 */
export function encodedResponse(
  asset: EncodedAsset,
  req: Request,
  headers: Readonly<Record<string, string>>,
  options: { etag: boolean },
): Response {
  const offer = pickOffer(req.headers.get("accept-encoding"), offersOf(asset));
  const coding = offer?.coding ?? "identity";
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
  const body = offer?.body ?? asset.bodies.identity;
  out.set("content-length", String(body.byteLength));
  return new Response(body, { headers: out });
}
