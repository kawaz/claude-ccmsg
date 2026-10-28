// The body of the sidebar's GLOBALS fold (DR-0043 §5): what belongs to no
// session — the endpoint this page is opened at, the daemon's version, and
// the Claude Code version of this host.
import type { AppState } from "../store.ts";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import { endpointChoices, lastSessionClaudeVersion, switchedHref } from "../sidebar-globals.ts";

function globalsSlice(state: AppState) {
  return {
    daemonVersion: state.daemonInfo?.version ?? null,
    webuiUrls: state.daemonInfo?.webuiUrls,
    claudeVersion: lastSessionClaudeVersion(state.agents)?.version ?? null,
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

export function SidebarGlobals() {
  const { store } = useApp();
  const slice = useStoreState(store, globalsSlice, shallowEqual);
  return (
    <div class="sidebar-globals">
      <EndpointLine candidates={slice.webuiUrls} />
      <p class="sidebar-globals-row">
        daemon {slice.daemonVersion !== null ? `v${slice.daemonVersion}` : "—"}
      </p>
      <p class="sidebar-globals-row">
        claude {slice.claudeVersion !== null ? `v${slice.claudeVersion}` : "—"}
      </p>
    </div>
  );
}
