import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findSubscribeOwnerFile, watchSubscribeOwner } from "../src/subscribe-owner.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function makeConfigDir(): { configDir: string; sessionsDir: string } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-subscribe-owner-"));
  fixtures.push(configDir);
  const sessionsDir = path.join(configDir, "sessions");
  fs.mkdirSync(sessionsDir);
  return { configDir, sessionsDir };
}

function writeOwner(sessionsDir: string, pid: number, sessionId: string): string {
  const file = path.join(sessionsDir, `${pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid, sessionId }));
  return file;
}

describe("subscribe owner supervision", () => {
  // A sid is owned only by the PID-named, internally consistent registry row;
  // unrelated and malformed rows must not be mistaken for its Claude process.
  test("finds the unique live Claude registry row for the subscribed sid", () => {
    const { configDir, sessionsDir } = makeConfigDir();
    writeOwner(sessionsDir, 101, "other");
    fs.writeFileSync(path.join(sessionsDir, "broken.json"), "not json");
    const expected = writeOwner(sessionsDir, 202, "subscribed");

    expect(findSubscribeOwnerFile(configDir, "subscribed")).toBe(expected);
    expect(findSubscribeOwnerFile(configDir, "missing")).toBeNull();
  });

  // Two PID rows claiming the same sid cannot establish which Claude process
  // owns the sidecar, so ambiguity must disable supervision rather than pick one.
  test("rejects ambiguous duplicate sid ownership", () => {
    const { configDir, sessionsDir } = makeConfigDir();
    writeOwner(sessionsDir, 201, "duplicate");
    writeOwner(sessionsDir, 202, "duplicate");

    expect(findSubscribeOwnerFile(configDir, "duplicate")).toBeNull();
    expect(watchSubscribeOwner(configDir, "duplicate", 20, 20)).toBeNull();
  });

  // `/clear` keeps the Claude PID but rewrites that PID's registry row to the
  // new conversation sid; the old subscribe must then terminate its watch.
  test("becomes stale when the owning PID switches to a new sid", async () => {
    const { configDir, sessionsDir } = makeConfigDir();
    const file = writeOwner(sessionsDir, 303, "old-sid");
    const watch = watchSubscribeOwner(configDir, "old-sid", 20);
    expect(watch).not.toBeNull();

    fs.writeFileSync(file, JSON.stringify({ pid: 303, sessionId: "new-sid" }));
    await watch!.stale;
    watch!.close();
  });

  // A truncate-and-rewrite of the same registry row is an ordinary persistence
  // detail, not a session transition; restoring the same sid within the grace
  // period must keep the subscribe alive.
  test("ignores a transient unreadable registry row that restores the same sid", async () => {
    const { configDir, sessionsDir } = makeConfigDir();
    const file = writeOwner(sessionsDir, 353, "stable-sid");
    const watch = watchSubscribeOwner(configDir, "stable-sid", 10, 40);
    expect(watch).not.toBeNull();

    fs.writeFileSync(file, "");
    setTimeout(() => writeOwner(sessionsDir, 353, "stable-sid"), 5);
    const survived = await Promise.race([
      watch!.stale.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 80)),
    ]);
    expect(survived).toBe(true);
    watch!.close();
  });

  // A normal Claude process exit removes its PID registry row. Once ownership
  // was established unambiguously, removal means the sidecar has no live owner.
  test("becomes stale when the owning Claude registry row disappears", async () => {
    const { configDir, sessionsDir } = makeConfigDir();
    const file = writeOwner(sessionsDir, 404, "owned-sid");
    const watch = watchSubscribeOwner(configDir, "owned-sid", 20);
    expect(watch).not.toBeNull();

    fs.unlinkSync(file);
    await watch!.stale;
    watch!.close();
  });

  // Missing registry support is ambiguous (older Claude, unusual launcher, or
  // config mismatch), so supervision stays disabled instead of killing a valid stream.
  test("does not supervise when initial ownership cannot be proven", () => {
    const { configDir } = makeConfigDir();
    expect(watchSubscribeOwner(configDir, "unknown-sid", 20)).toBeNull();
    expect(watchSubscribeOwner(undefined, "unknown-sid", 20)).toBeNull();
  });
});
