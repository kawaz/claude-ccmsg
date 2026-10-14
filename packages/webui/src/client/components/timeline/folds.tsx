// tools folding の fold group と、その中の 1 行 (LineView)。
import { memo } from "preact/compat";
import { useContext, useMemo } from "preact/hooks";
import { formatClockTime } from "../../utils.ts";
import {
  agentCommunicationCount,
  CACHE_KEEPALIVE_FOLD_LABEL,
  ccmsgMessageCount,
  extractCcmsgMessages,
  foldGroupLabel,
  foldGroupNeedsOuterFold,
  isCacheKeepaliveReplyLine,
  isUserSpeechKind,
  segmentSearchText,
  isDirectFoldEntry,
  type ParsedLine,
  type TimelineEntry,
} from "../../transcript-model.ts";
import { foldGroupKey } from "../../fold-tree.ts";
import { foldSummaryView, type FoldSummaryDecoration } from "../../timeline-summary.ts";
import { foldGroupShouldAutoOpen } from "../../timeline-auto-open.ts";
import { type TLSearchCtx } from "./useInViewSearch.ts";
import { TimelineAutoOpenContext, useFoldOpen } from "./context.ts";
import { ItemRawToggle } from "./raw.tsx";
import { AttachmentFileView } from "./tools.tsx";
import { AgentIdentity } from "./agents.tsx";
import { type TranslationAvailability } from "./translation.ts";
import { SegmentView } from "./segments.tsx";
import { SystemMessageFold } from "./system-messages.tsx";
import { PeerCcmsgLineView } from "./ccmsg.tsx";

// 表示形式の統一 (kawaz spec 2026-07-12): fold 対象アイテム (thinking/
// tool_use/tool_result/meta 行/システム由来 user メッセージ) は全て同一の
// 「▶ HH:MM:SS ラベル」1 行 summary + <details> 展開に統一する — 以前は meta
// 行だけこの形、tool_use/tool_result は「時刻の行」+「▶ ラベルの行」の 2 行、
// システム由来 user メッセージは fold すらされず時刻+チップ+本文全開、と
// 3 通りに割れていた (kawaz: 「時刻表示の位置や出る出ないが不規則」)。ts が
// null の行 (Segment 自体は ts を持たないので親 TurnLine の ts を渡す) は
// 時刻 span を省略して詰める。
/** 展開 fold の左端縦線ガイド (kawaz r17 mid=45,49): クリックすると最も近い
 * 祖先の <details> (= 自分が中身を描いている fold) を閉じ、summary 位置へ
 * スクロールバックする。DOM 走査 (closest) 方式なのは、この線を fold group /
 * thinking / tool_use / tool_result / meta の全展開部で
 * 使い回すため — 各コンポーネントの open state を prop で配るより、閉じる
 * 対象を「線が属する details」と構造で決める方が一貫する (details の open
 * 属性除去は onToggle 経由で各コンポーネントの state にも同期される)。 */
export function FoldGuide() {
  return (
    <button
      type="button"
      class="tl-fold-guide"
      title="この折り畳みを閉じる"
      aria-label="この折り畳みを閉じる"
      onClick={(e) => {
        const details = e.currentTarget.closest("details");
        if (!details) return;
        details.open = false;
        details.scrollIntoView({ block: "nearest" });
      }}
    />
  );
}

