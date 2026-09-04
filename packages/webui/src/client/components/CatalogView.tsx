// /catalog — the shared parts of this UI, rendered in the real stylesheet on
// the real host, so what is on screen is what ships. Two things follow from
// that and shape everything below.
//
// It reads nothing. No ws op, no store selector, no fetch: a catalog that
// needed live data could not be opened to diagnose a screen that is broken
// *because* the data is wrong, and it would render differently on a busy
// daemon than on an idle one. Every specimen here is a literal.
//
// It documents by being made of what it documents. The spacing bars are as
// long as the token they name; the type rows are set in the size they name.
// A table of numbers can drift from the stylesheet — a bar drawn with
// `width: var(--space-9)` cannot.
import type { ComponentChildren } from "preact";
import type { MemberInfo, RoomState } from "../store.ts";
import { ADMIN_ID } from "../store.ts";
import type { PeerInfo } from "@ccmsg/protocol";
import { Avatar, AvatarLabel, UserAvatar, hueForSeed } from "../avatar.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { ErrorView } from "./ErrorView.tsx";
import { FileTypeIcon, type FileIconKind } from "./FileIcon.tsx";
import { MarkdownView } from "../markdown-view.tsx";
import { MdAllSection, MdColorSection } from "./CatalogMdColors.tsx";
import { MemberChip } from "./MemberChip.tsx";
import { NO_TRANSCRIPT_MESSAGE } from "./SessionView.tsx";
import { Fold } from "./Fold.tsx";
import { Tabs } from "./Tabs.tsx";

interface SectionDef {
  id: string;
  title: string;
  /** What this section is for, in one line. Read before the specimens. */
  note: string;
}

/** Order is the reading order: the material (tokens) first, then the parts
 * built out of it, then the whole screens. The index at the top of the page is
 * generated from this list so a new section cannot be added without appearing
 * in the index. */
const SECTIONS: SectionDef[] = [
  { id: "color", title: "色", note: "テーマ切替の単位。CSS はこの名前だけを参照する。" },
  { id: "space", title: "余白", note: "padding / margin / gap の全段。棒の長さが実値。" },
  { id: "type", title: "文字サイズ", note: "各行はその段自身のサイズで組んである。" },
  {
    id: "avatar",
    title: "アバター",
    note: "seed から色を決める identicon と、User 固定アイコン。",
  },
  { id: "chip", title: "メンバーチップ", note: "ルーム参加者。接続状態と選択状態を持つ。" },
  { id: "fold", title: "折り畳み", note: "見出しで畳める区画。開閉は browser 側が持つ。" },
  { id: "tabs", title: "タブ", note: "排他的な表示切替。行ごとにクラスが違う。" },
  { id: "status", title: "接続ステータス", note: "daemon との WebSocket の状態、全 4 種。" },
  { id: "badge", title: "バッジ・ドット", note: "行内の小さな状態表示。" },
  {
    id: "bubble",
    title: "チャット吹き出し",
    note: "Timeline の発話者別スタイル。既存クラスの見本。",
  },
  { id: "file", title: "ファイルアイコン", note: "FileTree / 検索結果のエントリ種別、全 7 種。" },
  {
    id: "markdown",
    title: "Markdown 本文",
    note: "ファイルプレビューの組版。段落・見出し・強調の縦リズムを 1 枚で見る。",
  },
  {
    id: "md-all",
    title: "Markdown 全装飾",
    note: "renderer が出す装飾の全種類を、面ごとに 1 通りずつ。",
  },
  {
    id: "md-color",
    title: "md 装飾カラーの内訳",
    note: "各装飾の混色式と、その面での解決値。どちらも実物から実行時に読む。",
  },
  {
    id: "code",
    title: "コードブロック",
    note: "Markdown のフェンス。Shiki が非同期で色を載せる。",
  },
  { id: "form", title: "フォーム部品", note: "セッション作成フォームの入力系クラス。" },
  { id: "error", title: "エラー画面", note: "「そこには何も無い / 読めない」の唯一の表現。" },
];

