// The person's userscript for the webui (DR-0057): the TypeScript or
// JavaScript they save from GLOBALS, checked without being run and built into
// JavaScript as it is saved, kept in the config dir (the source) and the
// state dir (the build), and handed to the browser as the build.
//
// The build is Bun.Transpiler's transformSync, not Bun.build (DR-0057 §2):
// the check refuses every import but a full URL, so there is nothing for a
// bundler to bring in, and the transpiler turns the one module into
// JavaScript in memory, keeping the URL imports as they are.
//
// The check reads the source with Bun's transpiler and never imports or runs
// it (DR-0057 §1): a correct script may touch `document` or `window` at its
// top level, which only a browser has, and the daemon is no place to run what
// the person wrote for the page. What it can tell without running it is what
// would stop the browser from importing the module at all: a syntax error, no
// `userscript` export to call, an import a module loaded from a `blob:` URL
// cannot resolve.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { errorText, parseWith } from "@ccmsg/protocol";

/** What the check made of a source: the JavaScript the browser imports, or
 * what stops it, one problem per entry. */
export type UserscriptCheck =
  | { readonly ok: true; readonly js: string }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The name the webui calls (DR-0057 §4). */
export const USERSCRIPT_EXPORT = "userscript";

/** The file name a problem's position is given under. */
const SOURCE_NAME = "userscript.ts";

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

/** One message Bun's parser throws (a `BuildMessage`), as far as the check
 * says it: what is wrong, and where. */
const BuildMessageSchema = v.object({
  message: v.string(),
  position: v.nullish(
    v.object({
      line: v.number(),
      column: v.number(),
      lineText: v.string(),
    }),
  ),
});

/** A thrown parse failure as lines for the person: Bun throws one message, or
 * an AggregateError of several. Each is `userscript.ts:<line>:<column>:
 * <message>`, then the line and a caret under the column (1-based). */
function parseFailureLines(e: unknown): string[] {
  const thrown: readonly unknown[] = e instanceof AggregateError ? e.errors : [e];
  return thrown.map((one) => {
    const read = parseWith(BuildMessageSchema, one);
    if (!read.ok) return errorText(one);
    const { message, position } = read.value;
    if (position === null || position === undefined) return `${SOURCE_NAME}: ${message}`;
    const caret = `${" ".repeat(Math.max(0, position.column - 1))}^`;
    return `${SOURCE_NAME}:${String(position.line)}:${String(position.column)}: ${message}\n  ${position.lineText}\n  ${caret}`;
  });
}

/** Whether a browser can import `specifier` from a module whose own URL is
 * `blob:` (DR-0057 §1): only a full `https:` / `http:` URL resolves. A bare
 * name has no import map to find it, and a relative or root path has no
 * hierarchical base to resolve against. */
function browserResolvable(specifier: string): boolean {
  return /^https?:\/\//iu.test(specifier);
}

/** Check `source` without running it (DR-0057 §1). */
export function checkUserscript(source: string): UserscriptCheck {
  let scanned: { exports: readonly string[]; imports: readonly { path: string }[] };
  try {
    scanned = transpiler.scan(source);
  } catch (e) {
    return { ok: false, problems: parseFailureLines(e) };
  }
  const problems: string[] = [];
  if (!scanned.exports.includes(USERSCRIPT_EXPORT)) {
    problems.push(
      `${SOURCE_NAME}: \`${USERSCRIPT_EXPORT}\` が export されていない (\`export async function ${USERSCRIPT_EXPORT}(util) { … }\` の形で書く)`,
    );
  }
  for (const { path: specifier } of scanned.imports) {
    if (!browserResolvable(specifier)) {
      problems.push(
        `${SOURCE_NAME}: import "${specifier}" はブラウザで読めない (https:// か http:// で始まる URL だけ import できる)`,
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  try {
    return { ok: true, js: transpiler.transformSync(source) };
  } catch (e) {
    return { ok: false, problems: parseFailureLines(e) };
  }
}

export interface UserscriptFiles {
  /** `<configDir>/userscript.ts` (Paths.userscript): the source as written. */
  readonly source: string;
  /** `<stateDir>/userscript.js` (Paths.userscriptBuilt): its build. */
  readonly built: string;
}

export type UserscriptWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly string[] };

export type UserscriptLoad =
  | { readonly ok: true; readonly js?: string }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface UserscriptStore {
  /** The saved source; null when none is saved. */
  read(): Promise<string | null>;
  /** Check and build `source`, and save the source and its build when both
   * pass. */
  write(source: string): Promise<UserscriptWrite>;
  /** The build of the saved source; no `js` when none is saved. A build that
   * is missing or older than the source (the source was edited by hand, or
   * the state dir was cleared) is made again from the source first. */
  load(): Promise<UserscriptLoad>;
  /** Delete the saved source and its build; false when none was saved. */
  delete(): Promise<boolean>;
}

function isMissing(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Remove `file`; false when it was not there. */
async function removeFile(file: string): Promise<boolean> {
  try {
    await fs.promises.unlink(file);
    return true;
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(file)).mtimeMs;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Write `text` to `file` whole: to a temporary file beside it, then renamed
 * over it, so a crash leaves the old file or the new one. */
async function writeWhole(file: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${String(process.pid)}.${crypto.randomUUID()}.tmp`,
  );
  await fs.promises.writeFile(tmp, text);
  await fs.promises.rename(tmp, file);
}

export function createUserscriptStore(files: UserscriptFiles): UserscriptStore {
  /** Saves and rebuilds, one after another, so that a source and the build
   * of another are never left side by side. */
  let changes: Promise<unknown> = Promise.resolve();
  function serial<T>(change: () => Promise<T>): Promise<T> {
    const done = changes.then(change, change);
    changes = done.catch(() => undefined);
    return done;
  }

  return {
    read: () => readText(files.source),
    write: (source) =>
      serial(async () => {
        const check = checkUserscript(source);
        if (!check.ok) return check;
        // The source first: a crash between the two leaves a build older
        // than its source, which load makes again.
        await writeWhole(files.source, source);
        await writeWhole(files.built, check.js);
        return { ok: true };
      }),
    load: () =>
      serial(async () => {
        const sourceAt = await mtimeOf(files.source);
        if (sourceAt === null) return { ok: true };
        const builtAt = await mtimeOf(files.built);
        if (builtAt !== null && builtAt >= sourceAt) {
          const js = await readText(files.built);
          if (js !== null) return { ok: true, js };
        }
        const source = await readText(files.source);
        if (source === null) return { ok: true };
        const check = checkUserscript(source);
        if (!check.ok) return check;
        await writeWhole(files.built, check.js);
        return { ok: true, js: check.js };
      }),
    delete: () =>
      serial(async () => {
        // The source first: without it nothing is saved, whatever became of
        // the build (load serves no build without a source).
        const had = await removeFile(files.source);
        await removeFile(files.built);
        return had;
      }),
  };
}
