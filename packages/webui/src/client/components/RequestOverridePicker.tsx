/** @jsxImportSource preact */
// The selects of the overrides of a session's requests (DR-0041 §6): one
// native `<select>` per field, its options in `<optgroup>`s, each value
// marked with what it is (request-override-view.ts). The FAB's prompt form
// puts the effort's select with the turn group beside the send, which applies
// it; the ctx line under the Timeline and the Status tab put the session
// override's editor (the model and the effort, the session group only), whose
// [適用] sends the change to the daemon (request_override).
import { useState } from "preact/hooks";
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

/** One field's select: the groups' options, `chosen` the key of the one
 * selected. Closed, it shows the selected option as the browser draws it. */
export function OverrideSelect({
  groups,
  chosen,
  onChoose,
  disabled,
  label,
}: {
  groups: readonly OverrideGroup[];
  chosen: string;
  onChoose: (key: string) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <select
      class="override-select"
      aria-label={label}
      value={chosen}
      disabled={disabled}
      onChange={(e) => onChoose(e.currentTarget.value)}
    >
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
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
  own,
  onChange,
}: {
  field: OverrideField;
  state: RequestOverrideState | undefined;
  own: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
}) {
  const [chosenKey, setChosenKey] = useState(CURRENT_KEY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const groups = overrideGroups(field, state, own, { turn: false, shorten: shortModel });
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
 * ev:"request_override" says of the session, `own` the session's own values
 * (the status snapshot's context). */
export function SessionOverrideEditor({
  state,
  own,
  onChange,
}: {
  state: RequestOverrideState | undefined;
  own: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
}) {
  return (
    <span class="override-editor" role="group" aria-label="通しの上書き">
      <SessionOverrideField field="effort" state={state} own={own} onChange={onChange} />
      <SessionOverrideField field="model" state={state} own={own} onChange={onChange} />
    </span>
  );
}

/** The ctx line under the Timeline with its model and effort as buttons that
 * open the session override's editor. The editor opens as a row of its own
 * below the line: the line itself is cut short with an ellipsis when it is
 * too long, which would cut it too. */
export function ContextLine({
  context,
  state,
  own,
  onChange,
}: {
  context: NonNullable<MiniSummaryLine["context"]>;
  state: RequestOverrideState | undefined;
  own: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
}) {
  const [open, setOpen] = useState(false);
  const { fill, model, effort, tail } = context;
  const button = (view: typeof model) => (
    <button
      type="button"
      class={view.by ? `ctx-value ctx-value-overridden ctx-value-${view.by}` : "ctx-value"}
      title={`${view.title}。押すと通しの上書きを変える`}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {view.text}
    </button>
  );
  return (
    <>
      <span class="tl-status-mini-line tl-status-mini-context">
        {fill} / {button(model)}
        {effort ? <> / {button(effort)}</> : null}
        {tail !== "" ? ` / ${tail}` : null}
      </span>
      {open ? (
        <span
          class="ctx-override-popover"
          role="dialog"
          aria-label="通しの上書き"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <SessionOverrideEditor state={state} own={own} onChange={onChange} />
          <button
            type="button"
            class="ctx-override-close"
            aria-label="閉じる"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </span>
      ) : null}
    </>
  );
}