const COLOR_GROUPS: { label: string; tokens: string[] }[] = [
  {
    label: "サーフェスと文字",
    tokens: ["--bg", "--bg-alt", "--fg", "--fg-muted", "--border"],
  },
  {
    label: "アクセントと状態",
    tokens: ["--accent", "--accent-fg", "--danger", "--warn", "--user-bg"],
  },
  {
    label: "吹き出し",
    tokens: [
      "--user-bubble-bg",
      "--peer-bubble-bg",
      "--assistant-bubble-bg",
      "--assistant-bubble-border",
      "--agent-comm-bg",
      "--agent-comm-border",
    ],
  },
  {
    label: "検索ハイライト",
    tokens: [
      "--search-color-1",
      "--search-color-2",
      "--search-color-3",
      "--search-color-4",
      "--search-color-5",
      "--search-color-6",
      "--search-hl-fg",
      "--search-current-color",
    ],
  },
];

/** Values duplicated from `:root` only as the *label*: the bar beside each one
 * is drawn with `var(--space-N)`, so a value that drifted from the stylesheet
 * would show up as a number that disagrees with the bar next to it. */
const SPACE_STEPS: [number, string][] = [
  [1, "0.1rem"],
  [2, "0.15rem"],
  [3, "0.2rem"],
  [4, "0.25rem"],
  [5, "0.3rem"],
  [6, "0.35rem"],
  [7, "0.4rem"],
  [8, "0.5rem"],
  [9, "0.6rem"],
  [10, "0.7rem"],
  [11, "0.75rem"],
  [12, "0.9rem"],
  [13, "1rem"],
  [14, "1.25rem"],
  [15, "1.5rem"],
  [16, "2rem"],
  [17, "3rem"],
];

const TYPE_STEPS: [string, string][] = [
  ["3xs", "0.6rem"],
  ["2xs", "0.65rem"],
  ["xs", "0.7rem"],
  ["sm", "0.75rem"],
  ["md", "0.8rem"],
  ["lg", "0.85rem"],
  ["xl", "0.9rem"],
  ["2xl", "1rem"],
  ["3xl", "1.15rem"],
  ["4xl", "1.25rem"],
];

const FILE_ICON_KINDS: FileIconKind[] = [
  "dir-closed",
  "dir-open",
  "symlink",
  "markdown",
  "image",
  "code",
  "file",
];

const CODE_SAMPLE = `export function catalogHref(): string {
  return "/catalog";
}`;

/** 読み物としての markdown を測るための見本。要素を 1 個ずつ並べた一覧では
 * 「詰まって見える」「強調が効いていない」は出てこない — 段落が連続し、その
 * 間に見出しやリストが挟まる普通の文書の形にして初めて縦のリズムが見える。
 * 実ファイルのプレビューと同じ `.viewer-preview .md` で組む。 */
const MARKDOWN_SAMPLE = `# 組版の見本

この段落は本文の基準になる。行間・字送り・1 行の長さは、**この長さの文章を続けて読んだときに目が迷わないか**で決まる。要素見本を 1 個ずつ並べても分からないのはここで、段落が 2 つ以上続いて初めて行間と段落間の差が効く。

段落が変わったことは、行が変わったことより強く見えなければならない。段落間隔が行間と同じだと、文章はひと塊の壁になる。逆に開けすぎると、今度は段落同士が無関係な断片に見えてしまう。

## 見出しの間隔

見出しは直後の本文のものなので、上の余白が下の余白より広い。狭いと前の節にくっついて見え、どこで話題が変わったのか分からなくなる。

### 強調と用語

本文中の \`--space-9\` のようなトークン名は等幅で出す。**強調は本文より強く見える**必要があり、[リンク](/catalog)は色で分かる。強調とリンクと等幅が同じ段落に同居しても、それぞれ別の役割として読めるのが目標。

- 箇条書きの 1 行目。折り返すくらいの長さがあるときに、2 行目が行頭記号ではなく 1 行目の文字に揃うと読みやすい
- **項目名** — 説明が続く形。項目名が本文と同じ濃さだと箇条書きは平坦になる
  - 入れ子の項目。親との段差は階層の唯一の手掛かり
  - もう 1 つの入れ子
- 3 つ目の項目

1. 順序に意味がある場合は番号付き
2. 番号と本文の間隔も縦のリズムに乗せる

- [x] チェックリストの行頭は、箇条書きの行頭記号と同じ位置に揃う
- [ ] 未チェックの項目

> 引用は本文と地を変え、左の罫で範囲を示す。引用の中でも段落の間隔は保たれる。

#### 4 段目

本文とサイズが近づく段。ここから先は、上の空きと番号が段を示す。

##### 5 段目

本文と同じ大きさになる段。太さだけでは本文中の強調と紛れるので、濃さを落として前に出ないようにしてある。

| 要素 | 決めるもの | 効き方 |
| --- | --- | --- |
| 行間 | 行と行の距離 | 1 段落の中の密度 |
| 段落間隔 | 段落と段落の距離 | 話の切れ目 |
| 強調 | 太さと濃さ | 本文からの浮き上がり |

\`\`\`ts
export function catalogHref(): string {
  return "/catalog";
}
\`\`\`

---

最後の段落。区切り線の前後も、他のブロックと同じ間隔の規則に従う。`;

