// One JSONL line per component boundary a transcript update crosses, so a
// recurrence of "the timeline lagged" can be answered with jq instead of a
// guess. Correlation key is (sid, start, end): every boundary from the daemon's
// file check through the browser's DOM commit carries the same byte range.
import * as fs from "node:fs";

export const TRACE_ROTATE_BYTES = 10 * 1024 * 1024;

export interface TraceRecord {
  ts: string;
  comp: "daemon" | "webui";
  edge: "in" | "out";
  kind: string;
  sid: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/**
 * Appends trace lines off the caller's turn (DR-0029).
 *
 * Design rationale: the instrument sits on the delivery path it measures — one
 * `client_trace` request carries up to 8 points and one tail delivery writes a
 * line per subscriber — so a synchronous stat+open+write+close per line put
 * tens of blocking syscalls between a transcript update and the wire write.
 * Lines produced within one turn are therefore buffered and flushed together
 * through a held descriptor, and the rotation threshold is tracked in memory
 * instead of re-stat'ing the file per line.
 *
 * The tradeoff is deliberate and specific to diagnostics: a buffered line is
 * lost if the process dies before its flush, and trace.jsonl trails real time
 * by up to a turn. Neither costs anything a trace reader relies on — the
 * timestamps are stamped at the boundary, not at write time — and in exchange
 * tracing cannot delay the delivery it exists to observe.
 */
export class TraceWriter {
  private pending: string[] = [];
  /** Flush already scheduled for the current batch, or null when the next
   * `write` starts a new one. Returned to callers so they can await their own
   * line reaching disk. */
  private scheduled: Promise<void> | null = null;
  /** Tail of the flush chain: keeps batches strictly ordered when a write
   * arrives while the previous flush is still in flight. */
  private chain: Promise<void> = Promise.resolve();
  private handle: fs.promises.FileHandle | null = null;
  /** Bytes in the currently open file, tracked from the descriptor's own
   * writes so rotation needs no `stat` per line. */
  private size = 0;

  constructor(
    private readonly path: string,
    private readonly rotateBytes = TRACE_ROTATE_BYTES,
  ) {}

  /** `ts` leads each line so a raw `tail -f` reads chronologically; browser
   * points carry their own `ts` (measured in the tab) and keep it.
   *
   * The returned promise settles once this line is on disk. Callers on a
   * delivery path discard it; the trace is best-effort and never rejects. */
  write(record: Omit<TraceRecord, "ts"> & { ts?: string }): Promise<void> {
    const { ts, ...rest } = record;
    this.pending.push(`${JSON.stringify({ ts: ts ?? new Date().toISOString(), ...rest })}\n`);
    if (this.scheduled === null) {
      // A microtask hop is the batch boundary: everything written in the
      // current synchronous run joins this flush, and nothing later does.
      this.scheduled = this.chain.then(() => this.flush());
      this.chain = this.scheduled;
    }
    return this.scheduled;
  }

  private async flush(): Promise<void> {
    const chunk = this.pending.join("");
    this.pending = [];
    this.scheduled = null;
    if (chunk === "") return;
    try {
      const bytes = Buffer.byteLength(chunk);
      await this.rotateIfNeeded(bytes);
      const handle = await this.open();
      await handle.write(chunk);
      this.size += bytes;
    } catch {
      // tracing must never affect delivery
      await this.closeHandle();
    }
  }

  private async open(): Promise<fs.promises.FileHandle> {
    if (this.handle !== null) return this.handle;
    const handle = await fs.promises.open(this.path, "a");
    this.handle = handle;
    this.size = (await handle.stat()).size;
    return handle;
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    // The open below is what establishes `size`; before it there is nothing to
    // rotate that this writer knows about.
    if (this.handle === null) await this.open();
    if (this.size + incomingBytes <= this.rotateBytes) return;
    // The descriptor follows the file through the rename, so it has to be
    // dropped for the next write to land in a fresh trace.jsonl.
    await this.closeHandle();
    try {
      await fs.promises.rm(`${this.path}.1`, { force: true });
      await fs.promises.rename(this.path, `${this.path}.1`);
    } catch {
      // keep appending when rotation cannot be completed
    }
  }

  /** Releases the held descriptor after any in-flight batch settles. Safe to
   * call when nothing is open. The daemon process exit reclaims the
   * descriptor either way, but callers that create short-lived writers (tests,
   * tooling) need a deterministic way to release it instead of relying on
   * GC — Bun 1.4+ treats an unclosed `FileHandle` collected by GC as an
   * error rather than a silent close. */
  async close(): Promise<void> {
    await this.chain;
    await this.closeHandle();
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    this.size = 0;
    if (handle === null) return;
    try {
      await handle.close();
    } catch {
      // a descriptor we can no longer write to is already forgotten
    }
  }
}
