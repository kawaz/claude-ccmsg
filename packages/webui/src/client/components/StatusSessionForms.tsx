// The Status tab's セッション操作 (DR-0028 「restart」, DR-0018 §3.9): a list of
// the two operations that start a session in this session's cwd, each a row
// with what it does and a button that opens its form in a modal dialog —
// 新セッションを起動, a new session there, and 再起動, the restart's prompt.
//
// A form is mounted while its dialog is open, so it opens each time on its
// defaults — what the person saved for the cwd, else the built-in ones — and
// what was left in it goes with the closing. A send that comes to what it was
// for (a launch whose command exits 0, a restart that resumed) closes the
// dialog; one that does not keeps it open with what went wrong, the text kept
// to try again. Either way what it came to shows under the list too, outside
// the dialog, so it stays after the dialog closes (and, for a restart, after
// the panel itself goes and comes back while the session is between
// processes).
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
import { ModalDialog } from "./ModalDialog.tsx";
import { LaunchResultPanel, PicklistField, type LaunchState } from "./SessionCreator.tsx";
import type { SessionRestart, SessionRestartResult } from "./StatusPanel.tsx";

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

/** Focuses the prompt as the form opens, the caret after its text: the person
 * either sends it or adds to it. The textarea also carries `autofocus`:
 * `showModal()` moves the focus to the dialog's autofocus element (else its
 * first focusable one, the 戻る / ×) when it opens, after this has run. */