/** 会話の中の markdown。文書見本と同じ要素を、Timeline に実際に出る分量で。 */
const MARKDOWN_BUBBLE_SAMPLE = `プレビューと同じ規則で組んであるが、値は詰めてある。**段落の切れ目**は行の切れ目より広く、それでも 1 発言が縦に伸びすぎない範囲に収まる。

行が続いてもここが段落の変わり目だと分かる。

### 見出し

- 箇条書きも同じ縦のリズムに乗る
- \`--space-10\` のようなトークン名は等幅

> 引用は地の色を落とす。他所の文の再掲だから。`;

function Section({ def, children }: { def: SectionDef; children: ComponentChildren }) {
  return (
    <section class="catalog-section" id={def.id}>
      <h2 class="catalog-section-title">{def.title}</h2>
      <p class="catalog-section-note">{def.note}</p>
      {children}
    </section>
  );
}

/** One specimen: the name it is called by in the gutter, the live thing on the
 * stage beside it. The pairing is the whole structure of this page — a reader
 * arrives knowing one of the two and leaves knowing both. */
function Specimen({
  name,
  note,
  children,
}: {
  name: string;
  note?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="catalog-specimen">
      <div class="catalog-specimen-head">
        <code class="catalog-specimen-name">{name}</code>
        {note !== undefined ? <span class="catalog-specimen-note">{note}</span> : null}
      </div>
      <div class="catalog-specimen-stage">{children}</div>
    </div>
  );
}

function ColorSection() {
  return (
    <>
      {COLOR_GROUPS.map((group) => (
        <Specimen key={group.label} name={group.label}>
          <ul class="catalog-swatches">
            {group.tokens.map((token) => (
              <li class="catalog-swatch" key={token}>
                {/* The one place a `style` attribute is right: the token being
                 * demonstrated is the data, so it cannot live in a class. */}
                <span class="catalog-swatch-chip" style={{ background: `var(${token})` }} />
                <code class="catalog-swatch-name">{token}</code>
              </li>
            ))}
          </ul>
        </Specimen>
      ))}
    </>
  );
}

function SpaceSection() {
  return (
    <Specimen name="--space-1 … --space-17" note="棒の長さ = その段の実値">
      <ul class="catalog-scale">
        {SPACE_STEPS.map(([step, value]) => (
          <li class="catalog-scale-row" key={step}>
            <code class="catalog-scale-name">--space-{step}</code>
            {/* The track is as wide as the largest step, so the bars share one
             * baseline and the value sits next to the bar it measures rather
             * than across the page from it. */}
            <span class="catalog-space-track">
              <span class="catalog-scale-bar" style={{ width: `var(--space-${step})` }} />
            </span>
            <span class="catalog-scale-value">{value}</span>
          </li>
        ))}
      </ul>
    </Specimen>
  );
}

function TypeSection() {
  return (
    <Specimen name="--font-size-3xs … --font-size-4xl" note="見本はその段自身のサイズ">
      <ul class="catalog-scale">
        {TYPE_STEPS.map(([step, value]) => (
          <li class="catalog-scale-row" key={step}>
            <code class="catalog-scale-name">--font-size-{step}</code>
            <span class="catalog-type-sample" style={{ fontSize: `var(--font-size-${step})` }}>
              セッション ccmsg Ag 0123
            </span>
            <span class="catalog-scale-value">{value}</span>
          </li>
        ))}
      </ul>
    </Specimen>
  );
}

