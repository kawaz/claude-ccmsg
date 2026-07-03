// daemon.log writer with single-generation rotation at ~10MB (DR-0002 §7).
import * as fs from "node:fs";

const ROTATE_BYTES = 10 * 1024 * 1024;

export class Logger {
  private path: string;
  private echoStderr: boolean;

  constructor(logPath: string, echoStderr = false) {
    this.path = logPath;
    this.echoStderr = echoStderr;
  }

  log(level: string, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.path, line);
    } catch {
      // logging must never crash the daemon
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

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fs.statSync(this.path).size;
    } catch {
      return; // file doesn't exist yet
    }
    if (size < ROTATE_BYTES) return;
    try {
      fs.renameSync(this.path, `${this.path}.1`);
    } catch {
      // if rotation fails, keep appending to the current file
    }
  }
}
