// Reading what comes from outside the process (DR-0038).
//
// A JSON value from outside — a socket line, standard input, a file, another
// command's output — is given its type where it arrives, by a valibot schema,
// and nowhere further in. The shape is written once, as the schema; its type
// is `v.InferOutput<typeof Schema>`, never a second hand-written interface.
//
// The house rules every boundary follows:
//
// - Text goes through `parseJsonWith(Schema, text)`: the JSON and its shape are
//   read in one step, so no untyped value exists even for a line. A value that
//   is already decoded (a field of an envelope read elsewhere) goes through
//   `parseWith(Schema, value)`, the one place an `unknown` is taken.
// - Failure is a value, not a throw: `Parsed<T>` is either the typed value or
//   a `ParseFailure`. What a boundary does with a failure — refuse with the
//   reason, drop the one line and go on, show less — is the boundary's call;
//   the shape of a failure is the same everywhere.
// - No `as`, `any` or `!`, and no function that takes `unknown` and looks
//   inside it: a value that does not fit is read by a schema, or the types
//   are fixed. A schema is strict only where an unknown field is an error of
//   the sender; a shape another program owns (Claude Code's) lists the fields
//   used and lets the rest through.
// - A value caught by `catch` is `unknown` by the language's rules. It is told
//   apart only by whether it is an Error (`errorText`); no other value is made
//   into text.
//
// This file and the schema files beside it import nothing but valibot, so a
// module that cannot load imports at run time (the hooks module) can bundle
// them.
import * as v from "valibot";

/** One thing wrong with a value: where (a dot path, `""` for the value
 * itself) and what. */
export interface ParseIssue {
  readonly path: string;
  readonly message: string;
}

/** Why a value from outside does not have the shape it was read with. */
export interface ParseFailure {
  readonly issues: readonly ParseIssue[];
  /** The issues as one line, for a log or an error answer. */
  readonly summary: string;
}

/** A value read at a boundary: the typed value, or why it is not one. */
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ParseFailure };

function failureOf(issues: readonly v.BaseIssue<unknown>[]): ParseFailure {
  const read = issues.map((issue) => ({
    path: v.getDotPath(issue) ?? "",
    message: issue.message,
  }));
  return {
    issues: read,
    summary: read.map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`)).join("; "),
  };
}

/** `input` read with `schema`. The one function that takes an `unknown`: the
 * boundary itself. */
export function parseWith<S extends v.GenericSchema>(
  schema: S,
  input: unknown,
): Parsed<v.InferOutput<S>> {
  const read = v.safeParse(schema, input);
  return read.success
    ? { ok: true, value: read.output }
    : { ok: false, failure: failureOf(read.issues) };
}

/** JSON text read with `schema`: text that is not JSON is a failure like any
 * other shape. */
export function parseJsonWith<S extends v.GenericSchema>(
  schema: S,
  text: string,
): Parsed<v.InferOutput<S>> {
  return parseWith(v.pipe(v.string(), v.parseJson(), schema), text);
}

/** A value caught by `catch`, as text for a log or an answer: an Error by its
 * name and message, anything else by its type alone. */
export function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : `a thrown ${typeof e}`;
}
