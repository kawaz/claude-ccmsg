// The built-in defaults of autoMode's lists (DR-0063 §7): what
// `claude auto-mode defaults` of the daemon's PATH's claude writes, read once
// per version of that claude. A version is keyed by the claude's realpath and
// mtime, so an update that replaces the binary is a new version; the output
// (82 KB) and `claude --version`'s first line are held for the newest
// version only. A failure is not held: the next read runs claude again.
import * as fs from "node:fs/promises";
import {
  type AutoModeDefaults,
  AutoModeDefaultsTextSchema,
  ErrorCode,
  errorText,
  parseWith,
} from "@ccmsg/protocol";
import { type CommandRun, outputGist } from "./claude-update.ts";

/** How long `claude auto-mode defaults` and `claude --version` together may
 * run (DR-0063 §7; measured 0.4 s for the first). */
export const AUTO_MODE_DEFAULTS_TIMEOUT_MS = 10_000;

export interface AutoModeDefaultsDeps {
  /** The `claude` the daemon's PATH names, or null when it names none. */
  which(): string | null;
  /** Run `argv` with stdin closed in the environment of a launch command
   * (clean_env / keep_env applied), stopping it once `deadline` (epoch ms)
   * passes. */
  run(argv: readonly string[], deadline: number): Promise<CommandRun>;
  now(): number;
}

export type AutoModeDefaultsRead =
  | { ok: true; version: string; label: string; defaults: AutoModeDefaults }
  | { ok: false; code: ErrorCode; msg: string };

interface Held {
  version: string;
  label: string;
  defaults: AutoModeDefaults;
}

/** The version key of the claude at `claude`: its realpath and mtime, an
 * opaque text the webui only hands back. Undefined when it cannot be read. */
async function versionKeyOf(claude: string): Promise<string | undefined> {
  try {
    const real = await fs.realpath(claude);
    const { mtimeMs } = await fs.stat(real);
    return `${real}@${String(mtimeMs)}`;
  } catch {
    return undefined;
  }
}

export class AutoModeDefaultsCache {
  readonly #deps: AutoModeDefaultsDeps;
  #held: Held | undefined;
  /** The run under way for a version, shared by the reads that ask
   * meanwhile. */
  #running: { version: string; read: Promise<AutoModeDefaultsRead> } | undefined;

  constructor(deps: AutoModeDefaultsDeps) {
    this.#deps = deps;
  }

  /** The version key of the PATH's claude now; undefined when the PATH names
   * none or it cannot be read. */
  async version(): Promise<string | undefined> {
    const claude = this.#deps.which();
    return claude === null ? undefined : versionKeyOf(claude);
  }

  /** The built-in defaults of version `version`: refused with invalid_args
   * when the PATH's claude is of another version now (the webui reads the
   * version again). */
  async read(version: string): Promise<AutoModeDefaultsRead> {
    const claude = this.#deps.which();
    if (claude === null) {
      return {
        ok: false,
        code: ErrorCode.claude_not_found,
        msg: "claude is not on the daemon's PATH",
      };
    }
    const now = await versionKeyOf(claude);
    if (now !== version) {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: "the daemon's claude is of another version now; read the project's autoMode again",
      };
    }
    if (this.#held?.version === version) return { ok: true, ...this.#held };
    if (this.#running?.version !== version) {
      const read = this.#runClaude(claude, version);
      this.#running = { version, read };
      void read.finally(() => {
        if (this.#running?.read === read) this.#running = undefined;
      });
    }
    return this.#running.read;
  }

  async #runClaude(claude: string, version: string): Promise<AutoModeDefaultsRead> {
    const deadline = this.#deps.now() + AUTO_MODE_DEFAULTS_TIMEOUT_MS;
    const failed = (msg: string): AutoModeDefaultsRead => ({
      ok: false,
      code: ErrorCode.auto_mode_defaults_unavailable,
      msg,
    });
    const said = (run: CommandRun, what: string): string | { failed: string } => {
      if (run.kind === "timed_out") {
        return {
          failed: `${what} did not end within ${String(AUTO_MODE_DEFAULTS_TIMEOUT_MS / 1000)} s`,
        };
      }
      if (run.code !== 0) {
        const gist = outputGist(run.stderr);
        return { failed: `${what} exited ${String(run.code)}${gist !== "" ? `: ${gist}` : ""}` };
      }
      return run.stdout;
    };
    let defaultsOut: string | { failed: string };
    let versionOut: string | { failed: string };
    try {
      defaultsOut = said(
        await this.#deps.run([claude, "auto-mode", "defaults"], deadline),
        "claude auto-mode defaults",
      );
      if (typeof defaultsOut !== "string") return failed(defaultsOut.failed);
      versionOut = said(await this.#deps.run([claude, "--version"], deadline), "claude --version");
      if (typeof versionOut !== "string") return failed(versionOut.failed);
    } catch (e) {
      return failed(`claude could not be run: ${errorText(e)}`);
    }
    const read = parseWith(AutoModeDefaultsTextSchema, defaultsOut);
    if (!read.ok)
      return failed(`claude auto-mode defaults wrote what does not read: ${read.failure.summary}`);
    const label = versionOut.split("\n")[0]?.trim() ?? "";
    if (label === "") return failed("claude --version wrote nothing");
    const held: Held = { version, label, defaults: read.value };
    this.#held = held;
    return { ok: true, ...held };
  }
}
