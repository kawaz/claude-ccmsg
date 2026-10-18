// ccmsg 経由のメッセージのバブル (本文の遅延取得を含む)。
import { useContext, useEffect, useState } from "preact/hooks";
import { type PeerInfo } from "@ccmsg/protocol";
import { type RoomState, ADMIN_ID } from "../../store.ts";
import { useApp } from "../../context.ts";
import { setBounded } from "../../bounded-map.ts";
import { Avatar, UserAvatar } from "../../avatar.tsx";
import { formatClockTime, formatMsgTime, memberLabel } from "../../utils.ts";
import { bubbleHue, filePathCtxForSender, MemberAvatar } from "../TimelineItem.tsx";
import {
  ccmsgUnitKey,
  type CcmsgMessage,
  type Segment,
  type TurnLine,
} from "../../transcript-model.ts";
import { LinkedMarkdownView } from "../../filepath-linker.tsx";
import { Tabs } from "../Tabs.tsx";
import { type TLSearchCtx } from "./useInViewSearch.ts";
import { CcmsgRenderContext, useCategoryOpen } from "./context.ts";
import { ItemRawToggle } from "./raw.tsx";
import { FoldGuide, NOOP_REGISTER_REF, NOOP_ON_CLICK } from "./folds.tsx";

/** fold group 内で peer 発 ccmsg messages を描画する (r55 m14 kawaz 裁定)。
 * CcmsgBubble を再利用するため、boundary 側 (Timeline() 直下) と同じ props
 * を組み立てる。共有状態 (now / rooms / peers / visibleCcmsgKeys) は
 * CcmsgRenderContext から取る。どのバブルを出すかは `ccmsgRenderTargets` が
 * 分類フェーズで確定済み — ここは key の在否を読むだけ (render 中に dedup
 * 状態を書き換えない: fold の開閉は Timeline 本体を再実行しないため、
 * render 中の mutation では 2 回目以降の pass で自分を消してしまう)。
 * u1 発は含まれない前提 (classifyBoundaryLine で boundary に格上げされて
 * いる) — 万一混じっても同じ key 集合で dedup される。 */
export function PeerCcmsgLineView({
  line,
  offset,
  messages,
  searchCtx,
}: {
  line: TurnLine;
  offset: number;
  messages: CcmsgMessage[];
  searchCtx: TLSearchCtx | undefined;
}) {
  const ctx = useContext(CcmsgRenderContext);
  if (ctx === null) {
    // 供給元 (Timeline) の Provider 外で呼ばれた場合の防御 — 実運用では
    // ここに来ない (Timeline は常に Provider を張るため)。
    return null;
  }
  // raw タブ用: boundary 側と同ロジック (text segment 結合)。
  const rawText = line.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
  return (
    <>
      {messages.map((m, j) => {
        if (!ctx.visibleCcmsgKeys.has(ccmsgUnitKey(offset, j))) return null;
        return (
          // 1 行から複数バブルが出るケース: どのバブルの jsonl トグルも同じ
          // 行を指す (itemRawSourceOffsets の doc comment 参照)。
          <ItemRawToggle key={`${offset}-${j}`} offset={offset}>
            <CcmsgBubble
              message={m}
              rawText={rawText}
              now={ctx.now}
              searchKey={ccmsgUnitKey(offset, j)}
              searchCtx={searchCtx}
              // navKey/register/onUserTurnClick/selected は u1 (右寄せ user
              // bubble) 用の user-nav 配線。peer 発では未使用なので undefined /
              // false 固定 (userNavTargets 側も message.from !== "u1" を弾く
              // ためここに来る対象は元々 nav 対象外)。
              registerUserTurnRef={NOOP_REGISTER_REF}
              onUserTurnClick={NOOP_ON_CLICK}
              selected={false}
              room={ctx.rooms.get(m.room)}
              peers={ctx.peers}
            />
          </ItemRawToggle>
        );
      })}
    </>
  );
}

