// The person's userscript in the webui (DR-0057): GLOBALS' line
// `userscript: none | enabled | disabled [edit]`, the edit dialog, and the
// notice a page shows when the userscript failed on it.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { ErrorCode } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { setDeviceEnabled, USERSCRIPT_TEMPLATE, USERSCRIPT_UTIL_TYPES } from "../userscript.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import type { AppState } from "../store.ts";
import { ModalDialog } from "./ModalDialog.tsx";

/** What GLOBALS shows (DR-0057 §3): `none` while no script is saved, and for
 * a saved one whether this browser runs it; null until the daemon has said. */
export type UserscriptShown = "none" | "enabled" | "disabled";

export function userscriptShown(state: AppState): UserscriptShown | null {
  const { saved, deviceEnabled } = state.userscript;
  if (saved === null) return null;
  if (!saved) return "none";
  return deviceEnabled ? "enabled" : "disabled";
}

function userscriptSlice(state: AppState) {
  return { shown: userscriptShown(state) };
}

/** A reply's or a rejection's words. */
function failureText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** `userscript: <state> [edit]` (DR-0057 §3). `none` is plain text; a saved
 * script's state is this browser's switch, a select between enabled (green)
 * and disabled (red), the same shape as the endpoint row's choice. The switch
 * is the browser's alone (localStorage) and takes effect on the next load, as
 * a save does. */
export function UserscriptLine() {
  const { store, ws } = useApp();
  const slice = useStoreState(store, userscriptSlice, shallowEqual);
  /** The edit dialog's source while it is open; null while it is closed. */
  const [editor, setEditor] = useState<EditorSource | null>(null);

  // edit: open the dialog and read the saved source into it. An answer that
  // comes after the dialog was closed is dropped.
  const openEditor = (): void => {
    setEditor({ kind: "loading" });
    const settle = (next: EditorSource): void =>
      setEditor((open) => (open?.kind === "loading" ? next : open));
    void ws.userscriptRead().then(
      (res) => {
        if (!res.ok) {
          settle({ kind: "unreadable", message: res.error.msg });
          return;
        }
        store.dispatch({ type: "userscript/saved", saved: res.source !== undefined });
        settle({ kind: "read", text: res.source ?? USERSCRIPT_TEMPLATE });
      },
      (e: unknown) =>
        settle({ kind: "unreadable", message: failureText(e, "読み込めませんでした") }),
    );
  };

  return (
    <>
      <p class="sidebar-globals-row sidebar-globals-userscript">
        <UserscriptStateControl
          shown={slice.shown}
          onSwitch={(enabled) => setDeviceEnabled(store, enabled)}
        />
        <button
          type="button"
          class="sidebar-globals-userscript-edit"
          title="userscript を編集"
          disabled={slice.shown === null}
          onClick={openEditor}
        >
          edit
        </button>
      </p>
      {editor !== null ? (
        <UserscriptDialog source={editor} onClose={() => setEditor(null)} />
      ) : null}
    </>
  );
}

function UserscriptStateControl({
  shown,
  onSwitch,
}: {
  shown: UserscriptShown | null;
  onSwitch: (enabled: boolean) => void;
}) {
  if (shown === null || shown === "none") {
    return <span>userscript: {shown ?? "—"}</span>;
  }
  return (
    <label>
      userscript:{" "}
      <select
        class={`sidebar-globals-userscript-state is-${shown}`}
        value={shown}
        title="このブラウザで読み込むか。次に読み込んだページから効く"
        onChange={(e) => {
          const next = e.currentTarget.value;
          if (next === shown) return;
          if (next === "enabled" || next === "disabled") onSwitch(next === "enabled");
        }}
      >
        <option value="enabled">enabled</option>
        <option value="disabled">disabled</option>
      </select>
    </label>
  );
}

/** The dialog's one sentence on what the script is and when it runs. */
const USERSCRIPT_NOTE =
  "TypeScript か JavaScript で書く。enabled にしたブラウザの webui がページを開いた時に読み込む (切り替えはブラウザごとで、既定は disabled)。保存しても今のページには効かず、読み込み直すと効く。URL に ?userscript=off を付けて開くとそのブラウザで止まる。";

/** What the dialog opens with: the source being read from the daemon, the
 * read's failure, or the source read (the template when none is saved). */
