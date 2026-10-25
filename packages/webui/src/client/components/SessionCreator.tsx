// New-session form (DR-0018 §3.9)。フォームはサイドバーの中に一覧と並んで
// 出る (Sidebar.tsx)。開いているかどうかとフォームの初期値は URL の `sb.*`
// が持つ — `?sb.panel=new&sb.resume=…` を開けば
// このフォームがその値で立ち上がる (sidebar-url.ts、表は
// docs/design/webui-url-grammar.md)。
//
// path 側に `"session-creator"` を足していないのは、このフォームがメイン
// ペインの中身を置き換えないから: `/s/<sid>/timeline` を開いたまま横で使う
// ものなので、「どこを見ているか」を名乗る path ではなく、それと直交する
// `sb.` の名前空間に属する。
//
// Explicitly out of scope (DR-0018 §2.3): no process tracking after launch.
// The run button's request/response round trip *is* the whole feature — the
// result renders once and nothing here polls, subscribes, or remembers past
// launches.
import { useEffect, useState } from "preact/hooks";
import { launchErrorText, type SessionLaunchResponse } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { sessionHref } from "../locator.ts";
import {
  checkSessionCreatorForm,
  commitCwdInput,
  formContinues,
  formMakesSession,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  LAUNCH_EFFORTS,
  LAUNCH_MODELS,
  shownEffort,
  shownModel,
  type CwdPickerMode,
  type DefaultEfforts,
  type SessionCreatorForm,
} from "../session-creator.ts";
import type { LaunchSeed } from "../sidebar-url.ts";
import { errorMessage } from "../utils.ts";
import { CwdTree } from "./CwdTree.tsx";

type LauncherProbe =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | { status: "ready"; rootDirs: readonly string[]; defaultEfforts: DefaultEfforts };

type LaunchState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; result: SessionLaunchResponse };

/** issue 2026-07-17-session-creator-cwd-picker-unify: the cwd field's two
 * display modes. "confirmed" shows the picked path as text plus an edit (✎)
 * button; "editing" shows a single input that both filters CwdTree (debounced
 * substring match) and accepts a full path typed by hand (Enter commits it
 * directly, for paths deeper than the tree surfaces). Selecting a row in the
 * tree commits the same way. `filterInput` is local — it's transient UI text,
 * not part of the launch, and resets each time editing mode is (re-)entered
 * so the edit button doesn't reopen with stale search text. */
function CwdPicker({
  cwd,
  mode,
  setMode,
  rootDirs,
  onCwdChange,
}: {
  cwd: string;
  mode: CwdPickerMode;
  setMode: (mode: CwdPickerMode) => void;
  rootDirs: readonly string[];
  onCwdChange: (cwd: string) => void;
}) {
  const [filterInput, setFilterInput] = useState("");

  function commit(): void {
    const result = commitCwdInput(filterInput);
    if (!result) return;
    onCwdChange(result.cwd);
    setMode(result.mode);
  }

  if (mode === "confirmed") {
    return (
      <div class="session-creator-cwd-confirmed">
        <span class="session-creator-cwd-value" title={cwd}>
          {cwd}
        </span>
        <button
          type="button"
          class="session-creator-cwd-edit"
          onClick={() => {
            setFilterInput("");
            setMode("editing");
          }}
          aria-label="cwd を編集"
          title="cwd を編集"
        >
          ✎
        </button>
      </div>
    );
  }

  return (
    <>
      <input
        type="text"
        class="session-creator-cwd-input"
        aria-label="cwd"
        placeholder="検索 (パス部分一致)、またはパスを直接入力して Enter"
        value={filterInput}
        onInput={(e) => setFilterInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          commit();
        }}
      />
      <CwdTree
        roots={rootDirs}
        selected={cwd}
        filterInput={filterInput}
        onSelect={(path) => {
          onCwdChange(path);
          setMode("confirmed");
        }}
      />
    </>
  );
}

/** The schema's reason a field cannot be sent, under the field. */
function FieldIssue({ issue }: { issue: string | undefined }) {
  return issue === undefined ? null : <span class="session-creator-issue">{issue}</span>;
}

/** A text field, labelled with claude's option: the session ids in a
 * monospace input, the rest in a plain one. */
function TextField({
  label,
  value,
  placeholder,
  uuid,
  issue,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  uuid?: boolean;
  issue: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <label class="session-creator-field">
      <span class="session-creator-label session-creator-option-name">{label}</span>
      <input
        type="text"
        class={uuid ? "session-creator-uuid-input" : undefined}
        value={value}
        placeholder={placeholder}
        aria-invalid={issue === undefined ? undefined : true}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
      <FieldIssue issue={issue} />
    </label>
  );
}

