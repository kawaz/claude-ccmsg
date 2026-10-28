/** @jsxImportSource preact */
// The selects of the overrides of a session's requests (DR-0041 §6): one
// native `<select>` per field, its options in `<optgroup>`s, each value
// marked with what it is (request-override-view.ts). The FAB's prompt form
// puts the effort's select with the turn group beside the send, which applies
// it; the ctx line under the Timeline and the Status tab put the session
// override's editor (the model and the effort, the session group only), whose
// [適用] sends the change to the daemon (request_override).
import { useCallback, useRef, useState } from "preact/hooks";
import type {
  ErrorResponse,
  RequestOverridePatch,
  RequestOverrideResponse,
  RequestOverrideState,
  SessionContextUsage,
} from "@ccmsg/protocol";
import {
  choicePatch,
  chosenOption,
  CURRENT_KEY,
  type OverrideField,
  type OverrideGroup,
  overrideGroups,
  requestOverrideNotice,
} from "../request-override-view.ts";
import { type MiniSummaryLine, shortModel } from "../session-status-view.ts";

/** Change the session override (ws.requestOverride for one session). */
export type SessionOverrideChange = (
  patch: RequestOverridePatch,
) => Promise<RequestOverrideResponse | ErrorResponse>;

/** Open the native picker of a select just drawn for a press. A browser
 * without `showPicker` for a select, or one that refuses it, leaves the
 * select focused: the next press or the keyboard opens it. */
function openPicker(select: HTMLSelectElement): void {
  select.focus();
  try {
    select.showPicker();
  } catch {
    // Not offered here (no `showPicker` for a select, or no user activation
    // left): the focused select is what is left to the person.
  }
}

/** One field's select (DR-0041 §6.1, §6.2). At rest it is text that reads as
 * pressable, the label of the option chosen (`low`, `⏱️high`, `📌high`);
 * pressed, it becomes the native `<select>` of the groups' options with its
 * picker open, and goes back to text once an option is chosen, on blur, or
 * on Escape. `chosen` is the key of the option chosen; `startOpen` draws the
 * select from the start (the ctx line opens a field's straight from its
 * value). */
