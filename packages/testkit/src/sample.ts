// macOS's `sample` on a process a test started, for a test that wants to say
// what that process's threads were doing when it took long.
//
// `sample <pid> <s> <ms> -file <path>` stops each thread of the process every
// `ms` of its running time and records the stack, for `s` seconds or until it
// is interrupted (SIGINT), and writes the analysis then. It is interrupted
// while the process still runs: one that exits first leaves an analysis with
// an empty call graph (measured with a daemon a test stopped, macOS 26). What
// it writes is long (a call graph per thread), so `summary()` gives each thread's
// most frequent tops of stack: where a thread of bun's pool (`Bun Pool N`, the
// threads node:fs's async operations run on) sat. Bun's own frames carry no
// symbols in a release build; the system's (`stat`, `open`, `kevent64`,
// `__ulock_wait2`) do.
//
// Design rationale: `sample` is not on every machine, and a process may refuse
// it; either is one line in the summary rather than a failure: the sampling is
// there to explain a slow run, not to judge it.
import * as fs from "node:fs";
import * as path from "node:path";

/** The longest a sampling runs, and the spacing of its samples. */
const SAMPLE_SECONDS = 30;
const SAMPLE_INTERVAL_MS = 5;
/** The tops of stack shown per thread. */
const TOPS_SHOWN = 3;

export interface Sampling {
  /** Stop the sampling, while the sampled process still runs: kept, it writes
   * its analysis (which takes a moment); not kept, it is killed. */
  stop(keep: boolean): Promise<void>;
  /** Once the sampling has ended (stopped and kept, or on its own): the
   * sampled threads' most frequent tops of stack, one line each, under
   * `label`; or one line saying why there are none. */
  summary(): Promise<string[]>;
}

/** Start sampling process `pid`, writing in `dir`. */
export function sampleProcess(pid: number, label: string, dir: string): Sampling {
  const file = path.join(dir, `sample-${String(pid)}.txt`);
  let proc: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  let notRun = "";
  let kept = true;
  try {
    proc = Bun.spawn(
      ["sample", String(pid), String(SAMPLE_SECONDS), String(SAMPLE_INTERVAL_MS), "-file", file],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
  } catch (e) {
    notRun = e instanceof Error ? e.message : String(e);
  }
  return {
    stop: async (keep) => {
      if (proc === undefined) return;
      kept = keep;
      proc.kill(keep ? "SIGINT" : "SIGKILL");
      await proc.exited;
    },
    summary: async () => {
      if (proc === undefined) return [`${label}: sample did not start: ${notRun}`];
      if (!kept) return [`${label}: the sampling was not kept`];
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        const why = err.trim().split("\n").at(-1) ?? "";
        return [`${label}: sample wrote nothing (exit ${String(code)}): ${why}`];
      }
      return sampleSummary(text).map((line) => `${label} ${line}`);
    },
  };
}

/** A frame as the summary names it: the function and its image, without the
 * offset and address (`kevent64 (in libsystem_kernel.dylib)`, `??? (in bun)`). */
function frameName(frame: string): string {
  const m = frame.match(/^(.*?\(in [^)]+\))/);
  return (m?.[1] ?? frame).replace(/\s+/g, " ");
}

/** The tops of stack of each thread in `sample`'s call graph, most frequent
 * first: `<thread> (<samples>): <frame> <count>, …`. */
export function sampleSummary(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("Call graph:"));
  const end = lines.findIndex((l) => l.startsWith("Total number in stack"));
  if (start < 0) return ["sample's output has no call graph"];
  const graph = lines.slice(start + 1, end < 0 ? undefined : end);
  const threads: { name: string; samples: number; tops: Map<string, number> }[] = [];
  const frames: { depth: number; count: number; name: string }[] = [];
  const flush = (): void => {
    const thread = threads.at(-1);
    if (thread === undefined) return;
    frames.forEach((f, i) => {
      const next = frames[i + 1];
      if (next !== undefined && next.depth > f.depth) return;
      thread.tops.set(f.name, (thread.tops.get(f.name) ?? 0) + f.count);
    });
    frames.length = 0;
  };
  for (const line of graph) {
    const header = line.match(/^ {4}(\d+) Thread_\d+:?\s*(.*)$/);
    if (header !== null) {
      flush();
      threads.push({
        name: (header[2] ?? "").replace(/\s+/g, " ").trim() || "(unnamed)",
        samples: Number(header[1]),
        tops: new Map(),
      });
      continue;
    }
    const frame = line.match(/^([\s+!:|]*?)(\d+) (\S.*)$/);
    if (frame === null) continue;
    frames.push({
      depth: (frame[1] ?? "").length,
      count: Number(frame[2]),
      name: frameName(frame[3] ?? ""),
    });
  }
  flush();
  return threads.map((t) => {
    const tops = [...t.tops]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOPS_SHOWN)
      .map(([name, count]) => `${name} ${String(count)}`)
      .join(", ");
    return `${t.name} (${String(t.samples)}): ${tops}`;
  });
}
