// Each project's autoMode (DR-0063): the person's additions to the auto mode
// classifier's description, kept per project in
// `<config dir>/project-auto-mode.json` and handed to every session the daemon
// starts there and every btw's fork as a settings file (`--settings`) under
// `<state dir>/launch-settings/`.
//
// The file is read again at each use (it is small, and a hand edit then holds
// from the next start without a daemon restart); the daemon writes it only
// for the webui's changes, one after another.
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as v from "valibot";
import {
  AUTO_MODE_DEFAULTS_ENTRY,
  AUTO_MODE_SECTIONS,
  type AutoModeSectionName,
  type AutoModeSections,
  AutoModeSectionsSchema,
  AutoModeSettingsTextSchema,
  ErrorCode,
  errorText,
  PROJECT_AUTO_MODE_SETTINGS_MAX_BYTES,
  type ProjectAutoModeChange,
  type ProjectAutoModeFile,
  ProjectAutoModeFileTextSchema,
  type ProjectKey,
  ProjectKeySchema,
  parseWith,
  type UserAutoMode,
} from "@ccmsg/protocol";
import { deriveLocation } from "./repo-derive.ts";
import { createKeyedSerial, createSerial, type KeyedSerial, type Serial } from "./serial.ts";

/** A project with nothing set: no section has entries. */
export const NOTHING_SET: AutoModeSections = v.parse(AutoModeSectionsSchema, {});

/** How long a settings file not used by a start or a btw is kept
 * (DR-0063 §4). */
export const LAUNCH_SETTINGS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** A project as the daemon keys it, and as the webui names it. */
export interface ProjectPlace {
  key: ProjectKey;
  label: string;
}

/** The project of `cwd` (DR-0063 §3): the repository derived from it, so
 * every workspace, worktree and subdirectory of one repo is one project; or
 * the cwd's realpath when no repository is derived. Undefined for a cwd that
 * is not an absolute path (a session that named none), or whose key the
 * file's schema would not read: such a key, once written, would make the
 * whole file unreadable. */
export async function projectOf(cwd: string): Promise<ProjectPlace | undefined> {
  if (!path.isAbsolute(cwd)) return undefined;
  let real = cwd;
  try {
    real = await fs.realpath(cwd);
  } catch {
    // A cwd that is gone is keyed as it was named.
  }
  const { repository } = await deriveLocation(real);
  const label =
    repository !== undefined ? `${repository.host}/${repository.owner}/${repository.name}` : real;
  const key = parseWith(ProjectKeySchema, `${repository !== undefined ? "repo" : "cwd"}:${label}`);
  return key.ok ? { key: key.value, label } : undefined;
}

export type ProjectAutoModeRead =
  | { ok: true; file: ProjectAutoModeFile }
  | { ok: false; msg: string };

/** `project-auto-mode.json` read: no file is nothing set; a file that is not
 * JSON or not of its shape is a failure, never a guess. */
export async function readProjectAutoModeFile(file: string): Promise<ProjectAutoModeRead> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return { ok: true, file: { projects: {} } };
    }
    return { ok: false, msg: `${file} is not readable: ${errorText(e)}` };
  }
  const read = parseWith(ProjectAutoModeFileTextSchema, text);
  if (!read.ok) return { ok: false, msg: `${file} does not read: ${read.failure.summary}` };
  return { ok: true, file: read.value };
}

/** Project `key`'s sections in `file`: nothing set when it has none. */
export function sectionsOf(file: ProjectAutoModeFile, key: ProjectKey): AutoModeSections {
  return file.projects[key] ?? NOTHING_SET;
}

/** The file's text: a section with no entries left out, and a project whose
 * four sections have none left out whole (DR-0063 §2). Indented, for a
 * person who edits it by hand. */
export function projectAutoModeFileText(file: ProjectAutoModeFile): string {
  const projects: Record<string, Partial<Record<AutoModeSectionName, string[]>>> = {};
  for (const [key, sections] of Object.entries(file.projects)) {
    const written: Partial<Record<AutoModeSectionName, string[]>> = {};
    for (const name of AUTO_MODE_SECTIONS) {
      if (sections[name].length > 0) written[name] = [...sections[name]];
    }
    if (Object.keys(written).length > 0) projects[key] = written;
  }
  return `${JSON.stringify({ projects }, null, 2)}\n`;
}

/** The settings a project's sections make (DR-0063 §4): only the sections
 * with entries, each `$defaults` first, then the entries in the order saved.
 * The project only adds: `$defaults` keeps the built-in defaults where the
 * user's settings do not write the list, which an entry without it would
 * take away. Undefined when no section has an entry. */
