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

interface HelperItemResult {
  ok: boolean;
  text?: string;
  error?: string;
}

interface HelperResponse {
  id: string;
  results: HelperItemResult[];
}

interface PendingRequest {
  /** Number of texts sent — a response whose results.length differs is wire
   * drift (e.g. the helper's decode-error path answers with results:[]), and
   * silently accepting it would hand N callers a shorter array as ok:true. */
  expected: number;
  resolve(results: TranslateResult[]): void;
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

    // Batch API (issue 2026-07-17 #2a): one line in, one line out, containing
    // every text in this call — the helper uses TranslationSession's
    // `translations(from:)` batch call instead of one `translate(_:)` call
    // per line. On a warm persistent helper the measured latency gain is a few
    // percent (2026-07-17: 10-item batch 12.7s vs 12.9s sequential; the PoC's
    // ~2x figure compared cold per-process launches) — the real speedup for
    // multiple thinkings comes from the webui folding N WS round trips into
    // one request (issue #2b), which this N-text wire shape is what enables.
    const id = `${process.pid}-${++this.nextId}`;
    const promise = new Promise<TranslateResult[]>((resolve, reject) => {
      this.pending.set(id, { expected: texts.length, resolve, reject });
    });

    try {
      const input = JSON.stringify({ id, texts }) + "\n";
      const stdin = proc.stdin as Bun.FileSink;
      // FileSink.write/flush return a Promise under backpressure; await both so
      // a broken pipe rejects into this catch instead of floating unobserved.
      await stdin.write(input);
      await stdin.flush();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.pending.delete(id);
      promise.catch(() => {});
      this.failProcess(proc, failure);
      return { ok: false, code: "translate_helper_failed", msg: failure.message };
    }

    try {
      return { ok: true, results: await promise };
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
    if (executable(this.binaryPath) && !this.sourceNewerThanBinary()) {
      return Promise.resolve({ ok: true, results: [] });
    }
    if (!this.buildPromise) {
      this.buildPromise = this.rebuild().finally(() => {
        this.buildPromise = null;
      });
    }
    return this.buildPromise;
  }

  /** The .build/ binary is a gitignored artifact that survives a plugin/repo
   * update. A binary compiled from an older main.swift may speak an older wire
   * protocol (the {id,text}→{id,texts} batch migration is exactly such a
   * change), and using it would fail every translation with "invalid response"
   * until someone deletes the binary by hand — so a source newer than the
   * binary forces a rebuild. Missing source falls back to the existing binary
   * (nothing to compare against). */
  private sourceNewerThanBinary(): boolean {
    try {
      return fs.statSync(this.sourcePath).mtimeMs > fs.statSync(this.binaryPath).mtimeMs;
    } catch {
      return false;
    }
  }

  /** build() plus: a helper process spawned from the pre-rebuild binary keeps
   * speaking the old wire protocol, so it must not serve requests after the
   * binary is replaced — kill it and let the next request spawn the fresh
   * binary. In-flight requests on the old process reject with this reason. */
  private async rebuild(): Promise<TranslateBatchResult> {
    const built = await this.build();
    const proc = this.process;
    if (built.ok && proc) {
      this.failProcess(proc, new Error("translation helper rebuilt; restarting"));
    }
    return built;
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
    if (!Array.isArray(response.results) || response.results.length !== pending.expected) {
      pending.reject(new Error("translation helper returned an invalid response"));
      return;
    }
    const results: TranslateResult[] = [];
    for (const item of response.results) {
      if (item.ok && typeof item.text === "string") {
        results.push({ ok: true, text: item.text });
      } else if (!item.ok && typeof item.error === "string") {
        results.push({ ok: false, error: item.error });
      } else {
        pending.reject(new Error("translation helper returned an invalid response"));
        return;
      }
    }
    pending.resolve(results);
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
