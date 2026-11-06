// agent (subagent / teammate) の起動・送信の fold とカード。
import { useContext, useRef } from "preact/hooks";
import { Avatar, hueForSeed } from "../../avatar.tsx";
import { type Segment } from "../../transcript-model.ts";
import { LinkedMarkdownView } from "../../filepath-linker.tsx";
import { agentDirectionMarker } from "../../agent-communication-view.ts";
import { spawnModelLabel } from "../agent-tree-view.ts";
import {
  AgentEngineLabelsContext,
  AgentTimelineHrefsContext,
  SessionFilePathCtxContext,
  useCategoryOpen,
} from "./context.ts";
import { FoldGuide, FoldSummary } from "./folds.tsx";
import { Tabs } from "../Tabs.tsx";
import {
  type TranslationAvailability,
  hasTranslationTabs,
  translationTabItems,
  useBubbleTranslationTab,
  useTranslatedText,
} from "./translation.ts";
import { TranslatedScope } from "./translated-scope.tsx";

// エージェント識別子 (avatar + 名前)。`linkify=true` の時だけ名前クリックで
// TL 遷移リンクを描く (kawaz r46m15 の「名前クリックで良いんじゃない?」の
// 適用先を絞る)。kawaz 2026-07-23 追加要件: フォルド閉状態 (= FoldSummary)
// では中身のクリック責務は open/close のみに専念させたいので、そこには
// linkify を渡さない。展開後のバブル内ヘッダ (AgentCard 側) では従来通り
// リンク化する。fold の details toggle と両立させるため click は
// stopPropagation する (バブル内でも fold summary の別 <details> に
// 巻き込まれないよう予防的に維持)。名前のすぐ右に、その agent が実際に
// 動いている model / effort を淡色で並べる (kawaz 2026-11-06、`(fable-5-1/low)`)。
// 源は agent tree のノード (AgentEngineLabelsContext)、取れない時だけ spawn の
// Agent call が渡した `spawnModel`。どちらも無ければ出さない。
export function AgentIdentity({
  name,
  spawnModel,
  linkify = false,
}: {
  name: string;
  spawnModel?: string;
  linkify?: boolean;
}) {
  const tlHref = useContext(AgentTimelineHrefsContext).get(name);
  const engine =
    useContext(AgentEngineLabelsContext).get(name) ??
    (spawnModel ? spawnModelLabel(spawnModel) : undefined);
  return (
    <span class="tl-agent-identity">
      <Avatar seed={`agent:${name}`} size={18} />
      {linkify && tlHref ? (
        <a class="tl-agent-name-link" href={tlHref} onClick={(event) => event.stopPropagation()}>
          <strong>{name}</strong>
        </a>
      ) : (
        <strong>{name}</strong>
      )}
      {engine ? <span class="tl-agent-model-inline">{engine}</span> : null}
    </span>
  );
}

