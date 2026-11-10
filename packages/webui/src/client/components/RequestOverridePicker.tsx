/** @jsxImportSource preact */
// The selects of the overrides of a session's requests (DR-0041 §6): one
// native `<select>` per field, its options in `<optgroup>`s, each value
// marked with what it is (request-override-view.ts). The FAB's prompt form
// puts the effort's select with the turn group beside the send, which applies
// it; the ctx line under the Timeline and the Status tab's MODEL and EFFORT
// rows put the session override's fields (the session group only), whose
// [適用] sends the change to the daemon (request_override). The ctx line keeps
// its own text for each value at rest and turns into the field's select where
// the value is.
import { type ComponentChildren, Fragment } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
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

/** How long what became of a change stays on the ctx line, as 「中断しました」
 * (TurnResponding.tsx) does: the line is a summary that is always on screen,
 * and the choice it was about is already back at the default or still with
 * its [適用]. */
export const CTX_LINE_NOTICE_MS = 4_000;

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
 * on Escape. `chosen` is the key of the option chosen. */
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
    // The option's label alone (`📌low`) does not say which field it is, so
    // its accessible name is the field's.
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

/** One field of the session override (DR-0041 §6.4), as the Status tab's
 * MODEL / EFFORT row and the ctx line put it: its select, the
 * [適用] beside it while an option other than the default is chosen, and
 * what became of the last change. Applied, the select goes back to the
 * default, which ev:"request_override" brings the new value to. `noticeMs` is
 * how long what became of the change stays (without it, until the next
 * choice). */
export function SessionOverrideField({
  field,
  state,
  context,
  onChange,
  noticeMs,
}: {
  field: OverrideField;
  state: RequestOverrideState | undefined;
  context: SessionContextUsage | undefined;
  onChange: SessionOverrideChange;
  noticeMs?: number;
}) {
  const [chosenKey, setChosenKey] = useState(CURRENT_KEY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The notice goes after a while where it has one: a timer, synchronised
  // with the notice it belongs to and cleared with it.
  useEffect(() => {
    if (notice === null || noticeMs === undefined) return;
    const timer = setTimeout(() => setNotice(null), noticeMs);
    return () => clearTimeout(timer);
  }, [notice, noticeMs]);
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
        label={field}
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

/** The ctx line under the Timeline (DR-0041 §5), its model and effort each
 * the session override's field in place, the same field the Status tab's
 * MODEL / EFFORT rows hold: at rest the value in force as its select labels
 * it, pressed the field's select where the value is, with [適用] beside it
 * once another option is chosen. What became of a change goes after a while.
 * Each ` / `-separated part is a span of its own, so a line too long for the
 * width breaks between parts, not inside one (`ccmsg` and its version, the
 * model and its window stay together). A part with a page to open (the
 * versions' CHANGELOG entries, DR-0048 §5) is a link to it in a new tab. */
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
  const { usage, tail } = line;
  const field = (name: OverrideField) => (
    <SessionOverrideField
      field={name}
      state={state}
      context={context}
      onChange={onChange}
      noticeMs={CTX_LINE_NOTICE_MS}
    />
  );
  const parts: {
    key: string;
    node: ComponentChildren;
    title?: string;
    tone?: "warn" | "danger";
  }[] = [];
  if (usage) {
    parts.push({ key: "fill", node: usage.fill });
    parts.push({ key: "model", node: field("model") });
    if (usage.effort !== null) parts.push({ key: "effort", node: field("effort") });
  }
  for (const part of tail) {
    const node =
      part.href !== undefined ? (
        <a class="ctx-link" href={part.href} target="_blank" rel="noopener noreferrer">
          {part.text}
        </a>
      ) : (
        part.text
      );
    parts.push({ key: part.key, node, title: part.title, tone: part.tone });
  }
  return (
    <span class="tl-status-mini-line tl-status-mini-context">
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 ? " / " : null}
          <span
            class={[
              "ctx-part",
              ...(part.title !== undefined ? ["ctx-part-titled"] : []),
              ...(part.tone !== undefined ? [`ctx-part-${part.tone}`] : []),
            ].join(" ")}
            title={part.title}
          >
            {part.node}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
