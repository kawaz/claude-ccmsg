// hello の translate_plamo_url (DR-0049): config の `translate_plamo_url` を
// user role の hello にだけ URL のまま返し、未設定・session role では省く。
// webui はこの有無で ja(plamo) タブを出すかを決めるので、省略が「タブ無し」の
// 唯一の合図になる。
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ResponseOf } from "@ccmsg/protocol";
import { ccmsgConfigSchema } from "../src/config.ts";
import * as v from "valibot";
import type { Daemon } from "../src/server.ts";
import { requestOk, stubDaemon } from "./drive-request.ts";

const PLAMO_URL = "https://translate.example.test";

function daemonWith(url?: string): Daemon {
  return stubDaemon({ config: url ? { translate_plamo_url: url } : {} });
}

async function helloWith(
  daemon: Daemon,
  identity: { role: "user" } | { role: "session"; sid: string; repo: string; ws: string },
): Promise<ResponseOf<"hello">> {
  return requestOk(daemon, null, {
    op: "hello",
    protocol: PROTOCOL_VERSION,
    request_id: "hello-1",
    ...identity,
  });
}

describe("hello translate_plamo_url", () => {
  test("echoes the configured URL to a user-role hello", async () => {
    expect((await helloWith(daemonWith(PLAMO_URL), { role: "user" })).translate_plamo_url).toBe(
      PLAMO_URL,
    );
  });

  test("omits the field when unconfigured", async () => {
    expect((await helloWith(daemonWith(), { role: "user" })).translate_plamo_url).toBeUndefined();
  });

  test("omits the field for a session-role hello", async () => {
    const session = await helloWith(daemonWith(PLAMO_URL), {
      role: "session",
      sid: "99999999-0000-4000-8000-000000000009",
      repo: "r",
      ws: "w",
    });
    expect(session.translate_plamo_url).toBeUndefined();
  });
});

describe("config translate_plamo_url", () => {
  test("accepts an http(s) URL", () => {
    const parsed = v.safeParse(ccmsgConfigSchema("/nonexistent/home"), {
      translate_plamo_url: ` ${PLAMO_URL} `,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.output.translate_plamo_url).toBe(PLAMO_URL);
  });

  test("refuses a non-http scheme", () => {
    expect(
      v.safeParse(ccmsgConfigSchema("/nonexistent/home"), { translate_plamo_url: "ftp://x.test" })
        .success,
    ).toBe(false);
  });
});
