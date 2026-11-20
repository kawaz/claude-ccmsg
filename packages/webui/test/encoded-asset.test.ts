import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { encodeAsset, encodedResponse, negotiateCoding, withBrotli } from "../src/encoded-asset.ts";

describe("negotiateCoding", () => {
  test("brotli when the client accepts it, gzip when only that, identity when neither", () => {
    expect(negotiateCoding("gzip, deflate, br, zstd")).toBe("br");
    expect(negotiateCoding("gzip, deflate")).toBe("gzip");
    expect(negotiateCoding("x-gzip")).toBe("gzip");
    expect(negotiateCoding("deflate")).toBe("identity");
    expect(negotiateCoding("")).toBe("identity");
    expect(negotiateCoding(null)).toBe("identity");
  });

  test("weights decide, q=0 excludes, and * stands for the codings not named", () => {
    expect(negotiateCoding("br;q=0.5, gzip;q=0.8")).toBe("gzip");
    expect(negotiateCoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateCoding("br;q=0, gzip;q=0")).toBe("identity");
    expect(negotiateCoding("*")).toBe("br");
    expect(negotiateCoding("br;q=0, *")).toBe("gzip");
    expect(negotiateCoding("*;q=0")).toBe("identity");
    expect(negotiateCoding("BR ; Q=1")).toBe("br");
  });
});

describe("encodedResponse", () => {
  const text = "<!doctype html><title>x</title>".repeat(50);
  const ask = (acceptEncoding: string, ifNoneMatch?: string): Request =>
    new Request("http://localhost/", {
      headers: {
        "accept-encoding": acceptEncoding,
        ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }),
      },
    });
  const answer = (asset: Awaited<ReturnType<typeof encodeAsset>>, req: Request): Response =>
    encodedResponse(asset, req, { "content-type": "text/html" }, { etag: true });

  test("an asset without its brotli body is answered in gzip to a client that takes br, and with it in br", async () => {
    const gzipOnly = await encodeAsset(text);
    expect(gzipOnly.bodies.br).toBeUndefined();
    const before = answer(gzipOnly, ask("gzip, br"));
    expect(before.headers.get("content-encoding")).toBe("gzip");
    expect(new TextDecoder().decode(gunzipSync(await before.bytes()))).toBe(text);
    // A client that takes br alone gets the uncompressed body, not a refusal.
    expect(answer(gzipOnly, ask("br")).headers.get("content-encoding")).toBeNull();

    const full = await withBrotli(gzipOnly);
    expect(full.digest).toBe(gzipOnly.digest);
    const after = answer(full, ask("gzip, br"));
    expect(after.headers.get("content-encoding")).toBe("br");
    expect(new TextDecoder().decode(brotliDecompressSync(await after.bytes()))).toBe(text);
    expect(answer(full, ask("gzip")).headers.get("content-encoding")).toBe("gzip");
  });

  test("the gzip body's etag does not revalidate once the answer is br", async () => {
    const gzipOnly = await encodeAsset(text);
    const gzipEtag = answer(gzipOnly, ask("gzip, br")).headers.get("etag") ?? "";
    expect(answer(gzipOnly, ask("gzip, br", gzipEtag)).status).toBe(304);
    const full = await withBrotli(gzipOnly);
    const after = answer(full, ask("gzip, br", gzipEtag));
    expect(after.status).toBe(200);
    expect(after.headers.get("content-encoding")).toBe("br");
    expect(after.headers.get("etag")).not.toBe(gzipEtag);
    expect(answer(full, ask("gzip", gzipEtag)).status).toBe(304);
  });
});
