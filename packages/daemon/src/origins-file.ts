// Persisted extra allowed Origins (docs/issue/2026-07-12-webui-403-behind-caddy).
//
// `CCMSG_HTTP_ALLOW_ORIGIN` (env) is lost whenever a client respawns the daemon
// without it, and the tailscale-serve auto-allow only covers proxies tailscale
// itself reports — a reverse proxy the daemon can't introspect (caddy on a
// public hostname) needs an allowance that survives respawns. That allowance
// lives in `<dataDir>/allowed-origins.json` (a JSON string[], managed by
// `ccmsg origins add/remove/list`) and is read here with an mtime-gated cache.
//
// Freshness without a watcher: http.ts consults this ONLY when a request's
// Origin failed every other check — the happy path never touches the
// filesystem beyond the first read, and a just-added origin takes effect on
// the very next request (its failing lookup re-stats the file, sees the new
// mtime, reloads). A deleted/corrupted file degrades to "no extra origins"
// with one log line, never a crash.
import * as fs from "node:fs";

export interface OriginsFile {
  /** current allowed origins; do not mutate (replaced wholesale on reload). */
  get(): Set<string>;
}

export function createOriginsFile(file: string, log: { warn(msg: string): void }): OriginsFile {
  let cached = new Set<string>();
  let cachedMtimeMs: number | null = null; // null = never successfully statted

  function reload(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      // missing file = no extra origins (the common case until first `origins add`)
      cached = new Set();
      cachedMtimeMs = null;
      return;
    }
    if (cachedMtimeMs !== null && stat.mtimeMs === cachedMtimeMs) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a JSON array");
      cached = new Set(parsed.filter((v): v is string => typeof v === "string"));
      cachedMtimeMs = stat.mtimeMs;
    } catch (e) {
      log.warn(`allowed-origins: unreadable ${file} (${String(e)}) — treating as empty`);
      cached = new Set();
      cachedMtimeMs = stat.mtimeMs; // don't re-parse the same broken content every request
    }
  }

  return {
    get() {
      reload();
      return cached;
    },
  };
}
