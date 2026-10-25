// サイドバーのフォームパネル (新規セッション / セッション検索) の
// 状態を URL に載せるための文法 (kawaz r259 m47-m53)。
//
// path はメインペインの中身だけを名指しする (`/r/<id>`、`/s/<sid>/<tab>`、
// `/usage` …)。この 2 つのパネルは `/s/<sid>/*` を開いたまま横に並べて使う
// もので、開いていること自体はメインペインの中身を変えない — だから path
// ではなく `sb.` 接頭辞付きの query に載せる。逆に言えば「どのセッションを
// 見ているか」と「どのフォームを開いているか」は 1 本の URL に同居でき、
// その URL を貼れば相手の画面も同じ組み合わせになる。
//
// - `sb.panel=new|search` — どれが開いているか。2 つは排他なので単一値。
//   これが無ければ他の `sb.*` は一切見ない (パネルが閉じている URL に、
//   効かないフォーム値だけが残るのを避ける)。
// - `sb.<field>=<value>` — 起動フォームの欄の初期値。名前は起動の入力
//   (DR-0018 §3.2 の `LaunchInput`) の field 名そのもの (`type` / `cwd` /
//   `resume_session_id` …、`LAUNCH_FORM_FIELDS`)。それ以外の名前は採用しない。
// - `sb.search=<query>` — Session Search の検索語。
//
// hash は使わない (Timeline のアンカーが既に使っている)。JSON 値も使わない —
// 値は素の文字列で、複数行の prompt も URL エンコード (`%0A`) で足りる。
import { parseWith } from "@ccmsg/protocol";
import * as v from "valibot";

/** 開けるフォームパネル。2 つは排他 (`SidebarUrlState.panel` が単一値)。 */
export type SidebarPanelKind = "session-creator" | "session-search";

/** `sb.panel` の語彙と内部 kind の対応。URL 側を短くしているのは、手で打つ /
 * 貼る対象だから (`new` / `search` は画面上のボタンの呼び名でもある)。 */
const PANEL_BY_TOKEN: Readonly<Record<string, SidebarPanelKind>> = {
  new: "session-creator",
  search: "session-search",
};

const TOKEN_BY_PANEL: Readonly<Record<SidebarPanelKind, string>> = {
  "session-creator": "new",
  "session-search": "search",
};

const PREFIX = "sb.";

/** 起動フォームの欄、表示の順。名前は起動の入力の field 名で、4 つの type の
 * field の和 (どの type がどれを取るかは session-creator.ts が schema から
 * 読む)。予約キー (`panel` / `search`) とは名前が重ならない。 */
export const LAUNCH_FORM_FIELDS = [
  "type",
  "resume_session_id",
  "resume_at",
  "cwd",
  "model",
  "effort",
  "name",
  "prompt",
] as const;
export type LaunchFormField = (typeof LAUNCH_FORM_FIELDS)[number];

/** URL が運ぶ起動フォームの初期値。値は素の文字列のままで、欄として読める
 * か (type や model が語彙の中か) は開く側 (session-creator.ts) が決める。 */
export type LaunchSeed = Readonly<Partial<Record<LaunchFormField, string>>>;

export interface SidebarUrlState {
  panel: SidebarPanelKind | null;
  /** `sb.<field>` の集合。`LAUNCH_FORM_FIELDS` の名前だけ。 */
  launch: LaunchSeed;
  /** `sb.search`。null = URL が指定していない。 */
  search: string | null;
}

/** パネルが閉じている状態。`sb.*` を 1 つも持たない URL がこれになる。 */
export const CLOSED_SIDEBAR: SidebarUrlState = {
  panel: null,
  launch: {},
  search: null,
};

function panelFromToken(token: string | null): SidebarPanelKind | null {
  return token === null ? null : (PANEL_BY_TOKEN[token] ?? null);
}

/** query から `sb.*` を読む。`sb.panel` が無い / 未知の語彙なら閉じた状態を
 * 返し、他の `sb.*` は見ない。壊れた percent エスケープも同じ扱い — URL の
 * 一部が読めないときにフォームを中途半端な値で開くより、開かない方が正しい。 */
export function parseSidebarUrl(search: string): SidebarUrlState {
  if (/%(?![0-9a-fA-F]{2})/.test(search)) return CLOSED_SIDEBAR;
  const query = new URLSearchParams(search);
  const panel = panelFromToken(query.get(`${PREFIX}panel`));
  if (!panel) return CLOSED_SIDEBAR;
  const launch: Partial<Record<LaunchFormField, string>> = {};
  for (const field of LAUNCH_FORM_FIELDS) {
    const value = query.get(`${PREFIX}${field}`);
    if (value !== null) launch[field] = value;
  }
  return { panel, launch, search: query.get(`${PREFIX}search`) };
}

