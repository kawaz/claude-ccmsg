/** @jsxImportSource preact */
// The selects of the overrides of a session's requests (DR-0041 §6): one
// native `<select>` per field, its options in `<optgroup>`s, each value
// marked with what it is (request-override-view.ts). The FAB's prompt form
// puts the effort's select with the turn group beside the send, which applies
// it; the ctx line under the Timeline and the Status tab put the session
// override's fields (the model and the effort, the session group only), whose
// [適用] sends the change to the daemon (request_override). The ctx line keeps
// its own text for each value at rest and turns into the field's select where
// the value is.
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
  type RequestValueView,
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
 * on Escape. `chosen` is the key of the option chosen; `face` is the value as
 * the ctx line shows it (DR-0041 §5), at rest in place of the option's label. */
export function OverrideSelect({
  groups,
  chosen,
  onChoose,
  disabled,
  label,
  face,
}: {
  groups: readonly OverrideGroup[];
  chosen: string;
  onChoose: (key: string) => void;
  disabled: boolean;
  label: string;
  face?: RequestValueView;
}) {
  const [open, setOpen] = useState(false);
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
    // The ctx line's text (`low⁺`) is read as it is, between the line's other
    // parts; the option's label alone (`📌low`) does not say which field it
    // is, so its accessible name is the field's.
    return face !== undefined ? (
      <button
        type="button"
        class={face.by ? `ctx-value ctx-value-overridden ctx-value-${face.by}` : "ctx-value"}
        aria-haspopup="listbox"
        title={`${face.title}。押すと通しの上書きを変える`}
        disabled={disabled}
        ref={textRef}
        onClick={() => setOpen(true)}
      >
        {face.text}
      </button>
    ) : (
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
        if (e.key === "Escape") close(true);
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
 * default, which ev:"request_override" brings the new value to. `face` is the
 * ctx line's text of the value, shown at rest while the default is chosen. */
function SessionOverrideField({
  field,
  state,
  context,
  onChange,
  face,
}: {
  field: OverrideField;
  state: RequestOverrideState | undefined;
  context: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
  face?: RequestValueView;
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
        face={chosen.key === CURRENT_KEY ? face : undefined}
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

/** The session override's editor in the Status tab (DR-0041 §6.4): the
 * effort, then the model. `state` is what ev:"request_override" says of the
 * session, `context` the status snapshot's (its `engine` is the session's own
 * values). */
export function SessionOverrideEditor({
  state,
  context,
  onChange,
}: {
  state: RequestOverrideState | undefined;
  context: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
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
        />
      ))}
    </span>
  );
}

/** The ctx line under the Timeline (DR-0041 §5), its model and effort each
 * the session override's field in place: at rest the line's own text of the
 * value, pressed the field's select where the value is, with [適用] beside it
 * once another option is chosen. */
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
  const { fill, model, effort, tail } = line;
  const field = (name: OverrideField, view: RequestValueView) => (
    <SessionOverrideField
      field={name}
      state={state}
      context={context}
      onChange={onChange}
      face={view}
    />
  );
  return (
    <span class="tl-status-mini-line tl-status-mini-context">
      {fill} / {field("model", model)}
      {effort ? <> / {field("effort", effort)}</> : null}
      {tail !== "" ? ` / ${tail}` : null}
    </span>
  );
}
