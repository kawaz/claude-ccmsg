// The one pill of btw and 後で under a text being sent (DR-0062 §3, §15):
// the FAB's input and the comment form both have it. Split by a line in its
// middle, btw on the left and 後で on the right, each a toggle button. The
// send it shapes is one of three: neither on (sent now), btw (asked of a fork
// now), 後で (kept, sent later from the 💬 filter). Never both: pressing a side
// turns it on and the other off, pressing the side that is on turns both off.
// Both sides can always be pressed. Kept nowhere: whoever holds the mode
// starts it with neither on.

/** What the send does: now (neither side on), btw, or 後で. */
export type SendMode = "now" | "btw" | "later";

/** The mode after the person presses `side` of the pill in `mode`. */
export function pressedSendMode(mode: SendMode, side: "btw" | "later"): SendMode {
  return mode === side ? "now" : side;
}

/** The send button's text in each mode. */
export const SEND_MODE_LABELS: Readonly<Record<SendMode, string>> = {
  now: "送る",
  btw: "btw",
  later: "後で",
};

const SEND_MODE_LABEL_LIST: readonly string[] = Object.values(SEND_MODE_LABELS);

/** The send button's text `shown`, with the other modes' texts drawn hidden
 * in the same cell (the button is an inline grid): pressing a side of the
 * pill does not change the button's width (kawaz 2026-11-22). A hidden text
 * is not in the button's accessible name. */
export function SendModeLabels({ shown }: { shown: string }) {
  return (
    <>
      <span>{shown}</span>
      {SEND_MODE_LABEL_LIST.filter((label) => label !== shown).map((label) => (
        <span key={label} class="session-input-send-off" aria-hidden="true">
          {label}
        </span>
      ))}
    </>
  );
}

export function SendModePill({
  mode,
  onChange,
  disabled,
}: {
  mode: SendMode;
  onChange: (next: SendMode) => void;
  disabled: boolean;
}) {
  return (
    <div class="session-input-segment" role="group" aria-label="送信の形">
      <button
        type="button"
        class="session-input-pill session-input-btw"
        title="本体の会話に入れず、fork に聞く"
        aria-pressed={mode === "btw"}
        disabled={disabled}
        onClick={() => onChange(pressedSendMode(mode, "btw"))}
      >
        btw
      </button>
      <button
        type="button"
        class="session-input-pill session-input-later"
        title="入れるとキューに置き、💬 のフィルタから送る"
        aria-pressed={mode === "later"}
        disabled={disabled}
        onClick={() => onChange(pressedSendMode(mode, "later"))}
      >
        後で
      </button>
    </div>
  );
}