type EditorSource =
  | { kind: "loading" }
  | { kind: "unreadable"; message: string }
  | { kind: "read"; text: string };

/** What came of the last save. */
type Saved =
  | { kind: "saved" }
  | { kind: "refused"; output: string }
  | { kind: "failed"; message: string };

/** The edit dialog (DR-0057 §1, §3): the saved source (the template when none
 * is saved) in a large textarea, 保存, and what the save came to. */
function UserscriptDialog({ source, onClose }: { source: EditorSource; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  return (
    <ModalDialog title="userscript" closable={!saving} onClose={onClose} class="userscript-dialog">
      <div class="modal-dialog-body">
        {source.kind === "loading" ? <p class="status-empty">読み込み中…</p> : null}
        {source.kind === "unreadable" ? (
          <div class="session-input-notice session-input-notice-danger" role="alert">
            <p>{source.message}</p>
          </div>
        ) : null}
        {source.kind === "read" ? (
          <UserscriptForm initial={source.text} saving={saving} onSaving={setSaving} />
        ) : null}
      </div>
    </ModalDialog>
  );
}

/** The textarea and 保存. A save the daemon refused shows the check's output
 * and changes nothing; a save that passed changes this page in nothing — a
 * reload runs it. */
function UserscriptForm({
  initial,
  saving,
  onSaving,
}: {
  initial: string;
  saving: boolean;
  onSaving: (saving: boolean) => void;
}) {
  const { store, ws } = useApp();
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState<Saved | null>(null);

  function submit(e: JSX.TargetedSubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (saving) return;
    onSaving(true);
    setSaved(null);
    void ws
      .userscriptWrite(text)
      .then(
        (res) => {
          if (res.ok) {
            store.dispatch({ type: "userscript/saved", saved: true });
            setSaved({ kind: "saved" });
          } else if (res.error.code === ErrorCode.userscript_invalid) {
            setSaved({ kind: "refused", output: res.error.msg });
          } else {
            setSaved({ kind: "failed", message: res.error.msg });
          }
        },
        (err: unknown) =>
          setSaved({ kind: "failed", message: failureText(err, "保存できませんでした") }),
      )
      .finally(() => onSaving(false));
  }

  return (
    <form class="userscript-form" onSubmit={submit}>
      <p class="userscript-note">{USERSCRIPT_NOTE}</p>
      <textarea
        class="userscript-editor"
        aria-label="userscript のソース (TypeScript / JavaScript)"
        spellcheck={false}
        autocapitalize="off"
        autocomplete="off"
        value={text}
        readOnly={saving}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setSaved(null);
        }}
      />
      <div class="session-input-actions">
        <button type="submit" class="session-input-send" disabled={saving}>
          {saving ? "確認中…" : "保存"}
        </button>
      </div>
      {saved?.kind === "saved" ? (
        <p class="userscript-saved" role="status">
          保存した。ページを読み込み直すと効く。
        </p>
      ) : null}
      {saved?.kind === "refused" ? (
        <div class="session-input-notice session-input-notice-danger" role="alert">
          <p class="session-input-notice-title">保存しなかった (確認で弾かれた)</p>
          <pre class="userscript-check-output">{saved.output}</pre>
        </div>
      ) : null}
      {saved?.kind === "failed" ? (
        <div class="session-input-notice session-input-notice-danger" role="alert">
          <p class="session-input-notice-title">保存できなかった</p>
          <p>{saved.message}</p>
        </div>
      ) : null}
      <details class="userscript-types">
        <summary>util の型</summary>
        <pre>{USERSCRIPT_UTIL_TYPES}</pre>
      </details>
    </form>
  );
}

/** The notice of a page whose userscript failed (DR-0057 §4): what failed,
 * how to open a page without it, and a close. */
export function UserscriptFailureNotice() {
  const { store } = useApp();
  const failure = useStoreState(store, (s: AppState) => s.userscript.failure);
  if (failure === null) return null;
  return (
    <div class="userscript-failure session-input-notice session-input-notice-danger" role="alert">
      <p class="session-input-notice-title">
        userscript でエラー (URL に ?userscript=off を付けて開くとこのブラウザで止められる)
      </p>
      <pre class="userscript-check-output">{failure}</pre>
      <button
        type="button"
        class="session-input-discard"
        onClick={() => store.dispatch({ type: "userscript/failure", message: null })}
      >
        閉じる
      </button>
    </div>
  );
}
