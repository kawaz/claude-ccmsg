// The Status tab's セッション操作 (DR-0028 「restart」, DR-0018 §3.9): a list of
// the operations that start a session in this session's cwd, each a row with
// what it does and a button that opens its form in a modal dialog —
// 新セッションを起動, a new session there; 再起動, the restart's prompt; and
// fork, a new session on this one's history while this one goes on.
//
// A form is mounted while its dialog is open, so it opens each time on its
// defaults — the prompt the person saved for the cwd, else the built-in one;
// the model and effort the launch's defaults for a new session, what the
// session runs as for a restart and a fork — and
// what was left in it goes with the closing. A send that comes to what it was
// for (a launch or fork whose command exits 0, a restart that resumed) closes the
// dialog; one that does not keeps it open with what went wrong, the text kept
// to try again. Either way what it came to shows under the list too, outside
// the dialog, so it stays after the dialog closes (and, for a restart, after
// the panel itself goes and comes back while the session is between
// processes).
//
// Each form is the FAB's prompt form (SessionInputComposer): its textarea,
// then its row with the selects and the send at the right end — here
// デフォルトに保存 on the left where the FAB's attach button is, and the
// model / effort the session is started (or resumed) with as the FAB's effort
// select (OverrideSelect). Its
// colours are not the FAB's (app.css `.status-prompt-form`), so it does not
// read as the box that writes to the session on screen.
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { launchErrorText, RESTART_PROMPT, type LaunchInput } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import {
  checkSessionCreatorForm,
  LAUNCH_EFFORTS,
  LAUNCH_MODELS,
  shownEffort,
  shownModel,
  type SessionCreatorForm,
} from "../session-creator.ts";
import {
  chooseEffort,
  chooseModel,
  FORK_PROMPT,
  forkLaunch,
  initialLaunchForm,
  parseStatusFormDefaults,
  restartAsk,
  serializeStatusFormDefaults,
  shownRunsAs,
  statusFormDefaultsStorageKey,
  type RunsAs,
  type StatusFormDefaults,
  type StatusFormName,
} from "../status-session-forms.ts";
import { readStorage, writeStorage } from "../storage.ts";
import { errorMessage } from "../utils.ts";
import { shouldSendOnKeyDown } from "./composer-keydown.ts";
import { ModalDialog } from "./ModalDialog.tsx";
import { OverrideSelect, type PickGroup } from "./RequestOverridePicker.tsx";
import { LaunchResultPanel, type LaunchState } from "./SessionCreator.tsx";
import type { SessionRestart, SessionRestartResult } from "./StatusPanel.tsx";

function readDefaults(cwd: string): StatusFormDefaults {
  return parseStatusFormDefaults(readStorage(statusFormDefaultsStorageKey(cwd)));
}

/** Saves one form's prompt as its default for `cwd` over what is stored now,
 * so saving one form keeps the others', and returns what was stored. */