function AvatarSection() {
  return (
    <>
      <Specimen name="<Avatar seed size />" note="seed のハッシュで色相が決まる">
        <div class="catalog-row">
          {["a3f1c204", "b8e07d55", "c19a4e6b", "d24f80a1"].map((seed) => (
            <span class="catalog-avatar-cell" key={seed}>
              <Avatar seed={seed} size={28} />
              <code class="catalog-caption">{seed}</code>
            </span>
          ))}
        </div>
      </Specimen>
      <Specimen name="<UserAvatar size />" note="u1 (User) 固定。seed を取らない">
        <div class="catalog-row">
          <UserAvatar size={16} />
          <UserAvatar size={20} />
          <UserAvatar size={28} />
        </div>
      </Specimen>
      <Specimen name="<AvatarLabel />">
        <div class="catalog-row">
          <AvatarLabel seed="a3f1c204">claude-ccmsg/main</AvatarLabel>
          <AvatarLabel>User</AvatarLabel>
        </div>
      </Specimen>
    </>
  );
}

/** A chip needs a room to name its member and a peer roster to decide whether
 * that member is connected, so the catalog supplies both as literals. Nothing
 * here is registered anywhere: the sids are invented, which is also why the
 * chip's own links lead to a 404 — a specimen of a chip, not a live one. */
const CATALOG_ROOM: RoomState = {
  id: "catalog-demo",
  title: "カタログ見本",
  sayUnread: new Set<number>(),
  membersById: new Map<string, MemberInfo>([
    [
      "a1",
      {
        type: "member",
        id: "a1",
        sid: "a3f1c204-0000-4000-8000-000000000001",
        repo: "/repos/claude-ccmsg",
        ws: "main",
        cwd: "/repos/claude-ccmsg/main",
        joined_at: "2026-08-12T00:00:00.000Z",
        left: false,
      },
    ],
    [
      "a2",
      {
        type: "member",
        id: "a2",
        sid: "b8e07d55-0000-4000-8000-000000000002",
        repo: "/repos/claude-ccmsg",
        ws: "review",
        cwd: "/repos/claude-ccmsg/review",
        joined_at: "2026-08-12T00:00:00.000Z",
        left: false,
      },
    ],
  ]),
  memberOrder: [ADMIN_ID, "a1", "a2"],
  msgs: new Map(),
  timeline: [],
  lastMid: 0,
  lastTs: null,
  kind: "normal",
  history: "loaded",
};

/** Only a1 is present, so a1 renders connected and a2 renders offline. */
const CATALOG_PEERS: PeerInfo[] = [
  {
    sid: "a3f1c204-0000-4000-8000-000000000001",
    repo: "/repos/claude-ccmsg",
    ws: "main",
    cwd: "/repos/claude-ccmsg/main",
  },
];

/** Both of a chip's actions are injected, so the specimens hand it handlers
 * that do nothing: clicking one here mentions nobody and kicks nobody. That is
 * the point of the split — a catalog whose chips could kick a real member
 * would be a hazard to open. */
const NO_OP = (): void => {};

function ChipSection() {
  return (
    <>
      <Specimen name="<MemberChip />" note="接続中 / 未接続 / User (u1)">
        <div class="catalog-row">
          <MemberChip
            id="a1"
            room={CATALOG_ROOM}
            selected={false}
            peers={CATALOG_PEERS}
            onSelect={NO_OP}
            onKick={NO_OP}
          />
          <MemberChip
            id="a2"
            room={CATALOG_ROOM}
            selected={false}
            peers={CATALOG_PEERS}
            onSelect={NO_OP}
            onKick={NO_OP}
          />
          <MemberChip
            id={ADMIN_ID}
            room={CATALOG_ROOM}
            selected={false}
            peers={CATALOG_PEERS}
            onSelect={NO_OP}
            onKick={NO_OP}
          />
        </div>
      </Specimen>
      <Specimen name="selected" note="メンション先に選ばれている状態">
        <div class="catalog-row">
          <MemberChip
            id="a1"
            room={CATALOG_ROOM}
            selected
            peers={CATALOG_PEERS}
            onSelect={NO_OP}
            onKick={NO_OP}
          />
        </div>
      </Specimen>
    </>
  );
}

