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

Also point the daemon's `HOME` at a directory under the temp base (`HOME=$(mktemp -d) …`). Session Search looks for `~/.claude*` under `$HOME`, so with the real `HOME` the isolated daemon reads the real config dirs' transcripts.

When the verify has the daemon start a real `claude` (the launch command, a restart), an isolated `HOME` breaks that claude's authentication (`apiKeyHelper` fails). If the isolated `HOME` is only there to keep Session Search off the real config dirs, first check whether narrowing it on the daemon's `CCMSG_CLAUDE_CONFIG_DIRS` side is enough instead of `HOME`. When the two cannot both hold, write in the findings which one the run kept.

2. Open `http://127.0.0.1:18642/` with `playwright-cli` in a fresh named session.
3. Drive the affected user flow through the browser. For Session Search, verify the form, daemon response, result click, Timeline state, and localStorage-backed pin state.
4. Capture a focused snapshot or screenshot plus browser-visible state (`aria-pressed`, counters, highlights, and error text).
5. Close the browser session and stop the isolated daemon.

Use a different port when `18642` is occupied. A daemon whose state dir is not the default one serves no Claude config dir: it lists, registers and delivers to only the sessions that say hello to it, each in the config dir that session announces, and not the sessions beside it. To show the sessions of a fixture config dir, name it in `CCMSG_CLAUDE_CONFIG_DIRS` (absolute paths joined by `:`). Never name a real config dir (`~/.claude*`) there: the daemon then reaches every session in it.

## Never deliver into a session kawaz is using

The isolated daemon still delivers to a real session that says hello to it: peer injection writes straight into that session's harness socket, found under the config dir the hello announced. The daemon cannot tell a hello that names a live session's sid and config dir from that session's own, so such a `hello` with `role: "session"`, a room whose member is that sid, or a `send_message` (the `send` tool) that names it, lands in that session's conversation.

Delivering into a real Claude Code session is fine when that session exists for the test. It is never fine to deliver into a session kawaz is working in.

- When a flow needs a receiving session (delivery, the `send` tool, rooms, input readiness), start one for the test: a throwaway jj workspace (`jj workspace add <temp base>/ws-<name>`) or any directory under the temp base, launched with `--name "🤖ccmsg-verify-<topic>"` (the 🤖 prefix marks it as a bot-run test session) so it is recognisable in `ccmsg peers`, hyoui, and the webui sidebar. Use that session's sid. Stop it when done and forget the workspace.
- A `claude` started from inside a Claude Code session (your Bash tool) inherits that session's environment. With it, the test session shows "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker", writes no transcript, and was not listed by `claude agents --json` (whose rows match the `sessions/<pid>.json` records the daemon reads), so the daemon need not register it and then drops the run its sidecar names. Start it with the inherited session variables removed (these are the ones a session's Bash had; with them removed the session was listed and saved its transcript):

```bash
env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_EXECPATH \
  claude --name "🤖ccmsg-verify-<topic>"
```

- Never run a command in the test session that saves a default to the user's `settings.json` (`/effort`, `/model`, and the like): the test session runs in a real config dir, so the change lands in every session kawaz starts afterwards. To get thinking out of it, steer it with the prompt, or launch it with a one-off override (`--settings '{"effortLevel":"high"}'`).
- Give the test session the same `CCMSG_STATE_DIR`, `CCMSG_CONFIG_DIR`, and `CCMSG_DATA_DIR` as the isolated daemon, not only the state dir. A newer plugin can be released while the test runs: a process started after that (a teammate, a restarted session) loads it, and its hello makes the isolated daemon shut down for the upgrade. The daemon it then starts takes only the variables the session has, so with only `CCMSG_STATE_DIR` passed its config and data go to the default places.
- For flows about subagents (the session's `subagents` facts, sending to a running subagent), launch with `--settings '{"teammateMode":"in-process"}'` when the test session runs inside tmux. The real config has agent teams enabled with `teammateMode: "auto"`, and the model can name the Agent it spawns. A named Agent then starts as a teammate, and inside tmux `auto` puts the teammate in a split pane: a separate process with its own sid. It never shows up as a subagent of the test session, so `subagents` stays empty. Outside tmux, `auto` falls back to in-process, where teammates show up like subagents (docs/findings/2026-10-18-subagents-teammate-vs-subagent.md).

- Never copy a sid from `ccmsg peers`, `sessions/*.json`, or a transcript path into a `hello`, a room member list, or a `send_message` / `send` target. A sid you did not just create for this verify run is someone's live conversation.
- A fake harness socket in the temp base (no Claude at all) is also acceptable for the receiving side when a full session is not needed.
