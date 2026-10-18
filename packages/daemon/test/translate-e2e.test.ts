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
// this while the protocol/manager mock tests still run. On macOS after
// `just build-translate-helper`, a spawned daemon's own translate service has to
// find that binary from its default path and accept it — the empty batch is the
// webui's capability probe, answered after that check without spawning the
// helper.
//
// Design rationale: no real translation here. Its latency is not this process's
// to bound: Translation.framework runs on the OS's shared on-device model, whose
// other clients (the OS's own periodic text analysis) slow a one-sentence
// request from ~0.5s to 10-30s while they run (measured: issue
// just-test-one-timeout-unidentified). The real helper and Translation.framework
// are exercised once, through the same service and parser, in
// translate-helper.test.ts under a deadline sized for that; the op's reply
// plumbing is covered with a stub translator in translate-op.test.ts.
const helperExists = fs.existsSync(defaultTranslateHelperPaths().binary);
const e2eTest = helperExists ? test : test.skip;
e2eTest("a spawned daemon's translate probe finds the built helper", async () => {
  daemon = await startTestDaemon();
  const client = await connect(daemon.sock);
  try {
    expect(await client.hello({ role: "user" })).toMatchObject({ ok: true });
    const reply = await client.requestOk({ op: "translate", texts: [] });
    expect(reply.ok).toBe(true);
    expect(reply.results).toEqual([]);
  } finally {
    client.close();
  }
});
