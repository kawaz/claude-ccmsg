// POST /webhook/<source> contract (webhook.ts): who may post, what shape is
// accepted, and what a producer is told. Driven against the handler directly —
// the HTTP listener's own concerns (source-IP allowlist, Origin) are tested in
// http-transport.test.ts and would only obscure these cases.
import { describe, expect, test } from "bun:test";
import { WEBHOOK_MAX_BYTES, handleWebhookRequest, type WebhookSource } from "../src/webhook.ts";

const TOKEN = "s3cr3t-token";
const SILENT = { error() {} };

function sources(handle: (items: unknown[]) => void): Map<string, WebhookSource> {
  return new Map<string, WebhookSource>([["llm-gateway", { token: TOKEN, handle }]]);
}

function post(
  body: string,
  init: { token?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request("http://127.0.0.1/webhook/llm-gateway", {
    method: "POST",
    headers,
    body,
  });
}

const event = {
  ts: 1785564745,
  session_id: "f13ba456",
  prefix: "484eda9c",
  model: "claude-fable-5",
};

describe("webhook auth", () => {
  test("a valid token is accepted", async () => {
    const got: unknown[][] = [];
    const res = await handleWebhookRequest(
      post(JSON.stringify(event)),
      "llm-gateway",
      sources((items) => got.push(items)),
      SILENT,
    );
    expect(res.status).toBe(204);
    expect(got).toEqual([[event]]);
  });

  test("a wrong, malformed, or missing Authorization is 401", async () => {
    const attempts = [
      post(JSON.stringify(event), { token: "wrong-token" }),
      // Same length as the real token: the comparison must reject on content,
      // not merely on length.
      post(JSON.stringify(event), { token: "s3cr3t-tokeX" }),
      post(JSON.stringify(event), { token: null }),
      post(JSON.stringify(event), { token: null, headers: { Authorization: TOKEN } }),
      post(JSON.stringify(event), { token: null, headers: { Authorization: `Basic ${TOKEN}` } }),
    ];
    for (const req of attempts) {
      let handled = false;
      const res = await handleWebhookRequest(
        req,
        "llm-gateway",
        sources(() => {
          handled = true;
        }),
        SILENT,
      );
      expect(res.status).toBe(401);
      expect(handled).toBe(false);
    }
  });

  test("an unregistered or malformed source is 404, and never authenticated", async () => {
    // An unconfigured webhook must look exactly like one that does not exist:
    // the reply cannot become a list of what this daemon could be posting to.
    for (const source of ["unknown-source", "", "Llm-Gateway", "../etc", "a".repeat(65)]) {
      const res = await handleWebhookRequest(
        post(JSON.stringify(event)),
        source,
        sources(() => {}),
        SILENT,
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("webhook payload", () => {
  test("a bare event and a batch arrive at the handler the same way", async () => {
    const got: unknown[][] = [];
    const batch = [event, { ...event, ts: event.ts + 1 }];
    await handleWebhookRequest(
      post(JSON.stringify(batch)),
      "llm-gateway",
      sources((items) => got.push(items)),
      SILENT,
    );
    expect(got).toEqual([batch]);
  });

  test("an unreadable body is the one failure the sender hears about", async () => {
    const res = await handleWebhookRequest(
      post("{not json"),
      "llm-gateway",
      sources(() => {}),
      SILENT,
    );
    expect(res.status).toBe(400);
  });

  test("individually unusable items still answer 204", async () => {
    // Fire-and-forget: a producer that retried on these would resend an event
    // ccmsg can never place, forever. Dropping is the handler's business; the
    // transport's job is to accept the delivery.
    const got: unknown[][] = [];
    const res = await handleWebhookRequest(
      post(JSON.stringify([event, { garbage: true }, 42])),
      "llm-gateway",
      sources((items) => got.push(items)),
      SILENT,
    );
    expect(res.status).toBe(204);
    expect(got[0]).toHaveLength(3);
  });

  test("a handler that throws is contained, and still answers 204", async () => {
    const logged: string[] = [];
    const res = await handleWebhookRequest(
      post(JSON.stringify(event)),
      "llm-gateway",
      sources(() => {
        throw new Error("bug in ccmsg");
      }),
      { error: (m) => logged.push(m) },
    );
    expect(res.status).toBe(204);
    expect(logged.join()).toContain("bug in ccmsg");
  });

  test("an oversized body is refused without being buffered whole", async () => {
    const huge = JSON.stringify([...Array(40_000)].map(() => event));
    expect(huge.length).toBeGreaterThan(WEBHOOK_MAX_BYTES);
    let handled = false;
    const res = await handleWebhookRequest(
      post(huge),
      "llm-gateway",
      sources(() => {
        handled = true;
      }),
      SILENT,
    );
    expect(res.status).toBe(413);
    expect(handled).toBe(false);
  });

  test("a lying content-length is refused on the bytes actually read", async () => {
    // content-length is advisory (and absent under chunked encoding), so the
    // ceiling has to hold on the stream itself.
    const huge = JSON.stringify([...Array(40_000)].map(() => event));
    const req = new Request("http://127.0.0.1/webhook/llm-gateway", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-length": "10" },
      body: huge,
    });
    const res = await handleWebhookRequest(
      req,
      "llm-gateway",
      sources(() => {}),
      SILENT,
    );
    expect(res.status).toBe(413);
  });
});
