// system 発 (tool の echo、task-notification 等) のユーザ行の描画。
import { useMemo, useState } from "preact/hooks";
import { formatClockTime } from "../../utils.ts";
import {
  parseSystemMessageFields,
  type Segment,
  type SystemMessageRich,
  type PeerRelay,
  type TurnLine,
  type UserMessageKind,
} from "../../transcript-model.ts";
import { type FoldSummaryDecoration } from "../../timeline-summary.ts";
import { peerChannelLabel, peerMessagePresentation } from "../../agent-communication-view.ts";
import { Tabs } from "../Tabs.tsx";
import { CopyablePreText } from "../CodeCopyFrame.tsx";
import { useCategoryOpen } from "./context.ts";
import { FoldGuide, FoldSummary } from "./folds.tsx";
import { BashRunCard } from "./tools.tsx";
import { AgentCard } from "./agents.tsx";
import { type TranslationAvailability } from "./translation.ts";
import { SegmentView } from "./segments.tsx";

// システム由来 user メッセージの rich 表示 (U2 kawaz spec): transcript-model.ts's
// parseSystemMessageFields が返す SystemMessageRich の 3 レイアウトを描画する
// だけの純表示コンポーネント — パース自体は行わない (ロジックは transcript-
// model.ts 側でユニットテスト可能に保つ、他の *-model.ts と描画部品の
// 分業と同じ)。"event" フィールドだけ等幅フォントを当てる (kawaz spec:
// 「event 本文は monospace で」) — task-notification 以外の kind がたまたま
// 同名フィールドを持つことは想定していないが、フィールド名一致だけで判定する
// のでどの kind から来ても等幅になる (副作用として無害)。
type PeerMessageRich = PeerRelay;

