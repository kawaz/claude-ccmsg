// Which live sessions are stopped on a harness API error, across *all*
// peers rather than just the one the webui has open.
//
// The sidebar has to colour every row, so the per-sid session_status
// subscription can't be the source: DR-0020 §2.1 (a) rejected subscribing a
// full fold per visible peer because its cost (agent-tree reads, workflow
// drilldown, snapshot pushes) scales with session count. This module keeps
// that budget by folding exactly one pattern — classifyApiErrorRow — over the
// lines the transcript relay reads (DR-0045 §5): a string compare per line,
// and nothing at snapshot time. A session is folded while its hooks module
// has a run named; the error row carries both what the harness showed and
// how Claude Code classified it (its `error`), which the module cannot read
// (DR-0039 §2).
import {
  isKnownTranscriptRow,
  parseWith,
  TranscriptRowLineSchema,
  type SessionApiError,
  type SessionErrorEntry,
} from "@ccmsg/protocol";
import { classifyApiErrorRow } from "./session-status.ts";
import type { LineFold } from "./transcript-relay.ts";

/** Cheap string prefilter before JSON.parse, mirroring
 * isSessionStatusCandidate's role: only rows that could set the state
 * (`isApiErrorMessage`) or clear it (any assistant row) are worth parsing.
 * `"type":"assistant"` is the clearing side and matches every assistant row —
 * that is the intended breadth, since a real assistant row is exactly what
 * ends an error. */
export function isApiErrorCandidate(line: string): boolean {
  return line.includes('"isApiErrorMessage"') || line.includes('"type":"assistant"');
}

interface ErrorFold {
  error?: SessionApiError;
}

export interface SessionErrorsStore {
  /** The settled fold of each live session. */
  folds: Map<string, ErrorFold>;
}

export function createSessionErrorsStore(): SessionErrorsStore {
  return { folds: new Map() };
}

/** Current error list, sorted by sid so callers can compare two snapshots by
 * value to decide whether a push is warranted. */
export function sessionErrorEntries(store: SessionErrorsStore): SessionErrorEntry[] {
  const entries: SessionErrorEntry[] = [];
  for (const [sid, fold] of store.folds) {
    if (fold.error) entries.push({ sid, ...fold.error });
  }
  return entries.sort((a, b) => a.sid.localeCompare(b.sid));
}

function foldLine(fold: ErrorFold, line: string): boolean {
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok) return false;
  const row = read.value;
  if (!isKnownTranscriptRow(row) || row.type !== "assistant") return false;
  const signal = classifyApiErrorRow(row);
  if (!signal) return false;
  if (signal.kind === "clear") {
    if (!fold.error) return false;
    fold.error = undefined;
    return true;
  }
  const current = fold.error;
  if (current?.text === signal.error.text && current.timestamp === signal.error.timestamp) {
    return false;
  }
  fold.error = signal.error;
  return true;
}

/** `sid`'s API error fold, for the transcript relay. A catch-up folds into
 * a detached state that replaces the settled one only when it lands, so the
 * list never shows a half-read transcript. `onChange` is told when the
 * session's entry may have moved. */
export function sessionErrorFold(
  store: SessionErrorsStore,
  sid: string,
  onChange: () => void,
): LineFold {
  let settled: ErrorFold | undefined;
  let next: ErrorFold | undefined;
  let moved = false;
  return {
    restart() {
      next = {};
    },
    take(line) {
      const fold = next ?? settled;
      if (fold !== undefined && isApiErrorCandidate(line) && foldLine(fold, line)) moved = true;
    },
    settle() {
      if (next !== undefined) {
        moved ||= next.error !== settled?.error;
        settled = next;
        next = undefined;
        store.folds.set(sid, settled);
      }
      if (!moved) return;
      moved = false;
      onChange();
    },
    close() {
      if (store.folds.get(sid) === settled) store.folds.delete(sid);
      if (settled?.error !== undefined) onChange();
      settled = undefined;
      next = undefined;
    },
  };
}
