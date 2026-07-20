// tailscale serve origin auto-allow (docs/issue/2026-07-11-tailscale-serve-origin-auto-
// allow.md). extractProxiedOrigins is pure (no subprocess), so RED/GREEN unit tests here
// cover the JSON shape; the subprocess/timeout seam and the end-to-end WS effect are
// covered in http-transport.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { extractProxiedOrigins, resolveStatusTimeoutMs } from "../src/tailscale-origin.ts";

// Observed 2026-07-11 via `tailscale serve status --json` on a machine with a single
// serve config fronting this daemon's default port (8642) over HTTPS on 443 — the
// real-world shape this module has to parse. Hostname replaced with a placeholder
// (sanitize-local-paths / sanitize-work-identifiers: real DNSName is this machine's
// tailnet identity, not a project concern).
const REAL_SERVE_STATUS = {
  TCP: { "443": { HTTPS: true } },
  Web: {
    "my-machine.tail1234.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:8642" } },
    },
  },
};

describe("extractProxiedOrigins", () => {
  test("real serve status shape, port matches this daemon's bind: origin extracted, :443 elided", () => {
    const origins = extractProxiedOrigins(REAL_SERVE_STATUS, new Set([8642]));
    expect(origins).toEqual(new Set(["https://my-machine.tail1234.ts.net"]));
  });

  test("serve status present but proxying to a port this daemon isn't bound to: no origin (not our serve config)", () => {
    // e.g. some *other* local service (not this daemon) has a serve entry too.
    const origins = extractProxiedOrigins(REAL_SERVE_STATUS, new Set([9999]));
    expect(origins).toEqual(new Set());
  });

  test("non-443 front-end port: kept explicit in the origin (only 443 gets the standard https-implies-443 elision)", () => {
    const status = {
      Web: {
        "my-machine.tail1234.ts.net:8443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8642" } },
        },
      },
    };
    const origins = extractProxiedOrigins(status, new Set([8642]));
    expect(origins).toEqual(new Set(["https://my-machine.tail1234.ts.net:8443"]));
  });

  test("hostname with a trailing dot (defensive: DNSName-shaped input, not observed on real Web keys): dot stripped", () => {
    const status = {
      Web: {
        "my-machine.tail1234.ts.net.:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8642" } },
        },
      },
    };
    const origins = extractProxiedOrigins(status, new Set([8642]));
    expect(origins).toEqual(new Set(["https://my-machine.tail1234.ts.net"]));
  });

  test("multiple Web entries, only one proxies to a bound port: only that one's origin is trusted", () => {
    const status = {
      Web: {
        "trusted.tail1234.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8642" } },
        },
        "other-app.tail1234.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
    };
    const origins = extractProxiedOrigins(status, new Set([8642]));
    expect(origins).toEqual(new Set(["https://trusted.tail1234.ts.net"]));
  });

  test("multiple bound ports (e.g. dual-stack 127.0.0.1 + [::1] listeners): matches any of them", () => {
    const status = {
      Web: {
        "my-machine.tail1234.ts.net:443": {
          Handlers: { "/": { Proxy: "http://[::1]:8642" } },
        },
      },
    };
    const origins = extractProxiedOrigins(status, new Set([8642, 9999]));
    expect(origins).toEqual(new Set(["https://my-machine.tail1234.ts.net"]));
  });

  test("empty JSON object: no Web key at all, returns empty (not a crash)", () => {
    expect(extractProxiedOrigins({}, new Set([8642]))).toEqual(new Set());
  });

  test("null input: returns empty", () => {
    expect(extractProxiedOrigins(null, new Set([8642]))).toEqual(new Set());
  });

  test("non-object input (e.g. a bare string or number, malformed subprocess output): returns empty", () => {
    expect(extractProxiedOrigins("not json shaped", new Set([8642]))).toEqual(new Set());
    expect(extractProxiedOrigins(42, new Set([8642]))).toEqual(new Set());
  });

  test("Web entry with no Handlers, or a Handler with no Proxy (e.g. a Text/static handler): skipped, no crash", () => {
    const status = {
      Web: {
        "a.tail1234.ts.net:443": {},
        "b.tail1234.ts.net:443": { Handlers: { "/": { Text: "static content, not a proxy" } } },
      },
    };
    expect(extractProxiedOrigins(status, new Set([8642]))).toEqual(new Set());
  });

  test("Web key without a parseable trailing port (malformed/future-shape defense): skipped, no crash", () => {
    const status = {
      Web: {
        "no-port-here": { Handlers: { "/": { Proxy: "http://127.0.0.1:8642" } } },
      },
    };
    expect(extractProxiedOrigins(status, new Set([8642]))).toEqual(new Set());
  });

  test("Proxy value that isn't a parseable URL: skipped, no crash", () => {
    const status = {
      Web: {
        "a.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "not a url" } } },
      },
    };
    expect(extractProxiedOrigins(status, new Set([8642]))).toEqual(new Set());
  });
});

describe("resolveStatusTimeoutMs (CCMSG_TAILSCALE_STATUS_TIMEOUT_MS)", () => {
  afterEach(() => {
    delete process.env.CCMSG_TAILSCALE_STATUS_TIMEOUT_MS;
  });

  test("env unset: falls back to the caller-supplied default", () => {
    expect(resolveStatusTimeoutMs(1000)).toBe(1000);
  });

  test("env set to a valid non-negative number: overrides the default", () => {
    process.env.CCMSG_TAILSCALE_STATUS_TIMEOUT_MS = "10000";
    expect(resolveStatusTimeoutMs(1000)).toBe(10000);
  });

  test("env set to a malformed value (not a finite number): falls back to the default", () => {
    process.env.CCMSG_TAILSCALE_STATUS_TIMEOUT_MS = "not-a-number";
    expect(resolveStatusTimeoutMs(1000)).toBe(1000);
  });
});
