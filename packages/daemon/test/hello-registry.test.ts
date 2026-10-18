// A session only a hello registered stays in the registry for as long as the
// agents poll could still list it (DR-0034 §5): a round of the poll begun
// after the hello, answered by the session's config dir, that does not list
// it forgets it (forgetUnlistedHellos). The rounds are given here; the poll
// and the hello themselves are agents.test.ts's (a hello here would look for
// the session's transcript in the machine's own config dirs).
import { describe, expect, test } from "bun:test";
import { forgetUnlistedHellos, type Conn, type Daemon } from "../src/server.ts";
import { requestOk, stubDaemon } from "./drive-request.ts";

const SID = "4e110000-0000-4000-8000-0000000000aa";
const USER: Conn["identity"] = { role: "user" };
const DIR_A = "/nonexistent/ccmsg-cfg-a";
const DIR_B = "/nonexistent/ccmsg-cfg-b";
/** When the hello registered SID. */
const AT = Date.parse("2026-10-18T00:00:00.000Z");

/** A daemon whose registry holds SID as a hello registered it at AT, naming
 * `configDir` when given. */
function registered(configDir?: string): Daemon {
  const sessions: Daemon["sessions"] = new Map();
  sessions.set(SID, {
    meta: { sid: SID, repo: "r", ws: "w", cwd: "/tmp" },
    ...(configDir !== undefined ? { configDir } : {}),
    connectedAt: new Date(AT).toISOString(),
  });
  return stubDaemon({ sessions });
}

async function listed(daemon: Daemon): Promise<boolean> {
  const { peers } = await requestOk(daemon, USER, { op: "peers", request_id: "q1" });
  return peers.some((p) => p.sid === SID);
}

describe("forgetUnlistedHellos", () => {
  test("a round begun after the hello whose dir answered without it forgets it", async () => {
    const daemon = registered(DIR_A);
    forgetUnlistedHellos(daemon, [DIR_A], AT + 1);
    expect(await listed(daemon)).toBe(false);
  });

  // A session that started just before its hello may be missing from a round
  // already under way.
  test("a round begun no later than the hello leaves it", async () => {
    const daemon = registered(DIR_A);
    forgetUnlistedHellos(daemon, [DIR_A], AT);
    forgetUnlistedHellos(daemon, [DIR_A], AT - 1);
    expect(await listed(daemon)).toBe(true);
  });

  test("a round its config dir did not answer leaves it", async () => {
    const daemon = registered(DIR_A);
    forgetUnlistedHellos(daemon, [DIR_B], AT + 1);
    forgetUnlistedHellos(daemon, [], AT + 1);
    expect(await listed(daemon)).toBe(true);
  });

  test("a hello that named no config dir is forgotten by a round any dir answered", async () => {
    const daemon = registered();
    forgetUnlistedHellos(daemon, [], AT + 1);
    expect(await listed(daemon)).toBe(true);
    forgetUnlistedHellos(daemon, [DIR_B], AT + 1);
    expect(await listed(daemon)).toBe(false);
  });

  test("a sid the poll has listed is left to vanish from the poll", async () => {
    const daemon = registered(DIR_A);
    daemon.agentsSeen.set(SID, DIR_A);
    forgetUnlistedHellos(daemon, [DIR_A], AT + 1);
    expect(await listed(daemon)).toBe(true);
  });
});
