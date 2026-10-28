// Presentation helpers shared by components. Kept out of store.ts because
// these are display-only (locale strings, truncation) and out of the reducer
// (which must stay a pure function of state + action).
import type {
  AgentInfo,
  ExternalFile,
  ExternalFileOrigin,
  PeerInfo,
  PermitRequestRecord,
  SayRecord,
  SessionApiError,
  SessionSearchHit,
  SessionSearchMatch,
  SessionSearchRequest,
  StaleClientInfo,
} from "@ccmsg/protocol";
import { jsonText, parseWith } from "@ccmsg/protocol";
import * as v from "valibot";
import type { PeerSortKey } from "./sidebar-url.ts";
import { numberText } from "./storage.ts";
import type { AppState, RoomState } from "./store.ts";
import { ADMIN_ID } from "./store.ts";
import { parseUrl } from "./locator.ts";
import { isHomePath, viewerPathForAbsolute } from "./filepath-ref.ts";
import { type Pin, PinSchema, pinForSid } from "./pinned-sessions.ts";

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

/** What a session's process has been running as, for the end of the
 * Timeline's ctx line: how long since it started, in the same `formatDuration`
 * the bubbles and the responding row use, and the Claude Code version it runs
 * ("2d15h", "claude v2.1.310"). A record that names no version gives the
 * uptime alone. */
export function sessionProcessParts(
  agent: Pick<AgentInfo, "startedAt" | "version">,
  now: number,
): string[] {
  const uptime = formatDuration(now - agent.startedAt);
  return agent.version ? [uptime, `claude v${agent.version}`] : [uptime];
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

/** msg 時刻の完全形 "2026-07-15 10:46:59 · 3h10m" (kawaz r17 mid=30、
 * 2026-07-15): 時刻だけだと日を跨いだ msg の古さが読めない — 年月日 +
 * 相対時間 (formatDuration の 2 単位形) を併記する。`now` は再描画の
 * 起点 (呼び出し側が数分おきの雑更新 tick で渡す)。 */
export function formatMsgTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hms = d.toTimeString().slice(0, 8);
  return `${ymd} ${hms} · ${formatDuration(now - d.getTime())}`;
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
 * (RoomList folds the archived ones into a bottom "アーカイブ (N)"
 * `<details>`). A plain `.filter()`
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

/** Further splits a non-archived room list (the `active` bucket from
 * `splitRoomsByArchived`) into 1on1 rooms and everything else, keeping each
 * bucket's relative order — same one-pass-single-decision shape as
 * `splitRoomsByArchived` (mid=61: 1on1 rooms get folded into a collapsed
 * "1on1 (N)" `<details>`, mirroring the "アーカイブ (N)" group). Run this
 * *after* `splitRoomsByArchived` so an archived 1on1 room lands in the
 * archived group, not duplicated into both. */
export function splitRoomsByKind(rooms: RoomState[]): {
  flat: RoomState[];
  oneOnOne: RoomState[];
} {
  const flat: RoomState[] = [];
  const oneOnOne: RoomState[] = [];
  for (const room of rooms) (room.kind === "1on1" ? oneOnOne : flat).push(room);
  return { flat, oneOnOne };
}

/** Unread `say` count per session sid (kawaz r244 m5-m6), for the Sessions
 * list's 🔔 marker. A sid with nothing unread is absent. */
export function sayUnreadBySid(says: readonly SayRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const say of says) {
    if (say.read) continue;
    out.set(say.sid, (out.get(say.sid) ?? 0) + 1);
  }
  return out;
}

/** Unread request-for-permission count per session sid (DR-0040), for the
 * Sessions list's 🔐 marker. A sid with nothing unread is absent. */
export function permitUnreadBySid(requests: readonly PermitRequestRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const request of requests) {
    if (request.read) continue;
    out.set(request.sid, (out.get(request.sid) ?? 0) + 1);
  }
  return out;
}

/** Whether a room member (by sid) is currently reachable over an open ws
 * connection — the `peers` op response only ever lists connected sessions,
 * so "not present" means offline (MemberChip links only a connected
 * member's session). Pure over the narrow `{sid}` shape (mirrors
 * `ownWorkspaceSegment`'s narrowing) so it doesn't need the full MemberInfo
 * import just to read one field. */
