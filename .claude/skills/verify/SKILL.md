---
name: verify
description: Run an isolated daemon and drive the ccmsg web UI.
---

# Verify ccmsg web UI

1. Start an isolated foreground daemon on an unused loopback port:

```bash
state_dir=$(mktemp -d)
config_dir=$(mktemp -d)
data_dir=$(mktemp -d)
CCMSG_STATE_DIR="$state_dir" \
CCMSG_CONFIG_DIR="$config_dir" \
CCMSG_DATA_DIR="$data_dir" \
CCMSG_HTTP_BIND=127.0.0.1:18642 \
  bun packages/daemon/src/index.ts --foreground
```

2. Open `http://127.0.0.1:18642/` with `playwright-cli` in a fresh named session.
3. Drive the affected user flow through the browser. For Session Search, verify the form, daemon response, result click, Timeline state, and localStorage-backed pin state.
4. Capture a focused snapshot or screenshot plus browser-visible state (`aria-pressed`, counters, highlights, and error text).
5. Close the browser session and stop the isolated daemon.

Use a different port when `18642` is occupied. The daemon scans the normal detected Claude config dirs while its own runtime, configuration, and data stay isolated.

## Never deliver into a session kawaz is using

The isolated daemon still delivers to real sessions: peer injection resolves the target by session id against the real Claude config dirs and writes straight into that session's harness socket, regardless of the daemon's own state dir. A `hello` with `role: "session"` that names a live session's sid, a room whose member is a live sid, or a `peer_send` (the `send` tool) that names a live session, lands in that session's conversation.

Delivering into a real Claude Code session is fine when that session exists for the test. It is never fine to deliver into a session kawaz is working in.

- When a flow needs a receiving session (delivery, the `send` tool, rooms, input readiness), start one for the test: a throwaway jj workspace (`jj workspace add <temp base>/ws-<name>`) or any directory under the temp base, launched with `--name "🤖ccmsg-verify-<topic>"` (the 🤖 prefix marks it as a bot-run test session) so it is recognisable in `ccmsg peers`, hyoui, and the webui sidebar. Use that session's sid. Stop it when done and forget the workspace.
- A `claude` started from inside a Claude Code session (your Bash tool) inherits that session's environment. With it, the test session shows "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker", writes no transcript, and is not listed by `claude agents --json`, so the daemon never registers it and drops the run its sidecar names. Start it with the inherited session variables removed (these are the ones a session's Bash had; with them removed the session was listed and saved its transcript):

```bash
env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_EXECPATH \
  claude --name "🤖ccmsg-verify-<topic>"
```

- Never copy a sid from `ccmsg peers`, `sessions/*.json`, or a transcript path into a `hello`, a room member list, or a `peer_send` / `send` target. A sid you did not just create for this verify run is someone's live conversation.
- A fake harness socket in the temp base (no Claude at all) is also acceptable for the receiving side when a full session is not needed.
