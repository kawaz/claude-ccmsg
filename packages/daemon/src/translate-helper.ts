import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  errorText,
  jsonText,
  parseWith,
  TranslateResultSchema,
  type TranslateResult,
} from "@ccmsg/protocol";
import * as v from "valibot";

export type TranslateBatchResult =
  | { ok: true; results: readonly TranslateResult[] }
  | { ok: false; code: string; msg: string };

export interface TranslateService {
  translate(texts: readonly string[]): Promise<TranslateBatchResult>;
  stop(): void;
}

/** One answer line of the helper (translate-helper/main.swift's
 * TranslationBatchResponse): per text, the translation or the
 * Translation.framework error. Swift's encoder leaves a nil field out, so a
 * result carries `text` or `error`, never both. */
const HelperResponseTextSchema = jsonText(
  v.object({
    id: v.string(),
    results: v.array(TranslateResultSchema),
  }),
);

/** The helper process: its three streams are pipes. */
type HelperProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface PendingRequest {
  /** Number of texts sent — a response whose results.length differs is wire
   * drift (e.g. the helper's decode-error path answers with results:[]), and
   * silently accepting it would hand N callers a shorter array as ok:true. */
  expected: number;
  resolve(results: readonly TranslateResult[]): void;
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

/** Watchdog budget. A request that outlives its deadline is taken as wedged:
 * the helper is killed so the queue behind it moves (the next request
 * respawns a fresh helper).
 *
 * Design rationale: a fixed deadline, not a judgement of whether the helper
 * is still making progress, because nothing the daemon can see tells a
 * wedged request from a waiting one. Translation.framework's
 * `translations(from:)` is a single await with no progress of its own, the
 * helper writes nothing to stdout or stderr until it answers, and its
 * process is alive in both cases. Wedges are real: a 14.7k-char paragraph
 * stopped producing inference requests after about two minutes and had not
 * answered after twelve, with the OS's inference service idle (measured
 * 2026-10-18). Waiting is real too: the on-device model is shared with the
 * OS's own periodic text analysis, during which a one-sentence translation
 * took up to 30.6 s instead of ~0.6 s (2026-10-18; 314 sentences translated
 * through one analysis window: p50 0.63 s, p99 3.6 s, max 10.8 s). The base
 * therefore outlasts the slowest wait observed with a 2x margin, and the
 * per-length part keeps the measured cost of long inputs (10k chars in 89 s,
 * 2026-07-18) under the deadline. The cap bounds how long a wedged long
 * input holds up the queue (docs/findings/2026-07-17-macos-translation-poc.md). */
export const WATCHDOG_BASE_MS = 60_000;
export const WATCHDOG_PER_100_CHARS_MS = 1_000;
export const WATCHDOG_MAX_MS = 240_000;

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

/** Translation.framework answers a single line break with a blank line
 * (measured 2026-10-18: "line one\nline two" comes back as two lines with an
 * empty line between them) and keeps a blank line as it is, so from its
 * answer alone a line break cannot be told apart from a paragraph break. A
 * text is therefore sent as its paragraphs, each its own item of the batch,
 * and a paragraph has no blank line by construction: every run of line
 * breaks in its translation is one line break the framework widened
 * (docs/findings/2026-07-17-macos-translation-poc.md). */
const PARAGRAPH_BREAK = "\n\n";

function paragraphsOf(text: string): string[] {
  return text.split(PARAGRAPH_BREAK);
}

/** A paragraph with nothing but whitespace is kept as it is, not sent. */
function isSent(paragraph: string): boolean {
  return paragraph.trim() !== "";
}

function foldBlankLines(translation: string): string {
  return translation.replace(/\n{2,}/g, "\n");
}

class TranslationHelperService implements TranslateService {
  private readonly platform: NodeJS.Platform;
  private readonly sourcePath: string;
  private readonly binaryPath: string;
  private readonly findSwiftc: () => string | null;
  private readonly spawn: typeof Bun.spawn;
  private readonly watchdogTimeoutMs: (totalChars: number) => number;
  private buildPromise: Promise<TranslateBatchResult> | null = null;
  private startPromise: Promise<HelperProcess> | null = null;
  private process: HelperProcess | null = null;
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

  async translate(texts: readonly string[]): Promise<TranslateBatchResult> {
    if (this.stopped) {
      return { ok: false, code: "translate_unavailable", msg: "translation helper is stopped" };
    }
    const available = await this.ensureExecutable();
    if (!available.ok) return available;
    // The webui uses an empty batch once after hello as a capability probe. It
    // verifies the OS/build prerequisite without paying the session startup cost.
    if (texts.length === 0) return { ok: true, results: [] };

    // A text is sent as its paragraphs (see paragraphsOf) and put back
    // together from their translations.
    const split = texts.map(paragraphsOf);
    const sent = split.flatMap((paragraphs) => paragraphs.filter(isSent));
    const answered = sent.length === 0 ? null : await this.enqueue(sent);
    if (answered !== null && !answered.ok) return answered;
    const translations = answered?.results ?? [];
    let next = 0;
    // performRequest has checked that there is one result per sent paragraph.
    const translateNext = (): TranslateResult => {
      const result = translations[next++] ?? {
        ok: false,
        error: "translation helper returned no result",
      };
      return result.ok ? { ok: true, text: foldBlankLines(result.text) } : result;
    };
    return {
      ok: true,
      results: split.map((paragraphs): TranslateResult => {
        const parts = paragraphs.map(
          (paragraph): TranslateResult =>
            isSent(paragraph) ? translateNext() : { ok: true, text: paragraph },
        );
        const texts: string[] = [];
        for (const part of parts) {
          if (!part.ok) return part;
          texts.push(part.text);
        }
        return { ok: true, text: texts.join(PARAGRAPH_BREAK) };
      }),
    };
  }

  private enqueue(texts: readonly string[]): Promise<TranslateBatchResult> {
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

  private async performRequest(texts: readonly string[]): Promise<TranslateBatchResult> {
    // Re-check under the chain: stop() may have run while queued, and the
    // helper an earlier link used may have been watchdog-killed — ensureProcess
    // below respawns in that case.
    if (this.stopped) {
      return { ok: false, code: "translate_unavailable", msg: "translation helper is stopped" };
    }
    let proc: HelperProcess;
    try {
      proc = await this.ensureProcess();
    } catch (error) {
      return { ok: false, code: "translate_unavailable", msg: errorText(error) };
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
    const promise = new Promise<readonly TranslateResult[]>((resolve, reject) => {
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
      // FileSink.write/flush return a Promise under backpressure; await both so
      // a broken pipe rejects into this catch instead of floating unobserved.
      await proc.stdin.write(input);
      await proc.stdin.flush();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorText(error));
      if (watchdog !== null) clearTimeout(watchdog);
      this.pending.delete(id);
      promise.catch(() => {});
      this.failProcess(proc, failure);
      return { ok: false, code: "translate_helper_failed", msg: failure.message };
    }

    try {
      return { ok: true, results: await promise };
    } catch (error) {
      return { ok: false, code: "translate_helper_failed", msg: errorText(error) };
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
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
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

  private ensureProcess(): Promise<HelperProcess> {
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

  private async readStdout(proc: HelperProcess): Promise<void> {
    const reader = proc.stdout.getReader();
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
      this.failProcess(proc, error instanceof Error ? error : new Error(errorText(error)));
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeStderr(proc: HelperProcess): Promise<void> {
    try {
      await new Response(proc.stderr).text();
    } catch {
      // stderr is diagnostic-only; process exit is handled through proc.exited.
    }
  }

  private acceptResponse(proc: HelperProcess, line: string): void {
    // A line that does not read cannot be told apart from a helper speaking
    // another protocol, so the helper is dropped like one that broke its pipe.
    const response = parseWith(HelperResponseTextSchema, line);
    if (!response.ok) {
      this.failProcess(
        proc,
        new Error(`translation helper returned an invalid response: ${response.failure.summary}`),
      );
      return;
    }
    const { id, results } = response.value;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (results.length !== pending.expected) {
      pending.reject(new Error("translation helper returned an invalid response"));
      return;
    }
    pending.resolve(results);
  }

  private failProcess(proc: HelperProcess, error: Error): void {
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