export function isMemberConnected(member: { sid: string }, peers: readonly PeerInfo[]): boolean {
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

export type { PeerSortKey };

// Cycle order matches the button-label progression kawaz asked for
// (name -> created -> recent -> name), which happens to differ from the
// PeerSortKey union's own declaration order above. "prompt" leads: it is the
// default, so the cycle starts where a fresh tab already is.
const NEXT_PEER_SORT_KEY = {
  prompt: "name",
  name: "connected",
  connected: "idle",
  idle: "prompt",
} as const satisfies Record<PeerSortKey, PeerSortKey>;

/** Short label for the sort-toggle button, so its current mode is visible
 * without hovering for the title attribute. kawaz 2026-07-16: "わかりづらい。
 * name/created/recent にして" — the prior abc/idle/new labels didn't map
 * cleanly onto what each key actually sorts by; these names describe the
 * *result* (a list ordered by name, by creation/connect time, or by recency
 * of activity) rather than the internal `PeerSortKey` value. */
export function peerSortButtonLabel(key: PeerSortKey): string {
  switch (key) {
    case "idle":
      return "recent";
    case "connected":
      return "created";
    case "prompt":
      return "prompt";
    default:
      return "name";
  }
}

export function nextPeerSortKey(key: PeerSortKey): PeerSortKey {
  return NEXT_PEER_SORT_KEY[key];
}

/** repo → ws → branch → sid, each segment compared with localeCompare — same
 * fields `sessionLabel` renders, so "name" order reads as alphabetical
 * grouping by the label the user actually sees. sid is the final tiebreak so
 * two sessions with identical repo/ws/branch (e.g. two plain checkouts of the
 * same repo with no workspace layer) still sort deterministically instead of
 * however they happened to arrive in `peers`. */
function cmpByName(a: PeerInfo, b: PeerInfo): number {
  return (
    (a.repo ?? "").localeCompare(b.repo ?? "") ||
    (a.ws ?? "").localeCompare(b.ws ?? "") ||
    (a.branch ?? "").localeCompare(b.branch ?? "") ||
    a.sid.localeCompare(b.sid)
  );
}

/** Descending compare on an optional ISO timestamp field (newest first);
 * a peer missing the field (older daemon, a session that hasn't made a
 * request yet for "idle", or one the daemon has folded no user input for —
 * see PeerInfo.last_user_input_at) sorts after every peer that has one,
 * tiebroken by
 * `cmpByName` so the ordering within "missing" and within equal timestamps
 * stays deterministic rather than following daemon Map insertion order. */
function cmpByTsDesc(
  a: PeerInfo,
  b: PeerInfo,
  field: "last_activity_at" | "connected_at" | "last_user_input_at",
): number {
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
export function sortPeers(peers: readonly PeerInfo[], key: PeerSortKey): PeerInfo[] {
  const sorted = [...peers];
  switch (key) {
    case "prompt":
      sorted.sort((a, b) => cmpByTsDesc(a, b, "last_user_input_at"));
      break;
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

/** Where the FileTree starts browsing: the session's own **cwd**, expressed
 * as a path relative to the daemon's containment root (`repo_root ?? cwd`,
 * DR-0008 §7) — the space every fs_list/fs_read/fs_find path key already
 * lives in, so this doubles as the tree's root `tree.dirs` key.
 *
 * kawaz r55 m97: the tree shows the directory the session is actually working
 * in, not the repo container above it. With a jj worktree layout (cwd
 * `<repo>/main`, repo_root `<repo>`) a container-rooted tree made every path
 * start at a `main/` node the user has to open first, which reads as "the tree
 * is one level off" for the session's own files. Widening the *daemon's*
 * containment to the container stays correct and unchanged (a sibling
 * worktree's file stays readable when a message links to it); only the
 * browsing origin comes back down to cwd.
 *
 * `""` (the containment root itself) when the session announced no accepted
 * repo_root — the containment root *is* cwd then — and likewise when cwd
 * unexpectedly isn't inside repo_root (defensive: the daemon's hello-time
 * validation already guarantees strict ancestry, but this stays a pure
 * function of its input and shouldn't invent a root for a malformed peer).
 * Parameter is the narrow `{repo_root, cwd}` shape (not `PeerInfo` itself)
 * so it stays reusable by any caller carrying only those two fields. */
export function treeRootPath(peer: { repo_root?: string; cwd: string }): string {
  if (!peer.repo_root) return "";
  const root = peer.repo_root.replace(/\/+$/, "");
  if (!peer.cwd.startsWith(`${root}/`)) return "";
  return peer.cwd.slice(root.length + 1).replace(/\/+$/, "");
}

/** Renders a caught value from a rejected ws.ts send() (e.g. `Error("ws not
 * open")` when a request races a not-yet-open/dropped socket) into the same
 * plain-string shape as `ErrorResponse["error"]["msg"]`, so callers can fold
 * a rejection into their existing error-state dispatch without a second code
 * path (DR-0008/DR-0009 fs_list/fs_read/transcript_read effects). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Splitter-driven pane sizing (sidebar / form pane / session panes) --- //

/** 潰した側のペインに残す最小幅 (px)。スプリッター自身の見える太さ
 * (最も太い #sidebar-splitter で 7px) を一回り上回る値で、潰しきっても
 * 「線ではなくペイン」として残り、掴み直す先が視認できるところで止まる。
 * 幅の好みはユーザがドラッグで決めるもので、ここは「消えて戻せなくなる」
 * だけを防ぐ下限 — だから上限は固定値で持たず、常に反対側の同じ下限
 * (= コンテナ幅 − PANE_MIN_PX) から導く。 */
export const PANE_MIN_PX = 16;

/** px 直値で寸法を持つペイン (#sidebar-lists / #sidebar-form 等) の丸め。`containerPx` は
 * そのペインが分け合っている領域の幅で、渡されたときだけ上限が効く
 * (レイアウト前・display:none で 0 や非有限になる場面では下限のみ)。
 * `fallbackPx` は px が非有限のとき — localStorage のゴミ値や、ドラッグ中に
 * 参照要素が消えた場合に NaN が state へ流れるのを止める。 */
export function clampPanePx(px: number, fallbackPx: number, containerPx?: number): number {
  if (!Number.isFinite(px)) return fallbackPx;
  const max =
    containerPx !== undefined && Number.isFinite(containerPx) && containerPx > 0
      ? Math.max(PANE_MIN_PX, containerPx - PANE_MIN_PX)
      : Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(PANE_MIN_PX, px));
}

/** Default first-pane (tree) fraction when nothing is persisted. Roughly
 * matches the pre-splitter fixed 280px tree width at a ~1000px viewport
 * (280/1000 = 0.28) so the first render after upgrading doesn't jump. */
export const SESSION_PANE_DEFAULT_RATIO = 0.28;

/** 比率を有効域に収める。実際の下限は px 側 (PANE_MIN_PX) にあるので、
 * コンテナ幅が分かる場面 (ドラッグ中) は `containerPx` を渡す — 同じ 1% でも
 * 400px 幅と 2000px 幅では残る太さが違うため、比率固定の下限では細い画面で
 * 潰せず広い画面で潰れすぎる。
 *
 * `containerPx` 無し (localStorage からの復元) は `[0, 1]` だけを守る:
 * ユーザが自分で潰した幅を、コンテナ幅を知らないまま押し戻さないため。
 * 非有限は既定比率へ — 呼び出し側は `parseFloat` の結果をそのまま渡すので、
 * ゴミ値のときに 0 (= 完全に潰れた状態) を作らない。
 *
 * 比率はスプリッターも含むコンテナに対する割合なので、反対側に実際に残るのは
 * PANE_MIN_PX からスプリッターの太さ (.session-splitter は 4px) を引いた分。
 * それでもスプリッターより太いままなので、掴み直す先は視認できる。 */
/** A pane ratio as a pane layout stores it, the default ratio when nothing
 * is stored. */
const PaneRatioSchema = v.optional(v.number(), SESSION_PANE_DEFAULT_RATIO);
const PaneRatioTextSchema = numberText(PaneRatioSchema);

/** A stored pane ratio (`readLayoutStorage` of a pane layout's key), held to
 * the valid range: the default ratio when nothing is stored or what is stored
 * is not a number. */
export function parsePaneRatio(raw: string | null): number {
  const read = raw === null ? null : parseWith(PaneRatioTextSchema, raw);
  return clampPaneRatio(read?.ok ? read.value : v.getDefault(PaneRatioSchema));
}

export function clampPaneRatio(ratio: number, containerPx?: number): number {
  if (!Number.isFinite(ratio)) return SESSION_PANE_DEFAULT_RATIO;
  // 両側の下限が衝突するほど狭いコンテナでは中央で折り合う。
  const floor =
    containerPx !== undefined && Number.isFinite(containerPx) && containerPx > 0
      ? Math.min(PANE_MIN_PX / containerPx, 0.5)
      : 0;
  return Math.min(1 - floor, Math.max(floor, ratio));
}

/** Turns a pointer position (clientX for horizontal splits, clientY for
 * vertical / mobile stack) into the new tree-pane fraction. Callers pass
 * the container's own `bounding{Left,Top}` and `.{width,height}` — this
 * function is deliberately axis-agnostic so the same code path drives both
 * the desktop side-by-side layout and the 720px-and-below column layout
 * (the CSS `flex-direction` swap is the only thing that changes). Returns
 * the default ratio when the container has collapsed to zero size
 * (mid-resize, tab hidden) rather than dividing by zero. */
export function paneRatioFromPointer(
  pointerPos: number,
  containerStart: number,
  containerSize: number,
): number {
  if (!(containerSize > 0)) return SESSION_PANE_DEFAULT_RATIO;
  return clampPaneRatio((pointerPos - containerStart) / containerSize, containerSize);
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
 * the matching agents row (same sessionId), or — when
 * the agents rows list a session with no matching PeerInfo — an
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
   * come from the agents rows, which carry no transcript info. */
  transcript_path?: string;
  agent?: AgentInfo;
  connected: boolean;
  /** Present iff the daemon currently reports this (connected) session as
   * stopped on a harness API error — the row's status then becomes `"error"`
   * ahead of anything the agents rows say (see sessionStatus). Filled in by
   * `toSessionRow` from the store's by-sid error map rather than passed to
   * `sessionStatus` as a second argument: every existing caller reads a row's
   * status from the row alone (`sessionBadges`, `groupSessionsBySection`), and
   * that invariant is what keeps those two from ever disagreeing. Always
   * absent on an agent-only row (`offlineAgentRows`): the daemon only folds
   * this over *connected* peers' transcripts, and such a row is `"offline"`
   * regardless. */
  api_error?: SessionApiError;
  /** ccmsg build / wire generation this session's latest hello announced, and
   * the warning set while some client of it is out of date (PeerInfo's three
   * build fields). All absent on an agent-only row: the agents rows
   * knows nothing about ccmsg, and a session that never connected has no
   * client to be stale. */
  client_version?: string;
  protocol?: number;
  stale_client?: StaleClientInfo;
}

/** Indexes agents rows by sessionId for O(1) lookup while
 * merging — built once per peers/agents pair (e.g. in a `useMemo`), not
 * per-row, since AgentsResponse.agents can be large across every
 * CLAUDE_CONFIG_DIR the daemon polls. */
export function indexAgentsBySid(agents: readonly AgentInfo[]): Map<string, AgentInfo> {
  const bySid = new Map<string, AgentInfo>();
  for (const a of agents) bySid.set(a.sessionId, a);
  return bySid;
}

/** Builds one SessionRow for a connected peer, attaching the matching agent
 * (if the agents rows have one with the same sessionId) and the matching
 * harness API error (if the daemon currently reports this session as stopped
 * on one) — used for every entry in the Sidebar's already-sorted peers array,
 * so the existing abc/idle/new ordering (Sidebar.tsx's sortPeers over `peers`)
 * carries straight through unchanged; this function only adds fields, never
 * reorders. `errorsBySid` is `AppState.sessionErrors` — already a by-sid Map,
 * so unlike agents it needs no index pass. Required, not optional: a caller
 * that forgot it would silently render every stopped session as busy. */
export function toSessionRow(
  peer: PeerInfo,
  agentsBySid: Map<string, AgentInfo>,
  errorsBySid: Map<string, SessionApiError>,
): SessionRow {
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
    client_version: peer.client_version,
    protocol: peer.protocol,
    stale_client: peer.stale_client,
    agent: agentsBySid.get(peer.sid),
    connected: true,
    api_error: errorsBySid.get(peer.sid),
  };
}

/** Agent-only SessionRows (U1): agents rows' sessions with no
 * matching PeerInfo — a Claude session running without (or not yet with) a
 * connected ccmsg CLI. Rendered as a distinct "ccmsg 未起動" group appended
 * after the peers rows (see SessionList.tsx) rather than interleaved into
 * the peers abc/idle/new ordering: these rows have no connected_at /
 * last_activity_at to drive that ordering, and grouping "not actually
 * reachable via ccmsg yet" rows together — instead of scattering them among
 * live sessions — reads as the more useful default. Sorted newest-started
 * first (the closest available proxy for "worth noticing"). */
export function offlineAgentRows(
  peers: readonly PeerInfo[],
  agents: readonly AgentInfo[],
): SessionRow[] {
  const peerSids = new Set(peers.map((p) => p.sid));
  // De-dup by sessionId (Map.set, last-wins — same policy as
  // indexAgentsBySid) before building rows: the agents rows from more
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
      // the agents rows carry no VCS metadata, so these rows have no
      // repo/ws and say so. They used to borrow `a.name` for `ws` to keep the
      // old single-label first line non-blank; the row now leads with that
      // name in its own right (sessionRowTitle), and a `ws` holding a session
      // title would print the title twice under kawaz r135m16's layout.
      repo: "",
      ws: "",
      cwd: a.cwd,
      agent: a,
      connected: false,
    }));
}