// DR-0027 §2 (Phase 1 lazy read cache): the daemon holds the canonical full
// message body in rooms/*.jsonl — transcript-model.ts's extraction only
// promises (room, mid, from, ts) + a best-effort recovered body (a truncated
// fragment's partial text, or the full text if it fit under the harness's
// notification size cap). CcmsgBubble looks the canonical body up with
// `ws.read(room, [mid])` on mount and swaps it in, so a "…(切り詰め)"
// fallback gets replaced by the real full text and a tool_result-detected
// send (Phase 2, from/msg initially empty) fills in from what the daemon
// actually stored.
//
// Cache lives at module scope, not store, per DR-0027's "実物の流儀で判断"
// bracket: this is a read-through of a daemon-owned canonical, not app
// state — reducers have nothing to touch. Values transition
// Promise<CcmsgReadBody | null> → CcmsgReadBody (success) or "failed" (room
// gone / daemon error / msg not found). A "failed" entry is retried on the
// next mount of a bubble for that key (the daemon might have come back) but
// still renders as a distinct failure state in between — a tool_result
// placeholder has no recovered body to fall back on, so the bubble must be
// able to say "couldn't fetch" instead of rendering blank. Keyed
// `${room}|m${mid}` (same shape as ccmsgDedupKey's canonical form) so the
// same key space is used for dedup and for look-up.
interface CcmsgReadBody {
  from: string;
  to?: readonly string[];
  msg: string;
  ts: string;
}
type CcmsgBodyCacheEntry = CcmsgReadBody | Promise<CcmsgReadBody | null> | "failed";
const CCMSG_BODY_CACHE = new Map<string, CcmsgBodyCacheEntry>();

/** 保持する (room, mid) 数の上限。1 セッションで開く transcript が増えるほど
 * 別々の key が積み上がり、値は msg 本文なので 1 件が小さいとも限らない。
 * 溢れた key は「まだ fetch していない」状態に戻るだけで、次にその bubble が
 * mount された時に read し直される (= "failed" と同じ復帰経路)。 */
const CCMSG_BODY_CACHE_MAX_ENTRIES = 256;

function setCcmsgBody(key: string, entry: CcmsgBodyCacheEntry): void {
  setBounded(CCMSG_BODY_CACHE, key, entry, CCMSG_BODY_CACHE_MAX_ENTRIES);
}

function ccmsgBodyCacheKey(room: string, mid: number): string {
  return `${room}|m${mid}`;
}

/** Kicks off a `ws.read(room, [mid])` on first mount for this (room, mid)
 * and returns the resolved body once available; `"failed"` once a read
 * settled without a body (room gone, daemon error, msg not stored) so
 * CcmsgBubble can render an explicit couldn't-fetch note for a tool_result
 * placeholder that has no recovered body of its own; undefined while
 * nothing has settled yet. A `"failed"` entry is retried on the next mount
 * (tab switch back, page section re-open — the daemon might have come
 * back) but not within the current one, so a dead room costs one read per
 * mount, not a render-loop of them. CcmsgBubble treats undefined as "use
 * the placeholder / recovered body from the extraction" so the bubble is
 * never blank — the swap is strictly an upgrade, never a downgrade. */
function useCcmsgBody(room: string, mid: number | undefined): CcmsgReadBody | "failed" | undefined {
  const { ws } = useApp();
  const [, force] = useState(0);
  useEffect(() => {
    if (mid === undefined) return;
    const key = ccmsgBodyCacheKey(room, mid);
    const cached = CCMSG_BODY_CACHE.get(key);
    // A resolved body never changes (daemon msgs are append-only), so it
    // needs no re-fetch. "failed" falls through to retry on this fresh mount.
    if (cached !== undefined && cached !== "failed" && !(cached instanceof Promise)) return;
    // If a Promise is already in flight for this key, subscribe to it —
    // multiple bubbles for the same (room, mid) (e.g. a tool_result send
    // + its subscribe teammate-message echo before dedup) share one read.
    let cancelled = false;
    const onSettle = () => {
      if (!cancelled) force((n) => n + 1);
    };
    if (cached instanceof Promise) {
      void cached.then(onSettle);
      return () => {
        cancelled = true;
      };
    }
    const p = ws
      .read(room, [mid])
      .then((resp) => {
        const m = resp.ok ? resp.msgs[0] : undefined;
        if (m === undefined) {
          setCcmsgBody(key, "failed");
          return null;
        }
        const body: CcmsgReadBody = {
          from: m.from,
          ...(m.to ? { to: m.to } : {}),
          msg: m.msg,
          ts: m.ts,
        };
        setCcmsgBody(key, body);
        return body;
      })
      .catch(() => {
        setCcmsgBody(key, "failed");
        return null;
      });
    setCcmsgBody(key, p);
    void p.then(onSettle);
    return () => {
      cancelled = true;
    };
  }, [room, mid, ws]);
  if (mid === undefined) return undefined;
  const c = CCMSG_BODY_CACHE.get(ccmsgBodyCacheKey(room, mid));
  return c !== undefined && !(c instanceof Promise) ? c : undefined;
}

