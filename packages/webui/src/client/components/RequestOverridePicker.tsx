/** @jsxImportSource preact */
// The pickers of the overrides of a session's requests (DR-0041 §5): the
// model and the effort, each "上書きなし" or one of the launch's vocabulary.
// The FAB's prompt form uses them for the one-shot override of one send; the
// ctx line under the Timeline and the Status tab use them for the session
// override, which goes to the daemon at once (request_override).
import { useState } from "preact/hooks";
import type {
  ErrorResponse,
  RequestOverride,
  RequestOverridePatch,
  RequestOverrideResponse,
} from "@ccmsg/protocol";
import {
  OVERRIDE_EFFORTS,
  OVERRIDE_MODELS,
  type OverrideField,
  overridePatch,
  pickerValue,
  requestOverrideNotice,
} from "../request-override-view.ts";
import type { MiniSummaryLine } from "../session-status-view.ts";

/** Change the session override (ws.requestOverride for one session, target
 * `session`). */
export type SessionOverrideChange = (
  patch: RequestOverridePatch,
) => Promise<RequestOverrideResponse | ErrorResponse>;

/** The `<select>`s of an override. The effort is the one to change lightly,
 * so it comes first and at hand; the model is a step further in, behind a
 * small disclosure that names the model set, if any (DR-0041 §5). */
export function OverrideFields({
  value,
  onPick,
  disabled,
  label,
}: {
  value: RequestOverride;
  onPick: (field: OverrideField, picked: string) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <span class="override-fields" role="group" aria-label={label}>
      <select
        class="override-select"
        aria-label={`${label}: effort`}
        value={pickerValue(value, "effort")}
        disabled={disabled}
        onChange={(e) => onPick("effort", e.currentTarget.value)}
      >
        <option value="">effort: 上書きなし</option>
        {OVERRIDE_EFFORTS.map((effort) => (
          <option key={effort} value={effort}>
            effort: {effort}
          </option>
        ))}
      </select>
      <details class="override-model">
        <summary>{value.model !== undefined ? `model: ${value.model}` : "model"}</summary>
        <select
          class="override-select"
          aria-label={`${label}: model`}
          value={pickerValue(value, "model")}
          disabled={disabled}
          onChange={(e) => onPick("model", e.currentTarget.value)}
        >
          <option value="">model: 上書きなし</option>
          {OVERRIDE_MODELS.map((model) => (
            <option key={model} value={model}>
              model: {model}
            </option>
          ))}
        </select>
      </details>
    </span>
  );
}

/** The session override's pickers: each pick goes to the daemon as it is
 * made, and what became of it is said beside them. The pickers show `value`,
 * the fields the session override sets to other than the session's own,
 * which ev:"request_override" brings back after a change. */
export function SessionOverrideEditor({
  value,
  onChange,
}: {
  value: RequestOverride;
  onChange: SessionOverrideChange;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pick = async (field: OverrideField, picked: string) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(requestOverrideNotice(await onChange(overridePatch(field, picked))));
    } catch {
      // The socket was not open: nothing was sent.
      setNotice("送れなかった (daemon に繋がっていない)。繋がり直してから選び直す");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="override-editor">
      <OverrideFields
        value={value}
        onPick={(field, picked) => {
          void pick(field, picked);
        }}
        disabled={busy}
        label="通しの上書き"
      />
      {notice ? (
        <span class="override-notice" role="status">
          {notice}
        </span>
      ) : null}
    </span>
  );
}

/** The ctx line under the Timeline with its model and effort as buttons that
 * open the session override's pickers. The pickers open as a row of their
 * own below the line: the line itself is cut short with an ellipsis when it
 * is too long, which would cut them too. */
export function ContextLine({
  context,
  value,
  onChange,
}: {
  context: NonNullable<MiniSummaryLine["context"]>;
  value: RequestOverride;
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
          <SessionOverrideEditor value={value} onChange={onChange} />
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