/** Whether a session has a transcript the daemon can serve — the single gate
 * behind SessionView's Timeline and Status tabs, derived from one session's
 * three possible transcript sources. Both ops resolve the same way for a
 * user-role conn (transcript.ts's `TranscriptResolveOptions` allowVirtual):
 * the announced `transcript_path` of a connected session first, else
 * `resolveVirtualTranscript`'s `<configDir>/projects/<project>/<sid>.jsonl`
 * from the sid alone. So a selected/pinned search hit (which carries its
 * resolved file) and an agent-only row — a sid the agents rows list
 * with no ccmsg connection, hence no `transcript_path` to offer, but with a
 * jsonl on disk — are both readable and foldable.
 *
 * `inAgentsList` only widens the gate while the session is absent from
 * `peers`: a connected session that announced no transcript_path keeps its own
 * `not_found` even under allowVirtual (transcript.ts), so opening the tabs for
 * it would just render an error. */
export function hasSessionTranscript(
  peer: { transcript_path?: string } | undefined,
  storedFile: string | undefined,
  inAgentsList: boolean,
): boolean {
  return !!peer?.transcript_path || !!storedFile || (!peer && inAgentsList);
}

/** Sessions-list row label (U1 first line): `{repo, ws}` when the row has
 * either (every peers row does), else falls back to the matched agent's
 * `name`, then the cwd's last path segment — an agent-only row never has
 * repo/ws (the agents rows carry no VCS metadata), so this is the
 * only path that ever exercises the fallback in practice, but a peers row
 * with an empty repo/ws (session announced neither) takes the same
 * fallback rather than rendering a blank first line. */