// ccmsg メッセージ吹き出し (kawaz spec): msg/raw 切替は thinking の
// original|ja タブと同じ UI 流儀 (下タブボタン列)。raw は抽出元行の生
// テキスト全文 (extractCcmsgMessages が読んだのと同じ text segment 結合、
// 複数 msg が同じ行から来た場合は全吹き出しで同じ raw を共有する — 各
// メッセージ個別の断片ではなく「この行に何が書いてあったか」を見るためのタブ
// なので、行単位で共通の全文がふさわしい)。
//
// from:u1 (ADMIN_ID) は本物のユーザ発話と同じ「右寄せ + user 吹き出し
// 色」で表示する (kawaz r15 mid=6、2026-07-14)。RoomView TimelineItem
// の .msg-user と同じ意味論を transcript 側に横展開する形。それ以外
// (agent 発 ccmsg msg) は従来通り .tl-bubble-left .tl-bubble-peer (青系)。
export function CcmsgBubble({
  message,
  rawText,
  now,
  searchKey,
  searchCtx,
  navKey,
  registerUserTurnRef,
  onUserTurnClick,
  selected,
  room,
  peers,
}: {
  message: CcmsgMessage;
  rawText: string;
  now: number;
  navKey?: string;
  registerUserTurnRef: (key: string, el: HTMLElement | null) => void;
  onUserTurnClick: (navKey: string) => void;
  selected: boolean;
  // In-view search (DR-0022 §3, extended by kawaz r26 mid=97's 💬 target
  // toggle): undefined whenever the ccmsg target toggle is off, mirroring
  // SegmentView's searchCtx={undefined} convention for out-of-scope units —
  // only message.msg (the "msg" tab) is searchable, the raw fallback tab
  // stays unhighlighted like every other raw fallback in the Timeline.
  searchKey: string;
  searchCtx: TLSearchCtx | undefined;
  /** ROOM チャットの MsgItem と同じ rich 表示 (identicon / memberLabel /
   * hue カラー / filepath-linker) をするための解決元。`message.room` の
   * RoomState は AppState.rooms 由来で、まだ届いていない (subscribe 前 /
   * 破棄済み) 場合は undefined — その時は id そのままの from 表記に
   * degrade する (アイコン非表示・memberLabel は id 返し・hue は from
   * id 自体を seed に fallback、これは ROOM 側 MsgItem と同じ挙動)。 */
  room: RoomState | undefined;
  peers: readonly PeerInfo[];
}) {
  const [tab, setTab] = useState<"msg" | "raw">("msg");
  // peer 側 bubble は thinking と同じ fold パターンに乗せる (kawaz r55 m10)。
  // auto-open は独立軸 "ccmsg" (C トグル、kawaz r55 m11) で制御 — TL 既定は
  // C=on (自 TL に届く peer ccmsg は主要文脈)、agent TL は C=off (peer 会話
  // よりも agent 通信/items を主にする defaultTimelineAutoOpen 参照)。
  const [foldOpen, setFoldOpen] = useCategoryOpen("ccmsg");
  // DR-0027 §2 Phase 1 lazy read: daemon-canonical body if known, otherwise
  // the placeholder / recovered body from the extraction. Fields fall back
  // individually (not all-or-nothing) so a tool_result-detected send (from
  // empty, ts = transcript ts) still shows the correct from as soon as read
  // resolves without waiting for msg. A settled-but-failed read (room gone /
  // msg not stored) keeps every recovered field and only replaces a body we
  // have nothing for with an explicit couldn't-fetch note — a bubble must
  // never render blank (DR-0027 §2.1's フォールバック requirement).
  const lookup = useCcmsgBody(message.room, message.mid);
  const body = lookup === "failed" ? undefined : lookup;
  const from = body?.from || message.from;
  const to = body?.to ?? message.to;
  const msgBody =
    body?.msg ||
    message.msg ||
    (lookup === "failed" ? `(本文を取得できません — #${message.room} は消えた可能性)` : "");
  const ts = body?.ts || message.ts;
  const isUser = from === ADMIN_ID;
  const direct = message.direct;
  // バルーン配色は ROOM 側 MsgItem と同一の bubbleHue (room 基準色 + room 内
  // member の nth 等分割、kawaz r55m54/m56)。同じ room の同じ発言者なら ROOM /
  // TL で同色になる。room 未解決なら undefined = 無彩色 degrade。
  const hue = isUser ? undefined : bubbleHue(room, from || message.from);
  // filePathCtxForSender は ROOM 側と同じ helper。room が未解決な場面では
  // undefined を返し LinkedMarkdownView が MarkdownView に degrade する
  // (プレーン表示、既存挙動と同じ)。
  const filePathCtx = room ? filePathCtxForSender(room, peers, from) : undefined;
  const isMatch = searchCtx !== undefined && searchCtx.words.length > 0;
  const innerBubble = (
    <div
      class={`${
        isUser
          ? "tl-bubble tl-bubble-right tl-bubble-ccmsg-user"
          : "tl-bubble tl-bubble-left tl-bubble-peer tl-bubble-ccmsg-peer"
      }${selected ? " tl-bubble-user-nav-selected" : ""}`}
      style={hue !== undefined ? { "--member-hue": String(hue) } : undefined}
      ref={
        isUser
          ? (el) => {
              if (navKey !== undefined) registerUserTurnRef(navKey, el);
            }
          : undefined
      }
      onClick={isUser && navKey !== undefined ? () => onUserTurnClick(navKey) : undefined}
    >
      <div class="tl-bubble-body">
        <div class="tl-bubble-from">
          {isUser ? (
            <>
              <UserAvatar size={16} />
              {memberLabel(ADMIN_ID, room)}
            </>
          ) : direct ? (
            <DirectSenderLabel from={from} direct={direct} peers={peers} />
          ) : from ? (
            <>
              <MemberAvatar id={from} room={room} />
              {memberLabel(from, room)}
            </>
          ) : (
            "…"
          )}
          {(() => {
            // u1 (ADMIN_ID) は always-exempt 配信済みなので mention 表示から
            // 除外 (TimelineItem 側と同ポリシー、kawaz 2026-07-20)。
            const shown = to?.filter((id) => id !== ADMIN_ID) ?? [];
            if (!shown.length) return null;
            return (
              <span class="msg-to">
                {" → "}
                {shown.map((id, i) => (
                  // ROOM 側 MsgItem と同構造の (avatar + name) ペア。id 重複が
                  // あっても衝突しないよう `${id}-${i}` を key に混ぜる。
                  <span key={`${id}-${i}`} class="msg-to-item">
                    {i > 0 ? ", " : null}
                    {direct ? (
                      <DirectSessionLabel sid={id} peers={peers} />
                    ) : (
                      <>
                        <MemberAvatar id={id} room={room} />
                        {memberLabel(id, room)}
                      </>
                    )}
                  </span>
                ))}
              </span>
            );
          })()}
          {direct ? (
            <span class="tl-ccmsg-direct-id">
              {direct.direction === "in"
                ? ` · ${direct.id}`
                : ` · ${direct.verb}${direct.replyTo ? ` ${direct.replyTo}` : ""}`}
            </span>
          ) : (
            <>
              {" · #"}
              {message.room}
              {message.mid === undefined ? null : `m${message.mid}`}
            </>
          )}
        </div>
        <Tabs
          class="tl-thinking-tabs"
          tabClass="tl-thinking-tab"
          label="ccmsg メッセージの表示"
          selected={tab}
          onSelect={setTab}
          items={[
            { id: "msg", label: "msg" },
            { id: "raw", label: "raw" },
          ]}
        />
        {tab === "msg" ? (
          // tl-ccmsg-msg: chat 様式の本文なので単一改行を行分けとして見せる
          // (CSS の white-space: pre-wrap、kawaz r17 mid=13)。markdown AST は
          // 段落内の改行を text node "\n" のまま保持しており、素の <p> では
          // 空白に潰れる。文書様式が前提の assistant markdown には波及させない
          // (ソフト折り返しを空白扱いする通常の markdown 表示のまま)。
          <div class="tl-ccmsg-msg">
            <LinkedMarkdownView source={msgBody} ctx={filePathCtx} restricted={isUser} />
          </div>
        ) : (
          <pre class="tl-fold-body">{direct?.direction === "out" ? direct.command : rawText}</pre>
        )}
        {direct?.direction === "out" && direct.status === "failed" ? (
          <p class="tl-say-error">送信失敗: {direct.error}</p>
        ) : null}
        {direct?.direction === "out" && direct.status === "unconfirmed" ? (
          <p class="tl-say-error">届いたか未確認: {direct.error}</p>
        ) : null}
      </div>
      <span class="tl-bubble-time">{formatMsgTime(ts, now)}</span>
    </div>
  );
  // u1 (自分の発話) は主役側なので従来通り右寄せ吹き出しをそのまま。
  // peer は thinking と同じ fold パターン (details + summary + tl-guided) で
  // 包み、閉時は identicon + 名前 + #room + preview の 1 行、開時は既存の
  // rich 表示 (hue / タブ / LinkedMarkdownView) を保つ。fold 自体の
  // 左インデント・フォントサイズは CSS 側 (.tl-ccmsg-fold / .tl-ccmsg-body)
  // で thinking と揃える。
  const bubble = isUser ? (
    innerBubble
  ) : (
    <details
      class={`tl-fold tl-ccmsg-fold${selected ? " tl-bubble-user-nav-selected" : ""}`}
      open={foldOpen}
      onToggle={(e) => setFoldOpen(e.currentTarget.open)}
      ref={(el) => {
        if (navKey !== undefined) registerUserTurnRef(navKey, el);
      }}
      onClick={navKey === undefined ? undefined : () => onUserTurnClick(navKey)}
    >
      {/* kawaz r55 m14: 閉時サマリは thinking/agent の `▶ HH:MM:SS <kind>`
       * と同トーンの控えめ 1 行 (identicon + 名前 + #room[m<mid>] + preview
       * を tl-summary-decoration の小さいチップにまとめる)、開時は装飾を
       * 落として時刻 + `ccmsg` ラベルだけ (rich な hue バブルは本文側に出る)。
       * FoldSummary を直接使わないのは MemberAvatar/memberLabel が room 依存
       * のため — decoration を context 化するより summary を局所組立する方が
       * 素直。 */}
      {foldOpen ? (
        <summary>
          {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
          <span class="tl-fold-label">ccmsg</span>
        </summary>
      ) : (
        <summary class="tl-decorated-summary tl-ccmsg-summary">
          {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
          {/* agent decoration (`peer-message ← name`) と同じ寸法感の控えめな
           * 1 行 (kawaz r55 m14): `ccmsg ← <avatar> <name>`。#room / preview
           * のような詳細は展開後の rich バブル本体に寄せる — 閉サマリで hue 枠
           * カードを出さない (「ウザい/デカい」対処)。 */}
          <span class="tl-fold-label tl-summary-decoration tl-ccmsg-summary-body">
            <span>ccmsg</span>
            {direct?.direction === "out" ? (
              <span class="tl-direction-badge tl-direction-outbound">→</span>
            ) : (
              <span class="tl-direction-badge tl-direction-inbound">←</span>
            )}
            {direct ? (
              <strong class="tl-ccmsg-summary-name">
                <DirectSenderLabel from={from} direct={direct} peers={peers} />
              </strong>
            ) : (
              <>
                {from ? <MemberAvatar id={from} room={room} /> : null}
                <strong class="tl-ccmsg-summary-name">
                  {from ? memberLabel(from, room) : "…"}
                </strong>
              </>
            )}
          </span>
        </summary>
      )}
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-ccmsg-body">{innerBubble}</div>
      </div>
    </details>
  );
  if (!isMatch || !searchCtx) return bubble;
  return (
    <div
      class="tl-search-unit"
      data-search-key={searchKey}
      ref={(el) => searchCtx.registerRef(searchKey, el)}
    >
      {bubble}
    </div>
  );
}

/** A session named by its sid in a standalone-ccmsg bubble: the connected
 * peer's repo/ws label when the web UI knows it, the short sid otherwise. */
function DirectSessionLabel({ sid, peers }: { sid: string; peers: readonly PeerInfo[] }) {
  if (sid === ADMIN_ID) return <>{memberLabel(ADMIN_ID, undefined)}</>;
  const peer = peers.find((p) => p.sid === sid);
  const repo = peer?.repo ? peer.repo.split("/").filter(Boolean).pop() : undefined;
  return (
    <>
      <Avatar seed={sid} size={16} />
      {repo ? (peer?.ws ? `${repo}/${peer.ws}` : repo) : sid.slice(0, 8)}
    </>
  );
}

/** Sender half of a standalone-ccmsg bubble header: this session for its own
 * sends, the delivering session (or the person) for received ones. */
function DirectSenderLabel({
  from,
  direct,
  peers,
}: {
  from: string;
  direct: NonNullable<CcmsgMessage["direct"]>;
  peers: readonly PeerInfo[];
}) {
  if (direct.direction === "out") return <>このセッション</>;
  return <DirectSessionLabel sid={from} peers={peers} />;
}