/** Both states of the same component, side by side — which is the one thing
 * the real screens cannot show you, since a `<details>` on a live screen is
 * whichever way the reader last left it. */
function FoldSection() {
  return (
    <>
      <Specimen name="<Fold open />" note="初期状態で開いている">
        <Fold
          open
          class="session-section"
          summaryClass="session-section-summary"
          summary="Pinned (2)"
        >
          <ul class="session-section-list">
            <li class="session-row">claude-ccmsg/main</li>
            <li class="session-row">claude-ccmsg/review</li>
          </ul>
        </Fold>
      </Specimen>
      <Specimen name="<Fold />" note="初期状態で閉じている。見出しだけが残る">
        <Fold class="session-section" summaryClass="session-section-summary" summary="Done (2)">
          <ul class="session-section-list">
            <li class="session-row">開くとここが見える</li>
          </ul>
        </Fold>
      </Specimen>
      <Specimen name="summary={<>…</>}" note="見出しに数値や棒を並べる版 (/usage)">
        <Fold
          class="stats-period-row"
          summary={
            <>
              <span class="stats-period-key">2026-08</span>
              <span class="stats-period-note">12 日分</span>
              <span class="stats-period-bar">
                <span class="stats-period-bar-fill" style={{ width: "62%" }} />
              </span>
              <span class="stats-period-usd">$12.34</span>
            </>
          }
        >
          <p class="stats-empty">この期間の内訳はありません。</p>
        </Fold>
      </Specimen>
    </>
  );
}

/** The three rows are one component with three sets of classes. Seeing them
 * stacked is what makes that visible — and what makes a fourth spelling
 * obviously the wrong move. */
function TabsSection() {
  return (
    <>
      <Specimen name=".session-tab" note="セッションの Files/Timeline/…。href を持つ = リンク">
        <div class="session-tabs">
          <Tabs
            class="session-tabs-list"
            tabClass="session-tab"
            label="セッションの表示 (見本)"
            selected="timeline"
            items={[
              { id: "files", label: "Files", href: "#" },
              { id: "timeline", label: "Timeline", href: "#" },
              { id: "status", label: "Status", href: "#" },
            ]}
          />
        </div>
      </Specimen>
      <Specimen name="disabled" note="そのセッションに無い表示。押せない">
        <div class="session-tabs">
          <Tabs
            class="session-tabs-list"
            tabClass="session-tab"
            label="セッションの表示 (無効タブの見本)"
            selected="files"
            items={[
              { id: "files", label: "Files", href: "#" },
              {
                id: "timeline",
                label: "Timeline",
                disabled: true,
                title: NO_TRANSCRIPT_MESSAGE,
              },
            ]}
          />
        </div>
      </Specimen>
      <Specimen name=".tl-thinking-tab" note="Timeline 内の小さな切替。href を持たない = ボタン">
        <Tabs
          class="tl-thinking-tabs"
          tabClass="tl-thinking-tab"
          label="本文の言語 (見本)"
          selected="original"
          items={[
            { id: "original", label: "original" },
            { id: "ja-host", label: "ja(host)" },
            { id: "ja-browser", label: "ja(browser)" },
          ]}
        />
      </Specimen>
      <Specimen name=".viewer-mode-btn" note="ファイルビューアのコード/プレビュー">
        <Tabs
          class="viewer-mode-toggle"
          tabClass="viewer-mode-btn"
          label="表示モード (見本)"
          selected="preview"
          items={[
            { id: "code", label: "コード" },
            { id: "preview", label: "プレビュー" },
          ]}
        />
      </Specimen>
    </>
  );
}

function StatusSection() {
  return (
    <Specimen name="<ConnectionStatus status />">
      <div class="catalog-row">
        <ConnectionStatus status="connecting" />
        <ConnectionStatus status="connected" />
        <ConnectionStatus status="disconnected" />
        <ConnectionStatus status="restarting" />
      </div>
    </Specimen>
  );
}

