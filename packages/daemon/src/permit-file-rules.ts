// The file rules a request for permission asks to add (DR-0040 §12), checked
// against the file system when the request comes in: Claude Code lets an
// Edit or a Read through a symlink only when a rule matches the path as
// written and another the real path, so a request that names a path through
// a symlink also names its real path, or is refused with the rule it lacks
// (docs/findings/2026-11-18-permission-rule-path-spelling.md). The forms that
// never match (`Write(...)`, a single `/`) are the request's schema's to
// refuse, before any of this.
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { absoluteFileRuleOf, absoluteFileRuleText, realFileRuleMissingText } from "@ccmsg/protocol";

/** `target` with each symlink it goes through resolved, as far as it exists:
 * the deepest ancestor (or the path itself) that resolves is replaced by its
 * real path, and the rest is put back as written (Python's `os.path.realpath`
 * without `strict`). So a file not made yet, or under a directory not made
 * yet, has the real path it will have. `target` is absolute.
 *
 * An ancestor that does not resolve for any reason (missing, no permission, a
 * loop) is passed over the same way: what cannot be resolved is left as it
 * is written. */
export async function realpathLoose(target: string): Promise<string> {
  const rest: string[] = [];
  let head = target;
  for (;;) {
    try {
      const real = await realpath(head);
      return rest.length === 0 ? real : `${real === "/" ? "" : real}/${rest.join("/")}`;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return target;
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** `abs` split where its first glob character (`*` `?` `[` `{`) is: `head`,
 * the path of the whole segments before the segment holding it (a path on
 * disk, which a realpath resolves), and `tail`, the rest as written (empty
 * when there is no glob). A trailing `/` goes to the tail, so the head names
 * the directory itself. */
function globFreeHead(abs: string): { head: string; tail: string } {
  const segments = abs.split("/");
  let cut = segments.findIndex((segment) => /[*?[{]/.test(segment));
  if (cut === -1) cut = segments.length;
  while (cut > 1 && segments[cut - 1] === "") cut--;
  const head = segments.slice(0, cut).join("/") || "/";
  const tail = cut < segments.length ? `/${segments.slice(cut).join("/")}` : "";
  return { head, tail };
}

/** What `adds`, the rules a request asks to add, lack for the file rules
 * among them to match (DR-0040 §12): for each `//` or `~/` file rule (`~`
 * read as `home`) whose path goes through a symlink, the `//` rule of the
 * same tool that names its real path, unless the request adds a rule naming
 * that path (in either form). Each is a sentence that names the rule as
 * written and the whole rule to add. Empty when nothing is lacking. */
export async function missingRealFileRules(
  adds: readonly string[],
  home: string,
): Promise<string[]> {
  const files = adds.flatMap((rule) => {
    const file = absoluteFileRuleOf(rule, home);
    return file === undefined ? [] : [{ rule, ...file }];
  });
  const named = new Set(files.map((file) => `${file.tool}(${file.path})`));
  const missing: string[] = [];
  for (const file of files) {
    const { head, tail } = globFreeHead(file.path);
    const realHead = await realpathLoose(head);
    const real = `${realHead === "/" && tail !== "" ? "" : realHead}${tail}`;
    if (real === file.path || named.has(`${file.tool}(${real})`)) continue;
    missing.push(realFileRuleMissingText(file.rule, absoluteFileRuleText(file.tool, real)));
  }
  return missing;
}
