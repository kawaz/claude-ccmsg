import { describe, expect, test } from "bun:test";
import { releaseDaemonResources } from "../src/daemon-shutdown.ts";

describe("daemon shutdown resource boundary", () => {
  test("UDS disappears only after every resource that can block a successor is released", async () => {
    // Clients use UDS disappearance as the sole proof that the predecessor has
    // yielded. HTTP ports, pid ownership, and the daemon lock must therefore be
    // released before UDS is stopped. A deferred
    // HTTP stop makes the forbidden intermediate window deterministic.
    const events: string[] = [];
    let finishHttp!: () => void;
    const httpStopped = new Promise<void>((resolve) => {
      finishHttp = resolve;
    });

    const releasing = releaseDaemonResources({
      stopHttp: async () => {
        events.push("http:start");
        await httpStopped;
        events.push("http:done");
      },
      removePid: () => events.push("pid"),
      releaseLock: () => events.push("lock"),
      stopUds: () => events.push("uds:stop"),
    });

    await Promise.resolve();
    expect(events).toEqual(["http:start"]);

    finishHttp();
    await releasing;
    expect(events).toEqual(["http:start", "http:done", "pid", "lock", "uds:stop"]);
  });
});
