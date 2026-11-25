// A file in the config dir the person may write by hand, rewritten by the
// daemon for a change made in the webui (`project-auto-mode.json` of
// DR-0063 §2, `userscript.ts` of DR-0057 §2). The person may keep it in their
// dotfiles and link it in, so a write lands in the file a symlink names and
// leaves the link, and keeps that file's mode.
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Write `text` to `file` through a temporary file beside it and a rename,
 * so a reader never sees half of it. The temporary file is synced before
 * the rename, so a crash leaves the old content or the new, never an empty
 * file under the name. */
export async function writeReplacing(file: string, text: string, mode: number): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", mode);
    try {
      await handle.writeFile(text);
      // The mode the open asked for is narrowed by the umask.
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Where a write of `file` lands and with what mode: the file a symlink names
 * (the link stays) with that file's mode, or `file` itself, 0644 when it is
 * new. */
async function writeTarget(file: string): Promise<{ path: string; mode: number }> {
  try {
    const real = await fs.realpath(file);
    return { path: real, mode: (await fs.stat(real)).mode & 0o7777 };
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT")
      return { path: file, mode: 0o644 };
    throw e;
  }
}

/** Write `text` to the hand-edited `file` whole (its directory made when
 * missing): to the file a symlink names, with its mode, through
 * writeReplacing. */
export async function writeHandEditedFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const target = await writeTarget(file);
  await writeReplacing(target.path, text, target.mode);
}
