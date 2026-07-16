// Historical session search (DR-0021 Phase 2). Sits inside the sidebar's
// SESSIONS section, toggled on by Sidebar's 🔍 button, replacing SessionList
// while open (see Sidebar.tsx's doc comment for why a sidebar-internal panel
// was chosen over a locator-driven `state.view` — search is a tool to find
// and pin a session, not itself a durable/bookmarkable screen the way a room
// or a session's Files/Timeline is). Clicking a result pins it (localStorage,
// SS-Q2=a, see store.ts's pinnedSessions) and navigates to its Timeline —
// the daemon's `allowVirtual` transcript_read/fs_list/fs_read resolution
// (DR-0021 §3.1, server.ts) makes a pinned-but-disconnected sid's Timeline
// work with no live peer required.
import { useMemo, useState } from "preact/hooks";
import {
  SESSION_SEARCH_RESULT_MAX,
  type SessionSearchHit,
  type SessionSearchResponse,
} from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { timelineHref } from "../locator.ts";
import {
  buildSessionSearchRequest,
  DEFAULT_SESSION_SEARCH_FORM,
  errorMessage,
  formatBytes,
  matchRoleBadge,
  relTime,
  sessionSearchHitLabel,
  shortSid,
  type SessionSearchForm,
} from "../utils.ts";

/** One search-result "block" (DR-0021 §2.3: repo/wt·ws/SID/created/updated/
 * size/match-summary, clickable as a whole). A `<div role="button">` rather
 * than an actual `<button>` — the match list below carries multiple lines of
 * text plus per-line role badges, and block-level content inside `<button>`
 * is non-conforming HTML even though browsers render it; a keyboard-operable
 * div sidesteps that without giving up the "whole block is one click target"
 * layout DR-0021 asks for. */
