// New-session launcher form (DR-0018 §2.1/§3.4)。フォームはサイドバーの中に
// 一覧と並んで出る (Sidebar.tsx)。開いているかどうかとフォームの初期値は
// URL の `sb.*` が持つ — `?sb.panel=new&sb.SESSION_ID=…` を
// 開けばこのフォームがその値で立ち上がる (sidebar-url.ts、表は
// docs/design/webui-url-grammar.md)。
//
// path 側に `"session-creator"` を足していない (DR-0018 §3.4 のスケッチはそう
// 書いていた) のは、このフォームがメインペインの中身を置き換えないから:
// `/s/<sid>/timeline` を開いたまま横で使うものなので、「どこを見ているか」を
// 名乗る path ではなく、それと直交する `sb.` の名前空間に属する。ブックマーク
// できないから query にしたのではない — できる、その上で path とは軸が違う。
//
// Explicitly out of scope (DR-0018 §2.3): no process tracking after launch.
// The run button's request/response round trip *is* the whole feature —
// stdout/stderr/exit_code/timed_out render once and nothing here polls,
// subscribes, or remembers past launches.
import { useEffect, useState } from "preact/hooks";
import type {
  LauncherParam,
  SessionLauncherConfigTemplate,
  SessionLaunchResponse,
} from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { registerUnsentInput } from "../unsent-input.ts";
import { errorMessage } from "../utils.ts";
import {
  buildSessionLaunchRequest,
  commitCwdInput,
  forkSourceDefaults,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  orderedParams,
  paramRows,
  paramWidget,
  selectSessionCreatorTemplate,
  sessionCreatorCwd,
  sessionCreatorFormDirty,
  sessionCreatorFormValid,
  SESSION_CREATOR_EFFORTS,
  SESSION_CREATOR_MODELS,
  SESSION_ID_PARAM,
  type CwdPickerMode,
  type ForkSourceInfo,
  type SessionCreatorForm,
} from "../session-creator.ts";
import type { AppState } from "../store.ts";
import { CwdTree } from "./CwdTree.tsx";

/** What the fork source session can tell the form about itself, read out of
 * AppState at the moment the form is seeded (kawaz r115 m6: "model/effort/cwd
 * も自動入力されるべき"). Two independent sources, because no single one has
 * all three: `peers` is the daemon's live registration and carries the cwd the
 * session actually runs in, while `sessionStatuses` carries the transcript's
 * latest main-context model/effort observation. The status entry exists
 * because forking is only reachable from that session's Timeline, which
 * subscribes it (DR-0020 §2.1) — when either source is missing the form simply
 * falls back to its usual defaults. */
function forkSourceInfo(state: AppState, sid: string): ForkSourceInfo {
  const context = state.sessionStatuses.get(sid)?.context;
  return {
    cwd: state.peers.find((p) => p.sid === sid)?.cwd,
    model: context?.model,
    effort: context?.effort,
    // The forked session should open under the source's name (the doc on
    // ForkSourceInfo.title); agents' `name` is where a live session's title
    // lives (same source pinnedSessionTitle reads).
    title: state.agents.find((a) => a.sessionId === sid)?.name,
  };
}

type LauncherProbe =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      rootDirs: string[];
      /** Configured launch recipes in config order. Each carries its raw shell
       * command (verbatim, no variable substitution) and prompt, which are the
       * textarea initial values and the "default" buttons' restore targets —
       * DR-0018 §3.2 addendum 2026-07-17. */
      templates: SessionLauncherConfigTemplate[];
    };

type LaunchState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; result: SessionLaunchResponse };

/** issue 2026-07-17-session-creator-cwd-picker-unify: the cwd field's two
 * display modes. "confirmed" shows the picked path as text plus an edit (✎)
 * button; "editing" shows a single input that both filters CwdTree (via
 * debounced substring match, DR-0018 §2.2) and accepts a full path typed by
 * hand (Enter commits it directly — requirement 5, for paths deeper than the
 * tree surfaces). Selecting a row in the tree commits the same way a
 * direct-entry Enter does: cwd is set and the picker collapses to
 * "confirmed". `filterInput` is local to this component (not part of
 * SessionCreatorForm) — it's transient UI text, not part of the wire
 * request, and resets each time editing mode is (re-)entered so the edit
 * button doesn't reopen with stale search text. */
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
  rootDirs: string[];
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
        placeholder="検索 (パス部分一致)、またはパスを直接入力して Enter"
        value={filterInput}
        onInput={(e) => setFilterInput((e.target as HTMLInputElement).value)}
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

