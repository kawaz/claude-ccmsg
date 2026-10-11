// `<configDir>/allowed-origins.json`, as a schema (DR-0038 §3): the extra
// Origins the daemon's HTTP / WebSocket endpoint accepts, kept by
// `ccmsg origins add/remove/list` and read by the daemon.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** The origins, each as a browser sends it in the Origin header
 * (scheme://host[:port]). */
export const AllowedOriginsSchema = v.array(v.string());
export type AllowedOrigins = Output<typeof AllowedOriginsSchema>;

/** The file's text. */
export const AllowedOriginsTextSchema = jsonText(AllowedOriginsSchema);