function SearchResultRow({
  hit,
  pinned,
  onSelect,
}: {
  hit: SessionSearchHit;
  pinned: boolean;
  onSelect: () => void;
}) {
  const { repo, ws } = sessionSearchHitLabel(hit);
  return (
    <li class="session-search-hit">
      <div
        class="session-search-hit-main"
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <div class="session-search-hit-head">
          <span class="session-search-hit-repo">{repo || ws || shortSid(hit.sid)}</span>
          {repo && ws ? <span class="session-search-hit-ws">{ws}</span> : null}
          <span class="session-search-hit-sid">{shortSid(hit.sid)}</span>
          {pinned ? (
            <span class="session-search-hit-pinned" title="pinned 済み">
              📌
            </span>
          ) : null}
        </div>
        <div class="session-search-hit-meta">
          作成 {relTime(hit.created_at)} · 更新 {relTime(hit.updated_at)} · {formatBytes(hit.size)}
        </div>
        {hit.matches.length > 0 ? (
          <div class="session-search-hit-matches">
            {hit.matches.map((m, i) => (
              <div key={i} class={`session-search-match session-search-match-${m.role}`}>
                <span class="session-search-match-badge">{matchRoleBadge(m.role)}</span>
                <span class="session-search-match-text">{m.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function SessionSearchPanel({ onClose }: { onClose: () => void }) {
  const { store, ws } = useApp();
  const state = useStoreState(store);
  const [form, setForm] = useState<SessionSearchForm>(DEFAULT_SESSION_SEARCH_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionSearchResponse | null>(null);

  // config_dir トグルの候補 (DR-0021 §2.1: 複数検出時のみ表示) — daemon の
  // agents 応答 (state.agents、claude agents --json ポーリング由来) が検出済
  // みの config_dir と、直近の検索結果が実際に返した config_dir の和集合。
  // 前者だけだと「今動いている agent が無い config_dir 配下の過去セッション」
  // を検索した結果が反映されない (kawaz 指示の「無理なら Phase 1 応答から」の
  // フォールバック)。
  const configDirOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of state.agents) set.add(a.config_dir);
    for (const hit of result?.hits ?? []) set.add(hit.config_dir);
    return [...set].sort();
  }, [state.agents, result]);

  function toggleConfigDir(dir: string): void {
    setForm((f) => {
      const active = new Set(f.configDirs.length === 0 ? configDirOptions : f.configDirs);
      if (active.has(dir)) {
        // Refuse to drop the last remaining selection — an empty array means
        // "no filter" (every config dir) on the wire, not "search nothing";
        // see buildSessionSearchRequest's doc comment.
        if (active.size <= 1) return f;
        active.delete(dir);
      } else {
        active.add(dir);
      }
      const next = [...active];
      return { ...f, configDirs: next.length === configDirOptions.length ? [] : next };
    });
  }

  async function runSearch(e: Event): Promise<void> {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await ws.sessionSearch(buildSessionSearchRequest(form));
      if (res.ok) {
        setResult(res);
      } else {
        setError(res.error.msg);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function pinAndOpen(hit: SessionSearchHit): void {
    store.dispatch({ type: "pinned/added", hit });
    location.assign(timelineHref(hit.sid));
    onClose();
  }

  return (
    <div id="session-search-panel">
      <div class="session-search-header">
        <h3>Session Search</h3>
        <button
          type="button"
          class="session-search-close"
          onClick={onClose}
          aria-label="検索を閉じる"
        >
          ✕
        </button>
      </div>
      <form class="session-search-form" onSubmit={(e) => void runSearch(e)}>
        <input
          type="text"
          class="session-search-query"
          placeholder="query words..."
          value={form.query}
          onInput={(e) => setForm({ ...form, query: (e.target as HTMLInputElement).value })}
        />
        <div class="session-search-row">
          <label class="session-search-toggle">
            <input
              type="checkbox"
              checked={form.targetUser}
              onChange={(e) =>
                setForm({ ...form, targetUser: (e.target as HTMLInputElement).checked })
              }
            />
            user
          </label>
          <label class="session-search-toggle">
            <input
              type="checkbox"
              checked={form.targetAgent}
              onChange={(e) =>
                setForm({ ...form, targetAgent: (e.target as HTMLInputElement).checked })
              }
            />
            agent
          </label>
        </div>
        <input
          type="text"
          placeholder="cwd words..."
          value={form.cwd}
          onInput={(e) => setForm({ ...form, cwd: (e.target as HTMLInputElement).value })}
        />
        <input
          type="text"
          placeholder="session id (partial)"
          value={form.sid}
          onInput={(e) => setForm({ ...form, sid: (e.target as HTMLInputElement).value })}
        />
        {configDirOptions.length > 1 ? (
          <fieldset class="session-search-config-dirs">
            <legend>config dir</legend>
            {configDirOptions.map((dir) => (
              <label key={dir} class="session-search-toggle">
                <input
                  type="checkbox"
                  checked={form.configDirs.length === 0 || form.configDirs.includes(dir)}
                  onChange={() => toggleConfigDir(dir)}
                />
                {dir}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label class="session-search-row session-search-mtime">
          mtime within
          <input
            type="text"
            placeholder="5d"
            value={form.mtimeWithin}
            onInput={(e) => setForm({ ...form, mtimeWithin: (e.target as HTMLInputElement).value })}
          />
        </label>
        <button type="submit" class="session-search-submit" disabled={loading}>
          {loading ? "検索中…" : "検索"}
        </button>
      </form>
      {error ? <p class="session-search-error">{error}</p> : null}
      {result ? (
        <>
          <ul class="session-search-results">
            {result.hits.map((hit) => (
              <SearchResultRow
                key={hit.sid}
                hit={hit}
                pinned={state.pinnedSessions.has(hit.sid)}
                onSelect={() => pinAndOpen(hit)}
              />
            ))}
          </ul>
          {result.hits.length === 0 ? <p class="session-search-empty">該当なし</p> : null}
          {result.truncated ? (
            // The daemon flags `truncated` for ANY partial scan — the
            // SESSION_SEARCH_RESULT_MAX hit cap, but also per-file prefilter
            // line caps and the request-wide scan byte budget
            // (session-search.ts) — so this can appear with far fewer than
            // MAX hits shown. Phrase it as "incomplete", not "over the cap".
            <p class="session-search-truncated">
              検索が途中で打ち切られました (結果上限 {SESSION_SEARCH_RESULT_MAX} 件 /
              走査量上限)。query・cwd・mtime で絞り込むと網羅されます。
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