/** One declared parameter's input. Which control appears is decided by
 * `paramWidget` and nothing else — CWD / MODEL / EFFORT get the control the
 * form has for them, and every other parameter gets a text field sized by
 * whether its value has newlines in it. No parameter carries explanatory text
 * of its own (kawaz r259 m47): the config author named them and knows what
 * they are.
 *
 * The fork values are plain editable inputs like every other parameter (kawaz
 * r115 m7:「仮にそこを正確でない値に変えたとしても単にコマンドの実行に失敗する
 * だけで、失敗含めて修正する自由を取り上げる理由がありません」), so nothing here
 * validates a value — a bad uuid surfaces as claude's own launch failure on
 * stderr. */
function ParamField({
  param,
  value,
  onChange,
  rootDirs,
  cwdMode,
  setCwdMode,
}: {
  param: LauncherParam;
  value: string;
  onChange: (value: string) => void;
  rootDirs: string[];
  cwdMode: CwdPickerMode;
  setCwdMode: (mode: CwdPickerMode) => void;
}) {
  const widget = paramWidget(param, value);
  const label = <span class="session-creator-label">{param.name.toLowerCase()}</span>;

  if (widget === "cwd") {
    return (
      <div class="session-creator-field">
        {label}
        <CwdPicker
          cwd={value}
          mode={cwdMode}
          setMode={setCwdMode}
          rootDirs={rootDirs}
          onCwdChange={onChange}
        />
      </div>
    );
  }

  if (widget === "model" || widget === "effort") {
    const options: readonly string[] =
      widget === "model" ? SESSION_CREATOR_MODELS : SESSION_CREATOR_EFFORTS;
    return (
      <label class="session-creator-field">
        {label}
        <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const restore = (
    <button
      type="button"
      class="session-creator-default-btn"
      onClick={() => onChange(param.default)}
    >
      default
    </button>
  );

  return (
    <label class="session-creator-field">
      <div class="session-creator-prompt-head">
        {label}
        {restore}
      </div>
      {widget === "multiline" ? (
        <textarea
          class="session-creator-prompt"
          rows={paramRows(value)}
          value={value}
          onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        />
      ) : (
        <input
          type="text"
          class="session-creator-resume-input"
          value={value}
          placeholder={`$${param.name}`}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
      )}
    </label>
  );
}

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

/** The template the form is currently on — the "default" buttons restore from
 * it, so a template switch also switches what "default" means. */
function selectedTemplate(
  templates: SessionLauncherConfigTemplate[],
  form: SessionCreatorForm,
): SessionLauncherConfigTemplate | undefined {
  return templates.find((t) => t.name === form.template);
}

export function SessionCreator({
  onClose,
  template,
  params,
}: {
  onClose: () => void;
  /** `sb.template` — the recipe the URL pinned, or null (every in-app action
   * leaves it out and lets the seeded parameters pick; see `initialTemplate`). */
  template: string | null;
  /** `sb.<PARAM>` — the seed values the URL carries. Read once when the config
   * arrives; the user's edits from then on are the form's own, and are not
   * written back to the address bar (a keystroke is not a navigation). */
  params: Readonly<Record<string, string>>;
}) {
  const { ws, store } = useApp();
  const [probe, setProbe] = useState<LauncherProbe>({ status: "loading" });
  const [form, setForm] = useState<SessionCreatorForm | null>(null);
  // 種の控え。「ユーザが打ち込んだ分だけ」を見分けるための比較相手で、URL 由来の
  // prefill (fork / resume) はここに入るので dirty にはならない。
  const [seededForm, setSeededForm] = useState<SessionCreatorForm | null>(null);
  const [cwdPickerMode, setCwdPickerMode] = useState<CwdPickerMode>("editing");
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    void ws
      .sessionLauncherConfig()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setProbe({ status: "ready", rootDirs: res.root_dirs, templates: res.templates });
          // URL が名指したセッションが今も動いていれば、そこから cwd /
          // model / effort を補う。URL に無いものだけが埋まる (URL が優先、
          // initialSessionCreatorForm 参照) ので、Timeline の ⑂ のように
          // 「セッションは画面に出ている = 生きている」経路はリンクを短く
          // 保てるし、手で打った `?sb.panel=new&sb.SESSION_ID=X` も同じ値で
          // 開く。購読せず getState() で 1 回だけ読むのは、以後の
          // peers/status 更新でフォームを上書きしたらユーザの編集を奪うから。
          const sessionId = params[SESSION_ID_PARAM];
          const defaults = sessionId
            ? forkSourceDefaults(forkSourceInfo(store.getState(), sessionId), res.root_dirs)
            : {};
          const initialForm = initialSessionCreatorForm(res.templates, template, params, defaults);
          setForm(initialForm);
          setSeededForm(initialForm);
          setCwdPickerMode(initialCwdPickerMode(sessionCreatorCwd(initialForm)));
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
    // template / params は URL 由来なので、別の値で開き直されれば URL が
    // 変わり = ここも張り直される。フォームを開いたまま別 turn を fork する
    // 経路がそれで、seed からやり直すのが正しい。
  }, [ws, store, template, params]);

  // 打ち込んだ内容は localStorage に載らないので、リロードすると本当に消える。
  // version 不一致の遅延リロード (version-guard.ts / navigation.ts) に
  // 「消えては困る入力がある」と申告して、遷移に相乗りしたリロードを止める。
  // 起動し終えたフォームは用済みなので申告しない。
  const dirty =
    form !== null &&
    seededForm !== null &&
    launch.status !== "done" &&
    sessionCreatorFormDirty(form, seededForm);
  useEffect(() => {
    if (!dirty) return;
    return registerUnsentInput();
  }, [dirty]);

  async function run(e: Event): Promise<void> {
    e.preventDefault();
    if (!form) return;
    if (probe.status !== "ready") return;
    const req = buildSessionLaunchRequest(form, probe.templates);
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
          {probe.templates.length > 1 ? (
            <label class="session-creator-field">
              <span class="session-creator-label">template</span>
              <select
                value={form.template}
                onChange={(e) =>
                  setForm(
                    selectSessionCreatorTemplate(
                      form,
                      probe.templates,
                      (e.target as HTMLSelectElement).value,
                    ),
                  )
                }
              >
                {probe.templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {/* 入力欄の唯一の根拠は選択中テンプレの params 宣言 (kawaz r119 m6)。
           * どの変数を受け取るかは config が決めることで、webui が command 文字列
           * から推測する筋合いのものではない。並べ替えるのは cwd/model/effort を
           * 前、COMMAND を後ろに寄せるところまでで、残りは宣言順 (orderedParams)。 */}
          {orderedParams(selectedTemplate(probe.templates, form)?.params ?? []).map((param) => (
            <ParamField
              key={param.name}
              param={param}
              value={form.params[param.name] ?? ""}
              onChange={(value) =>
                setForm({ ...form, params: { ...form.params, [param.name]: value } })
              }
              rootDirs={probe.rootDirs}
              cwdMode={cwdPickerMode}
              setCwdMode={setCwdPickerMode}
            />
          ))}
          <label class="session-creator-field">
            <div class="session-creator-prompt-head">
              <span class="session-creator-label">command</span>
              <button
                type="button"
                class="session-creator-default-btn"
                onClick={() =>
                  setForm({
                    ...form,
                    command: selectedTemplate(probe.templates, form)?.command ?? "",
                  })
                }
              >
                default
              </button>
            </div>
            <textarea
              class="session-creator-prompt"
              rows={paramRows(form.command)}
              value={form.command}
              onInput={(e) =>
                setForm({ ...form, command: (e.target as HTMLTextAreaElement).value })
              }
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