function BadgeSection() {
  return (
    <>
      <Specimen name=".tl-agent-badge" note="agent 通信カードの種別バッジ">
        <div class="catalog-row">
          <span class="tl-agent-badge">Task</span>
          <span class="tl-agent-badge">SendMessage</span>
        </div>
      </Specimen>
      <Specimen name=".tl-summary-agent-messages" note="折り畳み時の件数表示">
        <div class="catalog-row">
          <span class="tl-summary-agent-messages">3 agent messages</span>
        </div>
      </Specimen>
    </>
  );
}

/** The bubbles are shown as raw markup rather than through the Timeline
 * components that normally build them: those take a parsed transcript segment,
 * and reproducing one here would document the parser instead of the styling.
 * What a reader needs from this section is which class produces which colour. */
function BubbleSection() {
  const peerHue = hueForSeed("a3f1c204-0000-4000-8000-000000000001");
  return (
    <>
      <Specimen name=".tl-bubble-right" note="ユーザのプロンプト。右寄せ・緑系">
        <div class="catalog-bubbles">
          <div class="tl-bubble tl-bubble-right">
            <div class="tl-bubble-body">
              locator に /catalog を足したい。既存の usage の分岐が近い。
            </div>
            <span class="tl-bubble-time">12:04</span>
          </div>
        </div>
      </Specimen>
      <Specimen name=".tl-bubble-assistant" note="このセッションのアシスタント応答。紫系">
        <div class="catalog-bubbles">
          <div class="tl-bubble tl-bubble-left tl-bubble-assistant">
            <div class="tl-bubble-body">parseUrl に catalog の分岐を足しました。</div>
            <span class="tl-bubble-time">12:05</span>
          </div>
        </div>
      </Specimen>
      <Specimen name=".tl-bubble-peer" note="別セッション発の ccmsg メッセージ。青系">
        <div class="catalog-bubbles">
          <div
            class="tl-bubble tl-bubble-left tl-bubble-peer"
            style={{ "--member-hue": String(peerHue) }}
          >
            <div class="tl-bubble-body">
              <div class="tl-bubble-from">
                <Avatar seed="a3f1c204-0000-4000-8000-000000000001" size={16} />
                claude-ccmsg/main
              </div>
              テストが通ったので確認をお願いします。
            </div>
            <span class="tl-bubble-time">12:07</span>
          </div>
        </div>
      </Specimen>
      <Specimen name=".tl-bubble-agent" note="サブエージェントとの通信カード。破線トーン">
        <div class="catalog-bubbles">
          <div
            class="tl-bubble tl-bubble-left tl-bubble-peer tl-bubble-agent tl-bubble-agent-out"
            style={{ "--member-hue": String(hueForSeed("agent:w2-catalog")) }}
          >
            <div class="tl-bubble-body">
              <div class="tl-bubble-from tl-agent-card-head">
                <span class="tl-agent-direction-marker">▸</span>
                w2-catalog
                <span class="tl-agent-badge">Task</span>
              </div>
              <div class="tl-agent-title">/catalog ルート実装</div>
              <div class="tl-agent-md">カタログのセクション構成をまとめました。</div>
            </div>
          </div>
        </div>
      </Specimen>
    </>
  );
}

function FileIconSection() {
  return (
    <Specimen name="<FileTypeIcon kind />">
      <ul class="catalog-icons">
        {FILE_ICON_KINDS.map((kind) => (
          <li class="catalog-icon-cell" key={kind}>
            <FileTypeIcon kind={kind} />
            <code class="catalog-caption">{kind}</code>
          </li>
        ))}
      </ul>
    </Specimen>
  );
}

/** `.viewer-preview` ごと借りるのは、プレビューの組版が容器側のクラスにも
 * 乗っているため — `.md` だけを裸で置くと、実画面と違うものを見本と呼ぶことに
 * なる。容器のスクロールと末尾余白だけを `.catalog-md-stage` で外す。 */
function MarkdownSection() {
  return (
    <>
      <Specimen name=".viewer-preview .md" note="ファイルプレビューの本文組版">
        <div class="viewer-preview catalog-md-stage">
          <MarkdownView source={MARKDOWN_SAMPLE} />
        </div>
      </Specimen>
      {/* 同じ markdown を容器なしで置くと、Timeline の密度がそのまま出る。
       * 2 つを並べて初めて「同じ比 / 違う値」という関係が見える。 */}
      <Specimen name=".md" note="Timeline の吹き出しの中。同じ規則を詰めた値で">
        <div class="tl-bubble tl-bubble-left tl-bubble-assistant">
          <div class="tl-bubble-body">
            <MarkdownView source={MARKDOWN_BUBBLE_SAMPLE} />
          </div>
          <span class="tl-bubble-time">12:05</span>
        </div>
      </Specimen>
    </>
  );
}

