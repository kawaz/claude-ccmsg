// Reading what comes from outside the process (DR-0038).
//
// A JSON value from outside — a socket line, standard input, a file, another
// command's output — is given its type where it arrives, by a valibot schema,
// and nowhere further in. The shape is written once, as the schema; its type
// is `Output<typeof Schema>` (the schema's output, immutable), never a second
// hand-written interface.
//
// The house rules every boundary follows:
//
// - Everything goes through `parseWith(Schema, input)`, the one place an
//   `unknown` is taken. For text, the schema is `jsonText(Schema)`, which reads
//   the JSON and its shape in one step, so no untyped value exists even for a
//   line. A boundary that reads one value in layers (a frame, then what the
//   frame holds) decodes it once with `JsonTextSchema`.
// - A schema is built once, when its module loads, and used for every value:
//   `jsonText(...)` and every other schema is a module-level constant, never
//   built inside a function that reads a value.
// - Failure is a value, not a throw: `Parsed<T>` is either the typed value or
//   a `ParseFailure`. What a boundary does with a failure — refuse with the
//   reason, drop the one line and go on, show less — is the boundary's call;
//   the shape of a failure is the same everywhere.
// - No `as`, `any` or `!`, and no function that takes `unknown` and looks
//   inside it: a value that does not fit is read by a schema, or the types
//   are fixed. A schema is strict only where an unknown field is an error of
//   the sender; a shape another program owns (Claude Code's) lists the fields
//   used and lets the rest through.
// - A value read is immutable data: its type is `Immutable` all the way down,
//   so a reader cannot write into what it was given. What it needs changed it
//   builds anew.
// - A value caught by `catch` is `unknown` by the language's rules. It is told
//   apart only by whether it is an Error (`errorText`); no other value is made
//   into text.
//
// This file and the schema files beside it import nothing but valibot, so a
// module that cannot load imports at run time (the hooks module) can bundle
// them.
import * as v from "valibot";

/** `T` with every property and element read-only, all the way down: the
 * type of a value read from outside (DR-0038 §6). valibot's `v.readonly()`
 * makes only the one level it is piped onto read-only, and a variant's
 * options take no pipe, so the depth is given by the type instead. A mapped
 * type over an array is a read-only array, and over a primitive the
 * primitive itself. `unknown` (a value read as any JSON) stays `unknown`: a
 * mapped type over it would be `{}`, which says the value is not null. */
export type Immutable<T> = unknown extends T ? T : { readonly [K in keyof T]: Immutable<T[K]> };

/** What a schema reads, as immutable data. */
export type Output<S extends v.GenericSchema> = Immutable<v.InferOutput<S>>;

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
 * boundary itself. `firstIssue` stops at the first thing wrong, for a
 * boundary whose sender's value can hold any number of wrong parts: the
 * failure then stays one issue however large the value is. */
export function parseWith<S extends v.GenericSchema>(
  schema: S,
  input: unknown,
  options: { readonly firstIssue?: boolean } = {},
): Parsed<Output<S>> {
  const read = v.safeParse(
    schema,
    input,
    options.firstIssue === true ? { abortEarly: true, abortPipeEarly: true } : undefined,
  );
  return read.success
    ? { ok: true, value: read.output }
    : { ok: false, failure: failureOf(read.issues) };
}

/** A schema of JSON text: text that is not JSON is a failure like any other
 * shape. Its output is not typed; it is for a boundary that reads the one
 * decoded value against several schemas in turn. */
export const JsonTextSchema: v.SchemaWithPipe<
  readonly [v.StringSchema<undefined>, v.ParseJsonAction<string, undefined, undefined>]
> = v.pipe(v.string(), v.parseJson());

/** The schema of JSON text whose value `schema` reads. Built once per schema,
 * as a module-level constant beside it. */
export function jsonText<S extends v.GenericSchema>(
  schema: S,
): v.SchemaWithPipe<
  readonly [v.StringSchema<undefined>, v.ParseJsonAction<string, undefined, undefined>, S]
> {
  return v.pipe(v.string(), v.parseJson(), schema);
}

/** A value caught by `catch`, as text for a log or an answer: an Error by its
 * name and message, anything else by its type alone. */
export function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : `a thrown ${typeof e}`;
}
