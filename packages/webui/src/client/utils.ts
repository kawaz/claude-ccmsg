// Presentation helpers shared by components. Kept out of store.ts because
// these are display-only (locale strings, truncation) and out of the reducer
// (which must stay a pure function of state + action).
import type { AgentInfo, FsEntry, PeerInfo } from "@ccmsg/protocol";
import type { RoomState } from "./store.ts";
import { ADMIN_ID } from "./store.ts";

/** Relative age of an ISO timestamp, e.g. "5s" / "3m" / "2h" / "1d". */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Elapsed-time text for a session-list row's idle indicator, e.g. "5s" /
 * "5m20s" / "1h10m" / "2d3h". Unlike `relTime` (single coarsest unit, used
 * for Timeline turns where sub-unit precision doesn't matter), this keeps
 * two units once the value crosses into minutes so "just went idle" and
 * "idle most of an hour" are distinguishable at a glance in a list that's
 * otherwise sorted by this exact value. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m${totalSec % 60}s`;
  const totalHour = Math.floor(totalMin / 60);
  if (totalHour < 24) return `${totalHour}h${totalMin % 60}m`;
  const days = Math.floor(totalHour / 24);
  return `${days}d${totalHour % 24}h`;
}

/** HH:MM:SS in the viewer's local timezone, for a Timeline turn's timestamp
 * (DR-0009). Returns "" for a missing/unparseable timestamp (some transcript
 * line types, e.g. file-history-snapshot, carry none) rather than "Invalid
 * Date" or throwing. */
export function formatClockTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

/** ROOM 内メンバー表示ラベル (Sidebar Sessions リストの `sessionLabel` とは別軸:
 * ROOM 内では repo の owner/org 部分 (`kawaz/`) を落とし `repo/ws` の短い形で示す
 * — 同じ owner 配下のメンバーが並ぶ chip 一覧で owner の反復はノイズなので、
 * kawaz 指示 (2026-07-11) により意図的に非対称。SESSIONS リスト側の owner 込み
 * 表示は変更しない。`m.repo` が空 (未アナウンス) なセッションは従来通り sid 先頭
 * 8 桁にフォールバックする。 */
export function memberLabel(id: string, room: RoomState | undefined): string {
  if (id === ADMIN_ID) return "User";
  const m = room?.membersById.get(id);
  if (!m) return id;
  const short = m.sid ? m.sid.slice(0, 8) : id;
  if (!m.repo) return short;
  const repoName = lastPathSegment(m.repo);
  return m.ws ? `${repoName}/${m.ws}` : repoName;
}

export function activeRoomsSorted(rooms: Map<string, RoomState>): RoomState[] {
  return [...rooms.values()].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
}

/** Splits an already-sorted room list (see `activeRoomsSorted`) into
 * non-archived / archived buckets, each keeping the input's relative order
 * (DR-0012: RoomList shows non-archived rooms as before, archived ones
 * folded into a bottom "アーカイブ (N)" `<details>`). A plain `.filter()`
 * twice would work too, but doing it in one pass keeps the "which bucket"
 * decision (`archived === true`) in exactly one place. */
export function splitRoomsByArchived(rooms: RoomState[]): {
  active: RoomState[];
  archived: RoomState[];
} {
  const active: RoomState[] = [];
  const archived: RoomState[] = [];
  for (const room of rooms) (room.archived ? archived : active).push(room);
  return { active, archived };
}

/** Whether a room member (by sid) is currently reachable over an open ws
 * connection — the `peers` op response only ever lists connected sessions,
 * so "not present" means offline (DR-0012: MemberChip's grey/strikethrough
 * treatment for a member whose session has disconnected, distinct from
 * `left` which means "left the room" — a member can be present-but-offline
 * without having left the room). Pure over the narrow `{sid}` shape (mirrors
 * `ownWorkspaceSegment`'s narrowing) so it doesn't need the full MemberInfo
 * import just to read one field. */
export function isMemberConnected(member: { sid: string }, peers: PeerInfo[]): boolean {
  return peers.some((p) => p.sid === member.sid);
}

/** Sidebar Sessions-section label: `repo · ws · branch`, each segment shown
 * only when non-empty (no more "?" placeholders — a missing field is simply
 * absent rather than noise). `ws` and `branch` collapse to one segment when
 * equal (the common case: a named workspace/worktree checked out at its own
 * branch), so "claude-ccmsg · main · main" reads as "claude-ccmsg · main".
 * The full cwd is shown separately via the list item's `title` attribute
 * (hover), not folded into this label. When repo/ws/branch are all absent
 * (a session that never announced VCS metadata), falls back to the first 8
 * chars of `sid` — an empty label would make such a session indistinguishable
 * from any other in the list. */
export function sessionLabel(peer: PeerInfo): string {
  const parts = [peer.repo, peer.ws, peer.branch !== peer.ws ? peer.branch : undefined].filter(
    (s): s is string => !!s,
  );
  return parts.length > 0 ? parts.join(" · ") : peer.sid.slice(0, 8);
}

/** Sidebar Sessions-list ordering keys, cycled by the sort-toggle button
 * (see Sidebar.tsx): "name" is the default (lexicographic on `sessionLabel`'s
 * fields, so it doubles as an alphabetical grouping by repo/ws/branch),
 * "idle" surfaces the most recently active session first, "connected"
 * surfaces the most recently (re)connected session first. */
export type PeerSortKey = "name" | "idle" | "connected";

const PEER_SORT_CYCLE: PeerSortKey[] = ["name", "idle", "connected"];

/** Short label for the sort-toggle button, so its current mode is visible
 * without hovering for the title attribute. */
export function peerSortButtonLabel(key: PeerSortKey): string {
  switch (key) {
    case "idle":
      return "idle";
    case "connected":
      return "new";
    default:
      return "abc";
  }
}

export function nextPeerSortKey(key: PeerSortKey): PeerSortKey {
  return PEER_SORT_CYCLE[(PEER_SORT_CYCLE.indexOf(key) + 1) % PEER_SORT_CYCLE.length];
}

/** repo → ws → branch → sid, each segment compared with localeCompare — same
 * fields `sessionLabel` renders, so "name" order reads as alphabetical
 * grouping by the label the user actually sees. sid is the final tiebreak so
 * two sessions with identical repo/ws/branch (e.g. two plain checkouts of the
 * same repo with no workspace layer) still sort deterministically instead of
 * however they happened to arrive in `peers`. */
function cmpByName(a: PeerInfo, b: PeerInfo): number {
  const pa = [a.repo ?? "", a.ws ?? "", a.branch ?? "", a.sid];
  const pb = [b.repo ?? "", b.ws ?? "", b.branch ?? "", b.sid];
  for (let i = 0; i < pa.length; i++) {
    const c = pa[i].localeCompare(pb[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** Descending compare on an optional ISO timestamp field (newest first);
 * a peer missing the field (older daemon, or a session that hasn't made a
 * request yet for "idle") sorts after every peer that has one, tiebroken by
 * `cmpByName` so the ordering within "missing" and within equal timestamps
 * stays deterministic rather than following daemon Map insertion order. */
function cmpByTsDesc(a: PeerInfo, b: PeerInfo, field: "last_activity_at" | "connected_at"): number {
  const ta = a[field];
  const tb = b[field];
  if (ta === tb) return cmpByName(a, b);
  if (ta === undefined) return 1;
  if (tb === undefined) return -1;
  const c = tb.localeCompare(ta);
  return c !== 0 ? c : cmpByName(a, b);
}

/** Pure sort used by the Sidebar Sessions list (see Sidebar.tsx / SessionList.tsx):
 * a stable, click-independent ordering so a peers refresh never reshuffles
 * rows out from under a pointer mid-click (the daemon's own `peers` order is
 * Map insertion order, which shifts on reconnect — see server.ts's
 * `sessions` Map). Never mutates its input. */
export function sortPeers(peers: PeerInfo[], key: PeerSortKey): PeerInfo[] {
  const sorted = [...peers];
  switch (key) {
    case "idle":
      sorted.sort((a, b) => cmpByTsDesc(a, b, "last_activity_at"));
      break;
    case "connected":
      sorted.sort((a, b) => cmpByTsDesc(a, b, "connected_at"));
      break;
    default:
      sorted.sort(cmpByName);
  }
  return sorted;
}

/** First path segment of `peer.cwd` relative to `peer.repo_root` — the
 * session's own workspace/worktree directory as it appears under the tree's
 * (now repo-container-rooted, DR-0008 addendum) root. `null` when the
 * session didn't announce/get-accepted a repo_root (fs root is still cwd,
 * nothing to highlight relative to it), or when cwd unexpectedly isn't
 * inside repo_root (defensive — the daemon's hello-time validation already
 * guarantees ancestry, but this stays a pure function of the input alone and
 * shouldn't throw on a malformed peer). Parameter is the narrow `{repo_root,
 * cwd}` shape (not `PeerInfo` itself) so U1's SessionRow — which carries the
 * same two fields but isn't a PeerInfo for agent-only rows — can reuse this
 * for its own "▷ 展開" sibling-workspace highlight without a duplicate copy. */
export function ownWorkspaceSegment(peer: { repo_root?: string; cwd: string }): string | null {
  if (!peer.repo_root) return null;
  const root = peer.repo_root.replace(/\/+$/, "");
  if (!peer.cwd.startsWith(`${root}/`)) return null;
  const rel = peer.cwd.slice(root.length + 1);
  const seg = rel.split("/")[0];
  return seg || null;
}

/** Last path segment of `peer.repo_root`, for the FileTree's root label
 * (DR-0008 addendum) — tells the viewer what the (now possibly
 * container-wide) tree root actually is, since it's no longer always "this
 * session's cwd". `null` when there's no repo_root to label (tree root is
 * still cwd, no label shown — same as today). */
export function repoRootLabel(peer: PeerInfo): string | null {
  if (!peer.repo_root) return null;
  const parts = peer.repo_root.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? peer.repo_root;
}

/** Renders a caught value from a rejected ws.ts send() (e.g. `Error("ws not
 * open")` when a request races a not-yet-open/dropped socket) into the same
 * plain-string shape as `ErrorResponse["error"]["msg"]`, so callers can fold
 * a rejection into their existing error-state dispatch without a second code
 * path (DR-0008/DR-0009 fs_list/fs_read/transcript_read effects). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- SessionView pane splitter (FileTree / FileViewer) --- //

/** Lower/upper clamp for the tree-pane fraction of the session-panes flex
 * container. Values chosen so neither pane can shrink to a hairline: at the
 * lower bound the tree still shows at least one full row of names, at the
 * upper bound the viewer's line-number gutter + a chunk of the first line
 * still fit. Not a user preference — a hard usability floor/ceiling that
 * the drag handler and the persisted-ratio loader both funnel through. */
export const SESSION_PANE_MIN_RATIO = 0.1;
export const SESSION_PANE_MAX_RATIO = 0.9;

/** Default first-pane (tree) fraction when nothing is persisted. Roughly
 * matches the pre-splitter fixed 280px tree width at a ~1000px viewport
 * (280/1000 = 0.28) so the first render after upgrading doesn't jump. */
export const SESSION_PANE_DEFAULT_RATIO = 0.28;

/** Clamps a pane-split fraction into the usability window. Kept as a plain
 * `[min, max]` clamp (not a bias-toward-default) so a persisted ratio the
 * user deliberately dragged near a limit reloads exactly where they left
 * it. NaN falls through to `min` because callers get NaN from `parseFloat`
 * on garbage localStorage values (private mode wipe, cross-origin
 * migration, etc.) — snapping to the closer edge of the range would just
 * silently pick one for them. */
export function clampPaneRatio(
  ratio: number,
  min: number = SESSION_PANE_MIN_RATIO,
  max: number = SESSION_PANE_MAX_RATIO,
): number {
  if (!Number.isFinite(ratio)) return min;
  if (ratio < min) return min;
  if (ratio > max) return max;
  return ratio;
}

/** Turns a pointer position (clientX for horizontal splits, clientY for
 * vertical / mobile stack) into the new tree-pane fraction. Callers pass
 * the container's own `bounding{Left,Top}` and `.{width,height}` — this
 * function is deliberately axis-agnostic so the same code path drives both
 * the desktop side-by-side layout and the 720px-and-below column layout
 * (the CSS `flex-direction` swap is the only thing that changes). Returns
 * `min` when the container has collapsed to zero size (mid-resize, tab
 * hidden) rather than dividing by zero. */
export function paneRatioFromPointer(
  pointerPos: number,
  containerStart: number,
  containerSize: number,
  min: number = SESSION_PANE_MIN_RATIO,
  max: number = SESSION_PANE_MAX_RATIO,
): number {
  if (containerSize <= 0) return min;
  return clampPaneRatio((pointerPos - containerStart) / containerSize, min, max);
}

/** File-extension predicate for FileViewer's Markdown preview toggle. Only
 * `.md` and `.markdown` are accepted — deliberately not `.mdx` (JSX
 * embedded, not a plain markdown superset the safe walker in
 * markdown-view.tsx renders correctly) and not `.txt` (plain text isn't
 * markdown, users would be surprised to see it get list/heading treatment).
 * Case-insensitive because README.MD on case-insensitive filesystems is
 * common. Extension must be the actual last segment past the final dot;
 * `foo.md.bak` is a backup file, not markdown. */
export function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

// --- Sidebar Sessions-list: peers x agents merge (U1) --- //

/** Number of leading hex chars a Sessions-list row shows for its sid (the
 * full value is always still available via the row's `title` attribute /
 * click-to-copy) — matches the truncation `sessionLabel`'s sid fallback and
 * `memberLabel` already use elsewhere, kept as a named constant here since
 * SessionList now truncates a sid on its own dedicated line rather than as
 * a fallback inside a joined label. */
export const SID_SHORT_LEN = 8;

/** Truncates a sid to its Sessions-list display length. The full value stays
 * reachable via the caller's `title` attribute / click-to-copy handler. */
export function shortSid(sid: string): string {
  return sid.slice(0, SID_SHORT_LEN);
}

/** Last non-empty `/`-separated segment of a path — used as a Sessions-list
 * row's fallback label when neither `repo`/`ws` (peers) nor `agent.name`
 * (agents-only rows) is available, so a row is never blank. Falls back to
 * the input itself for a path with no `/` at all (e.g. a bare cwd like
 * `/`), which is still better than an empty string. */
export function lastPathSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** One row of the Sidebar Sessions list (U1): either a connected ccmsg
 * session (`connected: true`, from PeersResponse) optionally enriched with
 * the matching `claude agents --json` row (same sessionId), or — when
 * `claude agents` reports a session with no matching PeerInfo — an
 * agent-only row (`connected: false`) for a Claude session that hasn't
 * started/connected its ccmsg CLI. `agent` is the raw AgentInfo either way,
 * so its `pid`/`kind`/`status`/`state`/`startedAt`/`config_dir` fields are
 * reachable without a second lookup. */
export interface SessionRow {
  sid: string;
  repo: string;
  ws: string;
  cwd: string;
  branch?: string;
  connected_at?: string;
  last_activity_at?: string;
  repo_root?: string;
  /** present iff the peer announced a transcript the daemon accepted (U3) —
   * SessionList uses this to route a row's click to the Timeline tab instead
   * of Files. Always absent on an agent-only row (offlineAgentRows): those
   * come from `claude agents --json`, which carries no transcript info. */
  transcript_path?: string;
  agent?: AgentInfo;
  connected: boolean;
}

/** Indexes `claude agents --json` rows by sessionId for O(1) lookup while
 * merging — built once per peers/agents pair (e.g. in a `useMemo`), not
 * per-row, since AgentsResponse.agents can be large across every
 * CLAUDE_CONFIG_DIR the daemon polls. */
export function indexAgentsBySid(agents: AgentInfo[]): Map<string, AgentInfo> {
  const bySid = new Map<string, AgentInfo>();
  for (const a of agents) bySid.set(a.sessionId, a);
  return bySid;
}

/** Builds one SessionRow for a connected peer, attaching the matching agent
 * (if `claude agents` has polled one with the same sessionId) — used for
 * every entry in the Sidebar's already-sorted peers array, so the existing
 * abc/idle/new ordering (Sidebar.tsx's sortPeers over `peers`) carries
 * straight through unchanged; this function only adds fields, never
 * reorders. */
export function toSessionRow(peer: PeerInfo, agentsBySid: Map<string, AgentInfo>): SessionRow {
  return {
    sid: peer.sid,
    repo: peer.repo,
    ws: peer.ws,
    cwd: peer.cwd,
    branch: peer.branch,
    connected_at: peer.connected_at,
    last_activity_at: peer.last_activity_at,
    repo_root: peer.repo_root,
    transcript_path: peer.transcript_path,
    agent: agentsBySid.get(peer.sid),
    connected: true,
  };
}

/** Agent-only SessionRows (U1): `claude agents --json` sessions with no
 * matching PeerInfo — a Claude session running without (or not yet with) a
 * connected ccmsg CLI. Rendered as a distinct "ccmsg 未起動" group appended
 * after the peers rows (see SessionList.tsx) rather than interleaved into
 * the peers abc/idle/new ordering: these rows have no connected_at /
 * last_activity_at to drive that ordering, and grouping "not actually
 * reachable via ccmsg yet" rows together — instead of scattering them among
 * live sessions — reads as the more useful default. Sorted newest-started
 * first (the closest available proxy for "worth noticing"). */
export function offlineAgentRows(peers: PeerInfo[], agents: AgentInfo[]): SessionRow[] {
  const peerSids = new Set(peers.map((p) => p.sid));
  // De-dup by sessionId (Map.set, last-wins — same policy as
  // indexAgentsBySid) before building rows: `claude agents --json` from more
  // than one config_dir could in theory report the same sessionId (see
  // indexAgentsBySid's doc comment), which would otherwise produce two
  // SessionRows sharing the same `sid` — SessionList's `key={row.sid}` needs
  // that to stay unique (nit finding, adversarial review).
  const bySid = new Map<string, AgentInfo>();
  for (const a of agents) if (!peerSids.has(a.sessionId)) bySid.set(a.sessionId, a);
  return [...bySid.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((a) => ({
      sid: a.sessionId,
      repo: "",
      ws: a.name ?? lastPathSegment(a.cwd),
      cwd: a.cwd,
      agent: a,
      connected: false,
    }));
}

/** Sessions-list row label (U1 first line): `{repo, ws}` when the row has
 * either (every peers row does), else falls back to the matched agent's
 * `name`, then the cwd's last path segment — an agent-only row never has
 * repo/ws (`claude agents --json` carries no VCS metadata), so this is the
 * only path that ever exercises the fallback in practice, but a peers row
 * with an empty repo/ws (session announced neither) takes the same
 * fallback rather than rendering a blank first line. */
export function sessionRowRepoWs(row: SessionRow): { repo: string; ws: string } {
  if (row.repo || row.ws) return { repo: row.repo, ws: row.ws };
  return { repo: "", ws: row.agent?.name || lastPathSegment(row.cwd) };
}

/** Whether a Sessions-list row's repo/ws label should render as a clickable
 * "▷" that expands sibling workspaces/worktrees inline (U1). Requires both a
 * live connection (fs_list only works against a currently-connected sid) and
 * an accepted repo_root (fs_list's containment root only widens past cwd
 * when the daemon accepted one at hello time, DR-0008 addendum) — without a
 * repo_root, `fs_list(sid, "")` would just list files inside this session's
 * own cwd, not sibling workspaces, which isn't what "▷" promises here. */
export function canExpandSiblings(row: SessionRow): boolean {
  return row.connected && !!row.repo_root;
}

/** Sibling workspace/worktree directories for the "▷" expansion (U1): the
 * directory-type entries from an `fs_list(sid, "")` call against a row with
 * an accepted repo_root, minus the row's own workspace segment (already
 * shown on the row itself — repeating it in the expansion would be noise).
 * Non-directory entries (stray files sitting at the repo container root)
 * are dropped outright; this expansion promises "other workspaces", not
 * "everything at this level". */
export function siblingWorkspaceEntries(entries: FsEntry[], ownSegment: string | null): FsEntry[] {
  return entries.filter((e) => e.type === "dir" && e.name !== ownSegment);
}

/** Primary busy/idle/done/offline status of a Sessions-list row — the single
 * source of truth both `sessionBadges` (U1, being retired per-row in U3 down
 * to just the `"bg"` tag) and `groupSessionsBySection` (U3) read, so the two
 * can never disagree about what one row's status is.
 * - A disconnected (agent-only, "ccmsg 未起動") row is always `"offline"`,
 *   regardless of what its matched agent's `status`/`state` say — offline
 *   rows form their own section (U3), not a busy/idle/done bucket.
 * - A *connected* row with no matched agent (older CLI, `claude agents`
 *   hasn't polled yet, or a non-Claude ccmsg client) has no distinct signal
 *   to report — before U3 this meant "no badge at all"; now that every row
 *   must land in exactly one section, it falls into `"idle"` (the "nothing
 *   to report" bucket) rather than inventing a fifth section the U3 spec
 *   (Busy / Idle / Done / ccmsg未起動) doesn't call for. */
export type SessionStatus = "offline" | "busy" | "idle" | "done";

export function sessionStatus(row: SessionRow): SessionStatus {
  if (!row.connected) return "offline";
  if (!row.agent) return "idle";
  if (row.agent.state === "done") return "done";
  return row.agent.status === "busy" ? "busy" : "idle";
}

/** Status/state badges for one Sessions-list row (U1), in display order.
 * - `"offline"` (agent-only row, no ccmsg connection) is exclusive of the
 *   busy/idle/done tri-state below — an offline row shows only "offline"
 *   since `agent` is always present for such a row (that's how it exists),
 *   so the loop below would otherwise also emit an idle/busy badge for it.
 * - A *connected* row (`row.connected`) with no matched agent (older CLI,
 *   `claude agents` hasn't polled yet, or a non-Claude ccmsg client) gets
 *   no badges at all — "従来通り" per the U1 spec: there's nothing from
 *   `claude agents` to report, so nothing is shown instead of guessing.
 * - `"bg"` is additive: a background agent still gets its busy/idle/done
 *   badge too, `"bg"` just tags kind separately.
 * U3 note: SessionList.tsx no longer renders the busy/idle/done/offline
 * badges this returns (that status now shows via the row's section instead)
 * — it only renders the `"bg"` entry, if present. The function itself is
 * kept as-is (tests still pin its full return value) since `"bg"`'s presence
 * still depends on this same busy/idle/done/offline computation. */
export function sessionBadges(row: SessionRow): Array<"offline" | "busy" | "idle" | "done" | "bg"> {
  if (!row.connected) return ["offline"];
  if (!row.agent) return [];
  const badges: Array<"offline" | "busy" | "idle" | "done" | "bg"> = [sessionStatus(row)];
  if (row.agent.kind === "background") badges.push("bg");
  return badges;
}

/** Display text for a badge kind (SessionList.tsx renders these verbatim). */
export function badgeLabel(kind: "offline" | "busy" | "idle" | "done" | "bg"): string {
  return kind === "offline" ? "ccmsg未起動" : kind;
}

// --- Sidebar Sessions-list: status sections (U3) --- //

/** Section display order + label, keyed by `sessionStatus`. Busy first
 * (kawaz's stated reason for sectioning at all: "busy 表示邪魔" — busy
 * sessions are the ones worth noticing first), offline ("ccmsg未起動") last
 * (least actionable — nothing to do from the webui for a session that
 * hasn't connected). */
const SESSION_SECTION_ORDER: SessionStatus[] = ["busy", "idle", "done", "offline"];

const SESSION_SECTION_LABELS: Record<SessionStatus, string> = {
  busy: "Busy",
  idle: "Idle",
  done: "Done",
  offline: "ccmsg未起動",
};

export interface SessionSection {
  key: SessionStatus;
  label: string;
  rows: SessionRow[];
}

/** Groups Sessions-list rows into busy/idle/done/offline sections (U3, kawaz
 * 2026-07-11: "busy 表示邪魔。リスト側に busy とかのやつでセクション切ってフォル
 * ディングもできるように。で各アイテムの busy は取る"). Only sections that
 * actually have a row appear — an empty section would just be a heading with
 * nothing under it. Row order *within* each section is the input array's
 * order (already the Sidebar's abc/idle/new sort by the time `rows` reaches
 * here, see SessionList.tsx) — this function only partitions, it never
 * reorders. */
export function groupSessionsBySection(rows: SessionRow[]): SessionSection[] {
  const buckets = new Map<SessionStatus, SessionRow[]>();
  for (const row of rows) {
    const key = sessionStatus(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  return SESSION_SECTION_ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    label: SESSION_SECTION_LABELS[key],
    rows: buckets.get(key)!, // non-null: key came from buckets.has() just above
  }));
}
