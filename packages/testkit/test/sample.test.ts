// macOS's `sample` on a process a test started (sample.ts): its summary gives
// each thread's most frequent tops of stack, from the call graph `sample`
// writes, or one line saying why there is none.
import { describe, expect, test } from "bun:test";
import { sampleProcess, sampleSummary } from "../src/sample.ts";
import { perTestTmpDir } from "../src/tmp.ts";

const tmpDir = perTestTmpDir();

// The shape `sample` writes, cut down: two threads, the second with two
// leaves under one frame.
const CALL_GRAPH = [
  "Analysis of sampling bun (pid 1) every 5 milliseconds",
  "",
  "Call graph:",
  "    720 Thread_11   DispatchQueue_1: com.apple.main-thread  (serial)",
  "    + 720 start  (in dyld) + 6992  [0x1832cfe00]",
  "    +   689 kevent64  (in libsystem_kernel.dylib) + 8  [0x183655ba8]",
  "    +   31 ???  (in bun)  load address 0x1009b0000 + 0x468c  [0x1009b468c]",
  "    720 Thread_12: Bun Pool 0",
  "    + 720 thread_start  (in libsystem_pthread.dylib) + 8  [0x183688c1c]",
  "    +   600 __openat_nocancel  (in libsystem_kernel.dylib) + 8  [0x18364bbcc]",
  "    +   120 __ulock_wait2  (in libsystem_kernel.dylib) + 8  [0x18364bbcc]",
  "",
  "Total number in stack (recursive counted multiple, when >=5):",
].join("\n");

describe("sampleSummary", () => {
  test("each thread's tops of stack, most frequent first", () => {
    expect(sampleSummary(CALL_GRAPH)).toEqual([
      "DispatchQueue_1: com.apple.main-thread (serial) (720): kevent64 (in libsystem_kernel.dylib) 689, ??? (in bun) 31",
      "Bun Pool 0 (720): __openat_nocancel (in libsystem_kernel.dylib) 600, __ulock_wait2 (in libsystem_kernel.dylib) 120",
    ]);
  });

  test("output without a call graph says so", () => {
    expect(sampleSummary("sample: no such process")).toEqual(["sample's output has no call graph"]);
  });
});

describe("sampleProcess", () => {
  // `sample` is macOS's; elsewhere there is nothing to run it on. A sampling
  // that cannot be made (here: the process is gone) is one line saying why,
  // with what `sample` said, rather than a failure.
  test.skipIf(process.platform !== "darwin")(
    "a process that is not there: one line with what sample said",
    async () => {
      const proc = Bun.spawn(["true"]);
      await proc.exited;
      const lines = await sampleProcess(proc.pid, "gone", tmpDir("ccmsg-sample-")).summary();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^gone: sample wrote nothing \(exit \d+\): \S/);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "a sampling stopped without keeping it says so",
    async () => {
      const proc = Bun.spawn(["true"]);
      await proc.exited;
      const sampling = sampleProcess(proc.pid, "dropped", tmpDir("ccmsg-sample-"));
      await sampling.stop(false);
      expect(await sampling.summary()).toEqual(["dropped: the sampling was not kept"]);
    },
  );
});
