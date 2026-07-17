// New-session launcher form (DR-0018 §2.1/§3.4). Sits inside the sidebar's
// SESSIONS section, toggled on by Sidebar's "+ 新規" button, replacing
// SessionList while open — same sidebar-internal-panel pattern
// SessionSearchPanel established (see Sidebar.tsx's doc comment for why a
// locator-driven `state.view` was rejected there): a session-creation form is
// a disposable tool, not a durable/bookmarkable screen, so this deliberately
// does NOT add a `"session-creator"` to store.ts's `View` union despite
// DR-0018 §3.4 sketching it that way — consistency with the established
// sidebar-panel convention won out once an existing precedent existed to
// match (SessionSearchPanel was the first of the two DRs, landed first).
//
// Explicitly out of scope (DR-0018 §2.3): no process tracking after launch.
// The run button's request/response round trip *is* the whole feature —
// stdout/stderr/exit_code/timed_out render once and nothing here polls,
// subscribes, or remembers past launches.
import { useEffect, useState } from "preact/hooks";
import type { SessionLaunchResponse } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { errorMessage } from "../utils.ts";
import {
  buildSessionLaunchRequest,
  initialSessionCreatorForm,
  sessionCreatorFormValid,
  SESSION_CREATOR_EFFORTS,
  SESSION_CREATOR_MODELS,
  type SessionCreatorForm,
} from "../session-creator.ts";
import { CwdTree } from "./CwdTree.tsx";

type LauncherProbe =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | { status: "ready"; rootDirs: string[]; defaultPrompt: string };

type LaunchState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; result: SessionLaunchResponse };

function LaunchResultPanel({ state }: { state: LaunchState }) {
  if (state.status === "idle") return null;
  if (state.status === "running") return <p class="session-creator-status">実行中…</p>;
  if (state.status === "error") return <p class="session-creator-error">{state.message}</p>;
  const { result } = state;
  return (
    <div class="session-creator-result">
      <p class="session-creator-result-summary">
        exit_code: {result.exit_code === null ? "null (シグナル終了)" : result.exit_code}
        {result.timed_out ? " · timeout" : ""}
      </p>
      {result.stdout ? (
        <>
          <p class="session-creator-result-label">stdout</p>
          <pre class="session-creator-result-body">{result.stdout}</pre>
        </>
      ) : null}
      {result.stderr ? (
        <>
          <p class="session-creator-result-label">stderr</p>
          <pre class="session-creator-result-body">{result.stderr}</pre>
        </>
      ) : null}
    </div>
  );
}

export function SessionCreator({ onClose }: { onClose: () => void }) {
  const { ws } = useApp();
  const [probe, setProbe] = useState<LauncherProbe>({ status: "loading" });
  const [form, setForm] = useState<SessionCreatorForm | null>(null);
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    void ws
      .sessionLauncherConfig()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setProbe({ status: "ready", rootDirs: res.root_dirs, defaultPrompt: res.default_prompt });
          setForm(initialSessionCreatorForm(res.default_prompt));
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
  }, [ws]);

  async function run(e: Event): Promise<void> {
    e.preventDefault();
    if (!form) return;
    const req = buildSessionLaunchRequest(form);
    if (!req) return;
    setLaunch({ status: "running" });
    try {
      const res = await ws.sessionLaunch(req);
      if (res.ok) setLaunch({ status: "done", result: res });
      else setLaunch({ status: "error", message: res.error.msg });
    } catch (err) {
      setLaunch({ status: "error", message: errorMessage(err) });
    }
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
            session launcher が未設定です。daemon の config.json に session_launcher
            キーを追加し、daemon を再起動してください。
          </p>
          <p>設定例は docs/runbooks/session-launcher-setup.md を参照。</p>
        </div>
      ) : form ? (
        <form class="session-creator-form" onSubmit={(e) => void run(e)}>
          <div class="session-creator-field">
            <span class="session-creator-label">cwd</span>
            <input
              type="text"
              class="session-creator-cwd-input"
              placeholder="下のツリーから選択、または直接入力"
              value={form.cwd}
              onInput={(e) => setForm({ ...form, cwd: (e.target as HTMLInputElement).value })}
            />
            <CwdTree
              roots={probe.rootDirs}
              selected={form.cwd}
              onSelect={(cwd) => setForm({ ...form, cwd })}
            />
          </div>
          <label class="session-creator-field">
            <span class="session-creator-label">model</span>
            <select
              value={form.model}
              onChange={(e) => setForm({ ...form, model: (e.target as HTMLSelectElement).value })}
            >
              {SESSION_CREATOR_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label class="session-creator-field">
            <span class="session-creator-label">effort</span>
            <select
              value={form.effort}
              onChange={(e) => setForm({ ...form, effort: (e.target as HTMLSelectElement).value })}
            >
              {SESSION_CREATOR_EFFORTS.map((eff) => (
                <option key={eff} value={eff}>
                  {eff}
                </option>
              ))}
            </select>
          </label>
          <label class="session-creator-field">
            <div class="session-creator-prompt-head">
              <span class="session-creator-label">prompt</span>
              <button
                type="button"
                class="session-creator-default-btn"
                onClick={() => setForm({ ...form, prompt: probe.defaultPrompt })}
              >
                default
              </button>
            </div>
            <textarea
              class="session-creator-prompt"
              value={form.prompt}
              onInput={(e) => setForm({ ...form, prompt: (e.target as HTMLTextAreaElement).value })}
            />
          </label>
          <button
            type="submit"
            class="session-creator-submit"
            disabled={!sessionCreatorFormValid(form) || launch.status === "running"}
          >
            {launch.status === "running" ? "実行中…" : "実行"}
          </button>
        </form>
      ) : null}
      <LaunchResultPanel state={launch} />
    </div>
  );
}
