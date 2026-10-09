// daemon.log writer with single-generation rotation at ~10MB (DR-0002 §7).
import * as fs from "node:fs";

const ROTATE_BYTES = 10 * 1024 * 1024;

/**
 * Design rationale: this is the one writer DR-0029 leaves synchronous. The log
 * records the daemon's own lifecycle, including lines emitted immediately
 * before `process.exit` (startup lock contention, invalid config, graceful
 * shutdown), and a buffered async write would drop exactly the lines that
 * explain why a daemon is gone. What the blocking-IO audit flagged is answered
 * instead by holding the descriptor and tracking the file size in memory: a log
 * line costs one `write` rather than a `stat` + `open` + `write` + `close`, and
 * the frequency is low enough that the remaining write is not what stalls the
 * loop. TraceWriter, whose lines are diagnostics that may be lost, takes the
 * other side of this tradeoff.
 */
/** One log call is one line: a line break or other control character in the
 * message is written as its escape. Messages carry text from outside the
 * daemon (a request's field, a client's error), and a raw line break in one
 * would let that text stand as a log line of its own. */
export function oneLine(msg: string): string {
  let out = "";
  for (const c of msg) {
    const code = c.charCodeAt(0);
    const control = code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
    if (!control) out += c;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

export class Logger {
  private path: string;
  private echoStderr: boolean;
  private fd: number | null = null;
  private size = 0;

  constructor(logPath: string, echoStderr = false) {
    this.path = logPath;
    this.echoStderr = echoStderr;
  }

  log(level: string, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${oneLine(msg)}\n`;
    try {
      this.rotateIfNeeded();
      const fd = this.open();
      const bytes = Buffer.byteLength(line);
      fs.writeSync(fd, line);
      this.size += bytes;
    } catch {
      // logging must never crash the daemon
      this.closeFd();
    }
    if (this.echoStderr) process.stderr.write(line);
  }

  info(msg: string): void {
    this.log("info", msg);
  }
  warn(msg: string): void {
    this.log("warn", msg);
  }
  error(msg: string): void {
    this.log("error", msg);
  }

  private open(): number {
    if (this.fd !== null) return this.fd;
    const fd = fs.openSync(this.path, "a");
    this.fd = fd;
    this.size = fs.fstatSync(fd).size;
    return fd;
  }

  private rotateIfNeeded(): void {
    if (this.fd === null) this.open();
    if (this.size < ROTATE_BYTES) return;
    // The descriptor follows the file through the rename, so it has to be
    // dropped for the next line to land in a fresh daemon.log.
    this.closeFd();
    try {
      fs.renameSync(this.path, `${this.path}.1`);
    } catch {
      // if rotation fails, keep appending to the current file
    }
  }

  private closeFd(): void {
    const fd = this.fd;
    this.fd = null;
    this.size = 0;
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch {
      // a descriptor we can no longer write to is already forgotten
    }
  }
}
