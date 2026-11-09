// The Status tab's session forms (DR-0028 「restart」, DR-0018 §3.9), each a
// fold above the danger zone: 新セッションを起動, a new session in this
// session's cwd, and 再起動, the restart's prompt. A form is mounted while its
// fold is open, so it opens each time on its defaults — what the person saved
// for the cwd, else the built-in ones — and what was left in it goes with the
// closing. What a launch or a restart came to shows under its fold, outside
// it, so closing the fold (or the panel going during a restart) keeps it.
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  launchErrorText,
  RESTART_PROMPT,
  type LaunchEffort,
  type LaunchInput,
  type LaunchModel,
} from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import {
  checkSessionCreatorForm,
  LAUNCH_EFFORTS,
  LAUNCH_MODELS,
  shownEffort,
  shownModel,
  type DefaultEfforts,
  type SessionCreatorForm,
} from "../session-creator.ts";
import {
  initialLaunchForm,
  launchDefaultOf,
  parseStatusFormDefaults,
  sameLaunchDefault,
  serializeStatusFormDefaults,
  statusFormDefaultsStorageKey,
  type StatusFormDefaults,
} from "../status-session-forms.ts";
import { readStorage, writeStorage } from "../storage.ts";
import { errorMessage } from "../utils.ts";
import { shouldSendOnKeyDown } from "./composer-keydown.ts";
import { Fold } from "./Fold.tsx";
import { LaunchResultPanel, PicklistField, type LaunchState } from "./SessionCreator.tsx";
import type { SessionRestart } from "./StatusPanel.tsx";

function readDefaults(cwd: string): StatusFormDefaults {
  return parseStatusFormDefaults(readStorage(statusFormDefaultsStorageKey(cwd)));
}

/** Saves one form's default for `cwd` over what is stored now, so saving one
 * form keeps the other's, and returns what was stored. */
function saveDefaults(
  cwd: string,
  change: Pick<StatusFormDefaults, "launch"> | Pick<StatusFormDefaults, "restart">,
): StatusFormDefaults {
  const next = { ...readDefaults(cwd), ...change };
  writeStorage(statusFormDefaultsStorageKey(cwd), serializeStatusFormDefaults(next));
  return next;
}

/** The save button's label: what the form holds is the saved default, or not
 * yet — the feedback that a save took is the label turning to 保存済み. */
function saveLabel(saved: boolean): string {
  return saved ? "保存済み" : "デフォルトに保存";
}

/** A fold whose open state this side holds, to close it from inside. */
function useFoldOpen(): {
  open: boolean;
  close: () => void;
  onToggle: (e: JSX.TargetedEvent<HTMLDetailsElement, Event>) => void;
} {
  const [open, setOpen] = useState(false);
  return {
    open,
    close: () => setOpen(false),
    onToggle: (e) => setOpen(e.currentTarget.open),
  };
}

/** A launch from the Status tab as it runs and what it came to. Held above
 * the folds: while it runs, the other forms' sends and the kill wait. */
export interface StatusLaunch {
  state: LaunchState;
  start: (launch: LaunchInput) => void;
}

export function useStatusLaunch(): StatusLaunch {
  const { ws } = useApp();
  const [state, setState] = useState<LaunchState>({ status: "idle" });
  return {
    state,
    start: (launch) => {
      setState({ status: "running" });
      ws.sessionLaunch({ launch })
        .then((res) =>
          setState(
            res.ok
              ? { status: "done", result: res }
              : { status: "error", message: launchErrorText(res.error).text },
          ),
        )
        .catch((err: unknown) =>
          setState({
            status: "error",
            message: `起動したか確かめられなかった: ${errorMessage(err)}`,
          }),
        );
    },
  };
}

type LauncherProbe =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | { status: "ready"; defaultEfforts: DefaultEfforts };

