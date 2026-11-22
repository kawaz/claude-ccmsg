// A project's autoMode (DR-0063): what the person adds, per project (a repo,
// or a cwd under none), to the auto mode classifier's description, which the
// daemon hands every session it starts there and every btw's fork through
// `--settings`. As schemas (DR-0038): the hand-editable file, the three ops'
// requests and replies, and the push of a project's change.
//
// Only the webui reads the ops (user role), and the daemon serves the webui's
// bundle. Imports nothing but valibot and the schema files beside it, as the
// other schema files.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** The four lists of `autoMode`, in the order the webui shows them. */
export const AUTO_MODE_SECTIONS = ["environment", "allow", "soft_deny", "hard_deny"] as const;
export const AutoModeSectionNameSchema = v.picklist(AUTO_MODE_SECTIONS);
export type AutoModeSectionName = Output<typeof AutoModeSectionNameSchema>;

/** The entry that stands, in a list of Claude Code's settings, for the
 * built-in defaults of that list. A project's section says it with its
 * `defaults` instead (DR-0063 §2). */
export const AUTO_MODE_DEFAULTS_ENTRY = "$defaults";

/** The longest entry, in characters: every entry is put before the
 * classifier at each decision (DR-0063 §2). */
export const AUTO_MODE_ENTRY_MAX_LENGTH = 2000;

/** The largest settings JSON one project's autoMode may make, in UTF-8
 * bytes (DR-0063 §2). */
export const PROJECT_AUTO_MODE_SETTINGS_MAX_BYTES = 32 * 1024;

const ENTRY_LENGTH_MESSAGE = `Expected an entry of at most ${String(AUTO_MODE_ENTRY_MAX_LENGTH)} characters`;
const DEFAULTS_ENTRY_MESSAGE = "$defaults is the section's `defaults`, not an entry";

/** One entry of a project's section: a sentence the classifier reads, line
 * breaks allowed, the surrounding blanks dropped. */
export const AutoModeEntrySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, "Expected an entry, not an empty text"),
  v.maxLength(AUTO_MODE_ENTRY_MAX_LENGTH, ENTRY_LENGTH_MESSAGE),
  v.check((s) => s !== AUTO_MODE_DEFAULTS_ENTRY, DEFAULTS_ENTRY_MESSAGE),
);

/** A project's section: whether `$defaults` goes first ("$defaults を入れる",
 * on when not written) and its entries in the order saved. */
export const AutoModeSectionSchema = v.strictObject({
  defaults: v.optional(v.boolean(), true),
  entries: v.optional(v.array(AutoModeEntrySchema), []),
});
export type AutoModeSection = Output<typeof AutoModeSectionSchema>;

/** A project's four sections, a section not written being as it is when
 * nothing is set. */
export const AutoModeSectionsSchema = v.strictObject({
  environment: v.optional(AutoModeSectionSchema, {}),
  allow: v.optional(AutoModeSectionSchema, {}),
  soft_deny: v.optional(AutoModeSectionSchema, {}),
  hard_deny: v.optional(AutoModeSectionSchema, {}),
});
export type AutoModeSections = Output<typeof AutoModeSectionsSchema>;

/** A project's key (DR-0063 §3): `repo:<host>/<owner>/<name>` for a cwd a
 * repository is derived from, else `cwd:<the cwd's realpath>`. */
export const ProjectKeySchema = v.pipe(
  v.string(),
  v.regex(
    /^(?:repo:[^/]+\/.+\/[^/]+|cwd:\/.*)$/s,
    "Expected repo:<host>/<owner>/<name> or cwd:<absolute path>",
  ),
);
export type ProjectKey = Output<typeof ProjectKeySchema>;

/** `<config dir>/project-auto-mode.json`: every project's sections. A person
 * may edit it by hand; the daemon writes it from the webui's changes. */
export const ProjectAutoModeFileSchema = v.strictObject({
  projects: v.record(ProjectKeySchema, AutoModeSectionsSchema),
});
export type ProjectAutoModeFile = Output<typeof ProjectAutoModeFileSchema>;
export const ProjectAutoModeFileTextSchema = jsonText(ProjectAutoModeFileSchema);

/** One list of `autoMode` as a settings file writes it: entries, any of them
 * `$defaults`. */
const AutoModeListSchema = v.array(v.string());

/** `autoMode`'s four lists as a settings file writes them, each absent when
 * not written. Another key of `autoMode` (`classifyAllShell`) is left out. */
export const AutoModeListsSchema = v.object({
  environment: v.optional(AutoModeListSchema),
  allow: v.optional(AutoModeListSchema),
  soft_deny: v.optional(AutoModeListSchema),
  hard_deny: v.optional(AutoModeListSchema),
});
export type AutoModeLists = Output<typeof AutoModeListsSchema>;

/** A settings file (`<config dir>/settings.json`) as far as its autoMode's
 * lists go. */
export const AutoModeSettingsTextSchema = jsonText(
  v.object({ autoMode: v.optional(AutoModeListsSchema) }),
);

