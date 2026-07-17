import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TranslateResult } from "@ccmsg/protocol";

export type TranslateBatchResult =
  | { ok: true; results: TranslateResult[] }
  | { ok: false; code: string; msg: string };

export interface TranslateService {
  translate(texts: string[]): Promise<TranslateBatchResult>;
  stop(): void;
}

interface HelperResponse {
  id: string;
  ok: boolean;
  text?: string;
  error?: string;
}

interface PendingRequest {
  resolve(result: TranslateResult): void;
  reject(error: Error): void;
}

export interface TranslateServiceOptions {
  platform?: NodeJS.Platform;
  sourcePath?: string;
  binaryPath?: string;
  findSwiftc?: () => string | null;
  spawn?: typeof Bun.spawn;
}

const DEFAULT_SOURCE_PATH = fileURLToPath(
  new URL("../../translate-helper/main.swift", import.meta.url),
);
const DEFAULT_BINARY_PATH = fileURLToPath(
  new URL("../../translate-helper/.build/translate-helper", import.meta.url),
);

function executable(pathname: string): boolean {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

class TranslationHelperService implements TranslateService {
  private readonly platform: NodeJS.Platform;
  private readonly sourcePath: string;
  private readonly binaryPath: string;
  private readonly findSwiftc: () => string | null;
  private readonly spawn: typeof Bun.spawn;
  private buildPromise: Promise<TranslateBatchResult> | null = null;
  private startPromise: Promise<Bun.Subprocess> | null = null;
  private process: Bun.Subprocess | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private stopped = false;

  constructor(opts: TranslateServiceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.sourcePath = opts.sourcePath ?? DEFAULT_SOURCE_PATH;
    this.binaryPath = opts.binaryPath ?? DEFAULT_BINARY_PATH;
    this.findSwiftc = opts.findSwiftc ?? (() => Bun.which("swiftc"));
    this.spawn = opts.spawn ?? Bun.spawn;
  }

  async translate(texts: string[]): Promise<TranslateBatchResult> {
    if (this.stopped) {
      return { ok: false, code: "translate_unavailable", msg: "translation helper is stopped" };
    }
    const available = await this.ensureExecutable();
    if (!available.ok) return available;
    // The webui uses an empty batch once after hello as a capability probe. It
    // verifies the OS/build prerequisite without paying the session startup cost.
    if (texts.length === 0) return { ok: true, results: [] };

    let proc: Bun.Subprocess;
    try {
      proc = await this.ensureProcess();
    } catch (error) {
      return { ok: false, code: "translate_unavailable", msg: String(error) };
    }

    const requests = texts.map((text) => {
      const id = `${process.pid}-${++this.nextId}`;
      const promise = new Promise<TranslateResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      return { id, text, promise };
    });

    try {
      const input = requests.map(({ id, text }) => JSON.stringify({ id, text })).join("\n") + "\n";
      const stdin = proc.stdin as Bun.FileSink;
      // FileSink.write/flush return a Promise under backpressure; await both so
      // a broken pipe rejects into this catch instead of floating unobserved.
      await stdin.write(input);
      await stdin.flush();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const request of requests) {
        this.pending.delete(request.id);
        request.promise.catch(() => {});
      }
      this.failProcess(proc, failure);
      return { ok: false, code: "translate_helper_failed", msg: failure.message };
    }

    try {
      return { ok: true, results: await Promise.all(requests.map((request) => request.promise)) };
    } catch (error) {
      return { ok: false, code: "translate_helper_failed", msg: String(error) };
    }
  }

  stop(): void {
    this.stopped = true;
    const proc = this.process;
    this.process = null;
    this.startPromise = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
    }
    this.rejectPending(new Error("translation helper stopped"));
  }

  private ensureExecutable(): Promise<TranslateBatchResult> {
    if (this.platform !== "darwin") {
      return Promise.resolve({
        ok: false,
        code: "translate_unavailable",
        msg: "host translation is available only on macOS",
      });
    }
    if (executable(this.binaryPath)) return Promise.resolve({ ok: true, results: [] });
    if (!this.buildPromise) {
      this.buildPromise = this.build().finally(() => {
        this.buildPromise = null;
      });
    }
    return this.buildPromise;
  }

  private async build(): Promise<TranslateBatchResult> {
    const swiftc = this.findSwiftc();
    if (!swiftc) {
      return {
        ok: false,
        code: "translate_unavailable",
        msg: "translation helper is not built and swiftc is unavailable",
      };
    }
    if (!fs.existsSync(this.sourcePath)) {
      return {
        ok: false,
        code: "translate_unavailable",
        msg: `translation helper source not found: ${this.sourcePath}`,
      };
    }
    fs.mkdirSync(path.dirname(this.binaryPath), { recursive: true });
    const build = this.spawn(
      [
        swiftc,
        "-parse-as-library",
        "-framework",
        "Translation",
        this.sourcePath,
        "-o",
        this.binaryPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout as ReadableStream<Uint8Array>).text(),
      new Response(build.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    if (exitCode !== 0 || !executable(this.binaryPath)) {
      const detail = stderr.trim() || stdout.trim() || `swiftc exited ${exitCode}`;
      return {
        ok: false,
        code: "translate_unavailable",
        msg: `failed to build translation helper: ${detail}`,
      };
    }
    return { ok: true, results: [] };
  }

  private ensureProcess(): Promise<Bun.Subprocess> {
    if (this.process && this.process.exitCode === null) return Promise.resolve(this.process);
    if (this.startPromise) return this.startPromise;
    this.startPromise = Promise.resolve().then(() => {
      const proc = this.spawn([this.binaryPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.process = proc;
      this.startPromise = null;
      void this.readStdout(proc);
      void this.consumeStderr(proc);
      void proc.exited.then((code) => {
        if (this.process !== proc) return;
        this.process = null;
        this.rejectPending(new Error(`translation helper exited with code ${code}`));
      });
      return proc;
    });
    return this.startPromise;
  }

  private async readStdout(proc: Bun.Subprocess): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line !== "") this.acceptResponse(proc, line);
        }
      }
    } catch (error) {
      this.failProcess(proc, error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeStderr(proc: Bun.Subprocess): Promise<void> {
    try {
      await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    } catch {
      // stderr is diagnostic-only; process exit is handled through proc.exited.
    }
  }

  private acceptResponse(proc: Bun.Subprocess, line: string): void {
    let response: HelperResponse;
    try {
      response = JSON.parse(line) as HelperResponse;
    } catch {
      this.failProcess(proc, new Error("translation helper returned invalid JSON"));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok && typeof response.text === "string") {
      pending.resolve({ ok: true, text: response.text });
      return;
    }
    if (!response.ok && typeof response.error === "string") {
      pending.resolve({ ok: false, error: response.error });
      return;
    }
    pending.reject(new Error("translation helper returned an invalid response"));
  }

  private failProcess(proc: Bun.Subprocess, error: Error): void {
    if (this.process === proc) this.process = null;
    try {
      proc.kill();
    } catch {
      // Already exited.
    }
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }
}

export function createTranslateService(opts: TranslateServiceOptions = {}): TranslateService {
  return new TranslationHelperService(opts);
}

export function defaultTranslateHelperPaths(): { source: string; binary: string } {
  return { source: DEFAULT_SOURCE_PATH, binary: DEFAULT_BINARY_PATH };
}
