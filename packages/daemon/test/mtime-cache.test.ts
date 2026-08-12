import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMtimeCache } from "../src/mtime-cache.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-mtime-cache-"));
  cleanup.push(dir);
  return dir;
}

/** Write `content` to `file` and force its mtime to `mtimeMs`. Tests that
 * assert on staleness cannot rely on the clock: two writes inside the same
 * millisecond carry the same mtime, and the cache is meant to notice the
 * change anyway (via size / ino) — so mtime is set explicitly here to test
 * each freshness signal in isolation. */
function writeAt(file: string, content: string, mtimeMs: number): void {
  fs.writeFileSync(file, content);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

describe("createMtimeCache", () => {
  test("reuses the memoized value while the file is unchanged", async () => {
    const dir = fixture();
    const file = path.join(dir, "a.json");
    writeAt(file, "one", 1_000);
    const cache = createMtimeCache<string>(8);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return fs.readFileSync(file, "utf-8");
    };

    expect(await cache.get(file, load)).toBe("one");
    expect(await cache.get(file, load)).toBe("one");
    expect(await cache.get(file, load)).toBe("one");
    expect(loads).toBe(1);
  });

  test("re-reads when mtime moves, even at identical size", async () => {
    // The common shape for a rewritten meta.json / workspace file: same byte
    // count, new content. mtime alone has to carry the invalidation here.
    const dir = fixture();
    const file = path.join(dir, "a.json");
    writeAt(file, "one", 1_000);
    const cache = createMtimeCache<string>(8);
    const load = async () => fs.readFileSync(file, "utf-8");

    expect(await cache.get(file, load)).toBe("one");
    writeAt(file, "two", 2_000);
    expect(await cache.get(file, load)).toBe("two");
  });

  test("re-reads when size moves at an identical mtime", async () => {
    // A rewrite landing in the same millisecond as the read that cached it:
    // mtime cannot see it, size can.
    const dir = fixture();
    const file = path.join(dir, "a.json");
    writeAt(file, "one", 1_000);
    const cache = createMtimeCache<string>(8);
    const load = async () => fs.readFileSync(file, "utf-8");

    expect(await cache.get(file, load)).toBe("one");
    writeAt(file, "one and more", 1_000);
    expect(await cache.get(file, load)).toBe("one and more");
  });

  test("re-reads when the file is replaced with an identical mtime and size", async () => {
    // unlink + recreate: the replacement is a different inode, which is the
    // only signal left when the writer preserved both mtime and length.
    const dir = fixture();
    const file = path.join(dir, "a.json");
    writeAt(file, "one", 1_000);
    const cache = createMtimeCache<string>(8);
    const load = async () => fs.readFileSync(file, "utf-8");

    expect(await cache.get(file, load)).toBe("one");
    fs.rmSync(file);
    writeAt(file, "two", 1_000);
    expect(await cache.get(file, load)).toBe("two");
  });

  test("returns undefined without loading when the path cannot be statted", async () => {
    const dir = fixture();
    const cache = createMtimeCache<string>(8);
    let loads = 0;
    const value = await cache.get(path.join(dir, "missing.json"), async () => {
      loads += 1;
      return "unreachable";
    });
    expect(value).toBeUndefined();
    expect(loads).toBe(0);
  });

  test("a path that disappears stops answering from the cache", async () => {
    const dir = fixture();
    const file = path.join(dir, "a.json");
    writeAt(file, "one", 1_000);
    const cache = createMtimeCache<string>(8);
    const load = async () => "one";

    expect(await cache.get(file, load)).toBe("one");
    fs.rmSync(file);
    expect(await cache.get(file, load)).toBeUndefined();
  });

  test("caches a loader's undefined (a parse failure is not retried per call)", async () => {
    const dir = fixture();
    const file = path.join(dir, "broken.json");
    writeAt(file, "{not json", 1_000);
    const cache = createMtimeCache<unknown>(8);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return undefined;
    };

    expect(await cache.get(file, load)).toBeUndefined();
    expect(await cache.get(file, load)).toBeUndefined();
    expect(loads).toBe(1);
  });

  test("evicts the least recently used path past the cap", async () => {
    const dir = fixture();
    const files = ["a", "b", "c"].map((name) => {
      const file = path.join(dir, `${name}.json`);
      writeAt(file, name, 1_000);
      return file;
    });
    const cache = createMtimeCache<string>(2);
    const loaded: string[] = [];
    const load = (file: string) => async () => {
      loaded.push(path.basename(file));
      return path.basename(file, ".json");
    };

    await cache.get(files[0]!, load(files[0]!));
    await cache.get(files[1]!, load(files[1]!));
    // Touching `a` makes `b` the least recently used, so admitting `c` drops b.
    await cache.get(files[0]!, load(files[0]!));
    await cache.get(files[2]!, load(files[2]!));
    expect(loaded).toEqual(["a.json", "b.json", "c.json"]);

    await cache.get(files[0]!, load(files[0]!)); // still cached
    await cache.get(files[1]!, load(files[1]!)); // evicted, reloads
    expect(loaded).toEqual(["a.json", "b.json", "c.json", "b.json"]);
  });
});
