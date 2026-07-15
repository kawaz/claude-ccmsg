// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TimelineState } from "../store.ts";
import { ADMIN_ID } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { UserAvatar } from "../avatar.tsx";
import { errorMessage, formatClockTime, formatMsgTime } from "../utils.ts";
import { useNow } from "../useNow.ts";
import {
  classifyBoundaryLine,
  foldGroupLabel,
  groupTimelineLines,
  isUserTextTurn,
  lineByteOffsets,
  parseSystemMessageFields,
  parseTranscriptLine,
  scrollPositionToUserTurnIndex,
  type CcmsgMessage,
  type ParsedLine,
  type Segment,
  type SystemMessageRich,
  type TimelineEntry,
  type TurnLine,
  type UserMessageKind,
} from "../transcript-model.ts";
import { MarkdownView } from "../markdown-view.tsx";
import { hasTranslatorApi, translateThinkingText } from "../translate.ts";

// Live tail 自動スクロール追従 (U2 kawaz spec: 「ユーザが最下部付近を見ている
// 時だけ自動スクロール追従、上にスクロール中は追従しない」) の「最下部付近」
// のしきい値 (px)。ちょうど末端に張り付いていなくても数行分の余裕は追従対象
// にする、というよくあるチャット UI の慣習値。
const NEAR_BOTTOM_PX = 80;

// 表示形式の統一 (kawaz spec 2026-07-12): fold 対象アイテム (thinking/
// tool_use/tool_result/meta 行/システム由来 user メッセージ) は全て同一の
// 「▶ HH:MM:SS ラベル」1 行 summary + <details> 展開に統一する — 以前は meta
// 行だけこの形、tool_use/tool_result は「時刻の行」+「▶ ラベルの行」の 2 行、
// システム由来 user メッセージは fold すらされず時刻+チップ+本文全開、と
// 3 通りに割れていた (kawaz: 「時刻表示の位置や出る出ないが不規則」)。ts が
// null の行 (Segment 自体は ts を持たないので親 TurnLine の ts を渡す) は
// 時刻 span を省略して詰める。
function FoldSummary({ ts, label }: { ts: string | null; label: string }) {
  return (
    <summary>
      {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
      <span class="tl-fold-label">{label}</span>
    </summary>
  );
}

// thinking 翻訳タブ (U2 kawaz spec): Chrome built-in Translator API が使える
//環境でのみ original|ja タブを描画する (feature-detect は hasTranslatorApi
// 呼び出し側で行う。タブ自体を出さない = レイアウト変化なし、という spec の
// 要件を満たすためモジュールレベルで一度だけ判定してコンポーネントに渡す)。
function ThinkingSegment({
  text,
  ts,
  translatorAvailable,
  // fold グループ (FoldGroup の <details>) が開いているか — 表示形式統一
  // タスクの kawaz spec: 「fold を開いた時、中の thinking は details open +
  // ja タブ選択がデフォルト」。fold 外 (境界行に混在する thinking 等) から
  // 呼ばれるときは常に false で渡り、その場合は従来通り閉じたまま
  // (「fold 外に単独で出る thinking の従来デフォルト (閉) は変えない」)。
  foldGroupOpen,
}: {
  text: string;
  ts: string | null;
  translatorAvailable: boolean;
  foldGroupOpen: boolean;
}) {
  const [tab, setTab] = useState<"original" | "ja">("original");
  // null = まだ翻訳していない (ja タブ初回クリック、または fold group の
  // 初回オープンで遅延実行、kawaz spec)。翻訳結果自体は translate.ts 側で
  // 段落単位にメモリキャッシュされるので、fold 開閉やタブ往復で再翻訳は
  // 起きない。
  const [jaText, setJaText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  // <details open> を FoldGroup 開閉に連動させる側 (uncontrolled 初期値 +
  // onToggle 同期) — open={foldGroupOpen} と直に結ぶと、ユーザーが手動で
  // この thinking だけ閉じた後にも再レンダーで強制的に開き直されてしまう
  // (Preact は同じ prop 値なら DOM に書き戻さないが、親の再レンダーで一度
  // false→true を経由すると上書きされる)。ここでは自前 state に落として
  // onToggle で追従させることでユーザーの手動 close を尊重する。
  const [detailsOpen, setDetailsOpen] = useState(false);
  // fold group が最初に開かれた瞬間だけ自動オープン+ja選択を発火させる
  // ためのワンショットフラグ。2 回目以降の開閉では発火しない (ユーザーが
  // その後 original タブへ戻したり details を閉じたりしても、再度の
  // fold 開閉で勝手に上書きされない)。
  const autoOpenedRef = useRef(false);

  function selectJa() {
    setTab("ja");
    if (jaText === null && !translating) {
      setTranslating(true);
      void translateThinkingText(text).then((result) => {
        setJaText(result);
        setTranslating(false);
      });
    }
  }

  // selectJa は毎レンダー新しい参照になるが、上の autoOpenedRef ガードで
  // 実行は fold group の初回オープン 1 回だけに絞られるため、依存配列に
  // 含めなくても安全 (毎回作り直される関数を追いかける必要がない)。
  //
  // details open と ja タブ選択は別ゲート (kawaz spec: 「fold を開いた時、
  // 中の thinking は details open + ja タブ選択がデフォルト」— ja 選択が
  // Translator 前提なのは当然だが、details open まで Translator の有無に
  // 依存する理由はない)。両方を translatorAvailable で一括ゲートすると、
  // Chrome built-in Translator API が無い環境 (Safari/Firefox 等) では
  // fold を開いても thinking が閉じたままになり、spec の "details open"
  // 部分が非対応ブラウザで丸ごと落ちてしまう。
  useEffect(() => {
    if (foldGroupOpen && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setDetailsOpen(true);
      if (translatorAvailable) selectJa();
    }
  }, [foldGroupOpen, translatorAvailable]);

  const bodyText = tab === "ja" && jaText !== null ? jaText : text;

  return (
    <details
      class="tl-fold tl-thinking"
      open={detailsOpen}
      onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary ts={ts} label="thinking" />
      {translatorAvailable ? (
        <div class="tl-thinking-tabs">
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "original" ? " active" : "")}
            onClick={() => setTab("original")}
          >
            original
          </button>
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "ja" ? " active" : "")}
            onClick={selectJa}
          >
            ja
          </button>
        </div>
      ) : null}
      <div class="tl-thinking-body">
        {/* ja タブの翻訳結果も markdown レンダリング (kawaz spec: 「ja 表示も
         * markdown レンダリング」) — original と同じ MarkdownView を再利用。 */}
        <MarkdownView source={bodyText} />
        {tab === "ja" && translating && jaText === null ? (
          <p class="tl-thinking-translating">翻訳中…</p>
        ) : null}
      </div>
    </details>
  );
}

