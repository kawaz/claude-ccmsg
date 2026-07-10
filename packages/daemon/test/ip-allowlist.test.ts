// CIDR matcher for CCMSG_HTTP_ALLOW (DR-0004 §3 addendum). Pure logic, no daemon
// process needed — this is the "isolate for unit testing" module the DR calls for.
import { describe, expect, test } from "bun:test";
import { DEFAULT_HTTP_ALLOW } from "@ccmsg/protocol";
import { isAllowed, normalizeIp, parseAllowList, parseCidr } from "../src/ip-allowlist.ts";

describe("normalizeIp", () => {
  test("plain IPv4", () => {
    expect(normalizeIp("127.0.0.1")).toEqual({ family: "v4", value: 0x7f000001n });
  });

  test("plain IPv6", () => {
    expect(normalizeIp("::1")).toEqual({ family: "v6", value: 1n });
  });

  test("IPv6 with :: compression in the middle", () => {
    // fd7a:115c:a1e0::1 -> fd7a:115c:a1e0:0000:0000:0000:0000:0001
    const norm = normalizeIp("fd7a:115c:a1e0::1");
    expect(norm?.family).toBe("v6");
    expect(norm?.value).toBe((0xfd7an << 112n) | (0x115cn << 96n) | (0xa1e0n << 80n) | 1n);
  });

  // Defensive case: some dual-stack listeners hand IPv4 peers back in this mapped
  // form on a 0.0.0.0 bind. The matcher must unwrap it back to plain v4 so it matches
  // v4 CIDR entries like 100.64.0.0/10. (A live 127.0.0.1 check against Bun on macOS
  // showed plain family:"IPv4" instead — this path is portability insurance, not a
  // locally-reproduced case.)
  test("IPv4-mapped IPv6 (::ffff:a.b.c.d) normalizes to v4", () => {
    expect(normalizeIp("::ffff:100.64.1.2")).toEqual({
      family: "v4",
      value: (100n << 24n) | (64n << 16n) | (1n << 8n) | 2n,
    });
  });

  test("IPv4-mapped IPv6, hex tail form (::ffff:6440:102 == ::ffff:100.64.1.2)", () => {
    expect(normalizeIp("::ffff:6440:102")).toEqual(normalizeIp("::ffff:100.64.1.2"));
  });

  test("garbage input is unparseable", () => {
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("1:2:3:4:5:6:7:8:9")).toBeNull(); // too many groups, no ::
    expect(normalizeIp("1::2::3")).toBeNull(); // two "::" is invalid
  });
});

describe("parseCidr", () => {
  test("v4 with explicit prefix", () => {
    expect(parseCidr("100.64.0.0/10")).toEqual({
      family: "v4",
      base: (100n << 24n) | (64n << 16n), // 100.64.0.0
      prefixLen: 10,
    });
  });

  test("bare v6 address defaults to /128 (host route)", () => {
    expect(parseCidr("::1")).toEqual({ family: "v6", base: 1n, prefixLen: 128 });
  });

  test("bare v4 address defaults to /32", () => {
    expect(parseCidr("127.0.0.1")).toEqual({ family: "v4", base: 0x7f000001n, prefixLen: 32 });
  });

  test("network base is masked even if host bits were passed in", () => {
    // 100.64.1.5/10 — host bits within the /10 must be dropped so `base` is a true
    // network address, matching what isAllowed() computes from a candidate address.
    const c = parseCidr("100.64.1.5/10");
    expect(c.base).toBe(parseCidr("100.64.0.0/10").base);
  });

  test("invalid prefix length throws", () => {
    expect(() => parseCidr("127.0.0.1/33")).toThrow();
    expect(() => parseCidr("::1/129")).toThrow();
    expect(() => parseCidr("127.0.0.1/-1")).toThrow();
  });

  test("unparseable address throws", () => {
    expect(() => parseCidr("not-an-ip/8")).toThrow();
  });
});

describe("isAllowed — IPv4 CGNAT boundary (100.64.0.0/10, DR-0004 §3 addendum)", () => {
  const cidrs = parseAllowList("100.64.0.0/10");

  test("100.63.255.255 just below the range: denied", () => {
    expect(isAllowed("100.63.255.255", cidrs)).toBe(false);
  });
  test("100.64.0.0 network address: allowed", () => {
    expect(isAllowed("100.64.0.0", cidrs)).toBe(true);
  });
  test("100.127.255.255 top of the /10: allowed", () => {
    expect(isAllowed("100.127.255.255", cidrs)).toBe(true);
  });
  test("100.128.0.0 just above the range: denied", () => {
    expect(isAllowed("100.128.0.0", cidrs)).toBe(false);
  });
});

