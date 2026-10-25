// A launch command's output too long to answer with (DR-0018 §3.6): written to
// `<state dir>/launches/<launch id>/stdout|stderr`, and the reply carries
// where it is instead of the text. The files live 7 days.
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorText } from "@ccmsg/protocol";

/** Output of this many bytes or more is written to a file rather than
 * answered with. */
export const LAUNCH_OUTPUT_INLINE_LIMIT = 4096;

/** How long a launch's files are kept after they were written. */
export const LAUNCH_OUTPUT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** `<UTC yyyymmddThhmmssZ>-<8 hex>`: when the launch's files were made, so
 * their age is read from the name, and 8 random hex digits so two launches of
 * one second do not share a directory. */
const LAUNCH_ID_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}$/;

export function launchId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

/** When the launch named `name` made its files, or undefined for a name that
 * is not a launch id (not ours to remove). */
function madeAt(name: string): number | undefined {
  const m = LAUNCH_ID_RE.exec(name);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

interface Log {
  warn(msg: string): void;
}

/** Remove the launch directories under `dir` made more than 7 days before
 * `now`. A directory that cannot be removed is logged and left; the next
 * prune tries it again. */
export async function pruneLaunchOutputs(dir: string, now: number, log: Log): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return;
    log.warn(`launch outputs: cannot list ${dir}: ${errorText(e)}`);
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const at = madeAt(name);
      if (at === undefined || now - at <= LAUNCH_OUTPUT_LIFETIME_MS) return;
      try {
        await fs.rm(path.join(dir, name), { recursive: true, force: true });
      } catch (e) {
        log.warn(`launch outputs: cannot remove ${path.join(dir, name)}: ${errorText(e)}`);
      }
    }),
  );
}

/** One launch's output streams, as the reply carries them: the text, or for
 * a stream of LAUNCH_OUTPUT_INLINE_LIMIT bytes or more, where it was written.
 * Nothing is written, not even the directory, when both streams are short. */
export async function launchOutputTexts(
  dir: string,
  streams: { readonly stdout: Uint8Array; readonly stderr: Uint8Array },
  now: Date,
  log: Log,
): Promise<{ stdout: string; stderr: string }> {
  const long = (bytes: Uint8Array): boolean => bytes.byteLength >= LAUNCH_OUTPUT_INLINE_LIMIT;
  if (!long(streams.stdout) && !long(streams.stderr)) {
    return { stdout: utf8(streams.stdout), stderr: utf8(streams.stderr) };
  }
  await pruneLaunchOutputs(dir, now.getTime(), log);
  const launchDir = path.join(dir, launchId(now));
  // The files may hold the prompt (a launch command can print it back), so
  // only this user reads them.
  const made: Promise<void> = fs
    .mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => fs.mkdir(launchDir, { mode: 0o700 }));
  const text = async (name: "stdout" | "stderr", bytes: Uint8Array): Promise<string> => {
    if (!long(bytes)) return utf8(bytes);
    const file = path.join(launchDir, name);
    try {
      await made;
      await fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      return `output is ${String(bytes.byteLength)} bytes, file: ${file}`;
    } catch (e) {
      return `output is ${String(bytes.byteLength)} bytes, not saved: ${errorText(e)}`;
    }
  };
  const [stdout, stderr] = await Promise.all([
    text("stdout", streams.stdout),
    text("stderr", streams.stderr),
  ]);
  return { stdout, stderr };
}

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}