/** Resolve `{repo, ws, cwd}` for the topbar title of a session sid (kawaz
 * r38 mid=9). Three sources, first non-empty wins — same fallback chain
 * `sessionRowTitle` uses for the sidebar, so the topbar can't disagree with
 * SessionList about what one session's repo/ws pair is:
 *
 * 1. A live peer's hello metadata (the session announced its own
 *    `SessionIdentity.ws` — the strongest signal we ever get).
 * 2. A pinned session's stored `repo/ws` — DR-0021 lets a
 *    disconnected session stay selected, and dropping to `sid.slice(0,8)`
 *    lost the whole worktree name for those rows.
 * 3. An agent-only row (an agents row with no ccmsg connection): the
 *    upstream carries no VCS metadata, so `agent.name` stands in for ws
 *    (the same substitution the sidebar's own first line makes).
 *
 * `cwd` comes from whichever source produced repo/ws (with a further peer /
 * pinned / agent fallback for the "all three empty" case) so the caller can
 * do a `lastPathSegment(cwd)` last-resort label. */
export function resolveSessionTopbar(
  state: AppState,
  sid: string,
): { repo: string; ws: string; cwd: string | null } {
  const peer = state.peers.find((p) => p.sid === sid);
  if (peer && (peer.repo || peer.ws)) {
    return { repo: peer.repo, ws: peer.ws, cwd: peer.cwd };
  }
  const pinned = pinForSid(state.pinnedSessions, sid);
  if (pinned && (pinned.repo || pinned.ws)) {
    return { repo: pinned.repo ?? "", ws: pinned.ws ?? "", cwd: pinned.cwd };
  }
  const agent = state.agents.find((a) => a.sessionId === sid);
  return {
    repo: "",
    ws: agent?.name ?? "",
    cwd: peer?.cwd ?? pinned?.cwd ?? agent?.cwd ?? null,
  };
}

/** The Sessions-list row's headline (kawaz r135m16 §1): the session's own
 * title — what `/rename` sets and Claude Code records as `name`
 * (e.g. "claude-ccmsg@main 20260812T0215", or whatever the user renamed it
 * to). That name is the only human-chosen identifier a session has, which is
 * why it now leads the row instead of repo/ws.
 *
 * The fallback chain deliberately skips repo/ws even though they are usually
 * available: the row's second line already prints `repo@ws`, so falling back
 * to it here would print the same string twice and make the two lines look
 * broken rather than informative. A row with no name therefore falls to the
 * cwd's last segment, and finally to a short sid — never blank, and never a
 * repeat of the line below. */
export function sessionRowTitle(row: SessionRow): string {
  return row.agent?.name || lastPathSegment(row.cwd) || shortSid(row.sid);
}

/** Primary status of a Sessions-list row — the single source of truth both
 * `sessionBadges` and `groupSessionsBySection` read, so the two can never
 * disagree about what one row's status is. In order:
 * - `"offline"`: a disconnected (agent-only, "ccmsg 未起動") row, whatever its
 *   agent says. Offline rows form their own section, and `api_error` can only
 *   be set for a connected row anyway (the daemon folds it over connected
 *   peers only).
 * - `"error"`: the latest main-context turn ended on a harness API error. The
 *   session is stopped waiting for the user, the most actionable state there
 *   is, whatever else is said of it.
 * - `"unobserved"`: a connected row with no `transcript_path`, so nothing
 *   about it can be viewed (Timeline, Status and the terminal all read the
 *   transcript): a session nobody has typed into yet, a launch the daemon has
 *   no transcript for.
 * - `"idle"`: a connected row the agents rows do not list (yet): nothing
 *   about it to report.
 * - `"waiting"`: Claude Code says a dialog waits for the person
 *   (`status: "waiting"`).
 * - `"busy"` / `"idle"`: the session answers a turn, or does not, as its
 *   hooks module said (`turn`, DR-0035 §3). Claude Code's own `status` is not
 *   read for this: it reports a session with a background shell (a Monitor)
 *   as busy for as long as the shell runs.
 * - `"no_module"`: no hooks module has said whether the session answers a
 *   turn, so the sidebar does not claim either. */
export type SessionStatus =
  | "offline"
  | "error"
  | "unobserved"
  | "idle"
  | "waiting"
  | "busy"
  | "no_module";

export function sessionStatus(row: SessionRow): SessionStatus {
  if (!row.connected) return "offline";
  if (row.api_error) return "error";
  if (!row.transcript_path) return "unobserved";
  if (!row.agent) return "idle";
  if (row.agent.status === "waiting") return "waiting";
  if (row.agent.turn === undefined) return "no_module";
  return row.agent.turn.state === "responding" ? "busy" : "idle";
}

/** Status/state badges for one Sessions-list row (U1), in display order.
 * - `"offline"` (agent-only row, no ccmsg connection) is exclusive of the
 *   statuses below — an offline row shows only "offline"
 *   since `agent` is always present for such a row (that's how it exists),
 *   so the loop below would otherwise also emit an idle/busy badge for it.
 * - A *connected* row (`row.connected`) with no matched agent (older CLI,
 *   the agents rows do not list it yet, or a non-Claude ccmsg client) gets
 *   no badges at all — "従来通り" per the U1 spec: there's nothing to
 *   report, so nothing is shown instead of guessing.
 * - `"bg"` is additive: a background agent still gets its status badge too,
 *   `"bg"` just tags kind separately.
 * U3 note: SessionList.tsx no longer renders the status badges this returns
 * (that status now shows via the row's section instead) — it only renders
 * the `"bg"` entry, if present. The function itself is kept as-is (tests
 * still pin its full return value) since `"bg"`'s presence still depends on
 * this same status computation. */
export function sessionBadges(row: SessionRow): string[] {
  if (!row.connected) return ["offline"];
  if (!row.agent) return [];
  const badges: string[] = [sessionStatus(row)];
  if (row.agent.kind === "background") badges.push("bg");
  return badges;
}

/** Two words naming the device behind a webui connection —
 * `<platform>/<browser>`, e.g. `iPad/Safari` — for the daemon log's hello line.
 *
 * Deliberately coarse: the question it answers is "which of kawaz's devices is
 * this connection", so a fixed vocabulary of platforms and browsers is enough
 * and the raw user agent never leaves the page. Order matters — Edge and Chrome
 * both claim Safari's token, and Chrome on iPadOS claims Safari's platform, so
 * the more specific claim is tested first. Anything unrecognized reads
 * `other/other` rather than guessing.
 *
 * iPadOS Safari presents itself as a Mac (`Macintosh` in the UA, the desktop
 * site by default), which is the one device pair the UA alone cannot tell
 * apart — so a Macintosh with a multi-touch screen (`maxTouchPoints`, which no
 * Mac reports above 0) is named iPad. */
