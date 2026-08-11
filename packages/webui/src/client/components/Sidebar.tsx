import { useMemo, useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import { selectedSid } from "../store.ts";
import { useApp } from "../context.ts";
import { nextPeerSortKey, peerSortButtonLabel, sortPeers, type PeerSortKey } from "../utils.ts";
import { readStorage, writeStorage } from "../storage.ts";
import { RoomCreator } from "./RoomCreator.tsx";
import { RoomList } from "./RoomList.tsx";
import { sessionCreatorPrefill, type SidebarPanelKind } from "../sidebar-panel.ts";
import { useNarrowLayout } from "../useNarrowLayout.ts";
import { SessionCreator } from "./SessionCreator.tsx";
import { SessionList } from "./SessionList.tsx";
import { SessionSearchPanel } from "./SessionSearchPanel.tsx";

const SORT_KEY_STORAGE = "ccmsg.peerSortKey";

function loadSortKey(): PeerSortKey {
  const raw = readStorage(SORT_KEY_STORAGE);
  if (raw === "name" || raw === "idle" || raw === "connected") return raw;
  return "name";
}

function saveSortKey(key: PeerSortKey): void {
  writeStorage(SORT_KEY_STORAGE, key);
}

function PeersRefreshButton() {
  const { store, ws } = useApp();
  return (
    <button
      id="peers-refresh"
      type="button"
      title="refresh"
      onClick={() =>
        void ws.peers().then((res) => {
          if (res.ok) store.dispatch({ type: "peers/loaded", peers: res.peers });
        })
      }
    >
      &#8635;
    </button>
  );
}

function PeersSortButton({ sortKey, onCycle }: { sortKey: PeerSortKey; onCycle: () => void }) {
  // Labels are name/created/recent (kawaz 2026-07-16: "わかりづらい。
  // name/created/recent にして"); "click for X" names the *next* key in
  // PEER_SORT_CYCLE's order (name -> connected -> idle -> name).
  const titles: Record<PeerSortKey, string> = {
    name: "sorted by name (repo · ws · branch) — click for created",
    connected: "sorted by connect time (most recently connected first) — click for recent",
    idle: "sorted by idle time (most recently active first) — click for name",
  };
  return (
    <button id="peers-sort" type="button" title={titles[sortKey]} onClick={onCycle}>
      {peerSortButtonLabel(sortKey)}
    </button>
  );
}

function SearchToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="session-search-toggle"
      type="button"
      title={open ? "検索を閉じる" : "過去セッションを検索 (DR-0021)"}
      aria-pressed={open}
      onClick={onToggle}
    >
      🔍
    </button>
  );
}

/** DR-0018 §2.1 "+ 新規" affordance — same chromeless toggle-button family as
 * SearchToggleButton (see its sibling doc comment on Sidebar for why this is
 * a panel toggle, not a `state.view`). Always rendered regardless of whether
 * session_launcher is configured (DR-0018 §2.1's "launcher 未設定時" branch
 * (b) — SessionCreator itself probes on open and shows setup guidance
 * instead of the form, rather than this button disappearing/needing its own
 * probe just to decide whether to render at all). */
function CreatorToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="session-creator-toggle"
      type="button"
      title={open ? "新規セッションを閉じる" : "新規セッションを起動 (DR-0018)"}
      aria-pressed={open}
      onClick={onToggle}
    >
      {"+⁠New"}
    </button>
  );
}

/** ROOMS section "+ 新規" affordance (issue 2026-07-17-rooms-sidebar-new-
 * button.md), the room-creation counterpart to CreatorToggleButton above —
 * same chromeless toggle-button family, symmetric with SESSIONS's "+ 新規"
 * per the issue's stated goal. Always rendered (no session-launcher-style
 * probe gate — create_room has no server-side "unconfigured" state). */
function RoomCreatorToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="room-creator-toggle"
      type="button"
      title={open ? "新規 Room を閉じる" : "新規 Room を作成"}
      aria-pressed={open}
      onClick={onToggle}
    >
      {"+⁠New"}
    </button>
  );
}