export function AgentCard({
  name,
  direction,
  title,
  body,
  model,
  channelLabel,
  translationAvailability,
}: {
  name: string;
  direction: "inbound" | "outbound";
  title?: string | null;
  body: string;
  /** Transport this message rode (`peerChannelLabel`) — shown as one quiet
   * chip on the header's right edge so a Claude Code cross-session peer can
   * be told from an in-process teammate without giving it a different bubble.
   * `null`/undefined for the unmarked default. */
  channelLabel?: string | null;
  // Agent spawn 用: spawn の Agent call が渡した model。agent tree から実物が
  // 取れない時だけ名前の右に出す (AgentIdentity)。SendMessage / relay は
  // undefined。
  model?: string;
  translationAvailability: TranslationAvailability;
}) {
  const marker = agentDirectionMarker(direction);
  // AgentCard の展開表示は CcmsgBubble (別セッション間 msg) と同じ rich
  // バブル形式に統一する (kawaz r55m29 裁定: 「もういいよ ccmsg 形式でさ。
  // そこから微調整していく」)。hue seed は AgentIdentity アイコンと同じ
  // `agent:${name}` — 同画面に並ぶ AgentCard とアイコンで色が揃う。左寄せ
  // (`.tl-bubble-left`) + max-width 85% で右端 (ユーザエリア) に触れさせない。
  //
  // ヘッダ順序 (kawaz r55m33): 行頭に direction marker (🤖← / 🤖→)、続けて
  // 相手セッションの icon + 名前 (model chip があれば名前の右)。peer-message
  // はルーム経由ではないため 🏠 room 表記は付けない (kawaz r55m32 で撤回)。
  // 右上の "送信 / 受信 / new / タスク指示 …" badge チップは kawaz 指示外
  // の改変だったので撤去し、direction は marker で表現する。
  // body は plain pre-wrap ではなく LinkedMarkdownView で描画: SendMessage /
  // spawn の prompt に含まれる `path:line` を TL 側同様にリンク化する
  // (filePathCtx はセッション owner の SessionFilePathCtxContext を使う)。
  const filePathCtx = useContext(SessionFilePathCtxContext);
  const hue = hueForSeed(`agent:${name}`);
  // 翻訳タブと既定の判定は応答のバブルと同じ (DR-0049 §8)。訳すのは本文
  // だけで、ヘッダ (名前、summary、channel ラベル) は原文のまま。
  const bubbleRef = useRef<HTMLDivElement>(null);
  const { tab, selectTab } = useBubbleTranslationTab({
    text: body,
    availability: translationAvailability,
    elementRef: bubbleRef,
  });
  const { bodyText, translatingLabel } = useTranslatedText(body, translationAvailability, tab);
  return (
    <div
      class={`tl-bubble tl-bubble-left tl-bubble-peer tl-bubble-agent tl-bubble-agent-${direction}`}
      style={{ "--member-hue": String(hue) }}
      ref={bubbleRef}
    >
      <div class="tl-bubble-body">
        <div class="tl-bubble-from tl-agent-card-head">
          <span class="tl-agent-direction-marker">{marker}</span>
          <AgentIdentity name={name} spawnModel={model} linkify />
          {channelLabel ? (
            <span
              class="tl-agent-badge"
              title="Claude Code ネイティブのセッション間メッセージ (SendMessage / ListAgents)"
            >
              {channelLabel}
            </span>
          ) : null}
        </div>
        {title ? <div class="tl-agent-title">{title}</div> : null}
        {body ? (
          <div class="tl-agent-md">
            <TranslatedScope tab={tab}>
              <LinkedMarkdownView source={bodyText} ctx={filePathCtx} />
            </TranslatedScope>
            {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
          </div>
        ) : null}
      </div>
      {/* 時刻はヘッダ側の fold 行が持つので、足元の行はツールバーだけ。 */}
      {body && hasTranslationTabs(translationAvailability) ? (
        <div class="tl-bubble-footer">
          <div class="tl-msg-toolbar">
            <Tabs
              class="tl-thinking-tabs"
              tabClass="tl-thinking-tab"
              label="本文の言語"
              selected={tab}
              onSelect={selectTab}
              items={translationTabItems(translationAvailability)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentSendFold({
  segment,
  ts,
  translationAvailability,
}: {
  segment: Extract<Segment, { kind: "agent-send" }>;
  ts: string | null;
  translationAvailability: TranslationAvailability;
}) {
  const [open, setOpen] = useCategoryOpen("agent");
  const label = `SendMessage → ${segment.to}`;
  return (
    <details
      class="tl-fold tl-agent-fold"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <FoldSummary
        ts={ts}
        label={label}
        open={open}
        decoration={{
          kind: "agent",
          prefix: "SendMessage",
          name: segment.to,
          direction: "outbound",
        }}
      />
      <div class="tl-guided">
        <FoldGuide />
        <AgentCard
          name={segment.to}
          direction="outbound"
          title={segment.summary}
          body={segment.message}
          translationAvailability={translationAvailability}
        />
      </div>
    </details>
  );
}

/* Agent tool 起動 (spawn) は SendMessage / peer-message と同型 fold として
 * 描画する (kawaz r46m15): 閉サマリは「Agent → name」(SendMessage 同形式)、
 * カード内は → マーカー + 名前クリックで TL 遷移 + 名前右にモデル。
 * 「送信 / 受信」バッジ位置には spawn を示す "new" を置く。
 * agentType / background は既存の badge 文字列に含まれる情報だが、new に
 * 譲るため title 直前のメタ行に降ろす (description が本文の主タイトル)。 */
export function AgentSpawnFold({
  segment,
  ts,
  translationAvailability,
}: {
  segment: Extract<Segment, { kind: "agent-spawn" }>;
  ts: string | null;
  translationAvailability: TranslationAvailability;
}) {
  const [open, setOpen] = useCategoryOpen("agent");
  const typeMeta = `${segment.agentType || "agent"}${segment.background ? " · background" : ""}`;
  const combinedTitle = segment.description ? `${typeMeta} — ${segment.description}` : typeMeta;
  return (
    <details
      class="tl-fold tl-agent-fold"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <FoldSummary
        ts={ts}
        label={`Agent → ${segment.name}`}
        open={open}
        decoration={{
          kind: "agent",
          prefix: "Agent",
          name: segment.name,
          direction: "outbound",
        }}
      />
      <div class="tl-guided">
        <FoldGuide />
        <AgentCard
          name={segment.name}
          direction="outbound"
          model={segment.model || undefined}
          title={combinedTitle}
          body={segment.prompt}
          translationAvailability={translationAvailability}
        />
      </div>
    </details>
  );
}