export function summarizeUserAgent(ua: string, maxTouchPoints = 0): string {
  const claimed =
    ["iPad", "iPhone", "Android", "Macintosh", "Windows", "Linux"].find((p) => ua.includes(p)) ??
    "other";
  const platform = claimed === "Macintosh" && maxTouchPoints > 1 ? "iPad" : claimed;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "other";
  return `${platform}/${browser}`;
}

/** How a session's ccmsg client reads in the Status tab: the build it
 * announced, and the generation when it named one.
 *
 * A client from before either field existed reads as "版数不明" and nothing
 * more — every subscribe running today is one, they are perfectly compatible
 * (`UNANNOUNCED_PROTOCOL_VERSION`), and this row is not the place to imply
 * otherwise. Any warning comes from `staleClientWarning` instead. */
export function clientBuildLabel(row: { client_version?: string; protocol?: number }): string {
  const version = row.client_version ? `v${row.client_version}` : "版数不明";
  return row.protocol === undefined ? version : `${version} (protocol ${row.protocol})`;
}

/** The warning one session's refused ccmsg client earns, or null while every
 * client of it is being served.
 *
 * The stale process is almost never the one that just hello'd — it is the
 * session's sidecar, started with the plugin of its day and still trying
 * against a daemon that has moved on, refused every few seconds and silent
 * about it. So the text names the fix (restart the session, which loads the
 * current plugin) rather than the symptom, and the version it reports is the
 * *stale* client's, not the row's.
 *
 * An absent `protocol` is not "unknown generation" here: it is the daemon
 * saying the hello never got as far as being read as one, for carrying no
 * `request_id`. Naming that is more useful than a generation number, since it
 * is the actual reason that client cannot connect. */
export function staleClientWarning(row: {
  stale_client?: StaleClientInfo;
}): { marker: string; build: string; text: string } | null {
  const stale = row.stale_client;
  if (!stale) return null;
  const version = stale.version ? `v${stale.version}` : "版数不明";
  const generation =
    stale.protocol === undefined ? "request_id 非対応" : `protocol ${stale.protocol}`;
  // The stale client's own build, not the row's: the row reports whatever
  // hello'd last, which on a healthy-plus-stale session is the *working*
  // process — naming that one would point the reader at the wrong version.
  const build = `${version} / ${generation}`;
  return {
    marker: "⚠",
    build,
    text:
      `ccmsg クライアントが古い (${build})。` +
      `このセッションを再起動してください (最新の plugin が載る)\n最終試行: ${stale.last_seen}`,
  };
}

/** Display text for a badge kind (SessionList.tsx renders these verbatim). */
export function badgeLabel(kind: string): string {
  return kind === "offline" ? "ccmsg未起動" : kind;
}

// --- Sidebar Sessions-list: status sections (U3) --- //

/** A Sessions-list section: the statuses it holds. Busy and idle are both
 * running sessions, so they form one section; each row still shows its own
 * idle time. */
export type SessionSectionKey = Exclude<SessionStatus, "idle">;

/** Section order. "error" (a harness API error stopped the turn) leads: like
 * "waiting" it waits for the person, but nobody is asking, so left alone it
 * stays stopped forever. "waiting" (承認待ち等でユーザ入力を待っている) comes
 * next (kawaz r46 mid=41: 「Busyより優先度高いので一番上に」— 人間のアクション
 * が要る状態が最も actionable), then busy (kawaz's stated reason for sectioning
 * at all: "busy 表示邪魔"), then "no_module": those sessions run too, but the
 * sidebar cannot say whether they answer a turn. "offline" (nothing to do
 * from the webui for a session that hasn't connected) and "unobserved" (rows
 * with nothing to open) close the list. */
const SESSION_SECTION_ORDER: readonly SessionSectionKey[] = [
  "error",
  "waiting",
  "busy",
  "no_module",
  "offline",
  "unobserved",
];

const SESSION_SECTION_LABELS: Record<SessionSectionKey, string> = {
  error: "Error",
  waiting: "Waiting",
  busy: "Active",
  no_module: "No module",
  offline: "ccmsg未起動",
  unobserved: "No transcript",
};

function sectionKeyOf(row: SessionRow): SessionSectionKey {
  const status = sessionStatus(row);
  return status === "idle" ? "busy" : status;
}

export interface SessionSection {
  key: SessionSectionKey;
  label: string;
  rows: SessionRow[];
}

/** Groups Sessions-list rows into per-status sections (U3, kawaz 2026-07-11:
 * "busy 表示邪魔。リスト側に busy とかのやつでセクション切ってフォルディングも
 * できるように。で各アイテムの busy は取る"), in `SESSION_SECTION_ORDER`. Only
 * sections that actually have a row appear — an empty section would just be
 * a heading with nothing under it. Row order *within* each section is the
 * input array's order (already the Sidebar's name/created/recent sort by the
 * time `rows` reaches here, see SessionList.tsx) — this function only
 * partitions, it never reorders rows. */