function saveDefaults(cwd: string, form: StatusFormName, prompt: string): StatusFormDefaults {
  const next = { ...readDefaults(cwd), [form]: { prompt } };
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

/** The select of one of the launch's fields (`--model`, `--effort`), its
 * values in one group. While the form holds none of them, a first option
 * `none` says what that stands for. */
function launchPicks(
  field: string,
  values: readonly string[],
  chosen: string,
  none: string,
): PickGroup[] {
  const options = values.map((value) => ({ key: value, label: value }));
  return [
    {
      label: field,
      options: values.includes(chosen) ? options : [{ key: chosen, label: none }, ...options],
    },
  ];
}

/** Why a form was not sent, as the FAB says what kept a send from arriving:
 * a notice above the row. Nothing when there is no reason. */
function FormIssues({ reasons }: { reasons: readonly string[] }) {
  if (reasons.length === 0) return null;
  return (
    <div class="session-input-notice session-input-notice-danger" role="alert">
      {reasons.map((reason) => (
        <p key={reason} class="session-input-notice-detail">
          {reason}
        </p>
      ))}
    </div>
  );
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

/** What a launch from here (新セッションを起動, or a fork) came to, under the
 * list (and in the dialog when it did not come to a session). Nothing before
 * the first launch. */
function LaunchResultCard({
  state,
  title,
  className,
}: {
  state: LaunchState;
  title: string;
  className: string;
}) {
  if (state.status === "idle") return null;
  const tone = state.status === "running" ? "running" : launchSucceeded(state) ? "ok" : "error";
  return (
    <div class={`status-op-result ${className}`} data-tone={tone}>
      <p class="status-op-result-title">{title}</p>
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
  | { status: "ready" };

function probeText(probe: Exclude<LauncherProbe, { status: "ready" }>): string {
  if (probe.status === "loading") return "確認中…";
  if (probe.status === "error") return probe.message;
  return "daemon にセッションの起動が設定されていません (docs/runbooks/session-launcher-setup.md)";
}

/** デフォルトに保存 of a form whose prompt is what it saves. */
function PromptSaveButton({
  cwd,
  form,
  prompt,
  stored,
  onStored,
  disabled,
}: {
  cwd: string;
  form: StatusFormName;
  prompt: string;
  stored: StatusFormDefaults;
  onStored: (stored: StatusFormDefaults) => void;
  disabled: boolean;
}) {
  const saved = stored[form]?.prompt === prompt;
  return (
    <button
      type="button"
      class="session-input-secondary"
      disabled={saved || disabled}
      onClick={() => onStored(saveDefaults(cwd, form, prompt))}
    >
      {saveLabel(saved)}
    </button>
  );
}

/** 新セッションを起動: a new session in the cwd. Its model and effort open on
 * the launch's defaults (`fable` and the model's `DEFAULT_LAUNCH_EFFORT`),
 * whatever the session runs as and whatever was saved; only the prompt is
 * saved as the default. */
function LaunchForm({
  cwd,
  launch,
  blocked,
  onLaunched,
}: {
  cwd: string;
  launch: StatusLaunch;
  blocked: boolean;
  onLaunched: () => void;
}) {
  const { ws } = useApp();
  const [probe, setProbe] = useState<LauncherProbe>({ status: "loading" });
  const [stored, setStored] = useState(() => readDefaults(cwd));
  const [form, setForm] = useState<SessionCreatorForm>(() => initialLaunchForm(cwd, stored.launch));
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
        if (res.ok) setProbe({ status: "ready" });
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
        {probe.status === "loading" ? (
          <p class="status-empty">{probeText(probe)}</p>
        ) : (
          <div class="session-input-notice session-input-notice-danger" role="alert">
            <p class="session-input-notice-detail">{probeText(probe)}</p>
          </div>
        )}
      </div>
    );
  }
  const check = showIssues ? checkSessionCreatorForm(form) : null;
  const issues = check && !check.ok ? check.issues : {};
  const reasons = [
    ...(issues.model !== undefined ? [`--model: ${issues.model}`] : []),
    ...(issues.effort !== undefined ? [`--effort: ${issues.effort}`] : []),
    ...(issues.prompt !== undefined ? [`prompt: ${issues.prompt}`] : []),
    ...(check && !check.ok ? check.general : []),
  ];
  const model = shownModel(form);
  const effort = shownEffort(form);
  const running = launch.state.status === "running";

  function update(change: Partial<SessionCreatorForm>): void {
    setForm({ ...form, ...change });
  }

  function submit(e: JSX.TargetedSubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (blocked) return;
    const read = checkSessionCreatorForm(form);
    if (!read.ok) {
      setShowIssues(true);
      return;
    }
    setSent(true);
    void launch.start(read.launch).then((settled) => {
      if (launchSucceeded(settled)) onLaunched();
    });
  }

  // ⌘/Ctrl+Enter launches through the form's own submit, with the FAB's
  // judgement: a bare Enter and an IME's confirming Enter stay a newline.
  function launchOnModEnter(e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void {
    if (!shouldSendOnKeyDown(e)) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }

  return (
    <div class="modal-dialog-body">
      <form class="status-prompt-form status-launch-form" onSubmit={submit}>
        <p class="status-prompt-where">
          <span>cwd</span>
          <code>{cwd}</code>
        </p>
        <textarea
          ref={focusPrompt}
          autoFocus
          class="session-input-textarea"
          aria-label="新しいセッションの最初の prompt"
          placeholder="空なら起動コマンドが決める (⌘+Enter で起動)"
          value={form.prompt}
          onInput={(e) => update({ prompt: e.currentTarget.value })}
          onKeyDown={launchOnModEnter}
          // As the FAB's: while it is sent, the text stays what was sent.
          readOnly={running}
        />
        <FormIssues reasons={reasons} />
        <div class="session-input-actions">
          <PromptSaveButton
            cwd={cwd}
            form="launch"
            prompt={form.prompt}
            stored={stored}
            onStored={setStored}
            disabled={running}
          />
          <OverrideSelect
            groups={launchPicks("--model", LAUNCH_MODELS, model, "model を選ぶ")}
            chosen={model}
            // A model chosen takes its default effort, over one chosen before.
            onChoose={(chosen) => update({ model: chosen, effort: undefined })}
            disabled={running}
            label="--model"
          />
          <OverrideSelect
            groups={launchPicks("--effort", LAUNCH_EFFORTS, effort, "effort を選ぶ")}
            chosen={effort}
            onChoose={(chosen) => update({ effort: chosen })}
            disabled={running}
            label="--effort"
          />
          <button
            type="submit"
            class="session-input-send"
            title="⌘+Enter でも起動する"
            disabled={blocked}
          >
            {running ? "起動中…" : "起動"}
          </button>
        </div>
        {sent && !running ? (
          <LaunchResultCard
            state={launch.state}
            title="新セッションを起動"
            className="status-launch-result"
          />
        ) : null}
      </form>
    </div>
  );
}

/** The `--model` / `--effort` of a restart or fork: what the session runs as
 * (`runsAs`) until the person chooses, a field the webui cannot name for the
 * session showing as 元の model / 元の effort. A model chosen takes its
 * `DEFAULT_LAUNCH_EFFORT`, over an effort chosen before; an effort may be
 * chosen alone. */
function RunsAsPicks({
  runsAs,
  chosen,
  onChoose,
  disabled,
}: {
  runsAs: RunsAs;
  chosen: RunsAs;
  onChoose: (chosen: RunsAs) => void;
  disabled: boolean;
}) {
  const shown = shownRunsAs(runsAs, chosen);
  return (
    <>
      <OverrideSelect
        groups={launchPicks("--model", LAUNCH_MODELS, shown.model ?? "", "元の model")}
        chosen={shown.model ?? ""}
        onChoose={(value) => {
          const model = LAUNCH_MODELS.find((m) => m === value);
          if (model !== undefined) onChoose(chooseModel(model));
        }}
        disabled={disabled}
        label="--model"
      />
      <OverrideSelect
        groups={launchPicks("--effort", LAUNCH_EFFORTS, shown.effort ?? "", "元の effort")}
        chosen={shown.effort ?? ""}
        onChoose={(value) => {
          const effort = LAUNCH_EFFORTS.find((e) => e === value);
          if (effort !== undefined) onChoose(chooseEffort(chosen, effort));
        }}
        disabled={disabled}
        label="--effort"
      />
    </>
  );
}

/** The 再起動 form: the resumed session's first prompt, and its model and
 * effort, which open on what the session runs as (`RunsAsPicks`). Only what
 * the person chose goes with the request (`restartAsk`): a field left as it
 * opened is the daemon's to fill with what the session runs as, so the
 * session goes on on the same model. Only the prompt is saved as the
 * default. */
function RestartForm({
  cwd,
  runsAs,
  restart,
  blocked,
  onRestarted,
}: {
  cwd: string | null;
  runsAs: RunsAs;
  restart: SessionRestart;
  blocked: boolean;
  onRestarted: () => void;
}) {
  const [stored, setStored] = useState(() => (cwd === null ? null : readDefaults(cwd)));
  const [draft, setDraft] = useState(() => stored?.restart?.prompt ?? RESTART_PROMPT);
  const [chosen, setChosen] = useState<RunsAs>({});
  // Whether a restart was sent from this opening (see LaunchForm's `sent`).
  const [sent, setSent] = useState(false);
  const focusDraft = useFocusAtEnd();
  const empty = draft.trim() === "";

  function send(): void {
    if (empty || blocked) return;
    setSent(true);
    void restart.start(restartAsk(draft, chosen)).then((result) => {
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
      <form class="status-prompt-form status-restart-form" onSubmit={submit}>
        <textarea
          ref={focusDraft}
          autoFocus
          class="session-input-textarea"
          aria-label="再起動後の最初の prompt"
          placeholder="resume したセッションに最初に渡す文 (⌘+Enter で再起動)"
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={sendOnModEnter}
          // As the FAB's: while it is sent, the text stays what was sent.
          readOnly={restart.busy}
        />
        <div class="session-input-actions">
          {cwd === null || stored === null ? null : (
            <PromptSaveButton
              cwd={cwd}
              form="restart"
              prompt={draft}
              stored={stored}
              onStored={setStored}
              disabled={restart.busy}
            />
          )}
          <RunsAsPicks
            runsAs={runsAs}
            chosen={chosen}
            onChoose={setChosen}
            disabled={restart.busy}
          />
          <button
            type="submit"
            class="session-input-send"
            title="⌘+Enter でも再起動する"
            disabled={blocked || empty}
          >
            {restart.busy ? "再起動中…" : "再起動"}
          </button>
        </div>
        {sent && restart.result !== null ? <RestartResultCard result={restart.result} /> : null}
      </form>
    </div>
  );
}

/** The fork form: `session_launch` resuming the session with
 * `fork_session` (`forkLaunch`), the session itself left running. Its first
 * prompt, and its model and effort, which open on what the session runs as
 * (`RunsAsPicks`) and go with the launch as shown — a launch does not fill a
 * field it is not given from the session. Only the prompt is saved as the
 * default, apart from the restart's. */
function ForkForm({
  sid,
  cwd,
  name,
  runsAs,
  fork,
  blocked,
  onForked,
}: {
  sid: string;
  cwd: string;
  name: string;
  runsAs: RunsAs;
  fork: StatusLaunch;
  blocked: boolean;
  onForked: () => void;
}) {
  const [stored, setStored] = useState(() => readDefaults(cwd));
  const [draft, setDraft] = useState(() => stored.fork?.prompt ?? FORK_PROMPT);
  const [chosen, setChosen] = useState<RunsAs>({});
  const [refused, setRefused] = useState<readonly string[]>([]);
  // Whether a fork was sent from this opening (see LaunchForm's `sent`).
  const [sent, setSent] = useState(false);
  const focusDraft = useFocusAtEnd();
  const empty = draft.trim() === "";
  const running = fork.state.status === "running";

  function send(): void {
    if (empty || blocked) return;
    const read = forkLaunch({ sid, cwd, name, prompt: draft, runsAs, chosen });
    if (!read.ok) {
      setRefused(read.failure.issues.map((issue) => issue.message));
      return;
    }
    setRefused([]);
    setSent(true);
    void fork.start(read.value).then((settled) => {
      if (launchSucceeded(settled)) onForked();
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
      <form class="status-prompt-form status-fork-form" onSubmit={submit}>
        <textarea
          ref={focusDraft}
          autoFocus
          class="session-input-textarea"
          aria-label="fork したセッションの最初の prompt"
          placeholder="fork したセッションに最初に渡す文 (⌘+Enter で fork)"
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={sendOnModEnter}
          // As the FAB's: while it is sent, the text stays what was sent.
          readOnly={running}
        />
        <FormIssues reasons={refused} />
        <div class="session-input-actions">
          <PromptSaveButton
            cwd={cwd}
            form="fork"
            prompt={draft}
            stored={stored}
            onStored={setStored}
            disabled={running}
          />
          <RunsAsPicks runsAs={runsAs} chosen={chosen} onChoose={setChosen} disabled={running} />
          <button
            type="submit"
            class="session-input-send"
            title="⌘+Enter でも fork する"
            disabled={blocked || empty}
          >
            {running ? "fork 中…" : "fork"}
          </button>
        </div>
        {sent && !running ? (
          <LaunchResultCard state={fork.state} title="fork" className="status-fork-result" />
        ) : null}
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
 * name, no resume), 再起動 (`restartShown`) and fork (a new session on this
 * one's history, this one left running; it needs the cwd, not the process),
 * each opening its dialog. */
export function SessionActions({
  sid,
  cwd,
  name,
  runsAs,
  launch,
  fork,
  restart,
  restartShown,
  blocked,
}: {
  sid: string;
  cwd: string | null;
  /** The session's name, which the fork's launch carries. */
  name: string;
  /** What the session runs as (`sessionRunsAs`): where the restart's and the
   * fork's model and effort open. */
  runsAs: RunsAs;
  launch: StatusLaunch;
  fork: StatusLaunch;
  restart: SessionRestart;
  restartShown: boolean;
  /** Something of the tab's (a launch, a fork, a restart, the kill) is
   * running: the sends wait. */
  blocked: boolean;
}) {
  const [opened, setOpened] = useState<"launch" | "restart" | "fork" | null>(null);
  const close = () => setOpened(null);
  const openLaunch = cwd === null ? undefined : () => setOpened("launch");
  const openRestart = () => setOpened("restart");
  const openFork = cwd === null ? undefined : () => setOpened("fork");
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
        <ActionRow
          name="fork"
          description={
            cwd === null
              ? "このセッションの cwd が分からないので fork できません (切断中)"
              : "このセッションを続けたまま、同じ履歴の新しいセッションを起動する"
          }
          onPress={openFork}
        >
          <button type="button" class="status-action-open" disabled={openFork === undefined}>
            fork
          </button>
        </ActionRow>
      </ul>
      <LaunchResultCard
        state={launch.state}
        title="新セッションを起動"
        className="status-launch-result"
      />
      {restart.result ? <RestartResultCard result={restart.result} /> : null}
      <LaunchResultCard state={fork.state} title="fork" className="status-fork-result" />
      {opened === "launch" && cwd !== null ? (
        <ModalDialog
          title="新セッションを起動"
          closable={launch.state.status !== "running"}
          onClose={close}
        >
          <LaunchForm cwd={cwd} launch={launch} blocked={blocked} onLaunched={close} />
        </ModalDialog>
      ) : null}
      {opened === "restart" ? (
        <ModalDialog title="再起動" closable={!restart.busy} onClose={close}>
          <RestartForm
            cwd={cwd}
            runsAs={runsAs}
            restart={restart}
            blocked={blocked}
            onRestarted={close}
          />
        </ModalDialog>
      ) : null}
      {opened === "fork" && cwd !== null ? (
        <ModalDialog title="fork" closable={fork.state.status !== "running"} onClose={close}>
          <ForkForm
            sid={sid}
            cwd={cwd}
            name={name}
            runsAs={runsAs}
            fork={fork}
            blocked={blocked}
            onForked={close}
          />
        </ModalDialog>
      ) : null}
    </section>
  );
}
