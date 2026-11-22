// The Status tab's autoMode of the session's project (DR-0063 §6), in the
// danger zone under the kill row: the four sections, each headed by its
// `$defaults` row (the project's check, the user's side, and what comes of
// them), then the three layers in the order they take effect — the project's
// entries (edited in place), the user's settings.json (read only), and the
// built-in defaults (read only, only where they hold, folded).
//
// The project's sections are the store's (`projectAutoModes`, by key), so a
// change saved in another tab or device arrives here as ev:"project_auto_mode";
// a textarea being edited keeps its text (its own state). The user's lists are
// read again as the tab comes to the front and after each save. The built-in
// defaults are read once per version of the daemon's claude and kept in this
// page's memory.
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  AUTO_MODE_DEFAULTS_ENTRY,
  AUTO_MODE_SECTIONS,
  type AutoModeDefaultsReadResponse,
  type AutoModeSection,
  type AutoModeSectionName,
  type ErrorResponse,
  errorText,
  type ProjectAutoModeChange,
  type ProjectAutoModeWriteResponse,
  type UserAutoMode,
} from "@ccmsg/protocol";
import { builtinApplies, resultText, userListState, userStateText } from "../auto-mode-view.ts";
import { useApp } from "../context.ts";
import { useEffectEvent } from "../useEffectEvent.ts";
import { sameJson, useStoreState } from "../useStore.ts";
import { shouldSendOnKeyDown } from "./composer-keydown.ts";
import { Fold } from "./Fold.tsx";

/** What `project_auto_mode_read` answered, but the project's sections (the
 * store's). */
type Read =
  | { kind: "loading" }
  | { kind: "failed"; text: string }
  | { kind: "read"; key: string; label: string; user: UserAutoMode; builtinVersion?: string };

/** The built-in defaults read so far, by version: the daemon's answer, or
 * why it gave none. Kept for the page's life, as the version changes only
 * when the daemon's claude is replaced. */
const builtinRead = new Map<string, Promise<AutoModeDefaultsReadResponse | ErrorResponse>>();

/** The built-in defaults of `version`, read once per version. A failure is
 * not kept, so the next look asks again. */
function readBuiltin(
  version: string,
  ask: (version: string) => Promise<AutoModeDefaultsReadResponse | ErrorResponse>,
): Promise<AutoModeDefaultsReadResponse | ErrorResponse> {
  const held = builtinRead.get(version);
  if (held !== undefined) return held;
  const read = ask(version).then((res) => {
    if (!res.ok) builtinRead.delete(version);
    return res;
  });
  builtinRead.set(version, read);
  return read;
}

type Builtin =
  | { kind: "loading" }
  | { kind: "failed"; text: string }
  | { kind: "read"; label: string; defaults: AutoModeDefaultsReadResponse["defaults"] };

/** The built-in defaults of the daemon's claude of `version`; asks for the
 * project's autoMode again (`onStale`) when the daemon's claude is of
 * another version now. */
function useBuiltin(version: string | undefined, onStale: () => void): Builtin {
  const { ws } = useApp();
  const [builtin, setBuiltin] = useState<Builtin>({ kind: "loading" });
  const stale = useEffectEvent(onStale);
  useEffect(() => {
    if (version === undefined) {
      setBuiltin({
        kind: "failed",
        text: "claude auto-mode defaults が答えなかった: claude is not on the daemon's PATH",
      });
      return;
    }
    let live = true;
    setBuiltin({ kind: "loading" });
    readBuiltin(version, (v) => ws.autoModeDefaultsRead(v))
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setBuiltin({ kind: "read", label: res.label, defaults: res.defaults });
          return;
        }
        if (res.error.code === "invalid_args") stale();
        setBuiltin({
          kind: "failed",
          text: `claude auto-mode defaults が答えなかった: ${res.error.msg}`,
        });
      })
      .catch((e: unknown) => {
        if (live) {
          setBuiltin({
            kind: "failed",
            text: `claude auto-mode defaults が答えなかった: ${errorText(e)}`,
          });
        }
      });
    return () => {
      live = false;
    };
  }, [version, ws]);
  return builtin;
}

/** `Claude Code 2.1.330` from `claude --version`'s line `2.1.330 (Claude Code)`. */
function claudeCodeVersion(label: string): string {
  return `Claude Code ${label.split(/\s+/)[0] ?? label}`;
}

/** The danger zone's autoMode of session `sid`'s project. `shown`: the tab
 * is in front (the user's lists are read again as it comes to the front). */
