// A mock `claude` for test daemons that run the agents poll: a fake $HOME to
// hold config-dir candidates, and a `claude agents --json` on a PATH-prepend
// dir answering per CLAUDE_CONFIG_DIR, so no real Claude CLI or real
// ~/.claude* dirs are ever touched.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";

/** Build a fake $HOME containing config-dir candidates, a mock `claude` binary
 *  on its own PATH-prepend dir, and a call-log file the mock appends one line
 *  to per invocation (so tests can observe "did/didn't poll again" without
 *  reaching into daemon internals). */
export function mkFixture(): {
  base: string;
  home: string;
  binDir: string;
  callLog: string;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agents-"));
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const binDir = path.join(base, "bin");
  fs.mkdirSync(binDir);
  const callLog = path.join(base, "calls.log");
  fs.writeFileSync(callLog, "");
  return { base, home, binDir, callLog };
}

/** Write the mock `claude` script: on `agents --json`, appends one line to
 *  callLog (so call count is observable) and echoes rows tagged with which
 *  CLAUDE_CONFIG_DIR it saw — the same shape agents.ts expects from the real
 *  CLI (camelCase fields, no `config_dir` — the daemon adds that itself). */
export function writeMockClaude(
  binDir: string,
  callLog: string,
  rowsByConfigDir: Record<string, unknown[]>,
): void {
  const script = `#!/usr/bin/env bash
set -e
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  echo "$CLAUDE_CONFIG_DIR $(date +%s%N)" >> "${callLog}"
  case "$CLAUDE_CONFIG_DIR" in
${Object.entries(rowsByConfigDir)
  .map(([dir, rows]) => `    "${dir}") echo '${JSON.stringify(rows)}' ;;`)
  .join("\n")}
    *) echo '[]' ;;
  esac
  exit 0
fi
exit 1
`;
  writeMockBin(path.join(binDir, "claude"), script);
}
