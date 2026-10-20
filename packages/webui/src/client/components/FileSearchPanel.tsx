// "Search files by name" for the Files pane (kawaz r55 m67). Replaces the tree
// body while a query is active, rather than filtering the tree in place: the
// tree is lazy (DR-0008), so a filtered *tree* could only ever hide rows the
// user had already expanded, which is not what "search this project" means.
// A flat result list also lets a hit show its whole path, which is the useful
// thing to read when the point of searching is that you don't know where the
// file lives.
//
// The panel follows SessionSearchPanel's flow (type → submit → result rows →
// click opens the target) but stays a plain input rather than that panel's
// multi-field form: the request is one query string against path names, and a
// submit button for a single text box would be ceremony. Enter and a debounced
// idle both run the search, so the box works whether the user types-and-waits
// or types-and-hits-Enter.
import { useEffect, useRef, useState } from "preact/hooks";
import type { FsFindHit, WorkspaceFolder } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { useKeyedValue } from "../useKeyedState.ts";
import { fileHref } from "../locator.ts";
import { fileIconKind, FileTypeIcon } from "./FileIcon.tsx";
import { FavoriteToggle, type FavContext } from "./FileTree.tsx";
import { errorMessage } from "../utils.ts";
import {
  fileSearchHitCount,
  fileSearchIncomplete,
  fileSearchTargets,
  filterExternalFiles,
  type FileSearchGroup,
  workspaceHitDisplayPath,
} from "../file-search.ts";

/** Idle delay before an unsubmitted query runs on its own. Long enough that a
 * normal typing burst produces one walk rather than one per keystroke, short
 * enough to feel like live filtering. */
const SEARCH_DEBOUNCE_MS = 250;

function basename(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? filePath : filePath.slice(slash + 1);
}

/** One hit row: the path as a single string (kawaz r55m76). File names alone
 * are ambiguous when a repo holds a dozen `index.ts` / `SKILL.md`, so the path
 * is what identifies the hit. Long paths scroll horizontally rather than wrap
 * or truncate.
 *
 * `display` is what the row shows, `hit.path` is what it links to and stars —
 * the two differ only for workspace hits, where the folder's absolute prefix
 * is shortened to its name (kawaz r55m127). Only the display side is
 * shortened: the href and the favorites key are the daemon's own path space,
 * and rewriting them would break the link and desynchronize the ★ from the
 * tree row for the same file. The `title` keeps the full path one hover away. */
function HitRow({
  sid,
  hit,
  display,
  fav,
}: {
  sid: string;
  hit: FsFindHit;
  display: string;
  fav: FavContext | null;
}) {
  return (
    <li>
      <a class="file-search-hit" href={fileHref(sid, hit.path)} title={hit.path}>
        <FileTypeIcon
          kind={fileIconKind(basename(hit.path), hit.type === "symlink" ? "symlink" : "file")}
        />
        <span class="file-search-hit-path">{display}</span>
      </a>
      {/* お気に入り (kawaz r55m82): ツリー行と同じ FavoriteToggle を行末に置く。
       * 同じ一覧を共有しているので、検索結果で付けた星はツリー側にも即座に
       * 反映される。`<a>` の兄弟として置くのはツリー行と同じ理由 (ネストは
       * 不正 HTML かつクリック対象が競合する)。 */}
      {fav ? (
        <FavoriteToggle
          path={hit.path}
          favorited={fav.isFavorite(hit.path)}
          onToggle={fav.onToggle}
        />
      ) : null}
    </li>
  );
}

