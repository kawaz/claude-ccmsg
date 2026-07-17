---
name: verify
description: Run an isolated daemon and drive the ccmsg web UI.
---

# Verify ccmsg web UI

1. Start an isolated foreground daemon on an unused loopback port:

```bash
state_dir=$(mktemp -d)
data_dir=$(mktemp -d)
CCMSG_STATE_DIR="$state_dir" \
CCMSG_DATA_DIR="$data_dir" \
CCMSG_HTTP_BIND=127.0.0.1:18642 \
  bun packages/daemon/src/index.ts --foreground
```

2. Open `http://127.0.0.1:18642/` with `playwright-cli` in a fresh named session.
3. Drive the affected user flow through the browser. For Session Search, verify the form, daemon response, result click, Timeline state, and localStorage-backed pin state.
4. Capture a focused snapshot or screenshot plus browser-visible state (`aria-pressed`, counters, highlights, and error text).
5. Close the browser session and stop the isolated daemon.

Use a different port when `18642` is occupied. The daemon scans the normal detected Claude config dirs while runtime/data state remains isolated.
