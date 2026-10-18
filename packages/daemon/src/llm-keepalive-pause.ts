// Stopping the gateway's prompt-cache keepalive for one session (the
// `llm_keepalive_pause` op): post the session id to the gateway's pause
// endpoint and read its acknowledgement. The gateway forgets the requests it
// kept for that session and sends no more keepalives; the session's next real
// request starts them again, on the gateway's side, with nothing for ccmsg to
// undo.
import { ErrorCode, parseWith } from "@ccmsg/protocol";
import * as v from "valibot";
import {
  fetchGatewayJson,
  type GatewayFailure,
  type LlmGatewayDeps,
  productionGatewayDeps,
  unreadable,
} from "./llm-gateway.ts";

/** A pause is one small exchange with the gateway, not a document. */
const LLM_KEEPALIVE_PAUSE_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 4 * 1024;

/** What the gateway answers a pause with: the session it paused. */
const PauseAnswerSchema = v.object({
  session_id: v.string(),
  paused: v.literal(true),
});

/** Ask the gateway at `url` to stop the keepalive of session `sid`. */
export async function pauseLlmKeepalive(
  url: string,
  sid: string,
  deps: LlmGatewayDeps = productionGatewayDeps,
): Promise<{ ok: true } | GatewayFailure> {
  const code = ErrorCode.llm_keepalive_pause_unavailable;
  const res = await fetchGatewayJson(
    {
      url,
      label: "keepalive pause",
      code,
      maxBytes: RESPONSE_MAX_BYTES,
      timeoutMs: LLM_KEEPALIVE_PAUSE_TIMEOUT_MS,
      post: { session_id: sid },
    },
    deps,
  );
  if (!res.ok) return res;
  const answer = parseWith(PauseAnswerSchema, res.document);
  if (!answer.ok) return unreadable("keepalive pause", code, answer.failure);
  if (answer.value.session_id !== sid) {
    return {
      ok: false,
      code,
      msg: `keepalive pause endpoint answered for session ${answer.value.session_id}, not ${sid}`,
    };
  }
  return { ok: true };
}