function CodeSection() {
  return (
    <>
      <Specimen name="<CodeBlock code lang />" note="lang を渡すと Shiki が着色する">
        <CodeBlock code={CODE_SAMPLE} lang="ts" />
      </Specimen>
      <Specimen name="lang={null}" note="言語不明。プレーンのまま">
        <CodeBlock code={CODE_SAMPLE} lang={null} />
      </Specimen>
    </>
  );
}

/** The form vocabulary is `session-creator-*` — there is no generic field
 * component yet, so these classes *are* the form styling for the whole UI.
 * Showing them here is what makes that visible. */
function FormSection() {
  return (
    <Specimen name=".session-creator-field" note="ラベル + 入力の 1 組">
      <div class="session-creator-form">
        <label class="session-creator-field">
          <span class="session-creator-label">template</span>
          <select>
            <option>plain</option>
            <option>worker</option>
          </select>
        </label>
        <label class="session-creator-field">
          <span class="session-creator-label">resume_sid</span>
          <input type="text" placeholder="a3f1c204" />
        </label>
        <label class="session-creator-field">
          <span class="session-creator-label">prompt</span>
          <textarea class="session-creator-prompt" rows={3}>
            カタログの表示を確認する
          </textarea>
          <span class="session-creator-hint">空にすると既定のプロンプトを使う。</span>
        </label>
        <div class="catalog-row">
          <button type="button">起動</button>
          <button type="button" disabled>
            起動中…
          </button>
        </div>
        <p class="session-creator-error">起動できません: cwd が見つかりません。</p>
      </div>
    </Specimen>
  );
}

function ErrorSection() {
  return (
    <>
      <Specimen name='<ErrorView mark="404" />' note="住所が何も指していない">
        <ErrorView
          mark="404"
          title="このセッションはありません"
          detail="a3f1c204-0000-4000-8000-000000000001"
          hint="終了・削除された可能性があります。左の一覧から選び直してください。"
          action={{ label: "トップに戻る", href: "/" }}
        />
      </Specimen>
      <Specimen name='mark="403"' note="読む権限が無い">
        <ErrorView
          mark="403"
          title="このパスは読めません"
          detail="/etc/shadow"
          hint="セッションの repo_root の外にあります。"
        />
      </Specimen>
      <Specimen name='tone="danger"' note="読み込み自体が壊れた。fill で画面全体を占める版もある">
        <ErrorView
          mark="!"
          tone="danger"
          title="トランスクリプトを読み込めません"
          detail="ENOENT: no such file or directory"
        />
      </Specimen>
    </>
  );
}

const SECTION_BODIES: Record<string, () => ComponentChildren> = {
  color: ColorSection,
  space: SpaceSection,
  type: TypeSection,
  avatar: AvatarSection,
  chip: ChipSection,
  fold: FoldSection,
  tabs: TabsSection,
  status: StatusSection,
  badge: BadgeSection,
  bubble: BubbleSection,
  file: FileIconSection,
  markdown: MarkdownSection,
  "md-all": MdAllSection,
  "md-color": MdColorSection,
  code: CodeSection,
  form: FormSection,
  error: ErrorSection,
};

export function CatalogView() {
  return (
    <main id="catalog-view">
      <header class="catalog-head">
        <h2 class="catalog-title">コンポーネントカタログ</h2>
        <p class="catalog-lead">
          webui の共有部品を、実際のスタイルシートで状態ごとに並べた見本帳。daemon
          からは何も読まないので、データが壊れている画面の切り分けにも使える。
        </p>
        <nav class="catalog-index" aria-label="セクション">
          {SECTIONS.map((section) => (
            <a class="catalog-index-link" href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
        </nav>
      </header>
      {SECTIONS.map((section) => {
        const Body = SECTION_BODIES[section.id];
        return (
          <Section def={section} key={section.id}>
            {Body ? <Body /> : null}
          </Section>
        );
      })}
    </main>
  );
}
