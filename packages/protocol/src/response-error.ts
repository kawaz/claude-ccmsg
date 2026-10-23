// The reply to a request the daemon did not serve, whatever its op
// (DR-0038). Apart from response.ts so that the hooks module, which bundles
// what it imports, reads a refusal without the replies of every op.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** Why a request was not served: a code from ErrorCode (or `internal` for an
 * op that threw), and a line saying what to do about it. */
export const ErrorBodySchema = v.object({
  code: v.string(),
  msg: v.string(),
});
export type ErrorBody = Output<typeof ErrorBodySchema>;

/** The reply to a request the daemon did not serve, whatever its op. */
export const ErrorResponseSchema = v.object({
  ok: v.literal(false),
  error: ErrorBodySchema,
});
export type ErrorResponse = Output<typeof ErrorResponseSchema>;
