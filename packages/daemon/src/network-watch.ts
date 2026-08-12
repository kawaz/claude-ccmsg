// Host network online/offline transitions, as an event source rather than a
// timer.
//
// The only consumer is the api-error wake (server.ts): a session whose turn
// died on an API error while the host was disconnected sits idle forever,
// because nothing re-prompts it once the link returns. Watching the link is
// therefore worth exactly one long-lived child process and nothing per tick —
// `route -n monitor` streams routing-socket messages (default route added or
// removed, interface up/down) and stays silent while the network is stable.
//
// A routing message is not the same as "the host is online", so each burst is
// coalesced and then answered by a probe. The probe asks configd whether a
// primary IPv4/IPv6 service exists (`scutil -w <key> -t 1`, exit 0 = present)
// rather than reaching for a remote host: the daemon has no business
// originating outbound traffic to decide this, and a default route is what the
// stalled session needs back.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Subprocess } from "bun";

export interface NetworkWatchLog {
  info(msg: string): void;
  error(msg: string): void;
}

/** Stop a started monitor. Null means "no monitor could be started here"
 * (non-macOS, or `route` missing) — the watch then never fires, which is the
 * honest degradation: no signal is better than a synthesized one. */
export type MonitorStop = () => void;

export interface NetworkWatchOptions {
  /** Fired on every offline→online transition, never on online→online. */
  onOnline(): void;
  log: NetworkWatchLog;
  /** Coalescing window for a burst of routing messages. A link coming up emits
   * several within milliseconds; probing on the first one would read the
   * half-configured state. */
  debounceMs?: number;
  /** Injectable for tests. */
  probeOnline?: () => Promise<boolean>;
  /** Injectable for tests: start the event source, calling `onEvent` per
   * routing message burst. */
  startMonitor?: (onEvent: () => void) => MonitorStop | null;
}

export interface NetworkWatch {
  /** False when no monitor could be started; the watch is inert. */
  readonly enabled: boolean;
  /** Last probed state. Undefined until the initial probe lands. */
  readonly online: boolean | undefined;
  /** Feed a network-change event by hand (the monitor does this itself; tests
   * and any future event source use the same door). */
  notifyChange(): void;
  /** Resolves once no probe is in flight and no coalescing timer is pending —
   * tests await a settled watch instead of sleeping. */
  settled(): Promise<void>;
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 1500;

/** configd keys whose presence means "a primary service of this family is
 * configured" — i.e. there is a default route to use. */
const GLOBAL_KEYS = ["State:/Network/Global/IPv4", "State:/Network/Global/IPv6"] as const;

async function scutilKeyPresent(key: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["scutil", "-w", key, "-t", "1"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Online = configd has a primary IPv4 or IPv6 service. */
export async function probeOnlineDefault(): Promise<boolean> {
  for (const key of GLOBAL_KEYS) {
    if (await scutilKeyPresent(key)) return true;
  }
  return false;
}

/** Spawn `route -n monitor` and report each output burst as one event. Returns
 * null off macOS or when the binary will not start. */
export function startRouteMonitor(onEvent: () => void, log: NetworkWatchLog): MonitorStop | null {
  if (process.platform !== "darwin") return null;
  let proc: Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(["/sbin/route", "-n", "monitor"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (e: unknown) {
    log.error(`network watch: route monitor did not start: ${String(e)}`);
    return null;
  }
  let stopped = false;
  void (async () => {
    try {
      // Every chunk is one event; the caller coalesces, so there is no reason
      // to parse the routing messages themselves.
      for await (const _chunk of proc.stdout) {
        if (stopped) return;
        onEvent();
      }
    } catch (e: unknown) {
      if (!stopped) log.error(`network watch: route monitor read failed: ${String(e)}`);
    }
  })();
  return () => {
    stopped = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
}

/** `CCMSG_NETWORK_WATCH_FILE`: drive the watch from a file instead of the
 * routing socket — writing `online` / `offline` into it is a link coming up or
 * going down. It exists so a daemon *process* can be tested against real
 * transitions (the in-process seams cover the rest); it is not part of the
 * wire protocol and normal runs never set it. */
export function fileNetworkSource(
  file: string,
): Pick<NetworkWatchOptions, "probeOnline" | "startMonitor"> {
  return {
    probeOnline: async () => {
      try {
        return (await Bun.file(file).text()).trim() === "online";
      } catch {
        return false;
      }
    },
    startMonitor: (onEvent) => {
      const watcher = fs.watch(path.dirname(file), (_event, name) => {
        if (name === null || name === path.basename(file)) onEvent();
      });
      return () => watcher.close();
    },
  };
}

export function createNetworkWatch(options: NetworkWatchOptions): NetworkWatch {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const probe = options.probeOnline ?? probeOnlineDefault;
  const start =
    options.startMonitor ?? ((onEvent: () => void) => startRouteMonitor(onEvent, options.log));

  let online: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let stopped = false;
  /** Resolved once the work a caller's `notifyChange` set in motion has
   * finished. Rebuilt per open window so `settled()` never waits on a window
   * that opened after it was called. */
  let idle: { promise: Promise<void>; resolve: () => void } | null = null;

  const openWindow = (): void => {
    if (idle) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    idle = { promise, resolve };
  };

  const closeWindow = (): void => {
    if (timer || inflight) return;
    idle?.resolve();
    idle = null;
  };

  const runProbe = (): void => {
    if (stopped || inflight) {
      // A probe already walking will publish a state at least as fresh as the
      // one this event asks about; re-running would only race with it.
      closeWindow();
      return;
    }
    openWindow();
    inflight = (async () => {
      let next: boolean;
      try {
        next = await probe();
      } catch (e: unknown) {
        options.log.error(`network watch: probe failed: ${String(e)}`);
        return;
      }
      if (stopped) return;
      const was = online;
      online = next;
      if (next && was === false) {
        options.log.info("network watch: host is back online");
        options.onOnline();
      }
    })().finally(() => {
      inflight = null;
      closeWindow();
    });
  };

  const notifyChange = (): void => {
    if (stopped) return;
    openWindow();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runProbe();
    }, debounceMs);
    // The daemon must still be able to exit while a coalescing window is open.
    timer.unref?.();
  };

  const stopMonitor = start(notifyChange);
  if (!stopMonitor) options.log.info("network watch: no monitor available, wake-on-online is off");
  // Seed the state without firing: a daemon that starts while online must not
  // treat its first event as a recovery.
  if (stopMonitor) runProbe();

  return {
    get enabled() {
      return stopMonitor !== null;
    },
    get online() {
      return online;
    },
    notifyChange,
    async settled() {
      await idle?.promise;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      idle?.resolve();
      idle = null;
      stopMonitor?.();
    },
  };
}