export function groupSessionsBySection(rows: SessionRow[]): SessionSection[] {
  const buckets = new Map<SessionSectionKey, SessionRow[]>();
  for (const row of rows) {
    const key = sectionKeyOf(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  return SESSION_SECTION_ORDER.flatMap((key) => {
    const bucket = buckets.get(key);
    return bucket ? [{ key, label: SESSION_SECTION_LABELS[key], rows: bucket }] : [];
  });
}

// --- FileTree favorites (U-fav) --- //

/** localStorage key for a session's Files-tree favorites, namespaced per
 * session directory — FileTree.tsx passes `peer.cwd` as `root`, so every
 * session/tab working in the same directory shares one favorites list while
 * two directories never do, including two workspaces/worktrees of one repo
 * (kawaz: worktrees of one repo often serve different roles, so their
 * favorites are kept apart; the same key the sidebar's pins use, DR-0021
 * §2.4). Kept as a plain string-formatting function (not reading `peer`
 * itself) so it stays testable without a PeerInfo fixture, mirroring
 * `favoritesStorageKey`'s sibling helpers above (`treeRootPath` etc.)
 * that narrow their input to just the fields they need. */
export function favoritesStorageKey(root: string): string {
  return `ccmsg.favorites.${root}`;
}

/** The stored favorites of a directory: its paths, none when nothing is
 * stored. */
const FavoritesSchema = v.optional(v.array(v.string()), () => []);
const FavoritesTextSchema = jsonText(FavoritesSchema);

/** Reads a raw `localStorage.getItem(favoritesStorageKey(...))` result into
 * a favorites path list. A value that does not read as a list of paths (one a
 * prior version / a manual edit / storage corruption left behind) is ignored
 * as a whole — the empty list — rather than read in part. */
export function parseFavorites(raw: string | null): string[] {
  const read = raw === null ? null : parseWith(FavoritesTextSchema, raw);
  return [...(read?.ok ? read.value : v.getDefault(FavoritesSchema))];
}

/** Toggles one path in a favorites list: removes it if already present,
 * appends it if absent. Pure (always returns a new array, never mutates
 * `favorites`) so a caller can feed the result straight into `useState`'s
 * setter / a localStorage-persisting effect without aliasing concerns. The
 * list holds normalized full paths (see FileTree); display order is the
 * Files tree's own (`groupByFolder` in files-sections.ts), not this list's. */
export function toggleFavorite(favorites: string[], path: string): string[] {
  return favorites.includes(path) ? favorites.filter((p) => p !== path) : [...favorites, path];
}

/** DR-0024 client convention: project tree paths are root-relative and never
 * start with `/`; session_status.external_files are absolute and always do.
 * This one discriminator selects fs_read vs fs_read_external and cannot collide
 * with an existing project path. */
export function isExternalFilePath(filePath: string): boolean {
  return filePath.startsWith("/");
}

/** DR-0026 client-side dispatcher: an absolute path whose realpath already
 * matches one of the session's workspace_folders roots (or a descendant) uses
 * fs_list_workspace / fs_read_workspace instead of the DR-0024 exact-file
 * fs_read_external. Kept as a pure helper so FileTree (loadDir) and
 * FileViewer (fs_read) share one classification rule.
 *
 * The client works from the folders' `path` values verbatim as the daemon
 * publishes them (realpaths); we don't re-resolve locally. A path is
 * considered a workspace path when it equals a folder root or lies under
 * `folder + "/"` — same containment test the daemon does. Prefix collisions
 * between two folders (`/a` vs `/ab`) are avoided by the trailing-slash
 * check, matching the daemon's `insideAny` logic. */
export function isWorkspaceFilePath(
  filePath: string,
  workspaceFolders: readonly { path: string }[],
): boolean {
  if (!filePath.startsWith("/")) return false;
  for (const folder of workspaceFolders) {
    if (filePath === folder.path) return true;
    const prefix = folder.path.endsWith("/") ? folder.path : `${folder.path}/`;
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}

/** The spelling the Files panes address `selectedPath` by.
 *
 * A path naming a file inside the session's own containment root is the same
 * file `fs_read` serves root-relative, so it is rebased to that shape no matter
 * which spelling arrived (a pasted URL, a link resolved against another
 * session's anchor, a viewer path carried between sessions). Left absolute it
 * routes to `fs_read_external`, whose DR-0024 allowlist holds only files the
 * session actually read — an ordinary project file then answers `path not
 * allowed` although the tree beside it lists that very file.
 *
 * Rebasing grants nothing: `fs_read` re-checks containment on the daemon side,
 * so this only picks which op a path the user can already browse goes through.
 *
 * Two shapes are returned untouched:
 *   - a workspace path (DR-0026), whose folder root may sit anywhere and whose
 *     absolute form is what the tree's ワークスペース section addresses;
 *   - an absolute path outside the containment root, which is external by
 *     definition and keeps the exact-file allowlist as its authorization.
 *
 * `containmentRoot` is `repo_root ?? cwd` — the daemon's own `resolveRoot`
 * rule. An absolute path cannot be classified until that root arrives. `null`
 * tells the caller to hold the read instead of prematurely treating it as an
 * external file.
 *
 * A `~/` path (a home-relative link target, see `refLinkTarget`) is expanded
 * with `home` — the daemon user's home from its `ping` reply, since only the
 * daemon's own home decides what the daemon serves — and then classified like
 * any absolute path. It is held (`null`) until that home is known. */
export function canonicalViewerPath(
  selectedPath: string,
  containmentRoot: string | undefined,
  workspaceFolders: readonly { path: string }[],
  home?: string,
): string | null {
  const path = !isHomePath(selectedPath)
    ? selectedPath
    : home === undefined
      ? null
      : `${home.replace(/\/+$/, "")}/${selectedPath.slice(2)}`;
  if (path === null) return null;
  if (!isExternalFilePath(path)) return path;
  if (containmentRoot === undefined) return null;
  if (isWorkspaceFilePath(path, workspaceFolders)) return path;
  return viewerPathForAbsolute(path, containmentRoot);
}

/** Extensions the daemon's /fs-serve endpoint renders as inline images. Keep
 * in sync with SERVE_MIME_BY_EXT in daemon/src/fs-serve.ts — the daemon rejects
 * anything not in that table, so a mismatch would surface immediately as a
 * broken <img>. */
const VIEWER_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
]);

export function isImagePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return VIEWER_IMAGE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/** Stable display order for the "プロジェクト外" section, split into the origin
 * groups it renders (kawaz r99 m35: files the session read or wrote are a
 * different thing from files it was handed as attachments, and mixing them in
 * one flat list makes neither findable). The daemon already deduplicates and
 * sorts snapshots, but keeping the view derivation pure makes a locally
 * constructed snapshot deterministic too — including the case where both
 * origins name one path, which keeps the tool entry so a file cannot appear
 * under two headings. */
export function groupExternalFiles(files: readonly ExternalFile[]): {
  tool: string[];
  attachment: string[];
} {
  const byPath = new Map<string, ExternalFileOrigin>();
  for (const file of files) {
    if (!isExternalFilePath(file.path)) continue;
    if (byPath.get(file.path) === "tool") continue;
    byPath.set(file.path, file.origin);
  }
  const sorted = [...byPath].sort(([a], [b]) => a.localeCompare(b));
  return {
    tool: sorted.filter(([, origin]) => origin === "tool").map(([path]) => path),
    attachment: sorted.filter(([, origin]) => origin === "attachment").map(([path]) => path),
  };
}

/** Every allowlisted external path in display order, regardless of origin —
 * for the consumers that treat the list as one set (name search, existence
 * probes) rather than as grouped sections. */
export function sortExternalFiles(files: readonly ExternalFile[]): string[] {
  const { tool, attachment } = groupExternalFiles(files);
  return [...tool, ...attachment].sort((a, b) => a.localeCompare(b));
}

// --- docs/inbox メモ作成 (DR-0019 Phase W2) --- //

/** Root-relative directory listings affected when fs_write creates `filePath`.
 * fs_write may create the whole docs/inbox chain, so refreshing only the leaf
 * directory can leave cached ancestors unaware that their child now exists.
 * Root is always included; then every named parent appears shallow-to-deep. */
export function fileAncestorDirectories(filePath: string): string[] {
  const parts = filePath.split("/");
  const directories = [""];
  for (let i = 1; i < parts.length; i++) directories.push(parts.slice(0, i).join("/"));
  return directories;
}

/** FileTree で `selectedPath` の行を見える状態にするために展開すべき
 * ディレクトリ (浅い順)。`fileAncestorDirectories` が「fs_write が触った
 * かもしれない listing」を数えるのに対し、こちらは「ツリー上でその行に
 * 到達するために開かねばならない node」を数える — 起点となる section root
 * の扱いが違うので別関数になる:
 *
 * - 相対パスは cwd の folder (`rootPath`) の下にある。cwd の folder も
 *   ワークスペース section の畳める DirNode なので、それ自身を含めて返す
 *   (祖先は返さない)。`rootPath` 配下でない相対パスはツリーに現れない
 *   (お気に入り / プロジェクト外が 1 行で描くだけ) ので空を返す。
 * - それ以外のワークスペース folder root も畳める DirNode なので、それ自身を
 *   含めて返す。
 * - どの workspace folder にも属さない絶対パス (DR-0024 のプロジェクト外
 *   ファイル) は depth 0 の平坦な行なので展開対象なし。 */
export function expandPathsForSelection(
  selectedPath: string,
  rootPath: string,
  workspaceFolders: readonly { path: string }[],
): string[] {
  if (selectedPath === "") return [];
  let base: string;
  if (selectedPath.startsWith("/")) {
    const folder = workspaceFolders.find((f) => isWorkspaceFilePath(selectedPath, [f]));
    if (!folder) return [];
    base = folder.path.replace(/\/+$/, "");
  } else {
    base = rootPath.replace(/\/+$/, "");
    if (base !== "" && !selectedPath.startsWith(`${base}/`)) return [];
  }
  const prefix = base === "" ? "" : `${base}/`;
  const deeper = fileAncestorDirectories(selectedPath).filter(
    (dir) => dir.length > base.length && dir.startsWith(prefix),
  );
  return [base, ...deeper];
}

/** docs/inbox メモ作成エディタ (FileViewer.tsx) の自動ファイル名。DR-0019 §2.2
 * が指定する `YYYYMMDD-HHmm.md` を端末のローカル時刻 (`Date` の非-UTC
 * ゲッター) から組み立てる — inbox は「今この瞬間に拾ってほしい雑メモ」を
 * 置く場所なので、UTC 表記だと作成者自身の体感時刻とずれる。分未満の衝突
 * (同一分に複数メモを作る) は許容 — その場合はファイル名 input を手で埋めれば
 * 済み、秒まで持たせて衝突を避ける複雑化はスコープ外 (kawaz 裁定なし、
 * DR-0019 の記述に忠実な最小実装)。 */
export function inboxAutoFilename(now: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  return `${y}${mo}${d}-${h}${mi}.md`;
}

/** docs/inbox メモ作成エディタのファイル名解決 (DR-0019 §2.2)。pure —
 * submit ハンドラが結果をそのまま `fsWrite` の path (`docs/inbox/<name>`)
 * に渡す。3 通り:
 * - 空/空白のみの入力 = 省略扱い → `inboxAutoFilename` の自動命名
 * - `/` を含む入力 → エラー (DR-0019 §2.3 曰くサブディレクトリ切りは W2
 *   スコープ外。daemon 側の containment も `docs/inbox/` 直下の
 *   prefix 前提なので、client 側で早期に弾いて往復を省く)
 * - それ以外 → `.md` 拡張子が無ければ付与 (大文字小文字を問わず既存の
 *   `.md`/`.MD` はそのまま尊重、二重付与を避ける) */
export function resolveInboxFilename(
  rawName: string,
  now: Date,
): { name: string } | { error: string } {
  const trimmed = rawName.trim();
  if (trimmed === "") return { name: inboxAutoFilename(now) };
  if (trimmed.includes("/")) {
    return { error: "ファイル名に / は使えません (サブディレクトリ未対応)" };
  }
  const name = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  return { name };
}

// --- Session search (DR-0021 Phase 2) --- //

/** Byte count → human string ("512 B" / "3.4 KB" / "1.2 MB"), for the search
 * result list's size column. Same coarse-unit-then-stop style as
 * `formatDuration` (one fractional digit past the first unit that's ≥1, no
 * further subdivision). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** SessionSearchPanel's controlled form state, one field per DR-0021 §2.1
 * search parameter. `configDirs: []` means "no explicit filter" (every
 * detected config dir) — the same "absent = server default" convention the
 * wire request itself uses, kept here too so a fresh form and an
 * explicitly-select-everything form serialize identically. */
export interface SessionSearchForm {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  targetUser: boolean;
  targetAgent: boolean;
  cwd: string;
  sid: string;
  configDirs: string[];
  mtimeWithin: string;
}

/** DR-0021 §2.1 defaults: both targets on, no cwd/sid/config_dir filter,
 * mtime window 5d (matches the wire default `SessionSearchRequest.mtime_within`
 * documented in @ccmsg/protocol, so an unmodified form and an omitted field
 * mean the same thing server-side). */
export const DEFAULT_SESSION_SEARCH_FORM: SessionSearchForm = {
  query: "",
  caseSensitive: false,
  regex: false,
  targetUser: true,
  targetAgent: true,
  cwd: "",
  sid: "",
  configDirs: [],
  mtimeWithin: "5d",
};

/** Builds the wire `session_search` request body (op excluded — ws.ts's
 * `sessionSearch` adds it, same option-object convention as
 * `fsList`/`transcriptRead`) from the form state. Free-text fields are
 * trimmed and omitted when empty; both target toggles are only sent when
 * `false` (their server-side default is `true`, so an unflipped toggle needs
 * no wire representation); `mtimeWithin` is omitted when it's still the form
 * default (also the server default) or blank. Never throws on a malformed
 * form (there's no way to construct one — this is a plain object literal,
 * not parsed input), so it's a total function, not a Result-returning one
 * like `resolveInboxFilename`. */
export function buildSessionSearchRequest(
  form: SessionSearchForm,
): Omit<SessionSearchRequest, "op" | "request_id"> {
  const query = form.query.trim();
  const cwd = form.cwd.trim();
  const sid = form.sid.trim();
  const mtime = form.mtimeWithin.trim();
  return {
    ...(query ? { query } : {}),
    ...(form.caseSensitive ? { case_sensitive: true } : {}),
    ...(form.regex ? { regex: true } : {}),
    ...(!form.targetUser ? { target_user: false } : {}),
    ...(!form.targetAgent ? { target_agent: false } : {}),
    ...(cwd ? { cwd } : {}),
    ...(sid ? { sid } : {}),
    ...(form.configDirs.length > 0 ? { config_dirs: form.configDirs } : {}),
    ...(mtime && mtime !== DEFAULT_SESSION_SEARCH_FORM.mtimeWithin ? { mtime_within: mtime } : {}),
  };
}

/** Converts the submitted Session Search query controls into Timeline's
 * per-session in-view search state. Keeping this pure makes the cross-view
 * handoff independently testable instead of coupling it to navigation. */
export function sessionSearchFormToTimelineSearch(form: SessionSearchForm) {
  return {
    queryText: form.query.trim(),
    caseSensitive: form.caseSensitive,
    regex: form.regex,
  };
}

/** repo/ws label for a search-result row or a pinned-session row (DR-0021
 * §2.3/§2.4) — same fallback chain as `sessionRowTitle`/`sessionLabel`:
 * `hit.repo`/`hit.ws` when present, else the cwd's last path segment (a
 * session outside the known `repos/{host}/{owner}/{repo}` layout still needs
 * a non-blank label), finally the sid's short form if even `cwd` is null
 * (daemon couldn't restore one, SessionSearchHit.cwd doc comment). */
export function sessionSearchHitLabel(hit: SessionSearchHit): { repo: string; ws: string } {
  if (hit.repo || hit.ws) return { repo: hit.repo ?? "", ws: hit.ws ?? "" };
  return { repo: "", ws: hit.cwd ? lastPathSegment(hit.cwd) : shortSid(hit.sid) };
}

/** Compact one-letter role marker for a search match line (DR-0021 §2.3:
 * "ユーザ・エージェントメッセージの区別がつく形") — "U" user, "A" agent
 * (covers ccmsg queue deliveries authored by a non-u1 member too, per
 * SessionSearchRequest.target_agent's doc comment; the daemon already folds
 * that distinction into `role` before it reaches the client). */
export function matchRoleBadge(role: SessionSearchMatch["role"]): string {
  return role === "user" ? "U" : "A";
}

// --- Pinned sessions (DR-0021 §2.4/§3.2, SS-Q2=a: webui localStorage, no
// daemon persistence) --- //

export const PINNED_SESSIONS_STORAGE_KEY = "ccmsg.pinnedSessions";

/** The stored pins as this webui writes them: a versioned envelope, so a later
 * change to `PinSchema` adds an option here and keeps reading what was
 * written before it. */
const PinnedSessionsV1Schema = v.object({ v: v.literal(1), pins: v.array(PinSchema) });

/** The stored pins as an earlier webui wrote them: Session Search hits, bare,
 * one per pin. Only the fields a pin keeps are read; a hit with no cwd could
 * never be pinned by directory and becomes no pin. */
const PinnedSessionsHitListSchema = v.pipe(
  v.array(
    v.object({
      ...PinSchema.entries,
      cwd: v.nullable(v.string()),
    }),
  ),
  v.transform((hits) => hits.flatMap(({ cwd, ...rest }) => (cwd ? [{ ...rest, cwd }] : []))),
);

const PinnedSessionsTextSchema = jsonText(
  v.union([
    v.pipe(
      PinnedSessionsV1Schema,
      v.transform(({ pins }) => pins),
    ),
    PinnedSessionsHitListSchema,
  ]),
);

/** Reads a raw `localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY)` result
 * into a pin list (the store keys it by cwd, pinsFromList). Nothing stored is
 * no pins. A value that reads as none of the stored shapes (a manual edit,
 * storage corruption) is no pins either — ignored as a whole rather than read
 * in part, same as `parseFavorites` — and the console says so, with why. */
export function parsePinnedSessions(raw: string | null): Pin[] {
  if (raw === null) return [];
  const read = parseWith(PinnedSessionsTextSchema, raw);
  if (read.ok) return [...read.value];
  console.warn(`ccmsg: ignored the stored pinned sessions: ${read.failure.summary}`);
  return [];
}

/** The localStorage text for `pins`, read back by `parsePinnedSessions`. */
export function serializePinnedSessions(pins: Iterable<Pin>): string {
  return JSON.stringify({ v: 1, pins: [...pins] });
}

/** textarea の視覚行数 = 改行 + 1 (空文字でも 1 行、末尾改行はその後ろの
 * 空行を 1 行として数える — textarea 上でカーソル可能な行と一致させる)。
 * `splitLines` (閲覧用) と違って末尾改行を吸収しないのが意図。 */
export function editorLineCount(value: string): number {
  let count = 1;
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) === 10) count += 1;
  return count;
}