/** 書き出す `sb.*` の並び。欄を `LAUNCH_FORM_FIELDS` の順にするのは、同じ
 * 状態が常に同じ文字列になるようにするため (URL の異同で比較する箇所がある
 * のと、貼られた URL が入力順に依存してばらつくと差分が読めない)。 */
function sidebarEntries(state: SidebarUrlState): [string, string][] {
  if (!state.panel) return [];
  const entries: [string, string][] = [[`${PREFIX}panel`, TOKEN_BY_PANEL[state.panel]]];
  if (state.search !== null) entries.push([`${PREFIX}search`, state.search]);
  for (const field of LAUNCH_FORM_FIELDS) {
    const value = state.launch[field];
    if (value !== undefined) entries.push([`${PREFIX}${field}`, value]);
  }
  return entries;
}

/** URL の `sb.*` だけを差し替える。path と、そのページ固有の query
 * (`/usage?days=`) はそのまま — 別の名前空間なので互いに触らない。 */
export function withSidebarState(url: string, state: SidebarUrlState): string {
  const parsed = new URL(url, "http://x");
  const kept = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (!key.startsWith(PREFIX)) kept.append(key, value);
  }
  for (const [key, value] of sidebarEntries(state)) kept.append(key, value);
  const query = kept.toString();
  return query === "" ? parsed.pathname : `${parsed.pathname}?${query}`;
}

/** 2 つの `sb.*` 状態が同じか。遷移のたびに parseSidebarUrl が新しい
 * オブジェクトを作るので、store 側でこれを見て同一なら前の参照を残す —
 * さもないと「ランチャーを開いたまま別セッションを開く」だけでフォームの
 * seed effect が張り直され、入力中の値が初期値に戻ってしまう。 */
export function sameSidebarState(a: SidebarUrlState, b: SidebarUrlState): boolean {
  if (a === b) return true;
  if (a.panel !== b.panel || a.search !== b.search) return false;
  return LAUNCH_FORM_FIELDS.every((field) => a.launch[field] === b.launch[field]);
}

/** パネルのトグル: 開いていれば閉じ、そうでなければそれを開く。開くときは
 * 常に空の状態から始める — 「+ 新規」で開いたランチャーが前回の fork 元を
 * 引きずらないための規則で、URL に載せた今は「前の `sb.*` を残さない」こと
 * がそれにあたる。 */
export function toggleSidebarPanel(
  state: SidebarUrlState,
  kind: SidebarPanelKind,
): SidebarUrlState {
  if (state.panel === kind) return CLOSED_SIDEBAR;
  return { panel: kind, launch: {}, search: null };
}

/** SESSIONS のソート順。localStorage に永続する。URL には載せない — 「今どう並べて見て
 * いるか」は貼って共有する類の状態ではない。 */
export const SORT_KEY_STORAGE = "ccmsg.peerSortKey";

/** Sidebar Sessions-list ordering keys, cycled by the sort-toggle button
 * (see Sidebar.tsx): "prompt" is the default (most recent *user* input first),
 * "name" is lexicographic on `sessionLabel`'s fields, so it doubles as an
 * alphabetical grouping by repo/ws/branch, "idle" surfaces the most recently
 * active session first, "connected" surfaces the most recently (re)connected
 * session first.
 *
 * "prompt" vs "idle" (kawaz 2026-08-31: "TL 上で最後にユーザ入力した時間の
 * 新しい順") — they answer different questions and both stay available.
 * "idle" reads `last_activity_at`, which every ccmsg request a session makes
 * re-stamps, so a session grinding through a long autonomous run keeps
 * floating to the top; "prompt" reads `last_user_input_at`, which only moves
 * when the user actually says something, so the list orders by the
 * conversations the reader is in the middle of. */
export const PeerSortKeySchema = v.picklist(["name", "idle", "connected", "prompt"]);
export type PeerSortKey = v.InferOutput<typeof PeerSortKeySchema>;

/** 既定の "prompt" は「最後にユーザが入力したセッションが上」で、次にどれを
 * 見るかを探す動きに一番近い。 */
const StoredPeerSortKeySchema = v.optional(PeerSortKeySchema, "prompt");

/** 保存された並び順。保存されていない・読めない値は既定。 */
export function parsePeerSortKey(raw: string | null): PeerSortKey {
  const read = parseWith(StoredPeerSortKeySchema, raw ?? undefined);
  return read.ok ? read.value : v.getDefault(StoredPeerSortKeySchema);
}
