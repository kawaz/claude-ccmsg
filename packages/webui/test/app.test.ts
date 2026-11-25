import { beforeAll, describe, expect, test } from "bun:test";
import { constants } from "node:zlib";
import * as v from "valibot";
import { createWebuiApp } from "../src/index.ts";
import { isUnknownAppPath } from "../src/client/utils.ts";

const Answer = v.object({
  status: v.number(),
  coding: v.nullable(v.string()),
  etag: v.nullable(v.string()),
  digest: v.string(),
});
const Answers = v.object({ shell: Answer, entry: Answer, stylesheet: Answer });
/** What brotli-later.fixture.ts prints. */
const BrotliLaterSeen = v.object({
  before: Answers,
  identity: Answers,
  after: Answers,
  shellEtags: v.object({ gzipBefore: v.number(), gzipAfter: v.number(), brAfter: v.number() }),
  gzipOnlyAfter: v.nullable(v.string()),
  /** brotli-stub.ts's record: while held back, and once prepare has settled. */
  brotli: v.object({
    heldBack: v.object({ asked: v.number(), started: v.number() }),
    prepared: v.object({
      asked: v.array(v.nullable(v.union([v.number(), v.boolean()]))),
      started: v.number(),
    }),
  }),
});

const CodedAnswer = v.object({
  status: v.number(),
  coding: v.nullable(v.string()),
  vary: v.nullable(v.string()),
  contentLength: v.nullable(v.string()),
  cacheControl: v.nullable(v.string()),
  etag: v.nullable(v.string()),
  byteLength: v.number(),
  digest: v.string(),
});
const ByAccept = v.object({
  none: CodedAnswer,
  identity: CodedAnswer,
  gzip: CodedAnswer,
  br: CodedAnswer,
  "gzip, deflate, br": CodedAnswer,
});
/** What compressed-assets.fixture.ts prints. */
const CompressedSeen = v.object({
  answers: v.object({ shell: ByAccept, entry: ByAccept, stylesheet: ByAccept }),
  revalidated: v.object({ sameCoding: CodedAnswer, otherCoding: CodedAnswer }),
});

/** Run a fixture in a process of its own and parse what it prints. */
async function runFixture<S extends v.GenericSchema>(
  name: string,
  schema: S,
): Promise<v.InferOutput<S>> {
  const proc = Bun.spawn([process.execPath, new URL(`./${name}`, import.meta.url).pathname], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return v.parse(schema, JSON.parse(out));
}

async function shellAndBundlePath(): Promise<{
  app: ReturnType<typeof createWebuiApp>;
  path: string;
  stylesheetPath: string;
}> {
  const app = createWebuiApp();
  const body = await (await app.fetch(new Request("http://localhost/"))).text();
  const path = body.match(/src="([^"]+)"/)?.[1];
  if (!path) throw new Error("shell did not contain a script src");
  const stylesheetPath = body.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
  if (!stylesheetPath) throw new Error("shell did not contain a stylesheet link");
  return { app, path, stylesheetPath };
}

