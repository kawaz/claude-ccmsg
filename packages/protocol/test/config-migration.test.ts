import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateLegacyConfigFiles, resolvePaths } from "../src/index.ts";

function tmpPaths(): ReturnType<typeof resolvePaths> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-migrate-"));
  const paths = resolvePaths({
    CCMSG_STATE_DIR: path.join(base, "s"),
    CCMSG_CONFIG_DIR: path.join(base, "c"),
    CCMSG_DATA_DIR: path.join(base, "d"),
  } as NodeJS.ProcessEnv);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  return paths;
}

function collector(): {
  info: string[];
  warn: string[];
  log: { info(m: string): void; warn(m: string): void };
} {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, log: { info: (m) => info.push(m), warn: (m) => warn.push(m) } };
}

describe("migrateLegacyConfigFiles", () => {
  // An install that predates the config/ split left both files in data/; the
  // daemon must find them at the new paths without the user doing anything.
  test("moves legacy config files from data/ to config/", () => {
    const paths = tmpPaths();
    fs.writeFileSync(path.join(paths.dataDir, "config.json"), '{"llm_usage_url":"http://x/"}');
    fs.writeFileSync(path.join(paths.dataDir, "allowed-origins.json"), '["https://a.example"]');
    const c = collector();

    migrateLegacyConfigFiles(paths, c.log);

    expect(fs.readFileSync(paths.config, "utf8")).toBe('{"llm_usage_url":"http://x/"}');
    expect(fs.readFileSync(paths.allowedOrigins, "utf8")).toBe('["https://a.example"]');
    expect(fs.existsSync(path.join(paths.dataDir, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(paths.dataDir, "allowed-origins.json"))).toBe(false);
    expect(c.info).toHaveLength(2);
    expect(c.warn).toEqual([]);
  });

  // Only the files that exist move; a partially migrated install is normal.
  test("leaves absent files alone and creates nothing", () => {
    const paths = tmpPaths();
    fs.writeFileSync(path.join(paths.dataDir, "config.json"), "{}");
    const c = collector();

    migrateLegacyConfigFiles(paths, c.log);

    expect(fs.existsSync(paths.config)).toBe(true);
    expect(fs.existsSync(paths.allowedOrigins)).toBe(false);
    expect(c.info).toHaveLength(1);
  });

  // Both present means the user may have edited either one, so the new path
  // wins and the legacy file is preserved untouched for them to inspect.
  test("keeps the config/ copy and does not touch the legacy one when both exist", () => {
    const paths = tmpPaths();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.config, '{"current":true}');
    fs.writeFileSync(path.join(paths.dataDir, "config.json"), '{"stale":true}');
    const c = collector();

    migrateLegacyConfigFiles(paths, c.log);

    expect(fs.readFileSync(paths.config, "utf8")).toBe('{"current":true}');
    expect(fs.readFileSync(path.join(paths.dataDir, "config.json"), "utf8")).toBe('{"stale":true}');
    expect(c.warn).toHaveLength(1);
    expect(c.warn[0]).toContain("both exist");
  });

  // Running twice must be a no-op, since every daemon start calls this.
  test("is idempotent", () => {
    const paths = tmpPaths();
    fs.writeFileSync(path.join(paths.dataDir, "config.json"), "{}");
    const first = collector();
    migrateLegacyConfigFiles(paths, first.log);
    const second = collector();

    migrateLegacyConfigFiles(paths, second.log);

    expect(second.info).toEqual([]);
    expect(second.warn).toEqual([]);
    expect(fs.readFileSync(paths.config, "utf8")).toBe("{}");
  });

  // CCMSG_CONFIG_DIR pointed at the data dir would make "legacy" and "new" the
  // same file; moving it onto itself must not be attempted.
  test("does nothing when config and data resolve to the same dir", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-migrate-same-"));
    const paths = resolvePaths({
      CCMSG_STATE_DIR: path.join(base, "s"),
      CCMSG_CONFIG_DIR: base,
      CCMSG_DATA_DIR: base,
    } as NodeJS.ProcessEnv);
    fs.writeFileSync(path.join(base, "config.json"), "{}");
    const c = collector();

    migrateLegacyConfigFiles(paths, c.log);

    expect(fs.readFileSync(path.join(base, "config.json"), "utf8")).toBe("{}");
    expect(c.info).toEqual([]);
    expect(c.warn).toEqual([]);
  });
});