export function ProjectAutoMode({ sid, shown }: { sid: string; shown: boolean }) {
  const { store, ws } = useApp();
  const launchAvailable = useStoreState(store, (s) => s.launchAvailable);
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [reads, setReads] = useState(0);
  const reload = (): void => setReads((n) => n + 1);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    ws.projectAutoModeRead(sid)
      .then((res) => {
        if (!live) return;
        setRead(
          res.ok
            ? {
                kind: "read",
                key: res.key,
                label: res.label,
                user: res.user,
                ...(res.builtin_version !== undefined
                  ? { builtinVersion: res.builtin_version }
                  : {}),
              }
            : { kind: "failed", text: `${res.error.code}: ${res.error.msg}` },
        );
      })
      .catch((e: unknown) => {
        if (live) setRead({ kind: "failed", text: errorText(e) });
      });
    return () => {
      live = false;
    };
  }, [shown, sid, ws, reads]);
  const key = read.kind === "read" ? read.key : undefined;
  const project = useStoreState(
    store,
    (s) => (key !== undefined ? s.projectAutoModes.get(key) : undefined),
    sameJson,
  );
  return (
    <div class="status-automode">
      <h4 class="status-automode-title">autoMode (このプロジェクト)</h4>
      {read.kind === "read" ? <p class="status-automode-key">{read.label}</p> : null}
      <p class="status-automode-note">
        ccmsg が起動・再起動するセッションと btw に <code>--settings</code>{" "}
        で渡す。今のセッションに効かせるには再起動する
        {launchAvailable ? null : (
          <>
            <br />
            起動コマンドが設定されていないので、起動には渡らない
          </>
        )}
      </p>
      {read.kind === "loading" ? <p class="status-automode-note">読み込み中…</p> : null}
      {read.kind === "failed" ? <p class="status-automode-error">{read.text}</p> : null}
      {read.kind === "read" && project !== undefined ? (
        <ProjectSections
          sid={sid}
          projectKey={read.key}
          project={project}
          user={read.user}
          builtinVersion={read.builtinVersion}
          reload={reload}
        />
      ) : null}
    </div>
  );
}

function ProjectSections({
  sid,
  projectKey,
  project,
  user,
  builtinVersion,
  reload,
}: {
  sid: string;
  projectKey: string;
  project: Readonly<Record<AutoModeSectionName, AutoModeSection>>;
  user: UserAutoMode;
  builtinVersion: string | undefined;
  reload: () => void;
}) {
  const { store, ws } = useApp();
  const builtin = useBuiltin(builtinVersion, reload);
  /** Save `change` to section `name`; the project as saved goes into the
   * store at once (the push follows), and the user's lists are read again. */
  const save = async (
    name: AutoModeSectionName,
    change: ProjectAutoModeChange,
  ): Promise<ProjectAutoModeWriteResponse | ErrorResponse> => {
    const res = await ws.projectAutoModeWrite(sid, name, change);
    if (res.ok) {
      store.dispatch({ type: "project-auto-mode/loaded", key: projectKey, project: res.project });
    }
    reload();
    return res;
  };
  return (
    <ul class="status-automode-sections">
      {AUTO_MODE_SECTIONS.map((name) => (
        <SectionView
          key={name}
          name={name}
          section={project[name]}
          user={user}
          builtin={builtin}
          save={(change) => save(name, change)}
        />
      ))}
    </ul>
  );
}

type Save = (
  change: ProjectAutoModeChange,
) => Promise<ProjectAutoModeWriteResponse | ErrorResponse>;

/** Why a save was refused, under the control it was made from. */
function failureText(res: ErrorResponse): string {
  return `${res.error.code}: ${res.error.msg}`;
}

function SectionView({
  name,
  section,
  user,
  builtin,
  save,
}: {
  name: AutoModeSectionName;
  section: AutoModeSection;
  user: UserAutoMode;
  builtin: Builtin;
  save: Save;
}) {
  const state = userListState(user, name);
  const [pending, setPending] = useState<boolean | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checked = pending ?? section.defaults;
  const onCheck = (e: JSX.TargetedEvent<HTMLInputElement, Event>): void => {
    const next = e.currentTarget.checked;
    setPending(next);
    setCheckError(null);
    save({ defaults: next })
      .then((res) => {
        if (!res.ok) setCheckError(failureText(res));
      })
      .catch((err: unknown) => setCheckError(errorText(err)))
      .finally(() => setPending(null));
  };
  const applies = builtinApplies(section, state);
  return (
    <li class="status-automode-section">
      <h5 class="status-automode-section-name">{name}</h5>
      <div class="status-automode-defaults">
        <label class="status-automode-check">
          <input type="checkbox" checked={checked} disabled={pending !== null} onChange={onCheck} />
          $defaults を入れる
        </label>
        <span class="status-automode-user-state">{userStateText(state)}</span>
        <span class="status-automode-result">{resultText(section, state)}</span>
      </div>
      {checkError !== null ? <p class="status-automode-error">{checkError}</p> : null}
      <Fold
        class="status-automode-layer status-automode-layer-project"
        summaryClass="status-automode-layer-title"
        summary="プロジェクト (編集できる)"
        open
      >
        <ProjectEntries entries={section.entries} save={save} />
      </Fold>
      <UserLayer user={user} name={name} />
      {applies === true ? <BuiltinLayer builtin={builtin} name={name} /> : null}
    </li>
  );
}

/** The entry being edited: one of the saved (`index`, as it read when the
 * edit began) or one being added. */
type Editing = { at: "entry"; index: number; before: string } | { at: "new" };