export function launchSettingsOf(
  sections: AutoModeSections,
): { text: string; entries: number } | undefined {
  const autoMode: Partial<Record<AutoModeSectionName, string[]>> = {};
  let entries = 0;
  for (const name of AUTO_MODE_SECTIONS) {
    const section = sections[name];
    if (section.length === 0) continue;
    autoMode[name] = [AUTO_MODE_DEFAULTS_ENTRY, ...section];
    entries += section.length;
  }
  if (entries === 0) return undefined;
  return { text: `${JSON.stringify({ autoMode }, null, 2)}\n`, entries };
}

export type SectionChanged =
  | { ok: true; sections: AutoModeSections; changed: boolean }
  | { ok: false; code: ErrorCode; msg: string };

/** `sections` with `change` made to section `name` (DR-0063 §7). An entry is
 * replaced or removed only while it is still `before`: another page may have
 * changed it first. */
export function changeSection(
  sections: AutoModeSections,
  name: AutoModeSectionName,
  change: ProjectAutoModeChange,
): SectionChanged {
  const section = sections[name];
  const withSection = (next: string[]): SectionChanged => ({
    ok: true,
    sections: { ...sections, [name]: next },
    changed: true,
  });
  if (!("index" in change)) {
    if (change.text === "") return { ok: true, sections, changed: false };
    return withSection([...section, change.text]);
  }
  const { index, before, text } = change;
  if (index >= section.length) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: `${name} has ${String(section.length)} entries; there is none at index ${String(index)}`,
    };
  }
  if (section[index] !== before) {
    return {
      ok: false,
      code: ErrorCode.file_conflict,
      msg: `the entry at ${name}[${String(index)}] was changed elsewhere; read it again`,
    };
  }
  return withSection(
    text === ""
      ? section.filter((_, i) => i !== index)
      : section.map((entry, i) => (i === index ? text : entry)),
  );
}

/** Write `text` to `file` through a temporary file beside it and a rename,
 * so a reader never sees half of it. The temporary file is synced before
 * the rename, so a crash leaves the old content or the new, never an empty
 * file under the name. */
async function writeReplacing(file: string, text: string, mode: number): Promise<void> {
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
 * (the person may link it in from their dotfiles, and the link stays) with
 * that file's mode, or `file` itself, 0644 when it is new. */
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

/** The settings bytes a project's sections make. */
function settingsBytes(sections: AutoModeSections): number {
  return Buffer.byteLength(launchSettingsOf(sections)?.text ?? "");
}

export type ProjectAutoModeWritten =
  | { ok: true; project: AutoModeSections; changed: boolean }
  | { ok: false; code: ErrorCode; msg: string };

/** `project-auto-mode.json`, changed one change at a time: each change reads
 * the file as it is then, so two changes in a row both hold. */
export class ProjectAutoModeStore {
  readonly file: string;
  readonly #writes: Serial = createSerial();

  constructor(file: string) {
    this.file = file;
  }

  read(): Promise<ProjectAutoModeRead> {
    return readProjectAutoModeFile(this.file);
  }

  /** Make `change` to section `name` of project `key` and write the file
   * when it changed. Refused, nothing written, when the file does not read,
   * the change does not apply, or the project's settings would grow past
   * PROJECT_AUTO_MODE_SETTINGS_MAX_BYTES (a change that does not make a
   * project over it by hand larger is saved: that is how it comes back
   * under). */
  change(
    key: ProjectKey,
    name: AutoModeSectionName,
    change: ProjectAutoModeChange,
  ): Promise<ProjectAutoModeWritten> {
    return this.#writes(async () => {
      const read = await this.read();
      if (!read.ok) {
        return { ok: false, code: ErrorCode.project_auto_mode_unreadable, msg: read.msg };
      }
      const changed = changeSection(sectionsOf(read.file, key), name, change);
      if (!changed.ok) return changed;
      if (!changed.changed) return { ok: true, project: changed.sections, changed: false };
      const bytes = settingsBytes(changed.sections);
      if (
        bytes > PROJECT_AUTO_MODE_SETTINGS_MAX_BYTES &&
        bytes > settingsBytes(sectionsOf(read.file, key))
      ) {
        return {
          ok: false,
          code: ErrorCode.invalid_args,
          msg: `the project's settings would be ${String(bytes)} bytes, over ${String(PROJECT_AUTO_MODE_SETTINGS_MAX_BYTES)}`,
        };
      }
      const next: ProjectAutoModeFile = {
        projects: { ...read.file.projects, [key]: changed.sections },
      };
      const text = projectAutoModeFileText(next);
      // The daemon never writes a file it would not read back.
      const back = parseWith(ProjectAutoModeFileTextSchema, text);
      if (!back.ok) {
        return {
          ok: false,
          code: ErrorCode.invalid_args,
          msg: `the change would make ${this.file} unreadable: ${back.failure.summary}`,
        };
      }
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const target = await writeTarget(this.file);
        await writeReplacing(target.path, text, target.mode);
      } catch (e) {
        return {
          ok: false,
          code: ErrorCode.project_auto_mode_unreadable,
          msg: `${this.file} was not written: ${errorText(e)}`,
        };
      }
      return { ok: true, project: changed.sections, changed: true };
    });
  }
}

