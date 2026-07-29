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

export class TraceWriter {
  constructor(
    private readonly path: string,
    private readonly rotateBytes = TRACE_ROTATE_BYTES,
  ) {}

  /** `ts` leads each line so a raw `tail -f` reads chronologically; browser
   * points carry their own `ts` (measured in the tab) and keep it. */
  write(record: Omit<TraceRecord, "ts"> & { ts?: string }): void {
    const { ts, ...rest } = record;
    const line = `${JSON.stringify({ ts: ts ?? new Date().toISOString(), ...rest })}\n`;
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.path, line);
    } catch {
      // tracing must never affect delivery
    }
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      size = fs.statSync(this.path).size;
    } catch {
      return;
    }
    if (size + incomingBytes <= this.rotateBytes) return;
    try {
      fs.rmSync(`${this.path}.1`, { force: true });
      fs.renameSync(this.path, `${this.path}.1`);
    } catch {
      // keep appending when rotation cannot be completed
    }
  }
}
