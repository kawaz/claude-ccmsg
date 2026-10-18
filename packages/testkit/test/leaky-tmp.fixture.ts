// A test file whose test makes a temp dir and a short one and times out
// before its `finally` could remove them, run by run-tmp.test.ts as a
// `bun test` of its own (the name keeps it out of the suite). It prints both
// paths first.
import { test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shortTmpDir } from "../src/tmp.ts";

test("makes temp dirs and times out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-leaky-"));
  const short = shortTmpDir("ccmsg-leaky-");
  console.log(`dir=${dir}`);
  console.log(`short=${short}`);
  try {
    await new Promise(() => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(short, { recursive: true, force: true });
  }
}, 200);
