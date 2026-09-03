// Historical session search (DR-0021 Phase 2)。開いているかどうかと検索語は
// URL の `sb.*` が持ち (`?sb.panel=search&sb.search=…`、sidebar-url.ts / 表は
// docs/design/webui-url-grammar.md)、描き場所は幅で変わる (デスクトップ =
// FormPane、スマホ = サイドバー内で SessionList を置換)。path 側の view に
// しないのは、検索がメインペインの中身を置き換えないから — 結果を選んで
// Timeline へ遷移してもこのパネルは開いたままで、そこが要点になっている。
//
// 検索語を URL に書き戻すのは検索を**実行した**時だけ (replace)。打鍵ごとに
// 履歴を積むと、戻るがパネルを閉じるところまで届かなくなる。
//
// 結果クリックは履歴メタデータと送信済みクエリをキャッシュしてから Timeline へ
// 遷移する (ピン留めもパネルを閉じることもしない)。daemon の allowVirtual
// transcript_read/fs_list/fs_read 解決 (DR-0021 §3.1, server.ts) により、
// 過去 sid の Timeline は live peer 無しで開ける。
import { useMemo, useState } from "preact/hooks";
import {
  SESSION_SEARCH_RESULT_MAX,
  type SessionSearchHit,
  type SessionSearchResponse,
} from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { selectedSid } from "../store.ts";
import { timelineHref } from "../locator.ts";
import { pushNavigation, replaceNavigation } from "../navigation.ts";
import {
  buildSessionSearchRequest,
  DEFAULT_SESSION_SEARCH_FORM,
  errorMessage,
  formatBytes,
  matchRoleBadge,
  relTime,
  sessionSearchFormToTimelineSearch,
  sessionSearchHitLabel,
  shortSid,
  type SessionSearchForm,
} from "../utils.ts";
import { prefillSidebarState } from "../session-creator.ts";
import { parseSearchQuery, splitTextForHighlight, type SearchWord } from "../in-view-search.ts";
import { SearchModeToggles } from "./SearchBar.tsx";

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
  active,
  words,
  onSelect,
  onResume,
  onTogglePin,
}: {
  hit: SessionSearchHit;
  pinned: boolean;
  /** This hit's sid is the sidebar's current selection (kawaz r99m2 相当: 検索
   * 結果をクリックして Timeline を開いた後、マウスが離れてもどれを見ているか
   * 分かるように) — same source of truth SessionList/RoomList use
   * (`selectedSid`, see store.ts's doc comment), so a hit stays marked as long
   * as its Timeline is what's open, and moves the moment another row is. */
  active: boolean;
  words: SearchWord[];
  onSelect: () => void;
  onResume: () => void;
  onTogglePin: () => void;
}) {
  const { repo, ws } = sessionSearchHitLabel(hit);
  return (
    <li class={active ? "session-search-hit active" : "session-search-hit"}>
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
          {/* Sits inside the whole-block click target, so its own click has to
           * stop there — toggling the pin is a different answer to "what did
           * the user ask for" than navigating to the Timeline. */}
          <button
            type="button"
            class={"session-search-hit-pin" + (pinned ? " active" : "")}
            aria-pressed={pinned}
            aria-label={pinned ? "ピン解除" : "ピン留め"}
            title={pinned ? "ピン解除" : "ピン留め"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") e.stopPropagation();
            }}
          >
            {pinned ? "⭐" : "☆"}
          </button>
          {/* Sits inside the whole-block click target, so its own click has to
           * stop there — opening the launcher and navigating to the Timeline
           * are two different answers to "what did the user ask for". */}
          <button
            type="button"
            class="session-search-hit-resume"
            title="このセッションを resume で再開"
            onClick={(e) => {
              e.stopPropagation();
              onResume();
            }}
            onKeyDown={(e) => {
              // The block's own Enter/Space handler would otherwise also fire
              // from this button's bubbling keydown and navigate away; the
              // button's native activation still produces the click above.
              if (e.key === "Enter" || e.key === " ") e.stopPropagation();
            }}
          >
            resume
          </button>
        </div>
        {/* A session never renamed has no title (protocol: `null` rather than a
         * guessed fallback), and nothing is shown in its place. */}
        {hit.title ? <div class="session-search-hit-title">{hit.title}</div> : null}
        <div class="session-search-hit-meta">
          作成 {relTime(hit.created_at)} · 更新 {relTime(hit.updated_at)} · {formatBytes(hit.size)}
        </div>
        {hit.matches.length > 0 ? (
          <div class="session-search-hit-matches">
            {hit.matches.map((m, i) => (
              <div key={i} class={`session-search-match session-search-match-${m.role}`}>
                <span class="session-search-match-badge">{matchRoleBadge(m.role)}</span>
                <span class="session-search-match-text">
                  {splitTextForHighlight(m.text, words).map((piece, pieceIndex) =>
                    piece.colorIndex === null ? (
                      piece.text
                    ) : (
                      <mark
                        key={pieceIndex}
                        class="search-hl session-search-hl"
                        style={{
                          "--hl-color": `var(--search-color-${piece.colorIndex + 1})`,
                        }}
                      >
                        {piece.text}
                      </mark>
                    ),
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function SessionSearchPanel({
  onClose,
  query,
}: {
  onClose: () => void;
  /** `sb.search` — the query the URL opened this panel on, or null. Seeds the
   * input once; from then on typing is the form's own state and the address
   * bar is rewritten only when a search is actually run (`runSearch`), so a
   * shared link reproduces the search that was performed rather than every
   * keystroke on the way to it. */
  query: string | null;
}) {
  const { store, ws } = useApp();
  const state = useStoreState(store);
  const currentSid = selectedSid(state);
  const [form, setForm] = useState<SessionSearchForm>(() =>
    query === null ? DEFAULT_SESSION_SEARCH_FORM : { ...DEFAULT_SESSION_SEARCH_FORM, query },
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionSearchResponse | null>(null);
  const [resultForm, setResultForm] = useState<SessionSearchForm | null>(null);
  const resultWords = useMemo(
    () =>
      resultForm
        ? parseSearchQuery(resultForm.query, {
            caseSensitive: resultForm.caseSensitive,
            regex: resultForm.regex,
          }).words
        : [],
    [resultForm],
  );

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
    // 実行した検索語を URL に残す (replace: 検索のたびに履歴を積むと、戻るが
    // 「パネルを閉じる」に届くまで何度も押すことになる)。
    replaceNavigation(`${location.pathname}${location.search}`, {
      ...state.sidebar,
      search: form.query,
    });
    setLoading(true);
    setError(null);
    try {
      const res = await ws.sessionSearch(buildSessionSearchRequest(form));
      if (res.ok) {
        setResult(res);
        setResultForm({ ...form, configDirs: [...form.configDirs] });
      } else {
        setError(res.error.msg);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function openResult(hit: SessionSearchHit): void {
    store.dispatch({
      type: "session-search/opened",
      hit,
      search: sessionSearchFormToTimelineSearch(resultForm ?? form),
    });
    pushNavigation(timelineHref(hit.sid));
  }

  /** Open the launcher on this session rather than viewing it: the form lands
   * on the resume recipe with the session and its cwd filled in. A hit with no
   * cwd still opens the form — the cwd picker starts empty and the run button
   * stays disabled until one is picked, which is the same state a plain open
   * has. The title travels too: `claude --resume` does not restore one, so a
   * relaunch that did not carry it would come back under a derived name and
   * lose the name the row is showing right here. */
  function resumeResult(hit: SessionSearchHit): void {
    pushNavigation(
      `${location.pathname}${location.search}`,
      prefillSidebarState({
        kind: "resume",
        cwd: hit.cwd ?? "",
        sessionId: hit.sid,
        ...(hit.model ? { model: hit.model } : {}),
        ...(hit.effort ? { effort: hit.effort } : {}),
        ...(hit.title ? { title: hit.title } : {}),
      }),
    );
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
        <div class="session-search-query-row">
          <textarea
            class="session-search-query"
            aria-label={
              form.regex
                ? "検索正規表現 (1 行 1 パターン、改行区切り OR)"
                : "検索パターン (空白区切り AND、改行区切り OR)"
            }
            placeholder={
              form.regex
                ? "regular expression\n1 行 1 パターン・改行で OR"
                : 'query words\n空白で AND・改行で OR・"引用句"'
            }
            value={form.query}
            onInput={(e) => setForm({ ...form, query: (e.target as HTMLTextAreaElement).value })}
          />
          <SearchModeToggles
            caseSensitive={form.caseSensitive}
            onToggleCaseSensitive={() => setForm({ ...form, caseSensitive: !form.caseSensitive })}
            regexMode={form.regex}
            onToggleRegex={() => setForm({ ...form, regex: !form.regex })}
          />
        </div>
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
                active={hit.sid === currentSid}
                words={resultWords}
                onSelect={() => openResult(hit)}
                onResume={() => resumeResult(hit)}
                onTogglePin={() => store.dispatch({ type: "pinned/toggled", hit })}
              />
            ))}
          </ul>
          {result.hits.length === 0 ? <p class="session-search-empty">該当なし</p> : null}
          {result.truncated ? (
            // The daemon flags `truncated` for either the result cap or the
            // request-wide scan byte budget, so this can appear with fewer than
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
