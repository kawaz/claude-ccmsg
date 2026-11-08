// The whole read of one session's transcripts the 🔔 and 🔐 filters ask for
// (notification_list, DR-0050 §5): the session's own transcript, then each of
// its subagents', teammates' and workflow agents'. The says and the requests
// for permission are found on the same lines, so the stores that look for
// them share one read when they ask together.
import { listAgentTranscripts } from "./agent-transcripts.ts";
import { scanTranscriptLines } from "./transcript.ts";

/** Takes one line of a sweep: `agentId` is the agent whose transcript it is
 * in, undefined for the session's own. */
export type SweepTake = (line: string, agentId: string | undefined) => void;

/** Reads the session's transcripts into `take`. Rejects when the session's
 * own transcript does not read; an agent's that does not read is left out. */
export type SessionSweep = (take: SweepTake) => Promise<void>;

/** The sweep of the session transcript `file` and its agents'. The takers
 * that ask in one turn of the event loop share one read; one that asks once
 * that read has begun gets a read of its own. */
export function sessionSweep(file: string): SessionSweep {
  let batch: SweepTake[] | undefined;
  let reading: Promise<void> = Promise.resolve();
  return (take) => {
    if (batch === undefined) {
      const takers: SweepTake[] = [];
      batch = takers;
      reading = (async () => {
        await Promise.resolve();
        batch = undefined;
        await sweepFiles(file, (line, agentId) => {
          for (const taker of takers) taker(line, agentId);
        });
      })();
    }
    batch.push(take);
    return reading;
  };
}

async function sweepFiles(file: string, take: SweepTake): Promise<void> {
  await scanTranscriptLines(file, undefined, (line) => take(line, undefined));
  for (const agent of await listAgentTranscripts(file)) {
    try {
      await scanTranscriptLines(agent.file, undefined, (line) => take(line, agent.agentId));
    } catch {
      // Gone between the listing and the read: it has nothing to add.
    }
  }
}