/** An option without an argument (`--continue`, `--fork-session`). */
function OptionField({
  label,
  checked,
  issue,
  onChange,
}: {
  label: string;
  checked: boolean;
  issue: string | undefined;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label class="session-creator-field session-creator-option">
      <span class="session-creator-label session-creator-option-name">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        aria-invalid={issue === undefined ? undefined : true}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <FieldIssue issue={issue} />
    </label>
  );
}

/** The model or effort select. A form that carries on from a session
 * (`--continue` / `--resume`) may leave it to the launch command, and offers
 * 指定しない; a new session must name one, so its blank is a prompt to choose
 * rather than a choice. */
function PicklistField({
  label,
  options,
  optional,
  value,
  issue,
  onChange,
}: {
  label: string;
  options: readonly string[];
  optional: boolean;
  value: string;
  issue: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <label class="session-creator-field">
      <span class="session-creator-label session-creator-option-name">{label}</span>
      <select
        value={value}
        aria-invalid={issue === undefined ? undefined : true}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        {optional ? (
          <option value="">指定しない</option>
        ) : (
          <option value="" disabled>
            選んでください
          </option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <FieldIssue issue={issue} />
    </label>
  );
}

/** One output of the launch command. An output of 4096 bytes or more arrives
 * as the daemon's `output is <N> bytes, file: <path>` and is shown as it is. */
function LaunchOutput({ label, text }: { label: string; text: string }) {
  return (
    <>
      <p class="session-creator-result-label">{label}</p>
      {text === "" ? (
        <p class="session-creator-hint">出力なし</p>
      ) : (
        <pre class="session-creator-result-body">{text}</pre>
      )}
    </>
  );
}

function LaunchResultPanel({ state }: { state: LaunchState }) {
  if (state.status === "idle") return null;
  if (state.status === "running")
    return <p class="session-creator-status">起動コマンドの終了を待っています…</p>;
  if (state.status === "error") return <p class="session-creator-error">{state.message}</p>;
  const { result } = state;
  return (
    <div class="session-creator-result">
      {result.session_id === undefined ? null : (
        <>
          <p class="session-creator-result-summary">
            session_id: <a href={sessionHref(result.session_id)}>{result.session_id}</a>
          </p>
          <p class="session-creator-hint">
            起動したセッションが daemon に繋がるまでは、開いても中身は空です。
          </p>
        </>
      )}
      <p class="session-creator-result-summary">exit_code: {result.exit_code}</p>
      <LaunchOutput label="stdout" text={result.stdout} />
      <LaunchOutput label="stderr" text={result.stderr} />
    </div>
  );
}

export function SessionCreator({
  onClose,
  seed,
}: {
  onClose: () => void;
  /** `sb.<field>` — the values the URL opens the form with. Read once when the
   * config arrives; the user's edits from then on are the form's own, and are
   * not written back to the address bar (a keystroke is not a navigation). */
  seed: LaunchSeed;
}) {
  const { ws } = useApp();
  const [probe, setProbe] = useState<LauncherProbe>({ status: "loading" });
  const [form, setForm] = useState<SessionCreatorForm | null>(null);
  const [cwdPickerMode, setCwdPickerMode] = useState<CwdPickerMode>("editing");
  // Reasons are shown once a submit was refused, and from then on follow the
  // edits, so a fixed field loses its reason as it is fixed.
  const [showIssues, setShowIssues] = useState(false);
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    void ws
      .sessionLauncherConfig()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setProbe({
            status: "ready",
            rootDirs: res.root_dirs,
            defaultEfforts: res.default_effort,
          });
          const initialForm = initialSessionCreatorForm(seed);
          setForm(initialForm);
          setCwdPickerMode(initialCwdPickerMode(initialForm.cwd));
          setShowIssues(false);
        } else if (res.error.code === "launcher_not_configured") {
          setProbe({ status: "unconfigured" });
        } else {
          setProbe({ status: "error", message: res.error.msg });
        }
      })
      .catch((err) => {
        if (!cancelled) setProbe({ status: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
    // seed は URL 由来なので、別の値で開き直されれば URL が変わり = ここも
    // 張り直される。フォームを開いたまま別の地点から fork する経路がそれで、
    // seed からやり直すのが正しい。
  }, [ws, seed]);

  async function run(e: Event): Promise<void> {
    e.preventDefault();
    if (!form || probe.status !== "ready") return;
    const check = checkSessionCreatorForm(form, probe.defaultEfforts);
    if (!check.ok) {
      setShowIssues(true);
      return;
    }
    setLaunch({ status: "running" });
    try {
      const res = await ws.sessionLaunch({ launch: check.launch });
      if (res.ok) setLaunch({ status: "done", result: res });
      else setLaunch({ status: "error", message: launchErrorText(res.error).text });
    } catch (err) {
      setLaunch({
        status: "error",
        message: `起動したか確かめられなかった: ${errorMessage(err)}`,
      });
    }
  }

  const defaults = probe.status === "ready" ? probe.defaultEfforts : {};
  const check = form && showIssues ? checkSessionCreatorForm(form, defaults) : null;
  const issues = check && !check.ok ? check.issues : {};

  function update(change: Partial<SessionCreatorForm>): void {
    if (form) setForm({ ...form, ...change });
  }

  return (
    <div id="session-creator-panel">
      <div class="session-creator-header">
        <h3>新規セッション</h3>
        <button type="button" class="session-creator-close" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      {probe.status === "loading" ? (
        <p class="session-creator-status">確認中…</p>
      ) : probe.status === "error" ? (
        <p class="session-creator-error">{probe.message}</p>
      ) : probe.status === "unconfigured" ? (
        <div class="session-creator-guidance">
          <p>
            daemon にセッションの起動が設定されていません。daemon の config に session_launcher
            を書き、daemon を再起動してください。
          </p>
          <p>設定例は docs/runbooks/session-launcher-setup.md を参照。</p>
        </div>
      ) : form ? (
        <form class="session-creator-form" onSubmit={(e) => void run(e)}>
          <div class="session-creator-field">
            <span class="session-creator-label">cwd</span>
            <CwdPicker
              cwd={form.cwd}
              mode={cwdPickerMode}
              setMode={setCwdPickerMode}
              rootDirs={probe.rootDirs}
              onCwdChange={(cwd) => update({ cwd })}
            />
            <FieldIssue issue={issues.cwd} />
          </div>
          <PicklistField
            label="--model"
            options={LAUNCH_MODELS}
            optional={formContinues(form)}
            value={shownModel(form)}
            issue={issues.model}
            // The effort follows the model chosen: its default, until chosen.
            onChange={(model) => update({ model, effort: undefined })}
          />
          <PicklistField
            label="--effort"
            options={LAUNCH_EFFORTS}
            optional={formContinues(form)}
            value={shownEffort(form, probe.defaultEfforts)}
            issue={issues.effort}
            onChange={(effort) => update({ effort })}
          />
          <OptionField
            label="--continue"
            checked={form.continue}
            issue={issues.continue}
            onChange={(checked) => update({ continue: checked })}
          />
          <TextField
            label="--resume"
            value={form.resume}
            placeholder="続けるセッションの id"
            uuid
            issue={issues.resume}
            onChange={(resume) => update({ resume })}
          />
          <TextField
            label="--resume-session-at"
            value={form.resume_session_at}
            placeholder="fork 地点の項目の uuid (空なら履歴の先端まで)"
            uuid
            issue={issues.resume_session_at}
            onChange={(resumeSessionAt) => update({ resume_session_at: resumeSessionAt })}
          />
          <OptionField
            label="--fork-session"
            checked={form.fork_session}
            issue={issues.fork_session}
            onChange={(checked) => update({ fork_session: checked })}
          />
          <label class="session-creator-field">
            <span class="session-creator-label session-creator-option-name">--session-id</span>
            <input
              type="text"
              class="session-creator-uuid-input"
              disabled
              value=""
              placeholder={
                formMakesSession(form) ? "自動生成" : "自動生成 (新規と --fork-session の時)"
              }
            />
          </label>
          <TextField
            label="--name"
            value={form.name}
            placeholder="空なら起動コマンドが決める"
            issue={issues.name}
            onChange={(name) => update({ name })}
          />
          <label class="session-creator-field">
            <span class="session-creator-label">PROMPT</span>
            <textarea
              class="session-creator-prompt"
              value={form.prompt}
              placeholder="空なら起動コマンドが決める"
              aria-invalid={issues.prompt === undefined ? undefined : true}
              onInput={(e) => update({ prompt: e.currentTarget.value })}
            />
            <FieldIssue issue={issues.prompt} />
          </label>
          {check && !check.ok
            ? check.general.map((message) => (
                <p key={message} class="session-creator-error">
                  {message}
                </p>
              ))
            : null}
          <button
            type="submit"
            class="session-creator-submit"
            disabled={launch.status === "running"}
          >
            {launch.status === "running" ? "起動中…" : "起動"}
          </button>
        </form>
      ) : null}
      <LaunchResultPanel state={launch} />
    </div>
  );
}
