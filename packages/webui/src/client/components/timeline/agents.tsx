// agent (subagent / teammate) の起動・送信の fold とカード。
import { useContext } from "preact/hooks";
import { Avatar, hueForSeed } from "../../avatar.tsx";
import { type Segment } from "../../transcript-model.ts";
import { LinkedMarkdownView } from "../../filepath-linker.tsx";
import { agentDirectionMarker } from "../../agent-communication-view.ts";
import {
  AgentTimelineHrefsContext,
  SessionFilePathCtxContext,
  useCategoryOpen,
} from "./context.ts";
import { FoldGuide, FoldSummary } from "./folds.tsx";

// エージェント識別子 (avatar + 名前)。`linkify=true` の時だけ名前クリックで
// TL 遷移リンクを描く (kawaz r46m15 の「名前クリックで良いんじゃない?」の
// 適用先を絞る)。kawaz 2026-07-23 追加要件: フォルド閉状態 (= FoldSummary)
// では中身のクリック責務は open/close のみに専念させたいので、そこには
// linkify を渡さない。展開後のバブル内ヘッダ (AgentCard 側) では従来通り
// リンク化する。fold の details toggle と両立させるため click は
// stopPropagation する (バブル内でも fold summary の別 <details> に
// 巻き込まれないよう予防的に維持)。model があれば名前のすぐ右に淡色で
// 並べる (Agent spawn 用。SendMessage / peer-message は model 情報を
// 持たないので undefined で無表示)。
export function AgentIdentity({
  name,
  model,
  linkify = false,
}: {
  name: string;
  model?: string;
  linkify?: boolean;
}) {
  const tlHref = useContext(AgentTimelineHrefsContext).get(name);
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
      {model ? <span class="tl-agent-model-inline">{model}</span> : null}
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
  // Agent spawn 用: モデル名は名前のすぐ右に淡色で並べる (kawaz r46m15:
  // 「モデル名は名前のすぐ右に置くとかで良いんじゃない?他の 2 エージェント
  // メッセージタイプのやつも」)。SendMessage / peer-message はモデル情報を
  // 持たないので undefined。
  model?: string;
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
  return (
    <div
      class={`tl-bubble tl-bubble-left tl-bubble-peer tl-bubble-agent tl-bubble-agent-${direction}`}
      style={{ "--member-hue": String(hue) }}
    >
      <div class="tl-bubble-body">
        <div class="tl-bubble-from tl-agent-card-head">
          <span class="tl-agent-direction-marker">{marker}</span>
          <AgentIdentity name={name} model={model} linkify />
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
            <LinkedMarkdownView source={body} ctx={filePathCtx} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AgentSendFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "agent-send" }>;
  ts: string | null;
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
}: {
  segment: Extract<Segment, { kind: "agent-spawn" }>;
  ts: string | null;
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
        />
      </div>
    </details>
  );
}