function SegmentView({
  segment,
  translatorAvailable,
  ts,
  foldGroupOpen,
}: {
  segment: Segment;
  translatorAvailable: boolean;
  // 親 TurnLine の ts (Segment 自体は持たない) — 表示形式統一タスクの
  // 「fold 対象アイテムは全て時刻を持つ」を満たすため各 fold summary に渡す。
  ts: string | null;
  foldGroupOpen: boolean;
}) {
  switch (segment.kind) {
    case "text":
      // Markdown rendering (DR-0010) is assistant-only: a user turn's text
      // is what the human actually typed, so it's shown verbatim rather than
      // interpreted as markdown syntax.
      return (
        <div class={"tl-text tl-text-" + segment.role}>
          {segment.role === "assistant" ? <MarkdownView source={segment.text} /> : segment.text}
        </div>
      );
    case "thinking":
      return (
        <ThinkingSegment
          text={segment.text}
          ts={ts}
          translatorAvailable={translatorAvailable}
          foldGroupOpen={foldGroupOpen}
        />
      );
    case "tool-use":
      return (
        <details class="tl-fold">
          <FoldSummary ts={ts} label={"tool_use: " + segment.name} />
          <pre class="tl-fold-body">{JSON.stringify(segment.input, null, 2)}</pre>
        </details>
      );
    case "tool-result":
      return (
        <details class="tl-fold">
          <FoldSummary ts={ts} label={"tool_result" + (segment.isError ? " (error)" : "")} />
          <pre class="tl-fold-body">{segment.text}</pre>
        </details>
      );
    case "unknown-segment":
      return (
        <details class="tl-fold">
          <FoldSummary ts={ts} label={segment.type} />
          <pre class="tl-fold-body">{JSON.stringify(segment.raw, null, 2)}</pre>
        </details>
      );
  }
}