/** Sidebar SESSIONS section (DR-0021 Phase 2 SS-Q1/Q2 doc note): search is a
 * panel toggle (`state.activePanel`), NOT a fourth
 * `state.view`/URL-locator form alongside room/session/timeline. The locator
 * forms in locator.ts each name something durable and shareable — "this
 * room", "this session's Files at this path", "this session's Timeline" —
 * whereas a search is a disposable tool for finding and pinning a session,
 * with no useful "resume this exact search" bookmark semantics. Everything
 * else (Rooms panel, the tab layout, the URL) is untouched by the toggle. The
 * Pinned section DR-0021 §2.4 asks for lives inside SessionList itself (see its doc
 * comment) — it's a permanent part of the normal session list, not something
 * the search toggle owns.
 *
 * DR-0018's "+ 新規" (SessionCreator) and the ROOMS section's "+ 新規"
 * (RoomCreator, same affordance for rooms) share that one toggle track rather
 * than adding parallel ones — `activePanel` holds at most one of the three at
 * a time (`null` = none), so opening any one of RoomList/SessionList's
 * "+ 新規"/🔍 toggles closes whichever of the other two was open, regardless
 * of which section it lived in (issue 2026-07-17-rooms-sidebar-new-button.md's
 * "creator/search パネルと同じ排他開閉に統合" — a single shared union is what
 * makes that cross-section exclusivity trivial instead of needing each boolean
 * setter to know about the other two).
 *
 * どこに描くかは幅で変わる (D-Q1 裁定 = b、2026-08-12):
 *
 * - **デスクトップ**: 新規セッション / 検索フォームは main ペイン側の
 *   `FormPane` が描き、サイドバーは SessionList を出したまま (= 一覧を見ながら
 *   入力できる)。サイドバーの実効幅 264px がフォームの表示欠けの根だった
 *   (docs/findings/2026-08-12-form-ux-width-survey.md)。
 * - **スマホ** (サイドバーが overlay になる幅): 従来どおりここでインライン
 *   置換する。overlay の中にさらにパネルを重ねない。
 * - **RoomCreator はどちらの幅でもここ**: 中身が title + メンバのチェック
 *   ボックスで幅に縛られておらず、そのメンバの並び順は SESSIONS の
 *   ソートボタン (`sortKey`、このコンポーネントのローカル state) に従う。
 *   main ペインへ出すとその並び順だけが別の場所から供給されることになる。
 *   排他は `state.activePanel` が担うので、描き分けても 3 パネル排他は保たれる。 */
export function Sidebar({ state }: { state: AppState }) {
  const { store } = useApp();
  const [sortKey, setSortKey] = useState<PeerSortKey>(loadSortKey);
  const narrow = useNarrowLayout();
  const activePanel = state.activePanel;
  const togglePanel = (panel: SidebarPanelKind) =>
    store.dispatch({ type: "panel/toggled", kind: panel });
  const closePanel = () => store.dispatch({ type: "panel/closed" });
  // デスクトップではこの 2 つは FormPane が描くので、ここは一覧のまま。
  const inlineSessionPanel = narrow ? activePanel : null;
  // Sorting only ever depends on the peers array reference and the chosen
  // key — never on wall-clock time — so a session list re-render triggered
  // purely by SessionList's idle-time tick doesn't reshuffle rows (see
  // sortPeers's doc comment in utils.ts and SessionList.tsx's tick).
  const sortedPeers = useMemo(() => sortPeers(state.peers, sortKey), [state.peers, sortKey]);

  return (
    <nav id="sidebar" class={state.sidebarOpen ? "open" : undefined}>
      <section id="sessions-panel">
        <h2>
          Sessions{" "}
          <CreatorToggleButton
            open={activePanel?.kind === "session-creator"}
            onToggle={() => togglePanel("session-creator")}
          />{" "}
          <SearchToggleButton
            open={activePanel?.kind === "session-search"}
            onToggle={() => togglePanel("session-search")}
          />{" "}
          <PeersSortButton
            sortKey={sortKey}
            onCycle={() => {
              const next = nextPeerSortKey(sortKey);
              setSortKey(next);
              saveSortKey(next);
            }}
          />{" "}
          <PeersRefreshButton />
        </h2>
        {inlineSessionPanel?.kind === "session-creator" ? (
          <SessionCreator
            onClose={closePanel}
            prefill={sessionCreatorPrefill(inlineSessionPanel)}
          />
        ) : inlineSessionPanel?.kind === "session-search" ? (
          <SessionSearchPanel onClose={closePanel} />
        ) : (
          <SessionList peers={sortedPeers} currentSid={selectedSid(state)} />
        )}
      </section>
      {/* Sessions が日常の主動線なので上 (kawaz r76m52)。Rooms は参照頻度が低い */}
      <section id="rooms-panel">
        <h2>
          Rooms{" "}
          <RoomCreatorToggleButton
            open={activePanel?.kind === "room-creator"}
            onToggle={() => togglePanel("room-creator")}
          />
        </h2>
        {activePanel?.kind === "room-creator" ? (
          <RoomCreator peers={sortedPeers} onClose={closePanel} />
        ) : (
          <RoomList state={state} />
        )}
      </section>
    </nav>
  );
}
