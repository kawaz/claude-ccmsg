// セッションの面 (CLAUDE_CONFIG_DIR) の正規化。daemon はこの綴りで面を 1 つに
// 数え、その面の state file を 1 度だけ読む。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeConfigDir } from "../src/config-dir.ts";

describe("normalizeConfigDir", () => {
  test("末尾スラッシュ・冗長な区切りを畳んで比較可能な綴りにする", () => {
    expect(normalizeConfigDir("/tmp")).toBe(normalizeConfigDir("/tmp/"));
    expect(normalizeConfigDir("/tmp")).toBe(normalizeConfigDir("/tmp//"));
    expect(normalizeConfigDir("/tmp")).toBe(normalizeConfigDir("/tmp/./"));
  });

  test("symlink を辿って実体の綴りに揃える (面が同じなら綴り違いでも一致)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cfgdir-"));
    try {
      const real = path.join(base, "real-config");
      const link = path.join(base, "link-config");
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      expect(normalizeConfigDir(link)).toBe(normalizeConfigDir(real));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("存在しないパスは realpath できなくても綴りのまま残す (比較材料としては有効)", () => {
    expect(normalizeConfigDir("/definitely/not/here/.claude")).toBe("/definitely/not/here/.claude");
  });

  test("比較材料にならない申告 (空・相対・非文字列) は undefined", () => {
    expect(normalizeConfigDir(undefined)).toBeUndefined();
    expect(normalizeConfigDir("")).toBeUndefined();
    expect(normalizeConfigDir("   ")).toBeUndefined();
    expect(normalizeConfigDir(".claude")).toBeUndefined();
    expect(normalizeConfigDir("~/.claude")).toBeUndefined();
  });
});