// idle 通知は operational noise (kawaz r46m6: 「でしゃばらせるな」)。
// 通常 peer メッセージのような decorated fold / AgentCard には流さず、
// 閉じた <details> の compact 行に demote する — 第 1 層 (Timeline 直下 /
// 展開済み fold 内) では時刻 + 淡色の "idle {from}" のみを見せて、body
// (実際の通知テキスト) は summary を開いたときだけ表示する。
function IdlePeerRow({ peer, ts }: { peer: PeerMessageRich; ts: string | null }) {
  const presentation = peerMessagePresentation(peer);
  if (presentation.kind !== "idle") return null;
  return (
    <details class="tl-line tl-fold tl-agent-idle">
      <summary>
        {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
        <span class="tl-agent-idle-label">
          <span class="tl-agent-idle-kind">idle</span>
          <span class="tl-agent-idle-from">{peer.from}</span>
          {presentation.channelLabel ? (
            <span class="tl-agent-idle-channel">{presentation.channelLabel}</span>
          ) : null}
        </span>
      </summary>
      <div class="tl-agent-idle-body">{presentation.text}</div>
    </details>
  );
}

function SystemMessageRichView({ rich }: { rich: SystemMessageRich }) {
  switch (rich.display) {
    case "fields":
      return (
        <div class="tl-sysmsg-fields">
          {rich.heading === null && rich.fields.length === 0 ? (
            <span class="tl-empty-turn">(フィールドなし)</span>
          ) : (
            <dl class="tl-sysmsg-dl">
              {rich.heading ? (
                <div class="tl-sysmsg-field">
                  <dt>summary</dt>
                  <dd>{rich.heading}</dd>
                </div>
              ) : null}
              {rich.fields.map((f, i) => (
                <div class="tl-sysmsg-field" key={i}>
                  <dt>{f.name}</dt>
                  <dd class={f.name === "event" ? "tl-sysmsg-mono" : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      );
    case "chip":
      return (
        <div class="tl-sysmsg-chip-row">
          <span class="tl-sysmsg-chip">{rich.label}</span>
          {rich.detail ? <span class="tl-sysmsg-chip-detail">{rich.detail}</span> : null}
        </div>
      );
    case "bash":
      // Reached only when a `! <cmd>` row somehow renders through the
      // system-message path instead of standing on its own (an unpaired half
      // whose sibling never arrived, a hand-built line). Same card either way
      // so the two paths can't look different.
      return <BashRunCard command={rich.command} output={rich.output} ts={null} />;
    case "peer": {
      // One card (or compact idle row) per relayed turn — a relay line often
      // batches several, and each stands on its own.
      return (
        <>
          {rich.relays.map((relay, i) =>
            peerMessagePresentation(relay).kind === "idle" ? (
              <IdlePeerRow key={i} peer={relay} ts={null} />
            ) : (
              <AgentCard
                key={i}
                name={relay.from}
                direction="inbound"
                title={relay.summary}
                body={relay.body}
                channelLabel={peerChannelLabel(relay.channel)}
              />
            ),
          )}
        </>
      );
    }
    case "text":
      return <CopyablePreText class="tl-fold-body" text={rich.text} />;
  }
}

// rich|raw タブ (U2 kawaz spec: 「ccmsg 吹き出しの msg/raw タブと同じ UI
// 流儀」、デフォルト rich) — LineView の sysKind 分岐 (システム由来 user
// メッセージの details 本文) から呼ばれる。raw タブは変更前と全く同じ描画
// (segments.map + SegmentView) を保つことで、rich 側のパースが空振りしても
// 元の情報は raw タブから必ず参照できる ("壊れた入力は raw fallback" 要件)。
export function systemMessageRawText(segments: readonly Segment[]): string {
  return segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
}

function SystemMessageBody({
  kind,
  line,
  translationAvailability,
  foldGroupOpen,
}: {
  kind: UserMessageKind;
  line: TurnLine;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
}) {
  const [tab, setTab] = useState<"rich" | "raw">("rich");
  // extractCcmsgMessages (transcript-model.ts) が使うのと同じ「text segment
  // だけを \n 結合」の抽出 — tool-result/unknown-segment 主体の line (例:
  // userMessageKind "tool-result") では空文字列になり、rich タブは text
  // フォールバックで空表示になるが、raw タブ側は元通り全 segment を描画する
  // ので情報は失われない。
  const segments = line.segments;
  const rawText = useMemo(() => systemMessageRawText(segments), [segments]);
  const rich = useMemo(() => parseSystemMessageFields(kind, rawText), [kind, rawText]);

  return (
    <div class="tl-sysmsg">
      <Tabs
        class="tl-thinking-tabs"
        tabClass="tl-thinking-tab"
        label="システムメッセージの表示"
        selected={tab}
        onSelect={setTab}
        items={[
          { id: "rich", label: "rich" },
          { id: "raw", label: "raw" },
        ]}
      />
      {tab === "rich" ? (
        <SystemMessageRichView rich={rich} />
      ) : (
        <div class="tl-fold-body tl-segments">
          {line.segments.length === 0 ? (
            <span class="tl-empty-turn">(空)</span>
          ) : (
            line.segments.map((seg, i) => (
              // システム由来メッセージの raw タブ / ccmsg 生テキストは in-view
              // search のスコープ外 (DR-0022 §3 は「TL は text/thinking/tool
              // セグメント」— 境界の 3 種チャットバブルとその fold 群を指し、
              // 折り畳み済み system メッセージの raw fallback までは対象に
              // 含めていない解釈)。searchCtx を渡さず不参加にする。
              <SegmentView
                key={i}
                segment={seg}
                translationAvailability={translationAvailability}
                ts={null}
                foldGroupOpen={foldGroupOpen}
                searchKey={`sysraw-${i}`}
                searchCtx={undefined}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SystemMessageFold({
  kind,
  line,
  translationAvailability,
  foldGroupOpen,
}: {
  kind: UserMessageKind;
  line: TurnLine;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useCategoryOpen("agent");
  const segments = line.segments;
  const rich = useMemo(
    () => parseSystemMessageFields(kind, systemMessageRawText(segments)),
    [kind, segments],
  );
  const relays = rich.display === "peer" ? rich.relays : [];
  // A line carrying only idle notifications never becomes a fold: each is
  // demoted to its own compact row. One that also carries a real relayed turn
  // keeps the fold — the fold's identity comes from that turn, not the idle
  // noise it happened to be batched with.
  if (relays.length > 0 && relays.every((relay) => relay.category === "idle")) {
    return (
      <>
        {relays.map((relay, i) => (
          <IdlePeerRow key={i} peer={relay} ts={line.ts} />
        ))}
      </>
    );
  }
  const peer = relays.find((relay) => relay.category !== "idle") ?? relays[0] ?? null;
  // peer 形に落ちたものがエージェントメッセージのカテゴリ (kawaz r55 m35:
  // AUTO OPEN の A チェックで開いておいてほしい対象)。spawn prompt は
  // wrapper の有無に関わらず parseSystemMessageFields が peer 形を返すので
  // (r55m155)、ここで kind を個別に見る必要はない。
  const isAgentCategory = peer !== null;
  const open = isAgentCategory ? agentOpen : manualOpen;
  const setOpen = isAgentCategory ? setAgentOpen : setManualOpen;
  const taskSummary =
    kind === "task-notification" && rich.display === "fields" ? rich.heading : null;
  // kind 文字列は internal enum なので UI に出す時だけ人間可読形へ (現状
  // spawn-prompt のみ special-case、他 kind は enum ラベルのまま踏襲)。
  // A cross-session relay is still `peer-message` on the wire, but naming the
  // transport in the closed summary is what makes the fold readable without
  // opening it — the peer's channel is the one thing the kind enum can't say.
  const kindLabel =
    kind === "spawn-prompt"
      ? "spawn prompt"
      : peer?.channel === "cross-session"
        ? "cross-session"
        : kind;
  // `! <cmd>` の入力行は閉じたままでも何を実行したか分かるように、summary に
  // コマンドそのものを出す (出力行は本文側にしかないので kindLabel のまま)。
  const bashCommand = rich.display === "bash" ? rich.command : null;
  // Closed summary names the relay the fold is identified by; the rest of a
  // batched line is counted so nothing inside is invisible while it is closed.
  const extraRelays = relays.length - 1;
  const label = peer
    ? `${kindLabel} ← ${peer.from}${extraRelays > 0 ? ` +${extraRelays}` : ""}`
    : bashCommand !== null
      ? `$ ${bashCommand}`
      : taskSummary && !open
        ? `${kindLabel} ${taskSummary}`
        : kindLabel;
  const decoration: FoldSummaryDecoration | undefined = peer
    ? { kind: "agent", prefix: kindLabel, name: peer.from, direction: "inbound" }
    : taskSummary
      ? { kind: "task-notification" }
      : undefined;
  return (
    <details
      class={peer ? "tl-line tl-fold tl-agent-fold" : "tl-line tl-fold"}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <FoldSummary ts={line.ts} label={label} open={open} decoration={decoration} />
      {peer ? (
        <div class="tl-guided">
          <FoldGuide />
          <div class="tl-guided-content">
            <SystemMessageBody
              kind={kind}
              line={line}
              translationAvailability={translationAvailability}
              foldGroupOpen={foldGroupOpen}
            />
          </div>
        </div>
      ) : (
        <SystemMessageBody
          kind={kind}
          line={line}
          translationAvailability={translationAvailability}
          foldGroupOpen={foldGroupOpen}
        />
      )}
    </details>
  );
}
