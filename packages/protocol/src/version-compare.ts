// Semver-ish comparison for DR-0002 §4 daemon version mismatch handling.
//
// Design rationale: gradual plugin rollout means old and new client versions
// connect to the daemon concurrently. Equality-based mismatch detection makes
// old and new clients fight over which version the daemon should run
// (docs/issue/2026-07-10-daemon-version-flapping-on-gradual-rollout.md). A
// "client wins only if strictly newer" rule breaks that tie deterministically:
// the daemon only ever gets upgraded, never downgraded back and forth. This is
// intentionally NOT a full semver implementation (no build metadata, no
// multi-segment pre-release precedence) — the version string here is always
// `x.y.z` or `x.y.z-<suffix>` from bump-semver, so a minimal 3-number compare
// plus "no suffix beats any suffix" covers every real value.
function splitVersion(v: string): { core: [number, number, number]; suffix: string } {
  const [corePart, ...rest] = v.split("-");
  const suffix = rest.join("-");
  const parts = (corePart ?? "").split(".").map((n) => Number.parseInt(n, 10));
  const core: [number, number, number] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  return { core, suffix };
}

/** Returns negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = va.core[i] - vb.core[i];
    if (diff !== 0) return diff;
  }
  if (va.suffix === vb.suffix) return 0;
  if (va.suffix === "") return 1; // a has no suffix, b does: a is newer
  if (vb.suffix === "") return -1; // b has no suffix, a does: b is newer
  return 0; // both have (different) suffixes: no ordering opinion
}
