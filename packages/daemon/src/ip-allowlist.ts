// Source-IP allowlist for the HTTP/WS transport (DR-0004 §3 addendum). No dependency —
// a minimal IPv4/IPv6 CIDR matcher covers exactly what `CCMSG_HTTP_ALLOW` needs.

export interface Cidr {
  family: "v4" | "v6";
  /** network address, masked to prefixLen, as an unsigned integer (32 or 128 bit). */
  base: bigint;
  prefixLen: number;
}

function parseIPv4(addr: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  let v = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet < 0 || octet > 255) return null;
    v = (v << 8n) | BigInt(octet);
  }
  return v;
}

/** Full IPv6 parse, including `::` compression and an embedded IPv4 tail
 *  (`::ffff:127.0.0.1` style). Some dual-stack listeners hand IPv4 peers back in this
 *  mapped form on a `0.0.0.0` bind, so the matcher must understand it even though
 *  normalizeIp() is what actually strips the mapping back to v4. (On macOS/Bun,
 *  requestIP() was observed to return plain `family:"IPv4"` addresses instead — this
 *  path exists for portability, not because it was seen firing locally.) */
function parseIPv6(addr: string): bigint | null {
  let s = addr;
  const zoneIdx = s.indexOf("%");
  if (zoneIdx >= 0) s = s.slice(0, zoneIdx);

  let embeddedV4: bigint | null = null;
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : s;
  if (tail.includes(".")) {
    embeddedV4 = parseIPv4(tail);
    if (embeddedV4 === null) return null;
    s = s.slice(0, lastColon); // strip the embedded v4 tail, keep the ':' skeleton (e.g. "::ffff")
  }

  const halves = s.split("::");
  if (halves.length > 2) return null; // more than one "::" is not valid

  const leftGroups = halves[0] === "" ? [] : halves[0]!.split(":");
  const rightGroups = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  for (const g of [...leftGroups, ...rightGroups]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }

  const v4GroupCount = embeddedV4 !== null ? 2 : 0;
  let groups: number[];
  if (halves.length === 2) {
    const zerosNeeded = 8 - (leftGroups.length + rightGroups.length + v4GroupCount);
    if (zerosNeeded < 0) return null;
    groups = [
      ...leftGroups.map((g) => Number.parseInt(g, 16)),
      ...Array<number>(zerosNeeded).fill(0),
      ...rightGroups.map((g) => Number.parseInt(g, 16)),
    ];
  } else {
    if (leftGroups.length + v4GroupCount !== 8) return null; // no "::": must be exactly 8 groups
    groups = leftGroups.map((g) => Number.parseInt(g, 16));
  }

  if (embeddedV4 !== null) {
    groups.push(Number((embeddedV4 >> 16n) & 0xffffn));
    groups.push(Number(embeddedV4 & 0xffffn));
  }
  if (groups.length !== 8) return null;

  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  return v;
}

/** Parses + normalizes any address string Bun's `requestIP()` can hand back. An
 *  IPv4-mapped IPv6 address (`::ffff:0:0/96`) is unwrapped to plain v4 so it matches
 *  v4 CIDR entries — the defensive case for dual-stack listeners that hand IPv4 peers
 *  back in this form on a `0.0.0.0` bind (not observed with Bun on macOS in a live
 *  127.0.0.1 check — see the module doc comment). */
export function normalizeIp(addr: string): { family: "v4" | "v6"; value: bigint } | null {
  const v4 = parseIPv4(addr);
  if (v4 !== null) return { family: "v4", value: v4 };
  const v6 = parseIPv6(addr);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { family: "v4", value: v6 & 0xffffffffn };
  return { family: "v6", value: v6 };
}

function maskFor(maxPrefix: number, prefixLen: number): bigint {
  if (prefixLen <= 0) return 0n;
  return ((1n << BigInt(prefixLen)) - 1n) << BigInt(maxPrefix - prefixLen);
}

/** Parses one `CCMSG_HTTP_ALLOW` entry: `a.b.c.d/n`, `a.b.c.d`, `xxxx::/n`, or `::1`
 *  (bare address = host route, prefixLen defaults to the family's full width). */
export function parseCidr(spec: string): Cidr {
  const slashIdx = spec.lastIndexOf("/");
  const addrPart = slashIdx >= 0 ? spec.slice(0, slashIdx) : spec;
  const norm = normalizeIp(addrPart);
  if (norm === null)
    throw new Error(`invalid CCMSG_HTTP_ALLOW entry (unparseable address): ${spec}`);
  const maxPrefix = norm.family === "v4" ? 32 : 128;
  const prefixLen = slashIdx >= 0 ? Number(spec.slice(slashIdx + 1)) : maxPrefix;
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > maxPrefix) {
    throw new Error(`invalid CCMSG_HTTP_ALLOW entry (bad prefix length): ${spec}`);
  }
  return { family: norm.family, base: norm.value & maskFor(maxPrefix, prefixLen), prefixLen };
}

/** Parses the whole comma-separated `CCMSG_HTTP_ALLOW` value. Throws on any
 *  unparseable entry — fail loud at startup rather than silently under-allowlisting. */
export function parseAllowList(spec: string): Cidr[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map(parseCidr);
}

/** True iff `addr` (as returned by Bun's `requestIP()`) falls in any entry of `cidrs`.
 *  An unparseable address is treated as not-allowed (fail closed, DR-0004 §3 addendum). */
export function isAllowed(addr: string, cidrs: Cidr[]): boolean {
  const norm = normalizeIp(addr);
  if (norm === null) return false;
  const maxPrefix = norm.family === "v4" ? 32 : 128;
  for (const c of cidrs) {
    if (c.family !== norm.family) continue;
    const mask = maskFor(maxPrefix, c.prefixLen);
    if ((norm.value & mask) === c.base) return true;
  }
  return false;
}