/** True when the browser is sitting on a path this app does not serve.
 *
 * The daemon answers *every* path with the HTML shell rather than a bare 404,
 * because a full-screen error page is unescapable in a standalone PWA (no
 * address bar, no back button). That rescue works — the app boots and the
 * sidebar is usable — but it also means a wrong URL looks exactly like the
 * home screen, so nothing tells the user they are somewhere that doesn't
 * exist (kawaz r55 m130).
 *
 * Deliberately a pathname test only: routing lives entirely in the hash, and a
 * hash locator always resolves to *some* view (an unknown room or session id
 * is an ordinary empty state, not a 404). */
export function isUnknownAppPath(pathname: string): boolean {
  return parseUrl(pathname).view === "unknown";
}

// --- document.title (browser tab label) --- //

/** Base app name, also the title when nothing is selected (matches
 * `<title>` in index.html and the topbar's own "何も選択していない" fallback,
 * see TopbarTitle in App.tsx). */
const DOCUMENT_TITLE_BASE = "ccmsg";

/** Browser tab title for the current app state. The identifying part comes
 * first and the app name last (`"<repo ▸ ws> - ccmsg"`) because a browser
 * tab only ever shows the leading characters of its title — with multiple
 * ccmsg tabs open (one per session), a fixed leading "ccmsg" made every tab
 * look identical until hovered. Session/room labels reuse the exact fallback
 * chains `TopbarTitle`/`resolveSessionTopbar` already use, so the tab title
 * can never disagree with what's shown in the topbar itself. Any other view
 * (usage, or nothing selected) keeps the plain app name — there's no single
 * identifying label to promote for those. */
export function documentTitleFor(state: AppState): string {
  if (state.missingTarget === null && state.unknownPath === null) {
    if (state.view === "session" || state.view === "timeline") {
      const sid = state.currentSid;
      if (sid !== null) {
        const { repo, ws, cwd } = resolveSessionTopbar(state, sid);
        const label =
          repo && ws
            ? `${repo} ▸ ${ws}`
            : repo || ws || (cwd ? lastPathSegment(cwd) : "") || sid.slice(0, 8);
        return `${label} - ${DOCUMENT_TITLE_BASE}`;
      }
    } else if (state.currentRoomId !== null) {
      const room = state.rooms.get(state.currentRoomId);
      const label = room?.title || state.currentRoomId;
      return `${label} - ${DOCUMENT_TITLE_BASE}`;
    }
  }
  return DOCUMENT_TITLE_BASE;
}