/** The project's entries of a section, each turned into a textarea in place
 * by a click, and [＋] to add one at the end. */
function ProjectEntries({ entries, save }: { entries: readonly string[]; save: Save }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  return (
    <ul class="status-automode-entries">
      {entries.map((entry, index) =>
        editing?.at === "entry" && editing.index === index ? (
          <li key={`edit-${String(index)}`}>
            <EntryEditor
              initial={editing.before}
              onClose={() => setEditing(null)}
              onSave={(text) => save({ index, before: editing.before, text })}
            />
          </li>
        ) : (
          <li key={`entry-${String(index)}`}>
            <button
              type="button"
              class="status-automode-entry status-automode-entry-editable"
              onClick={() => setEditing({ at: "entry", index, before: entry })}
            >
              {entry}
            </button>
          </li>
        ),
      )}
      {editing?.at === "new" ? (
        <li key="new">
          <EntryEditor
            initial=""
            onClose={() => setEditing(null)}
            onSave={(text) => save({ text })}
          />
        </li>
      ) : (
        <li key="add">
          <button
            type="button"
            class="status-automode-add"
            aria-label="項目を足す"
            onClick={() => setEditing({ at: "new" })}
          >
            ＋
          </button>
        </li>
      )}
    </ul>
  );
}

/** One entry's textarea: ⌘Enter (Ctrl+Enter) saves — an empty text removes
 * the entry, or adds nothing — and Esc leaves it as it was. Losing the focus
 * keeps it open, so what was written is not lost. While it saves it is
 * disabled; a refusal keeps it open with the reason under it. */
function EntryEditor({
  initial,
  onSave,
  onClose,
}: {
  initial: string;
  onSave: (text: string) => Promise<ProjectAutoModeWriteResponse | ErrorResponse>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The click that opened it puts the caret at the end of its text. Not
  // `autofocus`: the browser honours it only while nothing has the focus,
  // and the clicked entry had it.
  const focusAtEnd = useCallback((el: HTMLTextAreaElement | null) => {
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = (): void => {
    if (initial === "" && text.trim() === "") {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    onSave(text)
      .then((res) => {
        if (res.ok) {
          onClose();
          return;
        }
        setSaving(false);
        setError(failureText(res));
      })
      .catch((e: unknown) => {
        setSaving(false);
        setError(errorText(e));
      });
  };
  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void => {
    if (shouldSendOnKeyDown(e)) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && !e.isComposing) {
      e.preventDefault();
      onClose();
    }
  };
  return (
    <>
      <textarea
        class="status-automode-textarea"
        value={text}
        disabled={saving}
        ref={focusAtEnd}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {error !== null ? <p class="status-automode-error">{error}</p> : null}
    </>
  );
}

/** The user's settings.json list of a section, read only. */
function UserLayer({ user, name }: { user: UserAutoMode; name: AutoModeSectionName }) {
  const where = "unavailable" in user ? "settings.json" : `${user.config_dir_name}/settings.json`;
  const list = "unavailable" in user ? [] : (user.autoMode[name] ?? []);
  return (
    <Fold
      class="status-automode-layer status-automode-layer-user"
      summaryClass="status-automode-layer-title"
      summary={`ユーザ (${where}、読むだけ)`}
      open
    >
      {"unavailable" in user ? (
        <p class="status-automode-layer-note">{user.unavailable}</p>
      ) : list.length === 0 ? (
        <p class="status-automode-layer-note">書いていない</p>
      ) : (
        <ul class="status-automode-entries">
          {list.map((entry, index) => (
            <li key={String(index)} class="status-automode-entry">
              {entry === AUTO_MODE_DEFAULTS_ENTRY
                ? "$defaults ← ここに組み込みの既定が入る"
                : entry}
            </li>
          ))}
        </ul>
      )}
    </Fold>
  );
}

/** The built-in defaults of a section, read only: folded, its count in the
 * summary. */
function BuiltinLayer({ builtin, name }: { builtin: Builtin; name: AutoModeSectionName }) {
  const list = builtin.kind === "read" ? builtin.defaults[name] : [];
  return (
    <Fold
      class="status-automode-layer status-automode-layer-builtin"
      summaryClass="status-automode-layer-title"
      summary={
        <>
          {builtin.kind === "read" ? `組み込みの既定 (${String(list.length)})` : "組み込みの既定"}
          <span class="status-automode-layer-sub">
            {builtin.kind === "read" ? `${claudeCodeVersion(builtin.label)}、読むだけ` : "読むだけ"}
          </span>
        </>
      }
    >
      {builtin.kind === "loading" ? (
        <p class="status-automode-layer-note">読み込み中…</p>
      ) : builtin.kind === "failed" ? (
        <p class="status-automode-layer-note">{builtin.text}</p>
      ) : (
        <ul class="status-automode-entries">
          {list.map((entry, index) => (
            <li key={String(index)} class="status-automode-entry">
              {entry}
            </li>
          ))}
        </ul>
      )}
    </Fold>
  );
}