export function OverrideSelect({
  groups,
  chosen,
  onChoose,
  disabled,
  label,
  startOpen = false,
}: {
  groups: readonly OverrideGroup[];
  chosen: string;
  onChoose: (key: string) => void;
  disabled: boolean;
  label: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  // Closed from the keyboard or by a choice, the text takes the focus back;
  // closed by the focus going elsewhere, it does not take it.
  const refocus = useRef(false);
  const textRef = useCallback((el: HTMLButtonElement | null) => {
    if (el === null || !refocus.current) return;
    refocus.current = false;
    el.focus();
  }, []);
  const selectRef = useCallback((el: HTMLSelectElement | null) => {
    if (el !== null) openPicker(el);
  }, []);
  const option = chosenOption(groups, chosen);
  if (!open || disabled) {
    return (
      <button
        type="button"
        class="override-value"
        aria-label={label}
        aria-haspopup="listbox"
        title={`${label}: 押すと選択肢が開く`}
        disabled={disabled}
        ref={textRef}
        onClick={() => setOpen(true)}
      >
        {option.label}
      </button>
    );
  }
  const close = (focusText: boolean) => {
    refocus.current = focusText;
    setOpen(false);
  };
  return (
    <select
      class="override-select"
      aria-label={label}
      value={option.key}
      ref={selectRef}
      onChange={(e) => {
        onChoose(e.currentTarget.value);
        close(true);
      }}
      // A choice or an Escape that closed it already says where the focus
      // goes; the blur of the select going away does not undo that.
      onBlur={() => {
        if (!refocus.current) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // The Escape is the select's: it does not also close the ctx line's
        // editor around it.
        e.stopPropagation();
        close(true);
      }}
    >
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** One field of the session override (DR-0041 §6.4): its select, the
 * [適用] beside it while an option other than the default is chosen, and
 * what became of the last change. Applied, the select goes back to the
 * default, which ev:"request_override" brings the new value to. */
function SessionOverrideField({
  field,
  state,
  context,
  onChange,
  startOpen,
}: {
  field: OverrideField;
  state: RequestOverrideState | undefined;
  context: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
  startOpen: boolean;
}) {
  const [chosenKey, setChosenKey] = useState(CURRENT_KEY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const groups = overrideGroups(field, state, context, { turn: false, shorten: shortModel });
  const chosen = chosenOption(groups, chosenKey);
  const patch = choicePatch(chosen.choice);
  const apply = async (change: RequestOverridePatch) => {
    setBusy(true);
    setNotice(null);
    try {
      const reply = await onChange(change);
      setNotice(requestOverrideNotice(reply));
      if (reply.ok) setChosenKey(CURRENT_KEY);
    } catch {
      // The socket was not open: nothing was sent, so the choice stays.
      setNotice("送れなかった (daemon に繋がっていない)。繋がり直してから [適用] を押し直す");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="override-field">
      <OverrideSelect
        groups={groups}
        chosen={chosen.key}
        onChoose={(key) => {
          setChosenKey(key);
          setNotice(null);
        }}
        disabled={busy}
        label={`通しの上書き: ${field}`}
        startOpen={startOpen}
      />
      {patch !== null ? (
        <button
          type="button"
          class="override-apply"
          disabled={busy}
          onClick={() => {
            void apply(patch);
          }}
        >
          適用
        </button>
      ) : null}
      {notice ? (
        <span class="override-notice" role="status">
          {notice}
        </span>
      ) : null}
    </span>
  );
}

/** The session override's editor, the same on the ctx line and in the Status
 * tab (DR-0041 §6.4): the effort, then the model. `state` is what
 * ev:"request_override" says of the session, `context` the status snapshot's
 * (its `engine` is the session's own values). `openField` is the field whose
 * select is drawn open from the start. */
export function SessionOverrideEditor({
  state,
  context,
  onChange,
  openField,
}: {
  state: RequestOverrideState | undefined;
  context: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
  openField?: OverrideField;
}) {
  const fields: OverrideField[] = ["effort", "model"];
  return (
    <span class="override-editor" role="group" aria-label="通しの上書き">
      {fields.map((field) => (
        <SessionOverrideField
          key={field}
          field={field}
          state={state}
          context={context}
          onChange={onChange}
          startOpen={field === openField}
        />
      ))}
    </span>
  );
}

/** The ctx line under the Timeline with its model and effort as buttons that
 * open the session override's editor with the pressed field's select open.
 * The editor opens as a row of its own below the line: the line itself is
 * cut short with an ellipsis when it is too long, which would cut it too. */
export function ContextLine({
  line,
  state,
  context,
  onChange,
}: {
  line: NonNullable<MiniSummaryLine["context"]>;
  state: RequestOverrideState | undefined;
  context: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
}) {
  const [open, setOpen] = useState<OverrideField | null>(null);
  const { fill, model, effort, tail } = line;
  const button = (field: OverrideField, view: typeof model) => (
    <button
      type="button"
      class={view.by ? `ctx-value ctx-value-overridden ctx-value-${view.by}` : "ctx-value"}
      title={`${view.title}。押すと通しの上書きを変える`}
      aria-expanded={open !== null}
      onClick={() => setOpen(open === null ? field : null)}
    >
      {view.text}
    </button>
  );
  return (
    <>
      <span class="tl-status-mini-line tl-status-mini-context">
        {fill} / {button("model", model)}
        {effort ? <> / {button("effort", effort)}</> : null}
        {tail !== "" ? ` / ${tail}` : null}
      </span>
      {open !== null ? (
        <span
          class="ctx-override-popover"
          role="dialog"
          aria-label="通しの上書き"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(null);
          }}
        >
          <SessionOverrideEditor
            state={state}
            context={context}
            onChange={onChange}
            openField={open}
          />
          <button
            type="button"
            class="ctx-override-close"
            aria-label="閉じる"
            onClick={() => setOpen(null)}
          >
            ✕
          </button>
        </span>
      ) : null}
    </>
  );
}