describe("createWebuiApp", () => {
  // The build and the compression run on the process's pool of threads (as
  // many as the cores) for a second or more, and every async file read the
  // process makes meanwhile waits: creating the app starts nothing, and
  // prepare (which the daemon calls once it listens for HTTP) starts the
  // build. In a process of its own, since the bundle is loaded once per
  // process and this one may have built it already.
  test("creating the app builds nothing; prepare starts the build", async () => {
    const proc = Bun.spawn(
      [process.execPath, new URL("./prepare.fixture.ts", import.meta.url).pathname],
      { stdout: "pipe", stderr: "inherit" },
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toBe('{"afterCreate":0,"afterPrepare":1}');
  });

  test("the shell points at a content-hashed bundle and requires revalidation", async () => {
    const { app, path } = await shellAndBundlePath();
    expect(path).toMatch(/^\/assets\/app\.[0-9a-z]+\.js$/);
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const etag = res.headers.get("etag");
    if (etag === null) throw new Error("the shell has no etag");
    const revalidated = await app.fetch(
      new Request("http://localhost/s/s1/status", { headers: { "if-none-match": etag } }),
    );
    expect(revalidated.status).toBe(304);
  });

  test("the hashed bundle is immutable and an unrecognized hash is not executable", async () => {
    const { app, path } = await shellAndBundlePath();
    const res = await app.fetch(new Request(`http://localhost${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = await res.text();
    expect(body).toContain("ccmsg.recent.");
    expect(body).toContain("navigate");

    const missing = await app.fetch(new Request("http://localhost/assets/app.deadbeefdeadbeef.js"));
    expect(missing.status).toBe(404);
  });

  // The syntax highlighter and its grammars are the largest part of the
  // client and nothing the first page load runs (client/highlight.ts), so
  // they are fetched on demand as chunks, not shipped in the entry. Every
  // file the entry can pull in (dynamic imports, and the static imports the
  // chunks make, including back into the entry) must be served under the
  // name it is imported by.
  test("the entry leaves the highlighter grammars to chunks, and every import between them is served immutable", async () => {
    const { app, path } = await shellAndBundlePath();
    const bodies = new Map<string, string>();
    const pending = [path];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (bodies.has(next)) continue;
      const res = await app.fetch(new Request(`http://localhost${next}`));
      expect({ path: next, status: res.status }).toEqual({ path: next, status: 200 });
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const body = await res.text();
      bodies.set(next, body);
      for (const m of body.matchAll(/(?:from|import)\s*\(?\s*"\.\/([^"]+\.js)"/g)) {
        pending.push(`/assets/${m[1]}`);
      }
    }
    expect(bodies.size).toBeGreaterThan(1);
    // A grammar is recognizable by its TextMate scope name.
    expect(bodies.get(path)).not.toContain('"source.tsx"');
    expect(Array.from(bodies.values()).some((body) => body.includes('"source.tsx"'))).toBe(true);
  });

  test("the shell links a content-hashed stylesheet that is served as written and immutable", async () => {
    const { app, stylesheetPath } = await shellAndBundlePath();
    expect(stylesheetPath).toMatch(/^\/assets\/app\.[0-9a-f]{16}\.css$/);
    const res = await app.fetch(new Request(`http://localhost${stylesheetPath}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const source = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    expect(await res.text()).toBe(source);
    const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex").slice(0, 16);
    expect(stylesheetPath).toBe(`/assets/app.${hash}.css`);

    const missing = await app.fetch(
      new Request("http://localhost/assets/app.deadbeefdeadbeef.css"),
    );
    expect(missing.status).toBe(404);
  });

  test("an unhashed /app.css is not a stylesheet path, so it gets the shell", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/app.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("real SPA paths and unknown paths both serve the recoverable shell", async () => {
    const app = createWebuiApp();
    for (const path of ["/s/s1/files?path=a.ts", "/r/r1/m4", "/does-not-exist"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  // The shell is the webui itself: put in an iframe of any other page, it
  // runs, opens /ws with the webui's own Origin (which the daemon admits) and
  // acts on the clicks it gets, while the page around it decides what the
  // person sees. Nothing frames the shell (the webui's own iframes hold other
  // documents: the Terminal tab's gateway, a sandbox-origin preview), so no
  // page may: `frame-ancestors 'none'`, the webui's own origin included. A
  // revalidation (304) carries it too, since the browser takes the headers of
  // a 304 over the cached ones.
  test("the shell may not be framed by any page, its revalidation included", async () => {
    const app = createWebuiApp();
    for (const path of ["/", "/s/s1/timeline", "/does-not-exist"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`));
      expect({ path, csp: res.headers.get("content-security-policy") }).toEqual({
        path,
        csp: "frame-ancestors 'none'",
      });
      const etag = res.headers.get("etag");
      if (etag === null) throw new Error("the shell has no etag");
      const revalidated = await app.fetch(
        new Request(`http://localhost${path}`, { headers: { "if-none-match": etag } }),
      );
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
  });
});

// A prepared app's answers in every coding. In a process of its own with
// node:zlib's brotli replaced (brotli-stub.ts), so the br bodies are made at
// the lowest quality: what is checked here is which coding is served and
// what it decodes to, and the quality the app asks for is checked in
// "brotli after gzip".
describe("compressed assets", () => {
  let seen: v.InferOutput<typeof CompressedSeen>;
  beforeAll(async () => {
    seen = await runFixture("compressed-assets.fixture.ts", CompressedSeen);
  });

  test("bundle, stylesheet and shell come in the coding Accept-Encoding asks for and decode to the uncompressed body", () => {
    for (const name of ["entry", "stylesheet", "shell"] as const) {
      const plain = seen.answers[name].none;
      expect(plain.coding).toBeNull();
      expect(plain.vary).toBe("accept-encoding");
      expect(plain.contentLength).toBe(String(plain.byteLength));
      for (const coding of ["br", "gzip"] as const) {
        const encoded = seen.answers[name][coding];
        expect(encoded.coding).toBe(coding);
        expect(encoded.vary).toBe("accept-encoding");
        expect(encoded.contentLength).toBe(String(encoded.byteLength));
        expect(encoded.byteLength).toBeLessThan(plain.byteLength);
        expect(encoded.digest).toBe(plain.digest);
      }
    }
  });

  test("the hashed bundle and stylesheet stay immutable in every coding", () => {
    for (const name of ["entry", "stylesheet"] as const) {
      for (const accept of ["none", "gzip", "gzip, deflate, br"] as const) {
        expect(seen.answers[name][accept].cacheControl).toBe("public, max-age=31536000, immutable");
      }
    }
  });

  test("the shell's etag names its coding, and only the same coding's etag revalidates", () => {
    const etags = (["identity", "br", "gzip"] as const).map((coding) => {
      const etag = seen.answers.shell[coding].etag;
      if (etag === null) throw new Error(`the ${coding} shell has no etag`);
      return etag;
    });
    expect(new Set(etags).size).toBe(3);
    expect(seen.revalidated.sameCoding.status).toBe(304);
    expect(seen.revalidated.otherCoding.status).toBe(200);
    expect(seen.revalidated.otherCoding.coding).toBe("gzip");
  });
});

// Brotli at the highest quality takes a second or more and holds a thread of
// the process's pool while it runs, so the app answers in gzip as soon as the
// bundle is built and gzipped, makes the brotli bodies after, and answers in
// br from then on: the same bytes either way, and a validator for one coding
// never revalidates the other. In a process of its own (the assets are loaded
// once per process), which holds the brotli back until it has asked, and
// records the brotli the app asks for (brotli-stub.ts).
describe("brotli after gzip", () => {
  test("gzip before the brotli is made, br after, the same content in both, and each coding its own etag", async () => {
    const seen = await runFixture("brotli-later.fixture.ts", BrotliLaterSeen);
    // While held back the app had asked for brotli, and none had started.
    expect(seen.brotli.heldBack.asked).toBeGreaterThan(0);
    expect(seen.brotli.heldBack.started).toBe(0);
    // Every brotli the app asked for is at the highest quality, and all of
    // them were made by the time prepare settled.
    expect(seen.brotli.prepared.asked.length).toBeGreaterThan(0);
    for (const quality of seen.brotli.prepared.asked) {
      expect(quality).toBe(constants.BROTLI_MAX_QUALITY);
    }
    expect(seen.brotli.prepared.started).toBe(seen.brotli.prepared.asked.length);
    for (const name of ["shell", "entry", "stylesheet"] as const) {
      expect({ name, status: seen.before[name].status, coding: seen.before[name].coding }).toEqual({
        name,
        status: 200,
        coding: "gzip",
      });
      expect({ name, status: seen.after[name].status, coding: seen.after[name].coding }).toEqual({
        name,
        status: 200,
        coding: "br",
      });
      expect(seen.identity[name].coding).toBeNull();
      expect(seen.before[name].digest).toBe(seen.identity[name].digest);
      expect(seen.after[name].digest).toBe(seen.identity[name].digest);
    }
    expect(seen.before.shell.etag).toBe(`"${seen.identity.shell.digest}-gzip"`);
    expect(seen.after.shell.etag).toBe(`"${seen.identity.shell.digest}-br"`);
    expect(seen.shellEtags).toEqual({ gzipBefore: 304, gzipAfter: 200, brAfter: 304 });
    expect(seen.gzipOnlyAfter).toBe("gzip");
  });
});

describe("isUnknownAppPath", () => {
  test("root, session tabs, agent timelines, and room messages are known", () => {
    for (const path of [
      "/",
      "/index.html",
      "/s/s1",
      "/s/s1/files",
      "/s/s1/timeline/head",
      "/s/s1/timeline/agent/sub/a1",
      "/s/s1/terminal",
      "/s/s1/status",
      "/r/r1",
      "/r/r1/m42",
    ]) {
      expect(isUnknownAppPath(path)).toBe(false);
    }
  });

  test("non-app and malformed paths are unknown", () => {
    for (const path of [
      "/fixtures/a.json",
      "/does-not-exist",
      "/s/s1/nope",
      "/s/s1/rooms",
      "/r/r1/nope",
    ]) {
      expect(isUnknownAppPath(path)).toBe(true);
    }
  });
});
