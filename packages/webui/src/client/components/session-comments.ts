// What a session's screen holds of its comments for its Timeline and its
// Files alike (DR-0062 §3, §12, §13): see SessionComments.
import { useCallback, useMemo, useRef, useState } from "preact/hooks";
import type {
  Asked,
  CommentFormTarget,
  OpenCommentForm,
  SessionComments,
} from "./timeline/comment-context.ts";

/** The state of a session's comments its screen holds (SessionView provides
 * it; a Timeline mounted alone holds its own), for the session whose root
 * and cwd are `root` and `cwd`. */
export function useSessionCommentsState(
  root: string | undefined,
  cwd: string | undefined,
): SessionComments {
  const [form, setForm] = useState<OpenCommentForm | null>(null);
  const openForm = useCallback(
    (target: CommentFormTarget, opener: HTMLElement | null) => setForm({ target, opener }),
    [],
  );
  const closeForm = useCallback(() => setForm(null), []);
  const asked = useRef(0);
  const [selected, setSelected] = useState<Asked<string> | null>(null);
  const select = useCallback((key: string | null) => {
    asked.current += 1;
    setSelected(key === null ? null : { value: key, seq: asked.current });
  }, []);
  const [reveal, setReveal] = useState<Asked<string> | null>(null);
  const revealFile = useCallback((cid: string | null) => {
    asked.current += 1;
    setReveal(cid === null ? null : { value: cid, seq: asked.current });
  }, []);
  // Changed only when what is lost changes, as each viewer reports whenever
  // it draws.
  const [lostByViewer] = useState(() => new Map<object, readonly string[]>());
  const [lostFiles, setLostFiles] = useState<ReadonlySet<string>>(() => new Set());
  const reportLostFile = useCallback(
    (viewer: object, lost: readonly string[] | null) => {
      if (lost === null || lost.length === 0) lostByViewer.delete(viewer);
      else lostByViewer.set(viewer, lost);
      const next = new Set([...lostByViewer.values()].flat());
      setLostFiles((before) =>
        before.size === next.size && [...next].every((cid) => before.has(cid)) ? before : next,
      );
    },
    [lostByViewer],
  );
  return useMemo(
    () => ({
      form,
      openForm,
      closeForm,
      selected,
      select,
      reveal,
      revealFile,
      lostFiles,
      reportLostFile,
      root,
      cwd,
    }),
    [
      form,
      openForm,
      closeForm,
      selected,
      select,
      reveal,
      revealFile,
      lostFiles,
      reportLostFile,
      root,
      cwd,
    ],
  );
}
