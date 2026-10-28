// The body of the sidebar's GLOBALS fold (DR-0043 §5): what belongs to no
// session — the endpoint this page is opened at, the daemon's version, and
// the Claude Code version of this host.
import { useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import {
  endpointChoices,
  hostClaudeVersion,
  lastSessionClaudeVersion,
  switchedHref,
} from "../sidebar-globals.ts";

function globalsSlice(state: AppState) {
  return {
    daemonVersion: state.daemonInfo?.version ?? null,
    webuiUrls: state.daemonInfo?.webuiUrls,
    claudeVersion: hostClaudeVersion(
      lastSessionClaudeVersion(state.agents),
      state.hostClaudeVersion,
    ),
  };
}

/** `endpoint: <host>`, and the other endpoints to move to (§5.1). Moving keeps
 * the path, query and hash, so the other origin opens the same screen; what
 * an origin keeps to itself (drafts, pins, pane sizes) stays behind. With no
 * other endpoint there is nothing to choose, and the host is plain text. */
function EndpointLine({ candidates }: { candidates: readonly string[] | undefined }) {
  const current = location.origin;
  const choices = endpointChoices(current, candidates);
  if (choices.length < 2) {
    return (
      <p class="sidebar-globals-row">
        endpoint: <span class="sidebar-globals-endpoint">{choices[0]?.label}</span>
      </p>
    );
  }
  return (
    <p class="sidebar-globals-row">
      <label>
        endpoint:{" "}
        <select
          class="sidebar-globals-endpoint"
          value={current}
          onChange={(e) => {
            const origin = e.currentTarget.value;
            if (origin !== current) location.assign(switchedHref(location.href, origin));
          }}
        >
          {choices.map((choice) => (
            <option key={choice.origin} value={choice.origin}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    </p>
  );
}

/** `claude v<version> [↻]` (§5.3). The button has the daemon run `claude
 * update`; the version shown changes when the daemon's reading arrives (the
 * reply here, ev:"claude_version" in every tab). No confirmation: the update
 * touches no running session, only the sessions started after it. A failure's
 * gist stays under the line until the next update succeeds, and is kept
 * nowhere else. */
function ClaudeLine({ version }: { version: string | null }) {
  const { ws } = useApp();
  const [updating, setUpdating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const update = (): void => {
    setUpdating(true);
    void ws
      .claudeUpdate()
      .then(
        (res) => setFailure(res.ok ? null : res.error.msg),
        (e: unknown) => setFailure(e instanceof Error ? e.message : "更新を依頼できませんでした"),
      )
      .finally(() => setUpdating(false));
  };
  return (
    <>
      <p class="sidebar-globals-row">
        claude {version !== null ? `v${version}` : "—"}
        <button
          type="button"
          class="sidebar-globals-claude-update"
          title="Claude Code を更新 (claude update)"
          aria-label="Claude Code を更新"
          disabled={updating}
          onClick={update}
        >
          &#8635;
        </button>
        {updating ? <span class="sidebar-globals-note">更新中…</span> : null}
      </p>
      {failure !== null ? (
        <p class="sidebar-globals-row sidebar-globals-failure" role="alert">
          {failure}
        </p>
      ) : null}
    </>
  );
}

export function SidebarGlobals() {
  const { store } = useApp();
  const slice = useStoreState(store, globalsSlice, shallowEqual);
  return (
    <div class="sidebar-globals">
      <EndpointLine candidates={slice.webuiUrls} />
      <p class="sidebar-globals-row">
        daemon {slice.daemonVersion !== null ? `v${slice.daemonVersion}` : "—"}
      </p>
      <ClaudeLine version={slice.claudeVersion} />
    </div>
  );
}
