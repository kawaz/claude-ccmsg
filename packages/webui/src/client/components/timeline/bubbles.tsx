// 境界の行のバブル (ユーザの発話、assistant の最終応答、API エラー)。
import { useEffect, useRef, useState } from "preact/hooks";
import { formatClockTime } from "../../utils.ts";
import { useDismissOnOutsidePointer } from "../../useDismissOnOutsidePointer.ts";
import { type TurnLine } from "../../transcript-model.ts";
import { Tabs } from "../Tabs.tsx";
import { type TLSearchCtx } from "./useInViewSearch.ts";
import { type TranslationAvailability, useBubbleTranslationTab } from "./translation.ts";
import { BubbleFooter } from "./BubbleFooter.tsx";
import { SegmentView } from "./segments.tsx";
import { systemMessageRawText } from "./system-messages.tsx";
import { DumpFileAction } from "./actions.tsx";

export function UserPromptBubble({
  line,
  offsetKey,
  navKey,
  registerUserTurnRef,
  translationAvailability,
  now,
  searchCtx,
  onUserTurnClick,
  selected,
}: {
  line: TurnLine;
  offsetKey: number;
  navKey: string;
  // "👤 N/M" nav indicator の DOM 測定対象として登録する — 実ユーザ発話
  // (isUserTextTurn) はこの吹き出し以外の経路には現れないので、fold-inner
  // 側 (LineView) はこの登録を一切行わない。
  registerUserTurnRef: (key: string, el: HTMLElement | null) => void;
  translationAvailability: TranslationAvailability;
  now: number;
  searchCtx: TLSearchCtx | undefined;
  // 👤 nav のクリック同期 (DR-0022 §2.2 の仕様を 👤 nav にも共通化): この吹き
  // 出しをクリックすると、スクロールなしで currentUserIdx をその位置に合わせる。
  onUserTurnClick: (navKey: string) => void;
  selected: boolean;
}) {
  // 既定のタブは応答のバブルと同じ判定 (DR-0049 §8)。訳すのは text segment
  // だけで、添付などそれ以外の表示は原文のまま。
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bodyText = line.segments
    .flatMap((seg) => (seg.kind === "text" ? [seg.text] : []))
    .join("\n\n");
  const { tab, selectTab } = useBubbleTranslationTab({
    text: bodyText,
    availability: translationAvailability,
    elementRef: bubbleRef,
  });
  return (
    <div
      ref={(el) => {
        bubbleRef.current = el;
        registerUserTurnRef(navKey, el);
      }}
      class={`tl-bubble tl-bubble-right${selected ? " tl-bubble-user-nav-selected" : ""}`}
      onClick={() => onUserTurnClick(navKey)}
    >
      <div class="tl-bubble-body">
        {line.segments.length === 0 ? (
          <span class="tl-empty-turn">(空)</span>
        ) : (
          line.segments.map((seg, i) => (
            <SegmentView
              key={i}
              segment={seg}
              translationAvailability={translationAvailability}
              ts={line.ts}
              foldGroupOpen={false}
              searchKey={`${offsetKey}-${i}`}
              searchCtx={searchCtx}
              userTab={tab}
            />
          ))
        )}
      </div>
      {/* 右寄せの吹き出しは時刻を右端に置く (kawaz: 「ユーザメッセージは右に
       * あるのに時刻が左」)。 */}
      <BubbleFooter
        translation={{ availability: translationAvailability, tab, onSelect: selectTab }}
        ts={line.ts}
        now={now}
        timeAtEnd
      />
    </div>
  );
}

/** assistant バブルのハンバーガーから開く「重い操作」一式に必要なもの。
 *
 * dump は URL の選択位置 (`position`) に紐づく操作のままで、バブルの
 * ツールバーは**その置き場所**を増やすだけ (kawaz 裁定: 不可逆・重い操作は
 * 明示選択のまま、hover だけで発火させない)。ハンバーガーを開く操作自体が
 * その明示選択に当たるので、開いた項目をその場で選択位置にする。 */
export interface BubbleActions {
  sid: string;
  /** 現在の選択位置 (URL の position、無選択なら "head")。 */
  position: string;
  /** この項目を選択位置にする (選択済みなら呼ばない — toggle なので外れる)。 */
  onSelect: (uuid: string) => void;
}

function BubbleActionsMenu({ actions }: { actions: BubbleActions }) {
  return (
    // 本文クリックは項目選択のトグルなので、メニュー内の余白 / 説明文への
    // クリックがそこへ伝播すると、開いたばかりのメニューの足元 (選択位置) が
    // 外れる。メニューの中はメニューの中で完結させる。
    <div class="tl-msg-menu" onClick={(e) => e.stopPropagation()}>
      <DumpFileAction sid={actions.sid} position={actions.position} />
    </div>
  );
}

