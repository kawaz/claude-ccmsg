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
  /** Per-request watchdog deadline in ms, given the total input length.
   * Defaults to translateWatchdogTimeoutMs; tests inject a tiny value so the
   * timeout path runs in milliseconds instead of tens of seconds. */
  watchdogTimeoutMs?: (totalChars: number) => number;
}

/** Watchdog budget: Translation.framework answers a short text in ~2s but its
 * latency grows with input size (measured 2026-07-18: 1 sentence 1.8s, 10k
 * chars 89s, 14.7k chars never returned), so the deadline scales with input
 * length. A request that outlives its deadline is assumed wedged — the helper
 * process gives no partial progress signal, so killing it is the only way to
 * unblock the queue (the next request respawns a fresh helper). */
export const WATCHDOG_BASE_MS = 10_000;
export const WATCHDOG_PER_100_CHARS_MS = 1_000;
export const WATCHDOG_MAX_MS = 120_000;

export function translateWatchdogTimeoutMs(totalChars: number): number {
  return Math.min(
    WATCHDOG_MAX_MS,
    WATCHDOG_BASE_MS + Math.ceil(totalChars / 100) * WATCHDOG_PER_100_CHARS_MS,
  );
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
  private readonly watchdogTimeoutMs: (totalChars: number) => number;
  private buildPromise: Promise<TranslateBatchResult> | null = null;
  private startPromise: Promise<Bun.Subprocess> | null = null;
  private process: Bun.Subprocess | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private stopped = false;
  /** Serializes helper I/O: the Swift helper's readLine loop answers one
   * request at a time (measured — see main.swift's comment), so a request
   * written while another is in flight only sits in the stdin buffer. The
   * per-request watchdog must clock actual helper processing, not queue
   * position: without this chain, N parallel paragraph ops (webui fold open,
   * 1 op = 1 paragraph) would start every deadline at write time and the
   * tail of the queue would "time out" before the helper even reads it,
   * killing the helper for everyone. Each link ignores the previous link's
   * outcome — a watchdog-killed request must not fail the queued ones, they
   * respawn via ensureProcess and continue. */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(opts: TranslateServiceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.sourcePath = opts.sourcePath ?? DEFAULT_SOURCE_PATH;
    this.binaryPath = opts.binaryPath ?? DEFAULT_BINARY_PATH;
    this.findSwiftc = opts.findSwiftc ?? (() => Bun.which("swiftc"));
    this.spawn = opts.spawn ?? Bun.spawn;
    this.watchdogTimeoutMs = opts.watchdogTimeoutMs ?? translateWatchdogTimeoutMs;
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

    // Queue behind the in-flight request (see sendChain's docstring): the
    // helper answers serially, so writing early gains nothing and would start
    // the watchdog clock while the request is still queued, not processing.
    // performRequest resolves (never rejects) with a TranslateBatchResult, so
    // the rejection arm below is just belt-and-braces chain hygiene.
    const run = this.sendChain.then(
      () => this.performRequest(texts),
      () => this.performRequest(texts),
    );
    this.sendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performRequest(texts: string[]): Promise<TranslateBatchResult> {
    // Re-check under the chain: stop() may have run while queued, and the
    // helper an earlier link used may have been watchdog-killed — ensureProcess
    // below respawns in that case.
    if (this.stopped) {
      return { ok: false, code: "translate_unavailable", msg: "translation helper is stopped" };
    }
    let proc: Bun.Subprocess;
    try {
      proc = await this.ensureProcess();
    } catch (error) {
      return { ok: false, code: "translate_unavailable", msg: String(error) };
    }

    // Wire shape: one JSONL line in, one line out, carrying every text in
    // this call. The webui sends one text per call (1 op = 1 thinking, kawaz
    // r34 mid=11 — batching many thinkings into one request wedged
    // Translation.framework on large inputs), but the N-text shape stays for
    // the capability probe (texts:[]) and any future multi-text caller.
    const id = `${process.pid}-${++this.nextId}`;
    // Per-request watchdog (DR-0023 addendum): a request that outlives its
    // input-length-scaled deadline means the helper is wedged inside
    // Translation.framework (observed with a 14.7k-char batch that never
    // returned). Kill the process — failProcess rejects every in-flight
    // pending with this reason, and the next translate() call respawns a
    // fresh helper, so one wedged request cannot freeze translation until a
    // daemon restart.
    const deadline = this.watchdogTimeoutMs(texts.reduce((n, t) => n + t.length, 0));
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<TranslateResult[]>((resolve, reject) => {
      this.pending.set(id, {
        expected: texts.length,
        resolve: (results) => {
          if (watchdog !== null) clearTimeout(watchdog);
          resolve(results);
        },
        reject: (error) => {
          if (watchdog !== null) clearTimeout(watchdog);
          reject(error);
        },
      });
    });
    watchdog = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.failProcess(
        proc,
        new Error(`translation helper timed out after ${deadline}ms; helper killed`),
      );
    }, deadline);

    try {
      const input = JSON.stringify({ id, texts }) + "\n";
      const stdin = proc.stdin as Bun.FileSink;
      // FileSink.write/flush return a Promise under backpressure; await both so
      // a broken pipe rejects into this catch instead of floating unobserved.
      await stdin.write(input);
      await stdin.flush();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (watchdog !== null) clearTimeout(watchdog);
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
