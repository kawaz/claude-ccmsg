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

## Never use a real session id

The isolated daemon still delivers to real sessions: peer injection resolves the target by session id against the real Claude config dirs and writes straight into that session's harness socket, regardless of the daemon's own state dir. A `hello` with `role: "session"` that names a live session's sid, a room whose member is a live sid, or a `post` / `address_send` to a live sid, lands in that real session's conversation.

- Every sid you make up for a fake session must be freshly generated (`crypto.randomUUID()`), never copied from `ccmsg peers`, `sessions/*.json`, or a transcript path.
- Do not create rooms or post to rooms in /verify. Room browsing is read-only; verify it with a room jsonl copied into the isolated data dir.
- To exercise delivery, run the receiving side yourself (a fake harness socket in the temp base), never a live session.
