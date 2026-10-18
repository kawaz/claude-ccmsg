// A test file that starts a sidecar and does not stop it, run by
// sidecar.test.ts as a `bun test` of its own (the name keeps it out of the
// suite). It prints the sidecar's socket and holds on until its stdin closes,
// so the outer test can reach the sidecar before the run ends.
import { test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { shortTmpDir } from "../../testkit/src/tmp.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("starts a sidecar and leaves it running", async () => {
  const stateDir = path.join(shortTmpDir("ccmsg-leaky-sc-"), "s");
  const sidecar = Bun.spawn(
    [
      process.execPath,
      CLI,
      "sidecar",
      "--sid",
      "11111111-2222-4333-8444-555555555555",
      "--run",
      "leakyrun1",
      "--started-at",
      String(Date.now()),
    ],
    {
      env: { ...process.env, CCMSG_STATE_DIR: stateDir, CCMSG_NO_SELF_EXEC: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const ready = /^ready (.*)\n/.exec(await firstLine(sidecar.stderr));
  console.log(`socket=${ready?.[1] ?? ""}`);
  await new Response(Bun.stdin.stream()).text();
});

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text;
}