export function FileSearchPanel({
  sid,
  query,
  respectGitignore,
  treeRoot,
  workspaceFolders,
  externalFiles,
  fav,
}: {
  sid: string;
  /** Whether the walk skips `.gitignore`d paths. Owned by FileTree alongside
   * the query (the toggle sits next to the box), and part of the effect's dep
   * list so flipping it re-runs the search rather than waiting for a keystroke
   * — a toggle that visibly changes nothing until you retype reads as broken. */
  respectGitignore: boolean;
  /** Current text in FileTree's search box. Owned there (the box lives in the
   * tree header and its emptiness decides whether this panel renders at all),
   * passed down so this component only owns the request/result cycle. */
  query: string;
  /** The tree's browsing origin, containment-root-relative (FileTree's
   * `rootPath`) — the search covers the subtree the tree shows, no more. */
  treeRoot: string;
  workspaceFolders: readonly WorkspaceFolder[];
  /** お気に入り機構 (FileTree と共有)。null = このセッションでは無効。 */
  fav: FavContext | null;
  externalFiles: readonly string[];
}) {
  const { ws } = useApp();
  const [groups, setGroups] = useState<FileSearchGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Guards against an out-of-order reply overwriting a newer query's results:
  // each run claims a sequence number and only the latest one is allowed to
  // commit. Walks of different subtrees take wildly different times, so "the
  // reply that arrives last" is emphatically not "the query typed last".
  const runSeq = useRef(0);
  // SessionView passes these as `sessionStatus?.x ?? []`, so their identity
  // changes on every render. Using those arrays as effect deps would clear and
  // restart the debounce timer forever and the search would never fire — so
  // the effect depends on arrays held per content (every field goes into the
  // key), which change only when the lists themselves do.
  const folders = useKeyedValue(
    [workspaceFolders.map((folder) => `${folder.path}\u0000${folder.name}`).join("\n")],
    () => workspaceFolders,
  );
  const external = useKeyedValue([externalFiles.join("\n")], () => externalFiles);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setGroups(null);
      setLoading(false);
      setFatalError(null);
      return;
    }
    const seq = ++runSeq.current;
    const timer = setTimeout(() => {
      setLoading(true);
      setFatalError(null);
      const targets = fileSearchTargets(folders, treeRoot);
      void Promise.all(
        targets.map(async (target): Promise<FileSearchGroup> => {
          const base = { label: target.label, folder: target.folder };
          try {
            const res = await ws.fsFind(sid, target.kind, target.root, trimmed, respectGitignore);
            if (!res.ok) {
              return { ...base, hits: [], truncated: false, error: res.error.msg };
            }
            return { ...base, hits: res.hits, truncated: res.truncated, error: null };
          } catch (err) {
            return { ...base, hits: [], truncated: false, error: errorMessage(err) };
          }
        }),
      )
        .then((resolved) => {
          if (runSeq.current !== seq) return;
          // External files (DR-0024) have no directory for the daemon to walk,
          // so they're matched here against the same contract — see
          // filterExternalFiles. Appended as its own group so the section
          // labels line up with the tree's own プロジェクト外 section.
          const externalHits = filterExternalFiles(external, trimmed);
          const withExternal: FileSearchGroup[] =
            externalHits.length > 0
              ? [
                  ...resolved,
                  {
                    label: "プロジェクト外",
                    folder: null,
                    hits: externalHits.map((filePath) => ({
                      path: filePath,
                      type: "file" as const,
                    })),
                    truncated: false,
                    error: null,
                  },
                ]
              : resolved;
          setGroups(withExternal);
          setLoading(false);
        })
        .catch((err) => {
          if (runSeq.current !== seq) return;
          setFatalError(errorMessage(err));
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sid, query, respectGitignore, treeRoot, folders, external, ws]);

  if (fatalError) return <p class="tree-error">{fatalError}</p>;
  if (groups === null) return loading ? <p class="tree-loading">検索中…</p> : null;

  const total = fileSearchHitCount(groups);
  return (
    <div class="file-search-results">
      {loading ? <p class="tree-loading">検索中…</p> : null}
      {total === 0 && !loading ? <p class="file-search-empty">該当なし</p> : null}
      {groups.map((group, groupIndex) =>
        group.error !== null ? (
          <p key={`err-${groupIndex}`} class="tree-error">
            {group.label ? `${group.label}: ` : ""}
            {group.error}
          </p>
        ) : group.hits.length === 0 ? null : (
          <div key={`g-${groupIndex}`}>
            {/* Workspace groups get no heading: every row in one already opens
             * with the folder's name (workspaceHitDisplayPath), so a heading
             * repeating it is a line of pure duplication. The error branch
             * above still uses `label` — a failed group has no rows to carry
             * the name, and "which folder failed" is the whole content of
             * that message. */}
            {group.label && group.folder === null ? (
              <p class="tree-section-label">{group.label}</p>
            ) : null}
            <ul class="file-search-list">
              {group.hits.map((hit) => (
                <HitRow
                  key={hit.path}
                  sid={sid}
                  hit={hit}
                  display={
                    group.folder
                      ? workspaceHitDisplayPath(hit.path, group.folder.path, group.folder.name)
                      : hit.path
                  }
                  fav={fav}
                />
              ))}
            </ul>
          </div>
        ),
      )}
      {fileSearchIncomplete(groups) && total > 0 ? (
        // Same phrasing posture as SessionSearchPanel's truncation notice: say
        // the result set is incomplete and what to do about it, rather than
        // quoting a cap the user has no way to act on.
        <p class="file-search-truncated">
          結果が多いため途中で打ち切られました。語を足すと絞り込めます。
        </p>
      ) : null}
    </div>
  );
}