// システム由来 user メッセージの rich 表示 (U2 kawaz spec): transcript-model.ts's
// parseSystemMessageFields が返す SystemMessageRich の 3 レイアウトを描画する
// だけの純表示コンポーネント — パース自体は行わない (ロジックは transcript-
// model.ts 側でユニットテスト可能に保つ、他の *-model.ts / Timeline.tsx の
// 分業と同じ)。"event" フィールドだけ等幅フォントを当てる (kawaz spec:
// 「event 本文は monospace で」) — task-notification 以外の kind がたまたま
// 同名フィールドを持つことは想定していないが、フィールド名一致だけで判定する
// のでどの kind から来ても等幅になる (副作用として無害)。
function SystemMessageRichView({ rich }: { rich: SystemMessageRich }) {
  switch (rich.display) {
    case "fields":
      return (
        <div class="tl-sysmsg-fields">
          {rich.heading ? <div class="tl-sysmsg-heading">{rich.heading}</div> : null}
          {rich.fields.length === 0 ? (
            <span class="tl-empty-turn">(フィールドなし)</span>
          ) : (
            <dl class="tl-sysmsg-dl">
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
    case "text":
      return <pre class="tl-fold-body">{rich.text}</pre>;
  }
}

// rich|raw タブ (U2 kawaz spec: 「ccmsg 吹き出しの msg/raw タブと同じ UI
// 流儀」、デフォルト rich) — LineView の sysKind 分岐 (システム由来 user
// メッセージの details 本文) から呼ばれる。raw タブは変更前と全く同じ描画
// (segments.map + SegmentView) を保つことで、rich 側のパースが空振りしても
// 元の情報は raw タブから必ず参照できる ("壊れた入力は raw fallback" 要件)。
function SystemMessageBody({
  kind,
  line,
  translatorAvailable,
  foldGroupOpen,
}: {
  kind: UserMessageKind;
  line: TurnLine;
  translatorAvailable: boolean;
  foldGroupOpen: boolean;
}) {
  const [tab, setTab] = useState<"rich" | "raw">("rich");
  // extractCcmsgMessages (transcript-model.ts) が使うのと同じ「text segment
  // だけを \n 結合」の抽出 — tool-result/unknown-segment 主体の line (例:
  // userMessageKind "tool-result") では空文字列になり、rich タブは text
  // フォールバックで空表示になるが、raw タブ側は元通り全 segment を描画する
  // ので情報は失われない。
  const rawText = useMemo(
    () =>
      line.segments
        .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
        .map((s) => s.text)
        .join("\n"),
    [line.segments],
  );
  const rich = useMemo(() => parseSystemMessageFields(kind, rawText), [kind, rawText]);

  return (
    <div class="tl-sysmsg">
      <div class="tl-thinking-tabs">
        <button
          type="button"
          class={"tl-thinking-tab" + (tab === "rich" ? " active" : "")}
          onClick={() => setTab("rich")}
        >
          rich
        </button>
        <button
          type="button"
          class={"tl-thinking-tab" + (tab === "raw" ? " active" : "")}
          onClick={() => setTab("raw")}
        >
          raw
        </button>
      </div>
      {tab === "rich" ? (
        <SystemMessageRichView rich={rich} />
      ) : (
        <div class="tl-fold-body tl-segments">
          {line.segments.length === 0 ? (
            <span class="tl-empty-turn">(空)</span>
          ) : (
            line.segments.map((seg, i) => (
              <SegmentView
                key={i}
                segment={seg}
                translatorAvailable={translatorAvailable}
                ts={null}
                foldGroupOpen={foldGroupOpen}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// fold group 内 (非境界) の 1 entry を描画する — thinking/tool_use-only の
// assistant turn、tool-result-only の user turn、meta 行、broken 行、
// そしてシステム由来 user メッセージ (ccmsg メッセージを含まないもの、含む
// 場合は境界として CcmsgBubble 側に回る) を扱う。境界行 (本物のユーザ発話/
// アシスタント最終応答/ccmsg メッセージ) は Timeline() 側の
// UserPromptBubble/AssistantBubble/CcmsgBubble が担当するため、
// registerUserTurnRef はここでは不要 (fold group 内に isUserTextTurn な行は
// 絶対に来ない — classifyBoundaryLine が boundary として弾くため)。
function LineView({
  line,
  translatorAvailable,
  foldGroupOpen,
}: {
  line: ParsedLine;
  translatorAvailable: boolean;
  foldGroupOpen: boolean;
}) {
  if (line.kind === "broken") {
    return (
      <div class="tl-line tl-broken">
        <pre class="tl-broken-raw">{line.raw || "(空行)"}</pre>
      </div>
    );
  }
  if (line.kind === "meta") {
    return (
      <details class="tl-line tl-fold">
        <FoldSummary ts={line.ts} label={line.summary} />
        <pre class="tl-fold-body">{line.raw}</pre>
      </details>
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
    line.role === "user" && line.userMessageKind && line.userMessageKind !== "user-prompt"
      ? line.userMessageKind
      : null;
  if (sysKind) {
    return (
      <details class="tl-line tl-fold">
        <FoldSummary ts={line.ts} label={sysKind} />
        <SystemMessageBody
          kind={sysKind}
          line={line}
          translatorAvailable={translatorAvailable}
          foldGroupOpen={foldGroupOpen}
        />
      </details>
    );
  }
  // 残り: thinking/tool_use-only の assistant turn、tool-result-only の
  // user turn — 中身の各 segment 自体が (SegmentView 経由で) fold 済みの
  // 1 行 summary を持つので、turn の外枠はプレーンな container のまま
  // (二重に時刻を出さない)。
  return (
    <div class="tl-line">
      <div class="tl-segments">
        {line.segments.length === 0 ? (
          <span class="tl-empty-turn">(空)</span>
        ) : (
          line.segments.map((seg, i) => (
            <SegmentView
              key={i}
              segment={seg}
              translatorAvailable={translatorAvailable}
              ts={line.ts}
              foldGroupOpen={foldGroupOpen}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Tools folding (kawaz spec): the run of thinking/tool_use/tool_result/meta
// entries between a user prompt and the assistant's next user-facing final
// response, collapsed into one <details> — default-collapsed via the native
// <details> element itself (no manual open/close state to manage, matches
// every other tl-fold in this file), label text from
// transcript-model.ts's foldGroupLabel (grouping/counting stays a pure,
// unit-tested function; this component only renders it). Open state is
// lifted into React state (rather than left fully uncontrolled) so it can be
// threaded down to each entry's ThinkingSegment as `foldGroupOpen` — the
// signal that drives the "fold を開いた時 thinking は details open + ja
// デフォルト" behavior (kawaz spec).
function FoldGroup({
  entries,
  translatorAvailable,
}: {
  entries: TimelineEntry[];
  translatorAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      class="tl-line tl-fold-group"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>{foldGroupLabel(entries)}</summary>
      <div class="tl-fold-group-body">
        {entries.map(({ offset, line }) => (
          <LineView
            key={offset}
            line={line}
            translatorAvailable={translatorAvailable}
            foldGroupOpen={open}
          />
        ))}
      </div>
    </details>
  );
}

// --- 境界行の吹き出し表示 (kawaz spec: 「timeline のユーザプロンプトと
// エージェントアウトプットは ROOM のチャットに寄せた表現にしたい」) ---
// 吹き出しになるのは 3 種のみ: 本物のユーザプロンプト (右寄せ, 緑系) /
// メインセッションのアシスタント最終応答 (左寄せ) / ccmsg メッセージを含む
// システムメッセージ (左寄せ, 第三者カラー)。見た目は ROOM チャット
// (TimelineItem.tsx の .msg 表示) の角丸・背景・メタ行構成に寄せるが、
// ROOM 側のコードそのものは参照のみで変更しない (app.css に .tl-bubble-*
// として別定義)。

function UserPromptBubble({
  line,
  offsetKey,
  registerUserTurnRef,
  translatorAvailable,
  now,
}: {
  line: TurnLine;
  offsetKey: number;
  // "👤 N/M" nav indicator の DOM 測定対象として登録する — 実ユーザ発話
  // (isUserTextTurn) はこの吹き出し以外の経路には現れないので、fold-inner
  // 側 (LineView) はこの登録を一切行わない。
  registerUserTurnRef: (key: number, el: HTMLDivElement | null) => void;
  translatorAvailable: boolean;
  now: number;
}) {
  return (
    <div class="tl-bubble tl-bubble-right" ref={(el) => registerUserTurnRef(offsetKey, el)}>
      <div class="tl-bubble-body tl-bubble-body-user">
        {line.segments.length === 0 ? (
          <span class="tl-empty-turn">(空)</span>
        ) : (
          line.segments.map((seg, i) => (
            <SegmentView
              key={i}
              segment={seg}
              translatorAvailable={translatorAvailable}
              ts={line.ts}
              foldGroupOpen={false}
            />
          ))
        )}
      </div>
      {/* 右寄せ吹き出しは時刻も右に揃える (kawaz: 「ユーザメッセージは右に
       * あるのに時刻が左」)。 */}
      {line.ts ? <span class="tl-bubble-time">{formatMsgTime(line.ts, now)}</span> : null}
    </div>
  );
}

function AssistantBubble({
  line,
  translatorAvailable,
  now,
}: {
  line: TurnLine;
  translatorAvailable: boolean;
  now: number;
}) {
  return (
    <div class="tl-bubble tl-bubble-left tl-bubble-assistant">
      <div class="tl-bubble-body">
        {line.segments.map((seg, i) => (
          <SegmentView
            key={i}
            segment={seg}
            translatorAvailable={translatorAvailable}
            ts={line.ts}
            foldGroupOpen={false}
          />
        ))}
      </div>
      {line.ts ? <span class="tl-bubble-time">{formatMsgTime(line.ts, now)}</span> : null}
    </div>
  );
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
function CcmsgBubble({
  message,
  rawText,
  now,
}: {
  message: CcmsgMessage;
  rawText: string;
  now: number;
}) {
  const [tab, setTab] = useState<"msg" | "raw">("msg");
  const isUser = message.from === ADMIN_ID;
  return (
    <div
      class={
        isUser
          ? "tl-bubble tl-bubble-right tl-bubble-ccmsg-user"
          : "tl-bubble tl-bubble-left tl-bubble-peer"
      }
    >
      <div class={isUser ? "tl-bubble-body tl-bubble-body-user" : "tl-bubble-body"}>
        <div class="tl-bubble-from">
          {isUser ? <UserAvatar size={16} /> : null}
          {message.from}
          {message.to?.length ? ` → ${message.to.join(", ")}` : ""}
          {" · #"}
          {message.room}
        </div>
        <div class="tl-thinking-tabs">
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "msg" ? " active" : "")}
            onClick={() => setTab("msg")}
          >
            msg
          </button>
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "raw" ? " active" : "")}
            onClick={() => setTab("raw")}
          >
            raw
          </button>
        </div>
        {tab === "msg" ? (
          // tl-ccmsg-msg: chat 様式の本文なので単一改行を行分けとして見せる
          // (CSS の white-space: pre-wrap、kawaz r17 mid=13)。markdown AST は
          // 段落内の改行を text node "\n" のまま保持しており、素の <p> では
          // 空白に潰れる。文書様式が前提の assistant markdown には波及させない
          // (ソフト折り返しを空白扱いする通常の markdown 表示のまま)。
          <div class="tl-ccmsg-msg">
            <MarkdownView source={message.msg} />
          </div>
        ) : (
          <pre class="tl-fold-body">{rawText}</pre>
        )}
      </div>
      <span class="tl-bubble-time">{formatMsgTime(message.ts, now)}</span>
    </div>
  );
}

export function Timeline({ sid, timeline }: { sid: string; timeline: TimelineState }) {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store).connStatus;

  // Chrome built-in Translator API の feature-detect (U2 kawaz spec): 環境が
  // 変わらない限り再評価不要なので mount 時に一度だけ判定する。
  const translatorAvailable = useMemo(() => hasTranslatorApi(), []);
  // msg 時刻の相対時間表示 ("3h10m") 用の雑更新 tick (kawaz r17 mid=30):
  // 3 分おきの再描画で十分。
  const now = useNow();

  // Live tail (DR-0009 addendum, transcript_subscribe): このセッションの
  // Timeline が表示されている間だけ subscribe し、タブ切替/セッション切替/
  // unmount (依存 [sid, connStatus] のいずれかが変わる、またはアンマウント)
  // で unsubscribe する。届いた行は ws.ts の ev:"transcript" ハンドラが
  // `timeline/tail` action に変換し、store.ts の applyTimelineTail が
  // contiguous なときだけ追記する — このコンポーネントは購読の開始/終了だけ
  // 管理し、フォールドロジックには関与しない。send() は socket が open で
  // ない間 reject するので (ws.ts) catch で握りつぶす — 再接続後の
  // onOpen 側で改めて subscribe できる余地を持たせるため、ここではエラー
  // 表示もリトライも行わない (次の connStatus 変化でこの effect が再実行
  // される)。
  useEffect(() => {
    if (connStatus !== "connected") return;
    void ws.transcriptSubscribe(sid).catch(() => {});
    return () => {
      void ws.transcriptUnsubscribe(sid).catch(() => {});
    };
  }, [sid, connStatus]);

  // Tail-load on first visit only — re-visiting a session whose Timeline is
  // already "loaded"/"error" must not refetch (mirrors FileViewer's
  // path-keyed effect guard). Gated on connStatus so a direct `#t<sid>` link
  // opened before the WS handshake completes doesn't race ws.send() (rejects
  // synchronously while not open, see ws.ts) — status stays "idle" (still
  // rendered as "読み込み中…" below) until connStatus flips to "connected",
  // which re-evaluates this effect via the dep list.
  useEffect(() => {
    if (timeline.status !== "idle") return;
    if (connStatus !== "connected") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }, [sid, timeline.status, connStatus]);

  // Resync on a non-contiguous tail push (DR-0009 addendum, adversarial
  // review fix): applyTimelineTail (store.ts) can only detect that a
  // `timeline/tail` push doesn't line up with the cached `end` — it can't
  // fetch, so it flags `timeline.needsResync` instead of just dropping the
  // push and leaving live tail silently stuck (DR-0005 §1: side effects stay
  // out of the reducer). This effect is the side effect: a background
  // "replace" read that catches the cache up. Deliberately does NOT dispatch
  // `timeline/loading` first (unlike every other transcriptRead call site in
  // this component) — flipping status to "loading" would blank the pane
  // (Timeline's "読み込み中…" branch below) for what should be an invisible
  // catch-up, not a user-visible reload. If the re-read's own result is
  // already stale by the time it lands (more appends happened meanwhile),
  // the next tail push simply re-flags needsResync and this effect fires
  // again — self-healing, no bound on retries needed since each attempt is
  // a normal full tail read.
  useEffect(() => {
    if (!timeline.needsResync) return;
    if (connStatus !== "connected") return;
    void ws
      .transcriptRead(sid)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }, [sid, timeline.needsResync, connStatus]);

  // Auto-refresh on Timeline visit (TLR-Q1=b裁定, issue
  // 2026-07-14-session-tl-refresh-on-revisit): SessionTreeState's timeline
  // cache is intentionally preserved across tab/session switches (store.ts's
  // newSessionTree — clicking Files/Rooms and returning must not discard
  // what's already loaded), but the transcript_subscribe above is torn down
  // alongside this component's unmount. Any live-tail updates that landed
  // while the Timeline was unmounted never reached the cache, so a revisit
  // sees an `end` byte frozen at unmount time — the symptom kawaz observed
  // (SessionView Timeline "空だったり", r12 mid=12 2026-07-14). This effect
  // re-reads the tail once per "arrival at a Timeline to look at" so the
  // stale cache is caught up before the user sees it.
  //
  // - Skipped when status is "idle" (initial-load effect above owns first
  //   visit) or "loading" (a fetch is already in flight; overlapping it
  //   would just collide on the same replace dispatch).
  // - Dep list is [sid, connStatus] deliberately, NOT timeline.status: this
  //   should fire once when Timeline mounts / the sid changes / a reconnect
  //   lands, not on the loading→loaded flip caused by our own fetch (which
  //   would loop). status is closed over from the render that scheduled
  //   this effect, sufficient to gate the "no revisit needed" cases.
  // - mode: "replace" because DR-0009's transcript_read has no "after"
  //   parameter — an incremental "just what's new" is not representable in
  //   the current protocol. The response's own start/end/lines become the
  //   new cache wholesale (same shape as refresh() below).
  useEffect(() => {
    if (connStatus !== "connected") return;
    if (timeline.status !== "loaded" && timeline.status !== "error") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
    // timeline.status is intentionally not in deps — see doc comment above.
  }, [sid, connStatus]);

  function loadOlder() {
    if (timeline.status === "loading" || timeline.atStart) return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid, { before: timeline.start })
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", error: errorMessage(err) });
      });
  }

  // "更新" (refresh): re-reads the tail (before omitted) and replaces the
  // cache wholesale rather than fetching only what's new since `end` — DR-0009
  // offers no cheaper "read what's new" shape (transcript_read has no
  // "after" parameter), and re-reading the tail is simple and correct at the
  // cost of re-fetching content we may already have (implementation
  // simplicity prioritized per the delegated spec).
  function refresh() {
    if (timeline.status === "loading") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
        // 「更新」= tail の読み直しなので、完了後は末尾へ (kawaz r17 mid=26)。
        // replace で end が同値のままだと tail-append effect が発火しないため
        // ここで明示的に飛ばす。isNearBottomRef も末尾扱いに戻す (更新直後に
        // 届く live tail への追従を継続させる)。
        isNearBottomRef.current = true;
        scrollToBottomSettled();
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }

  // Re-parsing on every render is cheap (pure JSON.parse over cached
  // strings), but memoizing keeps it off the hot path of unrelated re-renders
  // (e.g. sidebar toggles) that don't change `timeline.lines`.
  const parsed = useMemo(() => timeline.lines.map(parseTranscriptLine), [timeline.lines]);
  // Absolute byte offsets, one per cached line — stable Preact keys across a
  // "load older" prepend (see transcript-model.ts's lineByteOffsets doc).
  const offsets = useMemo(
    () => lineByteOffsets(timeline.start, timeline.lines),
    [timeline.start, timeline.lines],
  );
  // Tools folding (kawaz spec): boundary lines (user prompts / assistant
  // user-facing final responses) stay standalone entries, everything between
  // them collapses into one fold group — see transcript-model.ts's
  // groupTimelineLines doc comment.
  const groups = useMemo(() => groupTimelineLines(parsed, offsets), [parsed, offsets]);
  // groups.map (render 本体) が毎レンダー classifyBoundaryLine を呼び直す
  // と、"👤 N/M" nav の scroll ハンドラ (rAF スロットル済みとはいえ
  // currentUserIdx の setState 経由で毎回 Timeline 全体を再レンダーさせる)
  // のたびに全 boundary entry を再分類することになり、長い transcript +
  // 大きい task-notification 本文 (ccmsg 判定側の JSON.parse を含む) で
  // scroll 中の CPU を無駄に食う。groups が変わった時だけ計算しメモ化する
  // (index を groups と揃え、entry 以外は使わないので null のまま)。
  const boundaries = useMemo(
    () =>
      groups.map((g) =>
        g.kind === "entry" && g.line.kind === "turn" ? classifyBoundaryLine(g.line) : null,
      ),
    [groups],
  );

  // --- "👤 N/M" user-turn nav (kawaz spec): toolbar buttons to jump to the
  // top/bottom of the loaded transcript and to the previous/next user-text
  // turn, plus a live "current position" counter. ---

  // Preact-key (byte offset, stable across prepend) of every currently-loaded
  // user-text turn, in document order — the "M" denominator and the index
  // space goPrevUserTurn/goNextUserTurn/scrollPositionToUserTurnIndex work in.
  const userTurnKeys = useMemo(
    () =>
      parsed
        .map((line, i) => (isUserTextTurn(line) ? offsets[i] : null))
        .filter((k): k is number => k !== null),
    [parsed, offsets],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // key (byte offset) -> mounted DOM node for each user-text turn, populated
  // by LineView's ref callback. Only ever read for keys currently in
  // userTurnKeys; entries for turns dropped by a "更新" (replace) reload are
  // pruned below rather than left to leak.
  const userTurnRefs = useRef(new Map<number, HTMLDivElement>());
  const registerUserTurnRef = useCallback((key: number, el: HTMLDivElement | null) => {
    if (el) userTurnRefs.current.set(key, el);
    else userTurnRefs.current.delete(key);
  }, []);

  // 1-based "you're currently past turn N" count (0 = scrolled above the
  // first loaded user turn). Recomputed on scroll (rAF-throttled) and
  // whenever the loaded lines change (older-load/refresh shift both the
  // denominator and which turn is "current").
  const [currentUserIdx, setCurrentUserIdx] = useState(0);

  const recomputeCurrentUserIdx = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const tops = userTurnKeys
      .map((key) => userTurnRefs.current.get(key))
      .filter((el): el is HTMLDivElement => el != null)
      .map((el) => el.getBoundingClientRect().top - containerTop + container.scrollTop);
    setCurrentUserIdx(scrollPositionToUserTurnIndex(tops, container.scrollTop));
  }, [userTurnKeys]);

  // Live tail 自動スクロール追従 (kawaz spec) のための「今ユーザは最下部付近
  // を見ているか」フラグ。scroll イベント (下の rAF スロットル済み onScroll)
  // でだけ更新する ref — レンダーごとの再計算は不要 (DOM 位置に依存する値を
  // state に上げると余計な再レンダーを誘発するため、ref に留める)。初期値
  // true: マウント直後 (まだ何もスクロールしていない状態) は「最下部相当」
  // とみなし、直後に届く tail に自然に追従させる。
  const isNearBottomRef = useRef(true);
  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distance < NEAR_BOTTOM_PX;
  }, []);

  useEffect(() => {
    // Drop refs for turns that no longer exist post-reload (a "更新" replace
    // swaps in an entirely new key set) so the Map doesn't accumulate
    // detached nodes across repeated refreshes.
    const validKeys = new Set(userTurnKeys);
    for (const key of userTurnRefs.current.keys()) {
      if (!validKeys.has(key)) userTurnRefs.current.delete(key);
    }

    const container = scrollRef.current;
    if (!container) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        recomputeCurrentUserIdx();
        checkNearBottom();
        ticking = false;
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    // Recompute once immediately — otherwise the indicator stays "0/M" until
    // the first scroll event fires (e.g. right after the initial tail load).
    recomputeCurrentUserIdx();
    checkNearBottom();
    return () => container.removeEventListener("scroll", onScroll);
  }, [userTurnKeys, recomputeCurrentUserIdx, checkNearBottom]);

  // セッション切替時、前セッションの「どこまで読んだか (byte end)」を引き
  // 継がないようにリセットする — このリセットを先に走らせておくことで、下の
  // tail 検知 effect が「セッション切替による end の変化」を「tail 追記」と
  // 誤認して意図しない自動スクロールを起こさない (両 effect の実行順序は
  // 定義順、[sid] だけに依存するこの effect が先に走る)。
  //
  // 追加 (kawaz r15 mid=7、2026-07-14): mount / sid 切替直後にも最下部へ
  // スクロールする。既存 tail-append effect は `timeline.end` の伸びに反応
  // する形式なので、cache がすでに埋まった状態 (前訪問済 or 再訪 revalidate)
  // で end が変わらないケースで scroll が発火せず「一番上のまま」になる
  // ことがあった。setTimeout(0) で initial render 完了を待ってから scroll
  // を書く — mount 直後の scrollHeight は content flush 前で 0 相当のため。
  const prevEndRef = useRef(timeline.end);
  // mount / sid 切替直後の末尾ジャンプは 0ms 1 発でなく間隔を空けて数回書く
  // (kawaz r17 mid=26): fold group / 画像 / フォントで paint 後に scrollHeight
  // が伸びるケースを 1 発では取り零す。ユーザが先に手動スクロールして末尾から
  // 離れたら (isNearBottomRef が false になったら) 以降の書き込みは中断。
  const scrollToBottomSettled = useCallback(() => {
    const ids = [0, 60, 300].map((ms) =>
      setTimeout(() => {
        const el = scrollRef.current;
        if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
      }, ms),
    );
    return () => ids.forEach(clearTimeout);
  }, []);
  useEffect(() => {
    prevEndRef.current = timeline.end;
    isNearBottomRef.current = true;
    return scrollToBottomSettled();
    // 依存は [sid] のみ意図的 — timeline.end を含めると「セッション切替
    // 検知」ではなく毎回の tail 追記でもリセットされてしまい、下の
    // tail-append effect の appended 判定が常に false になってしまう。
  }, [sid]);

  // Live tail で新しい行が追記されたとき (`timeline.end` が伸びる) だけ、か
  // つユーザが最下部付近を見ているときだけ自動スクロールする (kawaz spec)。
  // `end` は「load older」prepend では変わらない (applyTimelineLoaded) の
  // で、この条件は自然に prepend を除外し、tail 追記 (と初回 tail ロード)
  // だけに反応する。smooth アニメーションなし — 高頻度で届く tail 行ごとに
  // アニメーションが重なるとかえって読みにくいため、即座にジャンプする。
  useEffect(() => {
    const appended = timeline.end > prevEndRef.current;
    prevEndRef.current = timeline.end;
    if (!appended || !isNearBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.end]);

  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function scrollToUserTurn(oneBasedIdx: number) {
    const key = userTurnKeys[oneBasedIdx - 1];
    if (key === undefined) return;
    userTurnRefs.current.get(key)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // No "turn 0" — prev is only meaningful once we've passed at least a
  // second turn (currentUserIdx <= 1 means we're at/before the first).
  function goPrevUserTurn() {
    if (currentUserIdx <= 1) return;
    scrollToUserTurn(currentUserIdx - 1);
  }

  function goNextUserTurn() {
    if (currentUserIdx >= userTurnKeys.length) return;
    scrollToUserTurn(currentUserIdx + 1);
  }

  if (timeline.status === "idle" || (timeline.status === "loading" && parsed.length === 0)) {
    return (
      <div class="timeline-view">
        <p class="tl-loading">読み込み中…</p>
      </div>
    );
  }

  return (
    <div class="timeline-view" ref={scrollRef}>
      <div class="tl-toolbar">
        <button
          type="button"
          disabled={timeline.atStart || timeline.status === "loading"}
          onClick={loadOlder}
        >
          {timeline.atStart ? "先頭まで読み込み済み" : "older を読み込む"}
        </button>
        <button type="button" disabled={timeline.status === "loading"} onClick={refresh}>
          更新
        </button>
        <button type="button" onClick={scrollToTop} title="最上部へ">
          ⤒
        </button>
        <button type="button" onClick={scrollToBottom} title="最下部へ">
          ⤓
        </button>
        <div class="tl-user-nav">
          <span class="tl-user-nav-count">
            👤 {currentUserIdx}/{userTurnKeys.length}
          </span>
          <button
            type="button"
            disabled={currentUserIdx <= 1}
            onClick={goPrevUserTurn}
            title="前のユーザ発言へ"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={currentUserIdx >= userTurnKeys.length}
            onClick={goNextUserTurn}
            title="次のユーザ発言へ"
          >
            ↓
          </button>
        </div>
      </div>
      {timeline.status === "error" ? (
        <div class="tl-error">
          <p>{timeline.error}</p>
          <button type="button" onClick={refresh}>
            再試行 (tail から読み直す)
          </button>
        </div>
      ) : (
        <div class="tl-lines">
          {parsed.length === 0 ? (
            <p class="tl-empty">(空の transcript)</p>
          ) : (
            // 同一 ccmsg event (room + ts + from) が transcript の複数箇所から
            // 抽出されるとき (queue-operation enqueue と task-notification 経由の
            // Monitor tool_result 両方に載っているケース、kawaz r15 mid=21、
            // 2026-07-14) の二重表示を避ける。この Set は本 iteration 内でだけ
            // 変化させる: React/Preact の render は同期 1 pass なので closure
            // 越しの mutation で問題ないが、次回 render では新規 Set が必要
            // (前回の Set を持ち越さない) — なので groups.map の直前でリセット
            // される形にしておく。
            ((seenCcmsg: Set<string>) =>
              groups.map((group, i) => {
                if (group.kind === "fold") {
                  return (
                    <FoldGroup
                      key={group.entries[0]!.offset}
                      entries={group.entries}
                      translatorAvailable={translatorAvailable}
                    />
                  );
                }
                const { line, offset } = group;
                // line.kind !== "turn" (meta/broken) は classifyBoundaryLine が
                // 絶対に boundary と判定しない (groupTimelineLines がそれらを
                // fold group に送るので groups の "entry" 側には来ない) —
                // ここでの line.kind==="turn" ガードは型ナローイングのためだが、
                // 実データ上も自明に成り立つ。
                if (line.kind !== "turn") return null;
                // boundaries[i] は上の useMemo で groups と同じ index で
                // 計算済み (render のたびの再分類を避けるため)。
                const boundary = boundaries[i]!;
                if (boundary === null) return null;
                switch (boundary.kind) {
                  case "user-prompt":
                    return (
                      <UserPromptBubble
                        key={offset}
                        line={line}
                        offsetKey={offset}
                        registerUserTurnRef={registerUserTurnRef}
                        translatorAvailable={translatorAvailable}
                        now={now}
                      />
                    );
                  case "assistant-response":
                    return (
                      <AssistantBubble
                        key={offset}
                        line={line}
                        translatorAvailable={translatorAvailable}
                        now={now}
                      />
                    );
                  case "ccmsg": {
                    const rawText = line.segments
                      .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
                      .map((s) => s.text)
                      .join("\n");
                    return boundary.messages
                      .map((m, j) => {
                        const dedupKey = `${m.room}|${m.ts}|${m.from}|${m.msg}`;
                        if (seenCcmsg.has(dedupKey)) return null;
                        seenCcmsg.add(dedupKey);
                        return (
                          <CcmsgBubble
                            key={`${offset}-${j}`}
                            message={m}
                            rawText={rawText}
                            now={now}
                          />
                        );
                      })
                      .filter((n) => n !== null);
                  }
                }
              }))(new Set<string>())
          )}
        </div>
      )}
    </div>
  );
}
