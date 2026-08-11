// Finding a fork's seam (fork-origin.ts). A forked transcript is a copy of its
// ancestor's records with only `sessionId` rewritten, so nothing in the file
// marks the seam and the answer has to come from the sibling transcripts —
// which is what makes the "not a fork" and "ancestor deleted" cases the same
// answer. Shapes here mirror what the real transcripts hold
// (docs/findings/2026-08-11-checkpoint-rewind.md §5).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createForkOriginCache, resolveForkOrigin } from "../src/fork-origin.ts";

const log = { error: () => {} };

/** Creation order, stated rather than staged on disk (see ForkOriginOptions'
 * createdAt). Files not listed here are treated as created "now". */
const order = new Map<string, number>();
const opts = {
  createdAt: (file: string) => order.get(path.basename(file)) ?? Date.now(),
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-fork-origin-"));
  order.clear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SID_A = "11111111-1111-4111-8111-111111111111";
const SID_B = "22222222-2222-4222-8222-222222222222";
const SID_C = "33333333-3333-4333-8333-333333333333";

function row(sid: string, uuid: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", sessionId: sid, uuid, ...extra });
}

/** Writes `<sid>.jsonl`, recording it as created `ageMs` ago — the ancestor is
 * identified by being older, and creation time is what no test can stage
 * portably. */
function write(sid: string, lines: string[], ageMs = 0): string {
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  order.set(`${sid}.jsonl`, Date.now() - ageMs);
  return file;
}

describe("resolveForkOrigin", () => {
  test("names the last copied record and the session it came from", async () => {
    // The copied rows carry the FORK's sid, not the ancestor's — the rewrite is
    // total, which is exactly why membership by uuid is the only signal.
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2"), row(SID_A, "u-3")], 60_000);
    const fork = write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2"), row(SID_B, "f-1")]);

    expect(await resolveForkOrigin(fork, log, opts)).toEqual({
      sid: SID_A,
      boundary_uuid: "u-2",
      copied: 2,
    });
  });

  test("an ordinary session shares no first record, so there is no seam", async () => {
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 60_000);
    const plain = write(SID_B, [row(SID_B, "x-1"), row(SID_B, "x-2")]);

    expect(await resolveForkOrigin(plain, log, opts)).toBeNull();
  });

  test("the ancestor's own uncopied rows don't break the run", async () => {
    // Sidechain/subagent rows interleave into the ancestor but never into the
    // forked message array, so the copied run matches a subset in order.
    // Index-by-index comparison would stop at "u-1" and report copied=1.
    write(
      SID_A,
      [row(SID_A, "u-1"), row(SID_A, "side-1"), row(SID_A, "u-2"), row(SID_A, "u-3")],
      60_000,
    );
    const fork = write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2"), row(SID_B, "f-1")]);

    expect(await resolveForkOrigin(fork, log, opts)).toMatchObject({
      boundary_uuid: "u-2",
      copied: 2,
    });
  });

  test("among sibling forks of one ancestor, the longest run wins", async () => {
    // Forks of forks share a prefix with every ancestor in the chain; the
    // nearest one is the one that shares the most.
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 120_000);
    write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2"), row(SID_B, "u-3")], 60_000);
    const fork = write(SID_C, [
      row(SID_C, "u-1"),
      row(SID_C, "u-2"),
      row(SID_C, "u-3"),
      row(SID_C, "f-1"),
    ]);

    expect(await resolveForkOrigin(fork, log, opts)).toMatchObject({ sid: SID_B, copied: 3 });
  });

  test("a younger sibling is never the ancestor", async () => {
    // Same shared prefix, but this one was created after the file under test,
    // so it is a sibling fork rather than the source.
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2"), row(SID_A, "s-1")]);
    const earlier = write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2"), row(SID_B, "f-1")], 60_000);

    expect(await resolveForkOrigin(earlier, log, opts)).toBeNull();
  });

  test("a vanished ancestor reads the same as never having forked", async () => {
    const fork = write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2"), row(SID_B, "f-1")]);

    expect(await resolveForkOrigin(fork, log, opts)).toBeNull();
  });

  test("no seam when nothing has been added past the copied history", async () => {
    // A fork with no turns of its own yet: the rule would sit under the last
    // row with nothing below it to divide.
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 60_000);
    const fresh = write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2")]);

    expect(await resolveForkOrigin(fresh, log, opts)).toBeNull();
  });

  test("rows without a uuid are skipped rather than ending the run", async () => {
    // Header rows (`last-prompt`, `mode`, ...) carry no uuid and appear in both
    // files; they are not records the seam can sit on.
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 60_000);
    const fork = write(SID_B, [
      JSON.stringify({ type: "last-prompt", sessionId: SID_B, leafUuid: "u-1" }),
      row(SID_B, "u-1"),
      row(SID_B, "u-2"),
      row(SID_B, "f-1"),
    ]);

    expect(await resolveForkOrigin(fork, log, opts)).toMatchObject({
      boundary_uuid: "u-2",
      copied: 2,
    });
  });

  test("a final row without a trailing newline still counts", async () => {
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 60_000);
    const file = path.join(dir, `${SID_B}.jsonl`);
    fs.writeFileSync(file, `${row(SID_B, "u-1")}\n${row(SID_B, "u-2")}\n${row(SID_B, "f-1")}`);

    expect(await resolveForkOrigin(file, log, opts)).toMatchObject({ copied: 2 });
  });

  test("unparseable rows don't abort the sweep", async () => {
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 60_000);
    const fork = write(SID_B, [
      row(SID_B, "u-1"),
      "{ this is not json",
      row(SID_B, "u-2"),
      row(SID_B, "f-1"),
    ]);

    expect(await resolveForkOrigin(fork, log, opts)).toMatchObject({
      boundary_uuid: "u-2",
      copied: 2,
    });
  });
});

describe("createForkOriginCache", () => {
  test("appending to a live session doesn't re-resolve", async () => {
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 60_000);
    const fork = write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2"), row(SID_B, "f-1")]);
    const cache = createForkOriginCache();
    const first = await cache.resolve(fork, log, opts);

    // The ancestor is removed before the second ask: a re-resolve would now
    // answer null, so an unchanged answer proves the memo was used. This is
    // the live-session case — a running fork appends for hours, and keying on
    // size or mtime would re-read the ancestor on every poll.
    fs.appendFileSync(fork, `${row(SID_B, "f-2")}\n`);
    fs.rmSync(path.join(dir, `${SID_A}.jsonl`));

    expect(await cache.resolve(fork, log, opts)).toEqual(first!);
  });

  test("concurrent asks share one sweep", async () => {
    write(SID_A, [row(SID_A, "u-1"), row(SID_A, "u-2")], 60_000);
    const fork = write(SID_B, [row(SID_B, "u-1"), row(SID_B, "u-2"), row(SID_B, "f-1")]);
    const cache = createForkOriginCache();

    const [a, b] = await Promise.all([
      cache.resolve(fork, log, opts),
      cache.resolve(fork, log, opts),
    ]);
    expect(a).toEqual(b!);
    expect(a).toMatchObject({ copied: 2 });
  });
});
