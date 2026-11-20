// Run by app.test.ts in a process of its own (the assets are loaded once per
// process, so a test process that already made the brotli bodies says
// nothing): the app's answers while its brotli is held back, then once it is
// let through and prepare has settled. node:zlib's brotliCompress is replaced
// before the app is loaded, with one that starts the real one only on release,
// so "before" is the state before brotli whatever the machine's speed.
import zlib from "node:zlib";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const { promise: released, resolve: release } = Promise.withResolvers<void>();
const brotliCompress = zlib.brotliCompress;
Reflect.set(
  zlib,
  "brotliCompress",
  (buf: zlib.InputType, options: zlib.BrotliOptions, callback: zlib.CompressCallback) => {
    void released.then(() => brotliCompress(buf, options, callback));
  },
);
const { createWebuiApp } = await import("../src/index.ts");
const app = createWebuiApp();

const ACCEPT = "gzip, deflate, br";

interface Answer {
  status: number;
  coding: string | null;
  etag: string | null;
  /** sha256 hex of the body decoded. */
  digest: string;
}

async function get(
  path: string,
  headers: Record<string, string> = { "accept-encoding": ACCEPT },
): Promise<Answer & { text: string }> {
  const res = await app.fetch(new Request(`http://localhost${path}`, { headers }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const coding = res.headers.get("content-encoding");
  const decoded =
    coding === "br" ? brotliDecompressSync(bytes) : coding === "gzip" ? gunzipSync(bytes) : bytes;
  return {
    status: res.status,
    coding,
    etag: res.headers.get("etag"),
    digest: new Bun.CryptoHasher("sha256").update(decoded).digest("hex"),
    text: new TextDecoder().decode(decoded),
  };
}

type Answers = Record<"shell" | "entry" | "stylesheet", Answer>;

/** The shell, the bundle's entry and the stylesheet, asked for with `headers`. */
async function answers(headers?: Record<string, string>): Promise<Answers> {
  const shell = await get("/", headers);
  const entry = shell.text.match(/src="([^"]+)"/)?.[1] ?? "";
  const stylesheet = shell.text.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1] ?? "";
  const of = ({ status, coding, etag, digest }: Answer): Answer => ({
    status,
    coding,
    etag,
    digest,
  });
  return {
    shell: of(shell),
    entry: of(await get(entry, headers)),
    stylesheet: of(await get(stylesheet, headers)),
  };
}

const before = await answers();
const identity = await answers({});
const gzipEtagBefore = (
  await get("/", { "accept-encoding": ACCEPT, "if-none-match": before.shell.etag ?? "" })
).status;
release();
await app.prepare();
const after = await answers();
// The gzip shell's validator, from a client that takes br: the answer is now
// in br, another representation, so not a 304.
const shellEtags = {
  gzipBefore: gzipEtagBefore,
  gzipAfter: (
    await get("/", { "accept-encoding": ACCEPT, "if-none-match": before.shell.etag ?? "" })
  ).status,
  brAfter: (await get("/", { "accept-encoding": ACCEPT, "if-none-match": after.shell.etag ?? "" }))
    .status,
};
// A client that takes gzip alone keeps getting gzip.
const gzipOnlyAfter = (await get("/", { "accept-encoding": "gzip" })).coding;
console.log(JSON.stringify({ before, identity, after, shellEtags, gzipOnlyAfter }));
process.exit(0);