/** The settings file a start or a btw is handed: its path, and how many
 * entries of the project's it carries (logged, never their text). */
export interface LaunchSettings {
  path: string;
  entries: number;
}

export type LaunchSettingsOutcome =
  | { ok: true; settings: LaunchSettings | undefined }
  | { ok: false; msg: string };

export interface LaunchSettingsDeps {
  /** `<config dir>/project-auto-mode.json`. */
  file: string;
  /** `<state dir>/launch-settings`. */
  dir: string;
  now(): Date;
}

/** Remove the settings files not used for LAUNCH_SETTINGS_KEEP_MS, but
 * `keep` (the one handed now). A file that cannot be removed is left for the
 * next time. */
async function pruneLaunchSettings(
  dir: string,
  now: Date,
  keep: string | undefined,
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const before = now.getTime() - LAUNCH_SETTINGS_KEEP_MS;
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      if (file === keep) return;
      try {
        if ((await fs.stat(file)).mtimeMs < before) await fs.rm(file, { force: true });
      } catch {
        // Gone already, or not ours to remove: the next prune tries again.
      }
    }),
  );
}

/** Whether `file` holds `text` now. */
async function holds(file: string, text: string): Promise<boolean> {
  try {
    return (await fs.readFile(file, "utf8")) === text;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
    throw e;
  }
}

/** The settings files are made and pruned one start at a time, per
 * directory: a prune never removes a file another start is handing. */
const launchSettingsTurns: KeyedSerial<string> = createKeyedSerial();

/** The settings file for a start or a btw in `cwd` (DR-0063 §4): made of the
 * project's sections and named by the SHA-256 of its content. A file of the
 * name that holds that content is only touched; one that holds anything else
 * (emptied by a crash, edited by hand) is written again, since claude reads
 * an empty or broken settings file as none. Undefined when the project's
 * sections make no settings. A file that does not read, a cwd that names no
 * project, or a settings file that cannot be written, is a failure: starting
 * without it would silently drop the person's entries. */
export function prepareLaunchSettings(
  deps: LaunchSettingsDeps,
  cwd: string,
): Promise<LaunchSettingsOutcome> {
  return launchSettingsTurns(deps.dir, async () => {
    const now = deps.now();
    const read = await readProjectAutoModeFile(deps.file);
    if (!read.ok) return read;
    const place = await projectOf(cwd);
    if (place === undefined)
      return { ok: false, msg: `the cwd ${JSON.stringify(cwd)} names no project` };
    const made = launchSettingsOf(sectionsOf(read.file, place.key));
    if (made === undefined) {
      await pruneLaunchSettings(deps.dir, now, undefined);
      return { ok: true, settings: undefined };
    }
    const name = `${crypto.createHash("sha256").update(made.text).digest("hex")}.json`;
    const file = path.join(deps.dir, name);
    await pruneLaunchSettings(deps.dir, now, file);
    try {
      await fs.mkdir(deps.dir, { recursive: true, mode: 0o700 });
      // A directory made before (or by another umask) is narrowed too.
      await fs.chmod(deps.dir, 0o700);
      if (await holds(file, made.text)) await fs.utimes(file, now, now);
      else await writeReplacing(file, made.text, 0o600);
    } catch (e) {
      return { ok: false, msg: `the settings file ${file} was not written: ${errorText(e)}` };
    }
    return { ok: true, settings: { path: file, entries: made.entries } };
  });
}

/** The `autoMode` lists `<configDir>/settings.json` writes (DR-0063 §7), or
 * why they were not read: each list's entries but `$defaults`, and the
 * sections whose list is written without it. No file, and an empty list, are
 * nothing written. */
export async function readUserAutoMode(configDir: string | undefined): Promise<UserAutoMode> {
  if (configDir === undefined) return { unavailable: "config dir が分からない" };
  const file = path.join(configDir, "settings.json");
  const config_dir_name = path.basename(configDir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return { config_dir_name, autoMode: {}, defaults_dropped: [] };
    }
    return { unavailable: `settings.json が読めない: ${errorText(e)}` };
  }
  const read = parseWith(AutoModeSettingsTextSchema, text);
  if (!read.ok) return { unavailable: `settings.json が読めない: ${read.failure.summary}` };
  const written = read.value.autoMode ?? {};
  const autoMode: Partial<Record<AutoModeSectionName, string[]>> = {};
  const defaults_dropped: AutoModeSectionName[] = [];
  for (const name of AUTO_MODE_SECTIONS) {
    const list = written[name];
    if (list === undefined) continue;
    autoMode[name] = list.filter((entry) => entry !== AUTO_MODE_DEFAULTS_ENTRY);
    if (list.length > 0 && !list.includes(AUTO_MODE_DEFAULTS_ENTRY)) defaults_dropped.push(name);
  }
  return { config_dir_name, autoMode, defaults_dropped };
}
