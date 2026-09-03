import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { defaultTranslateHelperPaths } from "../src/translate-helper.ts";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";

let daemon: DaemonCtx | null = null;

afterEach(async () => {
  if (daemon) await stopTestDaemon(daemon);
  daemon = null;
});

// A fresh checkout and Linux CI have no generated helper binary, so they skip
// Translation.framework execution while protocol/manager mock tests still run.
// On macOS after `just build-translate-helper`, this exercises the real daemon,
// persistent Swift child process, JSONL correlation, and mixed-text translation.
const helperExists = fs.existsSync(defaultTranslateHelperPaths().binary);
const e2eTest = helperExists ? test : test.skip;
e2eTest("daemon translate replies with a real en→ja mixed-text result", async () => {
  daemon = await startTestDaemon();
  const client = await connect(daemon.sock);
  try {
    expect(await client.hello({ role: "user" })).toMatchObject({ ok: true });
    const input = "The build completed successfully.ここから日本語です。";
    const reply = await client.request({ op: "translate", request_id: "e2e-1", texts: [input] });
    expect(reply.ok).toBe(true);
    expect(reply.results).toHaveLength(1);
    expect(reply.results[0].ok).toBe(true);
    expect(reply.results[0].text).toContain("ここから日本語です。");
    expect(reply.results[0].text).not.toContain("The build completed successfully.");
  } finally {
    client.close();
  }
});