export function AssistantBubble({
  line,
  offset,
  translationAvailability,
  now,
  searchCtx,
  actions,
}: {
  line: TurnLine;
  offset: number;
  translationAvailability: TranslationAvailability;
  now: number;
  searchCtx: TLSearchCtx | undefined;
  /** 重い操作 (dump) の材料。agent TL のように選択位置を表せない
   * 文脈では undefined で、ハンバーガー自体を出さない。 */
  actions: BubbleActions | undefined;
}) {
  // 既定のタブは thinking と同じ判定 (DR-0049 §8): ja(plamo) が使えて本文に
  // 英語の段落があれば ja(plamo)、それ以外は original。本文はバブルの中の
  // text segment をつないだもの (ツールバー 1 つがその全部に効く)。
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bodyText = line.segments
    .flatMap((seg) => (seg.kind === "text" ? [seg.text] : []))
    .join("\n\n");
  const { tab, selectTab } = useBubbleTranslationTab({
    text: bodyText,
    availability: translationAvailability,
    elementRef: bubbleRef,
  });
  const [source, setSource] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // メニューは選択位置に紐づいて意味を持つので、選択が他の項目へ移ったら
  // 畳む (残すと、開いた項目でなく選択中の別の項目への操作になる)。
  const selectedHere = actions !== undefined && actions.position === line.uuid;
  useEffect(() => {
    if (menuOpen && !selectedHere) setMenuOpen(false);
  }, [menuOpen, selectedHere]);

  // メニューは本文の上に重なるオーバーレイなので、外側を触ったら畳む
  // (置きっぱなしだと下の項目が押せない)。足元の行ごと囲うことで、翻訳
  // タブ等の隣接操作では閉じない。
  const footerRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsidePointer(footerRef, menuOpen, () => setMenuOpen(false));
  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div class="tl-bubble tl-bubble-left tl-bubble-assistant" ref={bubbleRef}>
      <div class="tl-bubble-body">
        {line.segments.map((seg, i) => (
          <SegmentView
            key={i}
            segment={seg}
            translationAvailability={translationAvailability}
            ts={line.ts}
            foldGroupOpen={false}
            searchKey={`${offset}-${i}`}
            searchCtx={searchCtx}
            assistantView={{ tab, source }}
          />
        ))}
      </div>
      <BubbleFooter
        translation={{ availability: translationAvailability, tab, onSelect: selectTab }}
        ts={line.ts}
        now={now}
        open={menuOpen}
        footerRef={footerRef}
      >
        <Tabs
          class="tl-thinking-tabs"
          tabClass="tl-thinking-tab"
          label="本文の表示形式"
          selected={source ? "source" : "md"}
          onSelect={(id) => setSource(id === "source")}
          items={[
            { id: "md", label: "md", title: "markdown として表示" },
            { id: "source", label: "source", title: "markdown の原文を表示 (コピペ用)" },
          ]}
        />
        {actions === undefined ? null : (
          // ☰ とメニューを同じ包みに入れる: メニューはこの包みを基準に
          // 絶対配置され、TL のレイアウトを一切動かさない。
          <div class="tl-msg-menu-anchor">
            <button
              type="button"
              class="tl-thinking-tab tl-msg-menu-toggle"
              aria-expanded={menuOpen}
              aria-label="この項目の操作"
              title="dump"
              onClick={() => {
                const next = !menuOpen;
                // 開く操作 = この項目を dump の対象に決める明示選択。
                if (next && !selectedHere && line.uuid) actions.onSelect(line.uuid);
                setMenuOpen(next);
              }}
            >
              ☰
            </button>
            {menuOpen ? <BubbleActionsMenu actions={actions} /> : null}
          </div>
        )}
      </BubbleFooter>
    </div>
  );
}

/** Claude Code's synthesized "the turn was cut short" line
 * (`assistantMessageKind === "api-error"`, transcript-model.ts) — main-context
 * overflow, API failure, usage limit, ... It wears the wire "assistant" role,
 * so AssistantBubble would render it as the agent's own final response
 * (purple bubble, markdown), which reads as "the agent said this".
 *
 * Rendered as a danger-colored notice row rather than a chat bubble: the
 * bubble shape *is* the "someone spoke" signal in this Timeline (user green /
 * assistant purple / peer blue), so anything that isn't speech must leave it.
 * It stays a standalone boundary entry (not folded into the surrounding tools
 * group like system-origin user lines are) because it marks where a turn
 * ended — the same structural role `assistant-response` plays — and because a
 * failure that cost a whole turn shouldn't need a click to notice.
 *
 * Body text is rendered verbatim (no markdown): the wording is the upstream
 * CLI's — sometimes a raw JSON error payload — not authored prose. */
export function ApiErrorNotice({ line }: { line: TurnLine }) {
  const text = systemMessageRawText(line.segments);
  return (
    <div
      class="tl-line tl-api-error"
      title="Claude Code が報告した turn の中断 (エージェントの発話ではない)"
    >
      {line.ts ? <span class="tl-time">{formatClockTime(line.ts)}</span> : null}
      <span class="tl-api-error-label">turn interrupted</span>
      {text === "" ? (
        <span class="tl-empty-turn">(空)</span>
      ) : (
        <span class="tl-api-error-text">{text}</span>
      )}
    </div>
  );
}