function LaunchForm({
  cwd,
  runsAs,
  launch,
  blocked,
  onClose,
}: {
  cwd: string;
  runsAs: { model?: LaunchModel; effort?: LaunchEffort };
  launch: StatusLaunch;
  blocked: boolean;
  onClose: () => void;
}) {
  const { ws } = useApp();
  const [probe, setProbe] = useState<LauncherProbe>({ status: "loading" });
  const [stored, setStored] = useState(() => readDefaults(cwd));
  const [form, setForm] = useState<SessionCreatorForm>(() =>
    initialLaunchForm(cwd, stored.launch, runsAs),
  );
  // Reasons show once a launch was refused, then follow the edits.
  const [showIssues, setShowIssues] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ws.sessionLauncherConfig()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setProbe({ status: "ready", defaultEfforts: res.default_effort });
        else if (res.error.code === "launcher_not_configured") setProbe({ status: "unconfigured" });
        else setProbe({ status: "error", message: res.error.msg });
      })
      .catch((err: unknown) => {
        if (!cancelled) setProbe({ status: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [ws]);

  if (probe.status === "loading") return <p class="status-empty">確認中…</p>;
  if (probe.status === "error") return <p class="status-kill-result">{probe.message}</p>;
  if (probe.status === "unconfigured") {
    return (
      <p class="status-kill-result">
        daemon にセッションの起動が設定されていません (docs/runbooks/session-launcher-setup.md)
      </p>
    );
  }
  const defaults = probe.defaultEfforts;
  const check = showIssues ? checkSessionCreatorForm(form, defaults) : null;
  const issues = check && !check.ok ? check.issues : {};
  const asDefault = launchDefaultOf(form, defaults);
  const saved = sameLaunchDefault(asDefault, stored.launch);
  const running = launch.state.status === "running";

  function update(change: Partial<SessionCreatorForm>): void {
    setForm({ ...form, ...change });
  }

  function submit(e: JSX.TargetedSubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (blocked) return;
    const read = checkSessionCreatorForm(form, defaults);
    if (!read.ok) {
      setShowIssues(true);
      return;
    }
    launch.start(read.launch);
  }

  // ⌘/Ctrl+Enter launches through the form's own submit, as in SessionCreator.
  function launchOnModEnter(e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void {
    if (!shouldSendOnKeyDown(e)) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }

  function closeOnEscape(e: JSX.TargetedKeyboardEvent<HTMLFormElement>): void {
    if (e.key !== "Escape" || e.isComposing || running) return;
    e.preventDefault();
    onClose();
  }

  return (
    <form class="status-session-form" onSubmit={submit} onKeyDown={closeOnEscape}>
      <div class="status-session-form-selects">
        <PicklistField
          label="--model"
          options={LAUNCH_MODELS}
          optional={false}
          value={shownModel(form)}
          issue={issues.model}
          // The effort follows the model chosen: its default, until chosen.
          onChange={(model) => update({ model, effort: undefined })}
        />
        <PicklistField
          label="--effort"
          options={LAUNCH_EFFORTS}
          optional={false}
          value={shownEffort(form, defaults)}
          issue={issues.effort}
          onChange={(effort) => update({ effort })}
        />
      </div>
      <textarea
        class="session-input-textarea"
        aria-label="新セッションの最初の prompt"
        placeholder="新セッションの最初の prompt... (⌘+Enter で起動)"
        value={form.prompt}
        disabled={running}
        onInput={(e) => update({ prompt: e.currentTarget.value })}
        onKeyDown={launchOnModEnter}
      />
      {issues.prompt !== undefined ? <p class="session-creator-error">{issues.prompt}</p> : null}
      {check && !check.ok
        ? check.general.map((message) => (
            <p key={message} class="session-creator-error">
              {message}
            </p>
          ))
        : null}
      <div class="status-kill-buttons">
        <button type="submit" class="status-form-submit" disabled={blocked}>
          {running ? "起動中…" : "起動"}
        </button>
        <button
          type="button"
          class="status-form-save"
          disabled={saved || asDefault === null}
          onClick={() => {
            if (asDefault !== null) setStored(saveDefaults(cwd, { launch: asDefault }));
          }}
        >
          {saveLabel(saved)}
        </button>
      </div>
    </form>
  );
}

/** 新セッションを起動: a new session in this session's cwd, with the model,
 * effort and prompt chosen here and nothing else (no name, no resume). */
export function LaunchFold({
  cwd,
  runsAs,
  launch,
  blocked,
}: {
  cwd: string | null;
  runsAs: { model?: LaunchModel; effort?: LaunchEffort };
  launch: StatusLaunch;
  blocked: boolean;
}) {
  const fold = useFoldOpen();
  return (
    <>
      <Fold
        class="status-launch"
        summaryClass="status-fold-summary"
        summary="新セッションを起動"
        open={fold.open}
        onToggle={fold.onToggle}
      >
        {!fold.open ? null : cwd === null ? (
          <p class="status-empty">このセッションの cwd が分からないので起動できません (切断中)</p>
        ) : (
          <LaunchForm
            cwd={cwd}
            runsAs={runsAs}
            launch={launch}
            blocked={blocked}
            onClose={fold.close}
          />
        )}
      </Fold>
      <LaunchResultPanel state={launch.state} />
    </>
  );
}

function RestartForm({
  cwd,
  restart,
  blocked,
  onClose,
}: {
  cwd: string | null;
  restart: SessionRestart;
  blocked: boolean;
  onClose: () => void;
}) {
  const [stored, setStored] = useState(() => (cwd === null ? null : readDefaults(cwd)));
  const [draft, setDraft] = useState(() => stored?.restart?.prompt ?? RESTART_PROMPT);
  // Focus the text as the form opens, the caret after it: the person either
  // sends it or adds to it.
  const focusDraft = useCallback((el: HTMLTextAreaElement | null) => {
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const empty = draft.trim() === "";
  const saved = stored?.restart?.prompt === draft;

  function send(): void {
    if (empty || blocked) return;
    void restart.start(draft).then(onClose);
  }

  function submit(e: JSX.TargetedSubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    send();
  }

  // ⌘/Ctrl+Enter sends, as in the composer (same judgement); a bare Enter and
  // an IME's confirming Enter stay a newline.
  function sendOnModEnter(e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void {
    if (!shouldSendOnKeyDown(e)) return;
    e.preventDefault();
    send();
  }

  function closeOnEscape(e: JSX.TargetedKeyboardEvent<HTMLFormElement>): void {
    if (e.key !== "Escape" || e.isComposing || restart.busy) return;
    e.preventDefault();
    onClose();
  }

  return (
    <form class="status-restart-form" onSubmit={submit} onKeyDown={closeOnEscape}>
      <textarea
        ref={focusDraft}
        class="session-input-textarea"
        aria-label="再起動後の最初の prompt"
        placeholder="再起動後の最初の prompt... (⌘+Enter で送信)"
        value={draft}
        disabled={restart.busy}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={sendOnModEnter}
      />
      <div class="status-kill-buttons">
        <button type="submit" class="status-form-submit" disabled={blocked || empty}>
          {restart.busy ? "再起動中…" : "再起動"}
        </button>
        {cwd === null ? null : (
          <button
            type="button"
            class="status-form-save"
            disabled={saved || restart.busy}
            onClick={() => setStored(saveDefaults(cwd, { restart: { prompt: draft } }))}
          >
            {saveLabel(saved)}
          </button>
        )}
      </div>
    </form>
  );
}

/** 再起動: the restart's form, its text the resumed session's first prompt. */
export function RestartFold({
  cwd,
  restart,
  blocked,
}: {
  cwd: string | null;
  restart: SessionRestart;
  blocked: boolean;
}) {
  const fold = useFoldOpen();
  return (
    <>
      <Fold
        class="status-restart"
        summaryClass="status-fold-summary"
        summary="再起動"
        open={fold.open}
        onToggle={fold.onToggle}
      >
        {fold.open ? (
          <RestartForm cwd={cwd} restart={restart} blocked={blocked} onClose={fold.close} />
        ) : null}
      </Fold>
      {restart.result ? (
        <div class="status-kill-result status-restart-result">
          <p>{restart.result.text}</p>
          {restart.result.output?.stdout ? <pre>{restart.result.output.stdout}</pre> : null}
          {restart.result.output?.stderr ? <pre>{restart.result.output.stderr}</pre> : null}
        </div>
      ) : null}
    </>
  );
}
