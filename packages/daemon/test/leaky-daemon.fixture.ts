// A test file that starts a daemon and does not stop it, run by
// test-lifeline.test.ts as a `bun test` of its own (the name keeps it out of
// the suite). It prints the daemon's socket and holds on until its stdin
// closes, so the outer test can reach the daemon before the run ends.
import { test } from "bun:test";
import { startTestDaemon } from "./helpers.ts";

test("starts a daemon and leaves it running", async () => {
  const ctx = await startTestDaemon();
  console.log(`sock=${ctx.sock}`);
  await new Response(Bun.stdin.stream()).text();
});
