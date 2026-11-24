// The one split button under a text being sent (DR-0062 §3, §15): the FAB's
// input and the comment form both have it. One frame holds three sides, left
// to right btw, 後で and 送る, and one of them is chosen (送る unless the
// holder starts it otherwise). Pressing a side that is not chosen chooses it
// and runs nothing; pressing the chosen side runs it, as ⌘Enter in the
// textarea does. On a touch screen, 後で or btw is two taps on the same place.
// The choice is kept nowhere: whoever holds it starts it each time the box
// opens. Where btw and 後で are not offered, 送る stands alone.
import type { ComponentChildren } from "preact";
import { useKeepsComposeFocus } from "./compose-focus.ts";

/** What the chosen side does: send now (送る), ask a fork (btw), or keep it
 * to send later (後で). */
export type SendMode = "now" | "btw" | "later";

type Side = {
  /** The text drawn on the side: the same whichever side is chosen. */
  readonly text: string;
  /** The side's name while it is chosen: what pressing it runs. */
  readonly run: string;
  readonly title?: string;
};

const SIDES: Readonly<Record<SendMode, Side>> = {
  btw: { text: "btw", run: "btw で聞く", title: "本体の会話に入れず、fork に聞く" },
  later: { text: "後で", run: "後で 溜める", title: "キューに置き、💬 のフィルタから送る" },
  now: { text: "送る", run: "送る" },
};

const ORDER: readonly SendMode[] = ["btw", "later", "now"];

/** A side's name while it is not chosen: pressing it chooses it. */
function chooseName(text: string): string {
  return `${text} に切り替える`;
}

export function SendSplitButton({
  chosen,
  offered,
  runnable,
  busy,
  onChoose,
  onRun,
  sendText = SIDES.now.text,
  runTitle,
  sendBadge,
}: {
  chosen: SendMode;
  /** btw and 後で are offered: false leaves 送る alone, chosen. */
  offered: boolean;
  /** The chosen side can run now (a text to send, no upload under way). */
  runnable: boolean;
  /** A send is under way: no side can be pressed. */
  busy: boolean;
  onChoose: (side: SendMode) => void;
  onRun: () => void;
  /** 送る's text where 送る runs something else (直す, changing a queued draft). */
  sendText?: string;
  /** The chosen side's title in place of its own. */
  runTitle?: string;
  /** Drawn over 送る's corner (the count of what goes before the text). */
  sendBadge?: ComponentChildren;
}) {
  // The textarea keeps the focus (compose-focus.ts).
  const keepFocus = useKeepsComposeFocus();
  const sides = offered ? ORDER : (["now"] as const);
  const current: SendMode = offered ? chosen : "now";
  return (
    <div class="send-split" role="group" aria-label="送信の形">
      {sides.map((mode) => {
        const side = SIDES[mode];
        const text = mode === "now" ? sendText : side.text;
        const isChosen = mode === current;
        return (
          <button
            key={mode}
            type="button"
            class={`send-split-side send-split-${mode}`}
            aria-current={isChosen ? "true" : undefined}
            aria-label={isChosen ? (mode === "now" ? text : side.run) : chooseName(text)}
            title={isChosen ? (runTitle ?? side.title) : side.title}
            disabled={busy || (isChosen && !runnable)}
            onPointerDown={keepFocus}
            onClick={() => (isChosen ? onRun() : onChoose(mode))}
          >
            {text}
            {mode === "now" ? sendBadge : null}
          </button>
        );
      })}
    </div>
  );
}
