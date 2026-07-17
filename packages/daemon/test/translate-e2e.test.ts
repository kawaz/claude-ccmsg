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
e2eTest(
  "daemon translate acks, then the result event carries a real en→ja mixed-text result",
  async () => {
    daemon = await startTestDaemon();
    const client = await connect(daemon.sock);
    try {
      expect(await client.hello({ role: "user" })).toMatchObject({ ok: true });
      const input = "The build completed successfully.ここから日本語です。";
      // 2-phase: positional reply is the ack, the translation itself arrives on
      // the correlated ev:"translate_result" event.
      const ack = await client.request({ op: "translate", request_id: "e2e-1", texts: [input] });
      expect(ack).toEqual({ ok: true, accepted: true, request_id: "e2e-1" });
      const event = await client.readEvent();
      expect(event.ev).toBe("translate_result");
      expect(event.request_id).toBe("e2e-1");
      expect(event.ok).toBe(true);
      expect(event.results).toHaveLength(1);
      expect(event.results[0].ok).toBe(true);
      expect(event.results[0].text).toContain("ここから日本語です。");
      expect(event.results[0].text).not.toContain("The build completed successfully.");
    } finally {
      client.close();
    }
  },
);
