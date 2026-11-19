// The person's userscript for the webui (DR-0057): TypeScript or JavaScript
// they write in the webui's GLOBALS, kept by the daemon with the JavaScript
// built from it, and run by the webui pages of the browsers they switch it on
// in. As schemas (DR-0038): the four ops' requests and replies.
//
// Imports nothing but valibot and the schema files beside it, as the other
// schema files.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** The longest source a userscript may be, as a JavaScript string's length.
 * The same bound as a file the webui reads (FS_READ_MAX_BYTES): one textarea
 * of hand-written code is far below it. */
export const USERSCRIPT_MAX_LENGTH = 512 * 1024;

/** A userscript's source, verbatim: TypeScript or JavaScript. */
export const UserscriptSourceSchema = v.pipe(
  v.string("Expected the userscript's source as a string"),
  v.maxLength(
    USERSCRIPT_MAX_LENGTH,
    `Expected a userscript of at most ${String(USERSCRIPT_MAX_LENGTH)} characters`,
  ),
);

/** The saved userscript's source (user role only, DR-0057 §2): whether one
 * is saved, for GLOBALS, and what the edit dialog starts from. */
export const UserscriptReadRequestSchema = v.object({
  op: v.literal("userscript_read"),
});
export type UserscriptReadRequest = Output<typeof UserscriptReadRequestSchema>;

/** Save `source` as the userscript (user role only, DR-0057 §1-§2). The
 * daemon checks it without running it and builds it into JavaScript, and
 * saves the source and the build only when both pass; otherwise the reply is
 * `userscript_invalid`, whose msg is the check's or the build's output, and
 * what was saved stays. */
export const UserscriptWriteRequestSchema = v.object({
  op: v.literal("userscript_write"),
  source: UserscriptSourceSchema,
});
export type UserscriptWriteRequest = Output<typeof UserscriptWriteRequestSchema>;

/** The saved userscript as the browser runs it (user role only, DR-0057 §2,
 * §4): the JavaScript built from it when it was saved. Whether this browser
 * runs it is the browser's own (DR-0057 §3), not asked here. */
export const UserscriptLoadRequestSchema = v.object({
  op: v.literal("userscript_load"),
});
export type UserscriptLoadRequest = Output<typeof UserscriptLoadRequestSchema>;

/** Delete the saved userscript, its source and its build (user role only,
 * DR-0057 §2): the edit dialog's 削除. `not_found` when none is saved. */
export const UserscriptDeleteRequestSchema = v.object({
  op: v.literal("userscript_delete"),
});
export type UserscriptDeleteRequest = Output<typeof UserscriptDeleteRequestSchema>;

/** userscript_read's reply: `source` is absent when none is saved. */
export const UserscriptReadResponseSchema = v.object({
  ok: v.literal(true),
  source: v.optional(v.string()),
});
export type UserscriptReadResponse = Output<typeof UserscriptReadResponseSchema>;

export const UserscriptWriteResponseSchema = v.object({ ok: v.literal(true) });
export type UserscriptWriteResponse = Output<typeof UserscriptWriteResponseSchema>;

export const UserscriptDeleteResponseSchema = v.object({ ok: v.literal(true) });
export type UserscriptDeleteResponse = Output<typeof UserscriptDeleteResponseSchema>;

/** userscript_load's reply: `js` is absent when none is saved. */
export const UserscriptLoadResponseSchema = v.object({
  ok: v.literal(true),
  js: v.optional(v.string()),
});
export type UserscriptLoadResponse = Output<typeof UserscriptLoadResponseSchema>;
