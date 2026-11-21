// The rules the daemon writes for a request's project permission to add
// (DR-0040 §12), put together from the rule the agent wrote: Claude Code lets
// an Edit or a Read through only in some forms, and through a symlink only
// when one rule matches the path as written and another the real path
// (docs/findings/2026-11-18-permission-rule-path-spelling.md). The agent is
// not asked to know this: it writes the path as it has it, and the person is
// shown, and the daemon writes, the rules that match.
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { absoluteFileRuleOf, absoluteFileRuleText, fileRuleWrittenForm } from "@ccmsg/protocol";

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

/** The rules to write for adding `rule` (DR-0040 §12): the rule in a form
 * that matches (fileRuleWrittenForm: `Write(...)` → `Edit(...)`, a single
 * leading `/` → `//`), then, for a `//` or `~/` file rule (`~` read as
 * `home`, and kept as written) whose path goes through a symlink, the `//`
 * rule of the same tool that names its real path. Up to a glob character
 * (`*` `?` `[` `{`) the path is resolved, and the glob is put back as
 * written. Any other rule (a relative path, not a file rule) is the one
 * rule. */
export async function addedRules(rule: string, home: string): Promise<string[]> {
  const written = fileRuleWrittenForm(rule);
  const file = absoluteFileRuleOf(written, home);
  if (file === undefined) return [written];
  const { head, tail } = globFreeHead(file.path);
  const realHead = await realpathLoose(head);
  const real = `${realHead === "/" && tail !== "" ? "" : realHead}${tail}`;
  if (real === file.path) return [written];
  return [written, absoluteFileRuleText(file.tool, real)];
}