function useFocusAtEnd(): (el: HTMLTextAreaElement | null) => void {
  return useCallback((el: HTMLTextAreaElement | null) => {
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
}

/** The key that sends from the prompt, as the hint under it (the sidebar's
 * 新規セッション says it in the placeholder; this prompt opens with text in
 * it, so a placeholder would not be seen). Not shown on a touch screen
 * (app.css), which has no ⌘ / Ctrl. */
function SendKeys({ action }: { action: string }) {
  return <span class="session-creator-hint session-creator-keys">⌘+Enter で{action}</span>;
}

/** Whether a launch came to a session: the command ran and exited 0. */
function launchSucceeded(state: LaunchState): boolean {
  return state.status === "done" && state.result.exit_code === 0;
}

/** A launch from the Status tab as it runs and what it came to. Held above
 * the dialogs: while it runs, the restart's send and the kill wait. */
export interface StatusLaunch {
  state: LaunchState;
  /** Launch; settles with what it came to. */
  start: (launch: LaunchInput) => Promise<LaunchState>;
}

export function useStatusLaunch(): StatusLaunch {
  const { ws } = useApp();
  const [state, setState] = useState<LaunchState>({ status: "idle" });
  return {
    state,
    start: (launch) => {
      setState({ status: "running" });
      return ws
        .sessionLaunch({ launch })
        .then(
          (res): LaunchState =>
            res.ok
              ? { status: "done", result: res }
              : { status: "error", message: launchErrorText(res.error).text },
        )
        .catch(
          (err: unknown): LaunchState => ({
            status: "error",
            message: `起動したか確かめられなかった: ${errorMessage(err)}`,
          }),
        )
        .then((settled) => {
          setState(settled);
          return settled;
        });
    },
  };
}

/** What a launch from here came to, under the list (and in the dialog when it
 * did not come to a session). Nothing before the first launch. */
function LaunchResultCard({ state }: { state: LaunchState }) {
  if (state.status === "idle") return null;
  const tone = state.status === "running" ? "running" : launchSucceeded(state) ? "ok" : "error";
  return (
    <div class="status-op-result status-launch-result" data-tone={tone}>
      <p class="status-op-result-title">新セッションを起動</p>
      <LaunchResultPanel state={state} />
    </div>
  );
}

/** What a restart came to, under the list (and in the dialog when it did not
 * resume). */
function RestartResultCard({ result }: { result: SessionRestartResult }) {
  return (
    <div class="status-op-result status-restart-result" data-tone={result.ok ? "ok" : "error"}>
      <p>{result.text}</p>
      {result.output?.stdout ? <pre>{result.output.stdout}</pre> : null}
      {result.output?.stderr ? <pre>{result.output.stderr}</pre> : null}
    </div>
  );
}

type LauncherProbe =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | { status: "ready"; defaultEfforts: DefaultEfforts };

function probeText(probe: Exclude<LauncherProbe, { status: "ready" }>): string {
  if (probe.status === "loading") return "確認中…";
  if (probe.status === "error") return probe.message;
  return "daemon にセッションの起動が設定されていません (docs/runbooks/session-launcher-setup.md)";
}

function LaunchForm({
  cwd,
  runsAs,
  launch,
  blocked,
  onLaunched,
}: {
  cwd: string;
  runsAs: { model?: LaunchModel; effort?: LaunchEffort };
  launch: StatusLaunch;
  blocked: boolean;
  onLaunched: () => void;
}) {
  const { ws } = useApp();
  const [probe, setProbe] = useState<LauncherProbe>({ status: "loading" });
  const [stored, setStored] = useState(() => readDefaults(cwd));
  const [form, setForm] = useState<SessionCreatorForm>(() =>
    initialLaunchForm(cwd, stored.launch, runsAs),
  );
  // Reasons show once a launch was refused, then follow the edits.
  const [showIssues, setShowIssues] = useState(false);
  // Whether a launch was sent from this opening: what it came to shows here
  // only then, not what an earlier opening's launch came to.
  const [sent, setSent] = useState(false);
  const focusPrompt = useFocusAtEnd();

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

  if (probe.status !== "ready") {
    return (
      <div class="modal-dialog-body">
        <p class={probe.status === "loading" ? "status-empty" : "session-creator-error"}>
          {probeText(probe)}
        </p>
      </div>
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
    setSent(true);
    void launch.start(read.launch).then((settled) => {
      if (launchSucceeded(settled)) onLaunched();
    });
  }

  // ⌘/Ctrl+Enter launches through the form's own submit, as in SessionCreator.
  function launchOnModEnter(e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void {
    if (!shouldSendOnKeyDown(e)) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }

  return (
    <div class="modal-dialog-body">
      <form class="session-creator-form status-launch-form" onSubmit={submit}>
        <div class="session-creator-field">
          <span class="session-creator-label">cwd</span>
          <span class="session-creator-cwd-value">{cwd}</span>
        </div>
        <fieldset class="session-creator-fieldset" disabled={running}>
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
          <label class="session-creator-field">
            <span class="session-creator-label">PROMPT</span>
            <textarea
              ref={focusPrompt}
              autoFocus
              class="session-creator-prompt"
              value={form.prompt}
              onInput={(e) => update({ prompt: e.currentTarget.value })}
              onKeyDown={launchOnModEnter}
            />
            <SendKeys action="起動" />
          </label>
        </fieldset>
        {issues.prompt !== undefined ? <p class="session-creator-error">{issues.prompt}</p> : null}
        {check && !check.ok
          ? check.general.map((message) => (
              <p key={message} class="session-creator-error">
                {message}
              </p>
            ))
          : null}
        <div class="session-creator-actions">
          <button type="submit" class="session-creator-submit" disabled={blocked}>
            {running ? "起動中…" : "起動"}
          </button>
          <button
            type="button"
            class="session-creator-secondary"
            disabled={saved || asDefault === null || running}
            onClick={() => {
              if (asDefault !== null) setStored(saveDefaults(cwd, { launch: asDefault }));
            }}
          >
            {saveLabel(saved)}
          </button>
        </div>
        {sent && !running ? <LaunchResultCard state={launch.state} /> : null}
      </form>
    </div>
  );
}

function RestartForm({
  cwd,
  restart,
  blocked,
  onRestarted,
}: {
  cwd: string | null;
  restart: SessionRestart;
  blocked: boolean;
  onRestarted: () => void;
}) {
  const [stored, setStored] = useState(() => (cwd === null ? null : readDefaults(cwd)));
  const [draft, setDraft] = useState(() => stored?.restart?.prompt ?? RESTART_PROMPT);
  // Whether a restart was sent from this opening (see LaunchForm's `sent`).
  const [sent, setSent] = useState(false);
  const focusDraft = useFocusAtEnd();
  const empty = draft.trim() === "";
  const saved = stored?.restart?.prompt === draft;

  function send(): void {
    if (empty || blocked) return;
    setSent(true);
    void restart.start(draft).then((result) => {
      if (result.ok) onRestarted();
    });
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

  return (
    <div class="modal-dialog-body">
      <form class="session-creator-form status-restart-form" onSubmit={submit}>
        <fieldset class="session-creator-fieldset" disabled={restart.busy}>
          <label class="session-creator-field">
            <span class="session-creator-label">再起動後の PROMPT</span>
            <textarea
              ref={focusDraft}
              autoFocus
              class="session-creator-prompt"
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={sendOnModEnter}
            />
            <SendKeys action="再起動" />
          </label>
        </fieldset>
        <div class="session-creator-actions">
          <button type="submit" class="session-creator-submit" disabled={blocked || empty}>
            {restart.busy ? "再起動中…" : "再起動"}
          </button>
          {cwd === null ? null : (
            <button
              type="button"
              class="session-creator-secondary"
              disabled={saved || restart.busy}
              onClick={() => setStored(saveDefaults(cwd, { restart: { prompt: draft } }))}
            >
              {saveLabel(saved)}
            </button>
          )}
        </div>
        {sent && restart.result !== null ? <RestartResultCard result={restart.result} /> : null}
      </form>
    </div>
  );
}

/** One row of an operations list: what it is, one line on what it does, and
 * the button that does it at the end. The danger zone's kill is a row of the
 * same shape. With `onPress`, a click anywhere in the row does what its button
 * does (the button stays the one thing the keyboard reaches); the kill's row
 * has none, so only its button ends the session. */
export function ActionRow({
  name,
  description,
  onPress,
  children,
}: {
  name: string;
  description: string;
  onPress?: (() => void) | undefined;
  children: JSX.Element;
}) {
  return (
    <li
      class={onPress ? "status-action status-action-pressable" : "status-action"}
      onClick={onPress}
    >
      <span class="status-action-what">
        <span class="status-action-name">{name}</span>
        <span class="status-action-desc">{description}</span>
      </span>
      {children}
    </li>
  );
}

/** セッション操作: 新セッションを起動 (a new session in this session's cwd,
 * with the model, effort and prompt chosen in its dialog and nothing else — no
 * name, no resume) and 再起動 (`restartShown`), each opening its dialog. */
export function SessionActions({
  cwd,
  runsAs,
  launch,
  restart,
  restartShown,
  blocked,
}: {
  cwd: string | null;
  runsAs: { model?: LaunchModel; effort?: LaunchEffort };
  launch: StatusLaunch;
  restart: SessionRestart;
  restartShown: boolean;
  /** Something of the tab's (a launch, a restart, the kill) is running: the
   * sends wait. */
  blocked: boolean;
}) {
  const [opened, setOpened] = useState<"launch" | "restart" | null>(null);
  const close = () => setOpened(null);
  const openLaunch = cwd === null ? undefined : () => setOpened("launch");
  const openRestart = () => setOpened("restart");
  return (
    <section class="status-section status-session-actions">
      <h3 class="status-section-title">セッション操作</h3>
      <ul class="status-actions">
        <ActionRow
          name="新セッションを起動"
          description={
            cwd === null
              ? "このセッションの cwd が分からないので起動できません (切断中)"
              : "このセッションと同じ cwd で、別のセッションを立てる"
          }
          onPress={openLaunch}
        >
          <button type="button" class="status-action-open" disabled={openLaunch === undefined}>
            起動
          </button>
        </ActionRow>
        {restartShown ? (
          <ActionRow
            name="再起動"
            description="止めてから同じ session_id で resume する"
            onPress={openRestart}
          >
            <button type="button" class="status-action-open">
              再起動
            </button>
          </ActionRow>
        ) : null}
      </ul>
      <LaunchResultCard state={launch.state} />
      {restart.result ? <RestartResultCard result={restart.result} /> : null}
      {opened === "launch" && cwd !== null ? (
        <ModalDialog
          title="新セッションを起動"
          closable={launch.state.status !== "running"}
          onClose={close}
        >
          <LaunchForm
            cwd={cwd}
            runsAs={runsAs}
            launch={launch}
            blocked={blocked}
            onLaunched={close}
          />
        </ModalDialog>
      ) : null}
      {opened === "restart" ? (
        <ModalDialog title="再起動" closable={!restart.busy} onClose={close}>
          <RestartForm cwd={cwd} restart={restart} blocked={blocked} onRestarted={close} />
        </ModalDialog>
      ) : null}
    </section>
  );
}