export function FoldSummary({
  ts,
  label,
  open = false,
  decoration,
  trailing,
}: {
  ts: string | null;
  label: string;
  open?: boolean;
  decoration?: FoldSummaryDecoration;
  /** Secondary label placed after the main one — which item of this kind the
   * fold holds (an attachment's hook name / file path). */
  trailing?: string | null;
}) {
  const view = foldSummaryView(label, open, decoration);
  return (
    <summary
      class={
        view.decoration ? `tl-decorated-summary tl-${view.decoration.kind}-summary` : undefined
      }
    >
      {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
      {view.decoration?.kind === "thinking" ? (
        <span class="tl-fold-label tl-summary-decoration">thinking</span>
      ) : view.decoration?.kind === "agent" ? (
        // agent-communication 3 タイプ (SendMessage / peer-message / Agent
        // spawn) は同型の閉サマリを持つ (kawaz r46m15): 「prefix + 方向 badge
        // + identicon + 名前」。TL リンクや model chip は閉サマリには出さない。
        <span class="tl-fold-label tl-summary-decoration">
          <span>{view.decoration.prefix}</span>
          {view.decoration.direction ? (
            <span class={`tl-direction-badge tl-direction-${view.decoration.direction}`}>
              {view.decoration.direction === "outbound" ? "→" : "←"}
            </span>
          ) : null}
          <AgentIdentity name={view.decoration.name} />
        </span>
      ) : view.decoration?.kind === "bash" || view.decoration?.kind === "task-notification" ? (
        <span class="tl-fold-label tl-summary-decoration">{view.label}</span>
      ) : (
        <span class="tl-fold-label">{view.label}</span>
      )}
      {trailing ? <span class="tl-fold-trailing">{trailing}</span> : null}
    </summary>
  );
}

export const NOOP_REGISTER_REF = (_key: string, _el: HTMLElement | null) => {};
export const NOOP_ON_CLICK = (_navKey: string) => {};

// fold group 内 (非境界) の 1 entry を描画する — thinking/tool_use-only の
// assistant turn、tool-result-only の user turn、meta 行、broken 行、
// そしてシステム由来 user メッセージ (ccmsg メッセージを含まないもの、含む
// 場合は u1 発なら境界として CcmsgBubble 側、peer 発なら本関数内
// PeerCcmsgLineView 経由で CcmsgBubble を直接描画) を扱う。u1 発本物の
// ユーザ発話 / アシスタント最終応答 / u1 発 ccmsg は Timeline() 側の
// UserPromptBubble/AssistantBubble/CcmsgBubble が担当するため、
// registerUserTurnRef はここでは不要 (fold group 内に isUserTextTurn な行は
// 絶対に来ない — classifyBoundaryLine が boundary として弾くため、u1 発
// ccmsg も同様)。
function LineView({
  line,
  offset,
  translationAvailability,
  foldGroupOpen,
  searchCtx,
}: {
  line: ParsedLine;
  // このエントリの byte offset — search unit key (`${offset}-${segIndex}`)
  // の組み立てに使う (DR-0022 §3)。
  offset: number;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
  searchCtx: TLSearchCtx | undefined;
}) {
  if (line.kind === "broken") {
    // 読めなかった行 (JSON でない、または既知の種類で形が違う行) であることと
    // その理由を閉じたまま示し、行そのものは開いて生の文字列で見る。
    return (
      <ItemRawToggle offset={offset}>
        <details class="tl-line tl-fold tl-broken">
          <FoldSummary ts={null} label="読めなかった行" trailing={line.error} />
          <pre class="tl-broken-raw">{line.raw || "(空行)"}</pre>
        </details>
      </ItemRawToggle>
    );
  }
  if (line.kind === "meta") {
    // attachment 行だけは共通 chrome (`attachment <type>`) + type 別詳細を出す
    // — 種類が多く、閉じたままでは全部が同じ「attachment」に見えるため。詳細を
    // 持たない type は従来どおり raw JSON だけになる。
    const attachment = line.attachment;
    return (
      <ItemRawToggle offset={offset}>
        <details class="tl-line tl-fold">
          <FoldSummary
            ts={line.ts}
            label={attachment ? `attachment ${attachment.type}` : line.summary}
            trailing={attachment?.trailing}
          />
          {attachment && attachment.fields.length > 0 ? (
            <dl class="tl-sysmsg-dl">
              {attachment.fields.map((f) => (
                <div class="tl-sysmsg-field" key={f.name}>
                  <dt>{f.name}</dt>
                  <dd class={f.name === "event" ? "tl-sysmsg-mono" : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {attachment?.file ? <AttachmentFileView file={attachment.file} /> : null}
          <pre class="tl-fold-body">{line.raw}</pre>
        </details>
      </ItemRawToggle>
    );
  }
  // r55 m14 (peer ccmsg を fold group 内で thinking/agent と同格に): この
  // line が peer 発 (u1 以外) の ccmsg messages を運んでいるなら、SystemMessageFold
  // に落とさず CcmsgBubble を直接描画する — boundary 側と同じ吹き出し UI に
  // 揃え、閉時は thinking/agent と同トーンの 1 行 summary が出る。u1 発を含む
  // 行は classifyBoundaryLine が boundary に格上げして Timeline トップで
  // 処理するのでここには来ない (groupTimelineLines の isBoundaryLine 経由)。
  const peerCcmsgMessages = extractCcmsgMessages(line);
  if (peerCcmsgMessages.length > 0) {
    return (
      <PeerCcmsgLineView
        line={line}
        offset={offset}
        messages={peerCcmsgMessages}
        searchCtx={searchCtx}
      />
    );
  }
  // システム由来の "type:user" メッセージ分類 (U2 kawaz spec,
  // transcript-model.ts's classifyUserMessage): role:"user" かつ
  // "user-prompt" (= 本物のユーザ発話) 以外の kind が付いているラインは
  // 表示形式統一タスクで details 化 (以前は常時全文表示だった —
  // kawaz: 「task-notification が fold されてない」)。summary は
  // 「▶ HH:MM:SS <kind>」形式 (kind をそのままラベルに)。本文は
  // SystemMessageBody の rich|raw タブに委譲 (U2 リッチ表示タスク)。
  const sysKind =
    line.role === "user" && line.userMessageKind && !isUserSpeechKind(line.userMessageKind)
      ? line.userMessageKind
      : null;
  if (sysKind) {
    return (
      <ItemRawToggle offset={offset}>
        <SystemMessageFold
          kind={sysKind}
          line={line}
          translationAvailability={translationAvailability}
          foldGroupOpen={foldGroupOpen}
        />
      </ItemRawToggle>
    );
  }
  // cache-keepalive 応答 (kawaz r259 m60): text segment 1 個だけの assistant
  // turn なので、下の既定経路では SegmentView の text 分岐に落ちてトークンの
  // 生文字列が ▶ も時刻もラベルも無しで裸で並ぶ — 同じ fold 内の
  // task-notification / queue-operation 行と揃わない。システム由来 user
  // メッセージ (SystemMessageFold) と同じ「▶ 時刻 ラベル」の 1 行に畳み、
  // 中身はトークンそのものを開いてから見せる。
  if (isCacheKeepaliveReplyLine(line)) {
    return (
      <ItemRawToggle offset={offset}>
        <details class="tl-line tl-fold">
          <FoldSummary ts={line.ts} label={CACHE_KEEPALIVE_FOLD_LABEL} />
          <pre class="tl-fold-body">{segmentSearchText(line.segments[0])}</pre>
        </details>
      </ItemRawToggle>
    );
  }
  // 残り: thinking/tool_use-only の assistant turn、tool-result-only の
  // user turn — 中身の各 segment 自体が (SegmentView 経由で) fold 済みの
  // 1 行 summary を持つので、turn の外枠はプレーンな container のまま
  // (二重に時刻を出さない)。
  return (
    <ItemRawToggle offset={offset}>
      <div class="tl-line">
        <div class="tl-segments">
          {line.segments.length === 0 ? (
            <span class="tl-empty-turn">(空)</span>
          ) : (
            line.segments.map((seg, i) => (
              <SegmentView
                key={i}
                segment={seg}
                translationAvailability={translationAvailability}
                ts={line.ts}
                foldGroupOpen={foldGroupOpen}
                searchKey={`${offset}-${i}`}
                searchCtx={searchCtx}
              />
            ))
          )}
        </div>
      </div>
    </ItemRawToggle>
  );
}

// LineView and FoldGroup (each memoized right where it is
// defined) render the fold side of the timeline, which is 73-96% of every
// entry in a real transcript — and a live tail re-rendered the whole of it
// once per appended line, because Preact recurses into every child of a
// re-rendered parent whether or not its props moved. Memoizing them narrows
// the re-render to the groups that actually changed: 2360 -> 3 fold-side
// component renders per appended line, measured on a 2180-line window.
//
// This only pays off because incremental-cross-line.ts hands back the *same*
// `entries` array for an unchanged group. Two other props have to hold still
// for the same reason, and are memoized in Timeline() (Timeline.tsx) for it:
// `translationAvailability` and `searchCtx`.
const MemoLineView = memo(LineView);

// Tools folding (kawaz spec): the run of thinking/tool_use/tool_result/meta
// entries between a user prompt and the assistant's next user-facing final
// response, collapsed into one <details> — default-collapsed via the native
// <details> element itself (no manual open/close state to manage, matches
// every other tl-fold in the Timeline), label text from
// transcript-model.ts's foldGroupLabel (grouping/counting stays a pure,
// unit-tested function; this component only renders it). Open state is
// lifted into React state (rather than left fully uncontrolled) so it can be
// threaded down to each entry's ThinkingSegment as `foldGroupOpen` — the
// signal that drives the "fold を開いた時 thinking は details open + ja
// デフォルト" behavior (kawaz spec).
function FoldGroup({
  entries,
  translationAvailability,
  searchCtx,
}: {
  entries: TimelineEntry[];
  translationAvailability: TranslationAvailability;
  searchCtx: TLSearchCtx | undefined;
}) {
  const autoOpen = useContext(TimelineAutoOpenContext);
  const groupAutoOpen = foldGroupShouldAutoOpen(entries, autoOpen.settings);
  // The auto-open settings are this group's *default*; Timeline drops every
  // stored override when their revision changes, so a settings edit lands here
  // without the store having to know what any group's default is.
  const { open, mountBody, setOpen } = useFoldOpen(foldGroupKey(entries), groupAutoOpen);
  const thinkingCount = useMemo(
    () =>
      entries.filter(
        ({ line }) =>
          line.kind === "turn" &&
          line.segments.some(
            (segment) => segment.kind === "thinking" || segment.kind === "thinking-hidden",
          ),
      ).length,
    [entries],
  );
  const ccmsgCount = useMemo(
    () => entries.reduce((count, entry) => count + ccmsgMessageCount(entry), 0),
    [entries],
  );
  const agentMessageCount = useMemo(
    () => entries.reduce((count, entry) => count + agentCommunicationCount(entry), 0),
    [entries],
  );
  const itemCount = useMemo(
    () => entries.filter((entry) => !isDirectFoldEntry(entry)).length,
    [entries],
  );
  // 単独の plain item は fold を作らず直接見せる (kawaz r38 mid=44)。
  if (!foldGroupNeedsOuterFold(entries)) {
    const { offset, line } = entries[0];
    return (
      <div class="tl-guided-content">
        <MemoLineView
          line={line}
          offset={offset}
          translationAvailability={translationAvailability}
          foldGroupOpen={false}
          searchCtx={searchCtx}
        />
      </div>
    );
  }
  return (
    <details
      class="tl-line tl-fold-group"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {/* summary の「N thinking」部だけ thinking と同じ装飾 (kawaz r17
       * mid=47): 展開せずとも thinking の在処 (紫破線トーン) が判る。文言は
       * foldGroupLabel (単体テスト済み) と同じ順序で、装飾のために span を
       * 分けて組み立てる。 */}
      {/* 「N agent messages」部も同様に agent カードと同じ破線トーンで囲う
       * (kawaz r38 mid=21)。 */}
      <summary>
        {thinkingCount > 0 || ccmsgCount > 0 || agentMessageCount > 0 ? (
          <>
            {thinkingCount > 0 ? (
              <span class="tl-summary-thinkings">{thinkingCount} thinking</span>
            ) : null}
            {ccmsgCount > 0 ? (
              <>
                {thinkingCount > 0 ? " + " : ""}
                <span class="tl-summary-ccmsg">{ccmsgCount} ccmsg</span>
              </>
            ) : null}
            {agentMessageCount > 0 ? (
              <>
                {thinkingCount > 0 || ccmsgCount > 0 ? " + " : ""}
                <span class="tl-summary-agent-messages">{agentMessageCount} agent messages</span>
              </>
            ) : null}
            {itemCount > 0 ? (
              <>
                {thinkingCount > 0 || ccmsgCount > 0 || agentMessageCount > 0 ? " + " : ""}
                <span class="tl-summary-items">{itemCount} items</span>
              </>
            ) : (
              ""
            )}
          </>
        ) : (
          foldGroupLabel(entries)
        )}
      </summary>
      <div class="tl-fold-group-body tl-guided">
        <FoldGuide />
        <div class="tl-guided-content">
          {mountBody
            ? entries.map(({ offset, line }) => (
                <MemoLineView
                  key={offset}
                  line={line}
                  offset={offset}
                  translationAvailability={translationAvailability}
                  foldGroupOpen={open}
                  searchCtx={searchCtx}
                />
              ))
            : null}
        </div>
      </div>
    </details>
  );
}

export const MemoFoldGroup = memo(FoldGroup);

// --- 境界行の吹き出し表示 (kawaz spec: 「timeline のユーザプロンプトと
// エージェントアウトプットは ROOM のチャットに寄せた表現にしたい」) ---
// 吹き出しになるのは 3 種のみ: 本物のユーザプロンプト (右寄せ, 緑系) /
// メインセッションのアシスタント最終応答 (左寄せ) / ccmsg メッセージを含む
// システムメッセージ (左寄せ, 第三者カラー)。見た目は ROOM チャット
// (TimelineItem.tsx の .msg 表示) の角丸・背景・メタ行構成に寄せるが、
// ROOM 側のコードそのものは参照のみで変更しない (app.css に .tl-bubble-*
// として別定義)。
