// サイドバーのフォームパネル (新規セッション / セッション検索 / 新規 Room) の
// 状態を URL に載せるための文法 (kawaz r259 m47-m53)。
//
// path はメインペインの中身だけを名指しする (`/r/<id>`、`/s/<sid>/<tab>`、
// `/usage` …)。この 3 つのパネルは `/s/<sid>/*` を開いたまま横に並べて使う
// もので、開いていること自体はメインペインの中身を変えない — だから path
// ではなく `sb.` 接頭辞付きの query に載せる。逆に言えば「どのセッションを
// 見ているか」と「どのフォームを開いているか」は 1 本の URL に同居でき、
// その URL を貼れば相手の画面も同じ組み合わせになる。
//
// - `sb.panel=new|search|room` — どれが開いているか。3 つは排他なので単一値。
//   これが無ければ他の `sb.*` は一切見ない (パネルが閉じている URL に、
//   効かないフォーム値だけが残るのを避ける)。
// - `sb.template=<name>` — ランチャーのテンプレ名。省略時は宣言済みパラメータ
//   から選ぶ (session-creator.ts の `initialTemplate`)。
// - `sb.<PARAM>=<value>` — ランチャーの params 初期値。名前は大文字
//   (`SESSION_ID` / `RESUME_AT` / `CWD` / `MODEL` …)。予約キーが小文字なのは
//   この 2 つの名前空間を衝突なく同居させるためで、テンプレが宣言していない
//   名前は採用されない (session-creator.ts 側で落とす)。
// - `sb.search=<query>` — Session Search の検索語。
//
// hash は使わない (Timeline のアンカーが既に使っている)。JSON 値も使わない —
// 値は素の文字列で、複数行の PROMPT も URL エンコード (`%0A`) で足りる。
import type { PeerSortKey } from "./utils.ts";

/** 開けるフォームパネル。3 つは排他 (`SidebarUrlState.panel` が単一値)。 */
export type SidebarPanelKind = "session-creator" | "session-search" | "room-creator";

/** `sb.panel` の語彙と内部 kind の対応。URL 側を短くしているのは、手で打つ /
 * 貼る対象だから (`new` / `search` / `room` は画面上のボタンの呼び名でもある)。 */
const PANEL_BY_TOKEN: Readonly<Record<string, SidebarPanelKind>> = {
  new: "session-creator",
  search: "session-search",
  room: "room-creator",
};

const TOKEN_BY_PANEL: Readonly<Record<SidebarPanelKind, string>> = {
  "session-creator": "new",
  "session-search": "search",
  "room-creator": "room",
};

const PREFIX = "sb.";

/** 予約キー (小文字)。`sb.<PARAM>` は大文字なので、両者は名前で見分けられる。 */
const RESERVED = new Set(["panel", "template", "search"]);

/** ランチャー params として採用する名前の形。config の author が決める名前
 * なので webui は一覧を持てず、形だけで判定する。 */
const PARAM_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface SidebarUrlState {
  panel: SidebarPanelKind | null;
  /** `sb.template`。null = URL が指定していない (params から導出する)。 */
  template: string | null;
  /** `sb.<PARAM>` の集合。大文字名のみ。 */
  params: Readonly<Record<string, string>>;
  /** `sb.search`。null = URL が指定していない。 */
  search: string | null;
}

/** パネルが閉じている状態。`sb.*` を 1 つも持たない URL がこれになる。 */
export const CLOSED_SIDEBAR: SidebarUrlState = {
  panel: null,
  template: null,
  params: {},
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
  const params: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!key.startsWith(PREFIX)) continue;
    const name = key.slice(PREFIX.length);
    if (RESERVED.has(name) || !PARAM_NAME.test(name)) continue;
    params[name] = value;
  }
  return {
    panel,
    template: query.get(`${PREFIX}template`),
    params,
    search: query.get(`${PREFIX}search`),
  };
}

/** 書き出す `sb.*` の並び。params を名前順にするのは、同じ状態が常に同じ
 * 文字列になるようにするため (URL の異同で比較する箇所があるのと、貼られた
 * URL が入力順に依存してばらつくと差分が読めない)。 */
function sidebarEntries(state: SidebarUrlState): [string, string][] {
  if (!state.panel) return [];
  const entries: [string, string][] = [[`${PREFIX}panel`, TOKEN_BY_PANEL[state.panel]]];
  if (state.template !== null) entries.push([`${PREFIX}template`, state.template]);
  if (state.search !== null) entries.push([`${PREFIX}search`, state.search]);
  for (const name of Object.keys(state.params).sort()) {
    entries.push([`${PREFIX}${name}`, state.params[name] ?? ""]);
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
  if (a.panel !== b.panel || a.template !== b.template || a.search !== b.search) return false;
  const names = Object.keys(a.params);
  if (names.length !== Object.keys(b.params).length) return false;
  return names.every((name) => a.params[name] === b.params[name]);
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
  return { panel: kind, template: null, params: {}, search: null };
}

/** SESSIONS のソート順。一覧と RoomCreator のメンバ欄が同じ順で並ぶよう
 * 共有し、localStorage に永続する。URL には載せない — 「今どう並べて見て
 * いるか」は貼って共有する類の状態ではない。 */
export const SORT_KEY_STORAGE = "ccmsg.peerSortKey";

export function isPeerSortKey(raw: string | null): raw is PeerSortKey {
  return raw === "name" || raw === "idle" || raw === "connected" || raw === "prompt";
}