/** What `claude auto-mode defaults` writes: the built-in four lists. */
export const AutoModeDefaultsSchema = v.object({
  environment: AutoModeListSchema,
  allow: AutoModeListSchema,
  soft_deny: AutoModeListSchema,
  hard_deny: AutoModeListSchema,
});
export type AutoModeDefaults = Output<typeof AutoModeDefaultsSchema>;
export const AutoModeDefaultsTextSchema = jsonText(AutoModeDefaultsSchema);

const SessionIdSchema = v.pipe(
  v.string(),
  v.nonEmpty("Expected a session id, not an empty string"),
);

/** Session `session_id`'s project's autoMode, with what the session's user
 * settings write and the version of the built-in defaults (user role only,
 * DR-0063 §7). */
export const ProjectAutoModeReadRequestSchema = v.object({
  op: v.literal("project_auto_mode_read"),
  session_id: SessionIdSchema,
});
export type ProjectAutoModeReadRequest = Output<typeof ProjectAutoModeReadRequestSchema>;

/** The built-in defaults of the `claude` whose version key is `version`
 * (user role only, DR-0063 §7). */
export const AutoModeDefaultsReadRequestSchema = v.object({
  op: v.literal("auto_mode_defaults_read"),
  version: v.pipe(v.string(), v.nonEmpty("Expected the version key")),
});
export type AutoModeDefaultsReadRequest = Output<typeof AutoModeDefaultsReadRequestSchema>;

/** The text of a change to an entry: trimmed, empty for none (an append of
 * nothing, a removal). */
export const AutoModeEntryTextSchema = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(AUTO_MODE_ENTRY_MAX_LENGTH, ENTRY_LENGTH_MESSAGE),
  v.check((s) => s !== AUTO_MODE_DEFAULTS_ENTRY, DEFAULTS_ENTRY_MESSAGE),
);

/** Change a section of session `session_id`'s project (user role only,
 * DR-0063 §7), in one of two forms the daemon reads with
 * ProjectAutoModeChangeSchema: `defaults` (the section's check), or `text`
 * with no `index` (appended; nothing when empty) or with `index` and
 * `before` (that entry replaced when it is still `before`, removed when
 * `text` is empty; `file_conflict` otherwise). */
export const ProjectAutoModeWriteRequestSchema = v.object({
  op: v.literal("project_auto_mode_write"),
  session_id: SessionIdSchema,
  section: AutoModeSectionNameSchema,
  defaults: v.optional(v.boolean()),
  index: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  before: v.optional(v.string()),
  text: v.optional(AutoModeEntryTextSchema),
});
export type ProjectAutoModeWriteRequest = Output<typeof ProjectAutoModeWriteRequestSchema>;

/** What a project_auto_mode_write asks, its fields read as one of its forms. */
export const ProjectAutoModeChangeSchema = v.union(
  [
    v.strictObject({ defaults: v.boolean() }),
    v.strictObject({ text: v.string() }),
    v.strictObject({ index: v.number(), before: v.string(), text: v.string() }),
  ],
  "Expected `defaults`, `text`, or `index` and `before` with `text`",
);
export type ProjectAutoModeChange = Output<typeof ProjectAutoModeChangeSchema>;

/** The session's user settings as far as autoMode goes: the config dir's
 * name and the lists its `settings.json` writes, `$defaults` as written; or
 * why they were not read. */
export const UserAutoModeSchema = v.union([
  v.object({ config_dir_name: v.string(), autoMode: AutoModeListsSchema }),
  v.object({ unavailable: v.string() }),
]);
export type UserAutoMode = Output<typeof UserAutoModeSchema>;

export const ProjectAutoModeReadResponseSchema = v.object({
  ok: v.literal(true),
  /** The project's key (DR-0063 §3). */
  key: ProjectKeySchema,
  /** The project as the webui names it: `<host>/<owner>/<name>`, or the cwd. */
  label: v.string(),
  project: AutoModeSectionsSchema,
  user: UserAutoModeSchema,
  /** The version key of the `claude` whose defaults auto_mode_defaults_read
   * answers; absent when the daemon's PATH names no claude. */
  builtin_version: v.optional(v.string()),
});
export type ProjectAutoModeReadResponse = Output<typeof ProjectAutoModeReadResponseSchema>;

export const AutoModeDefaultsReadResponseSchema = v.object({
  ok: v.literal(true),
  version: v.string(),
  /** The first line of `claude --version`. */
  label: v.string(),
  defaults: AutoModeDefaultsSchema,
});
export type AutoModeDefaultsReadResponse = Output<typeof AutoModeDefaultsReadResponseSchema>;

export const ProjectAutoModeWriteResponseSchema = v.object({
  ok: v.literal(true),
  project: AutoModeSectionsSchema,
});
export type ProjectAutoModeWriteResponse = Output<typeof ProjectAutoModeWriteResponseSchema>;

/** A project's sections as just written, to every user-role subscriber
 * (DR-0063 §7). A webui takes it for the session it shows when the key is
 * that session's project's. Never to a session. */
export const ProjectAutoModeStreamEventSchema = v.object({
  ev: v.literal("project_auto_mode"),
  key: ProjectKeySchema,
  project: AutoModeSectionsSchema,
});
export type ProjectAutoModeStreamEvent = Output<typeof ProjectAutoModeStreamEventSchema>;
