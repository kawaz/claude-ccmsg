// Persisted extra allowed Origins (origins-file.ts) — the reverse-proxy
// allowance that must survive daemon respawns, unlike CCMSG_HTTP_ALLOW_ORIGIN
// (docs/issue/2026-07-12-webui-403-behind-caddy). Covers the read path only:
// the write path is `ccmsg origins add/remove` (plain read-modify-write of the
// same JSON file, exercised via the CLI's own JSON output shape).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOriginsFile } from "../src/origins-file.ts";

const silentLog = { warn: () => {} };

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-origins-"));
  return path.join(dir, "allowed-origins.json");
}

describe("createOriginsFile", () => {
  // The common state until the user's first `origins add`: no file at all.
  // Must behave as "no extra origins", not throw — every Origin-check miss
  // hits this path on a fresh install.
  test("missing file reads as an empty set", () => {
    const of = createOriginsFile(tmpFile(), silentLog);
    expect(of.get().size).toBe(0);
  });

  // Round-trip of the format `ccmsg origins add` writes (JSON string[]).
  test("reads a JSON string[] as a set of origins", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify(["https://a.example", "https://b.example"]));
    const of = createOriginsFile(file, silentLog);
    expect(of.get().has("https://a.example")).toBe(true);
    expect(of.get().has("https://b.example")).toBe(true);
    expect(of.get().size).toBe(2);
  });

  // The whole point of the file over env: an `origins add` while the daemon
  // runs must take effect on the next lookup, no restart. mtime is the
  // change signal — utimesSync makes the mtime step explicit instead of
  // relying on filesystem timestamp granularity within a fast test.
  test("picks up additions on the next get() after the file changes", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify(["https://a.example"]));
    const of = createOriginsFile(file, silentLog);
    expect(of.get().has("https://new.example")).toBe(false);
    fs.writeFileSync(file, JSON.stringify(["https://a.example", "https://new.example"]));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(of.get().has("https://new.example")).toBe(true);
  });

  // Deleting the file (or wiping the data dir) revokes everything — the
  // cache must not keep serving origins whose backing file is gone.
  test("file removal revokes previously cached origins", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify(["https://a.example"]));
    const of = createOriginsFile(file, silentLog);
    expect(of.get().has("https://a.example")).toBe(true);
    fs.rmSync(file);
    expect(of.get().size).toBe(0);
  });

  // Corruption degrades to "no extra origins" with a warn, and the broken
  // content is not re-parsed on every subsequent lookup (mtime-gated).
  test("corrupted JSON reads as empty and warns once per mtime", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{not json");
    let warns = 0;
    const of = createOriginsFile(file, { warn: () => warns++ });
    expect(of.get().size).toBe(0);
    expect(of.get().size).toBe(0);
    expect(warns).toBe(1);
  });

  // Non-string entries (hand-edited file) are skipped, not fatal.
  test("non-string array entries are ignored", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify(["https://a.example", 42, null]));
    const of = createOriginsFile(file, silentLog);
    expect(of.get().size).toBe(1);
    expect(of.get().has("https://a.example")).toBe(true);
  });
});