describe("isAllowed — loopback (127.0.0.0/8)", () => {
  const cidrs = parseAllowList("127.0.0.0/8");
  test("127.0.0.1 allowed", () => expect(isAllowed("127.0.0.1", cidrs)).toBe(true));
  test("127.255.255.255 allowed (top of /8)", () =>
    expect(isAllowed("127.255.255.255", cidrs)).toBe(true));
  test("126.255.255.255 denied", () => expect(isAllowed("126.255.255.255", cidrs)).toBe(false));
  test("128.0.0.1 denied", () => expect(isAllowed("128.0.0.1", cidrs)).toBe(false));
});

describe("isAllowed — IPv6 host route (::1)", () => {
  const cidrs = parseAllowList("::1");
  test("::1 allowed", () => expect(isAllowed("::1", cidrs)).toBe(true));
  test("::2 denied (only the exact host is allowed)", () =>
    expect(isAllowed("::2", cidrs)).toBe(false));
});

describe("isAllowed — IPv6 tailscale ULA (fd7a:115c:a1e0::/48)", () => {
  const cidrs = parseAllowList("fd7a:115c:a1e0::/48");
  test("network address allowed", () => expect(isAllowed("fd7a:115c:a1e0::", cidrs)).toBe(true));
  test("a host within the /48 allowed", () =>
    expect(isAllowed("fd7a:115c:a1e0:1234::5", cidrs)).toBe(true));
  test("neighboring /48 denied (only the a1e1 nibble differs)", () =>
    expect(isAllowed("fd7a:115c:a1e1::", cidrs)).toBe(false));
});

describe("isAllowed — IPv4-mapped IPv6 addresses match v4 CIDR entries", () => {
  const cidrs = parseAllowList("100.64.0.0/10,127.0.0.0/8");
  test("::ffff:100.64.1.2 allowed (unwraps to 100.64.1.2, inside the CGNAT range)", () =>
    expect(isAllowed("::ffff:100.64.1.2", cidrs)).toBe(true));
  test("::ffff:8.8.8.8 denied (unwraps to 8.8.8.8, outside every entry)", () =>
    expect(isAllowed("::ffff:8.8.8.8", cidrs)).toBe(false));
  test("::ffff:127.0.0.1 allowed (unwraps to loopback)", () =>
    expect(isAllowed("::ffff:127.0.0.1", cidrs)).toBe(true));
});

describe("isAllowed — cross-family and malformed input never match", () => {
  const cidrs = parseAllowList("127.0.0.0/8");
  test("a v6 candidate against a v4-only allowlist is denied, not coerced", () =>
    expect(isAllowed("::1", cidrs)).toBe(false));
  test("unparseable candidate address is denied (fail closed)", () =>
    expect(isAllowed("not-an-ip", cidrs)).toBe(false));
});

describe("DEFAULT_HTTP_ALLOW (daemon's actual out-of-the-box policy)", () => {
  const cidrs = parseAllowList(DEFAULT_HTTP_ALLOW);

  test("loopback v4 allowed", () => expect(isAllowed("127.0.0.1", cidrs)).toBe(true));
  test("loopback v6 allowed", () => expect(isAllowed("::1", cidrs)).toBe(true));
  // tailscale CGNAT/ULA ranges removed from the default (2026-07-10 trust-model
  // addendum, docs/issue/2026-07-10-webui-transport-trust-model-security-critical.md):
  // source IP alone can't distinguish this daemon's own webui from any other browser
  // tab open on a device kawaz owns via a shared tailnet. Origin verification
  // (http.ts isAllowedOrigin) is the actual trust boundary for that case now;
  // CCMSG_HTTP_ALLOW_ORIGIN is the opt-in path for a tailscale-serve front.
  test("tailscale v4 no longer allowed by default", () =>
    expect(isAllowed("100.100.50.4", cidrs)).toBe(false));
  test("tailscale v6 no longer allowed by default", () =>
    expect(isAllowed("fd7a:115c:a1e0:abcd::1", cidrs)).toBe(false));
  test("public v4 denied", () => expect(isAllowed("8.8.8.8", cidrs)).toBe(false));
  test("public v6 denied", () => expect(isAllowed("2001:4860:4860::8888", cidrs)).toBe(false));
  test("private LAN (192.168.0.0/16, not in the default list) denied", () =>
    expect(isAllowed("192.168.1.10", cidrs)).toBe(false));
});
