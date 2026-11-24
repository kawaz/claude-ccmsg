// Run by app.test.ts in a process of its own, with node:zlib's brotli
// replaced (brotli-stub.ts, which is not undone): a prepared app's answers
// for the shell, the bundle's entry and the stylesheet, asked for with each
// Accept-Encoding, and the shell's revalidation with the br validator.
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { releaseBrotli } from "./brotli-stub.ts";

releaseBrotli();
const { createWebuiApp } = await import("../src/index.ts");
const app = createWebuiApp();
await app.prepare();

interface Answer {
  status: number;
  coding: string | null;
  vary: string | null;
  contentLength: string | null;
  cacheControl: string | null;
  etag: string | null;
  /** Of the body as it came. */
  byteLength: number;
  /** sha256 hex of the body decoded. */
  digest: string;
}

async function get(path: string, headers: Record<string, string>): Promise<Answer> {
  const res = await app.fetch(new Request(`http://localhost${path}`, { headers }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const coding = res.headers.get("content-encoding");
  const decoded =
    coding === "br" ? brotliDecompressSync(bytes) : coding === "gzip" ? gunzipSync(bytes) : bytes;
  return {
    status: res.status,
    coding,
    vary: res.headers.get("vary"),
    contentLength: res.headers.get("content-length"),
    cacheControl: res.headers.get("cache-control"),
    etag: res.headers.get("etag"),
    byteLength: bytes.byteLength,
    digest: new Bun.CryptoHasher("sha256").update(decoded).digest("hex"),
  };
}

const shell = await (await app.fetch(new Request("http://localhost/"))).text();
const entry = shell.match(/src="([^"]+)"/)?.[1];
if (entry === undefined) throw new Error("shell did not contain a script src");
const stylesheet = shell.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
if (stylesheet === undefined) throw new Error("shell did not contain a stylesheet link");

/** Each Accept-Encoding asked with; "none" sends no header. */
const ACCEPTS = ["none", "identity", "gzip", "br", "gzip, deflate, br"] as const;

async function answersFor(path: string): Promise<Record<(typeof ACCEPTS)[number], Answer>> {
  const ask = (accept: (typeof ACCEPTS)[number]) =>
    get(path, accept === "none" ? {} : { "accept-encoding": accept });
  return {
    none: await ask("none"),
    identity: await ask("identity"),
    gzip: await ask("gzip"),
    br: await ask("br"),
    "gzip, deflate, br": await ask("gzip, deflate, br"),
  };
}

const answers = {
  shell: await answersFor("/"),
  entry: await answersFor(entry),
  stylesheet: await answersFor(stylesheet),
};
const brEtag = answers.shell.br.etag ?? "";
const revalidated = {
  sameCoding: await get("/", { "accept-encoding": "br", "if-none-match": brEtag }),
  otherCoding: await get("/", { "accept-encoding": "gzip", "if-none-match": brEtag }),
};
console.log(JSON.stringify({ answers, revalidated }));
process.exit(0);
