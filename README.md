# claude-ccmsg

> 🇯🇵 [README-ja.md](./README-ja.md)

Central daemon behind the ccmsg web UI.
The plugin's only job is to keep the daemon running: its hooks module starts the daemon when a session starts, if it isn't up, and adds nothing to the session's context. The daemon stays resident for the web UI, where the human user browses sessions, transcripts, and the read-only logs of past rooms, and types into a Claude Code session: the input is put into the session's own prompt box, as if typed there. Sessions send to each other with the plugin's `send` tool, and the daemon delivers each message straight into the recipient session (`send_message`, [DR-0039](./docs/decisions/DR-0039-all-mods-and-typed-tools.md) §3).

## Status

**MVP + web UI implemented.** Architecture is captured in [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md) / [DR-0002](./docs/decisions/DR-0002-daemon-supervision.md) / [DR-0003](./docs/decisions/DR-0003-wire-protocol.md) / [DR-0004](./docs/decisions/DR-0004-webui-architecture.md), grounded in the verbatim primary sources under [docs/research/](./docs/research/). The daemon, CLI, protocol, and webui packages under [packages/](./packages/) are implemented and tested.

## Install

Requires [bun](https://bun.sh/) (the CLI and daemon run on bun).

```
claude plugin marketplace add kawaz/claude-ccmsg
claude plugin install ccmsg-v1@ccmsg-v1
```

Update:

```
claude plugin marketplace update ccmsg-v1
claude plugin update ccmsg-v1@ccmsg-v1
```

The plugin's `bin/ccmsg` lives under a versioned plugin-cache path, so it isn't on your shell `PATH` by default. To use `ccmsg` from a shell or a launchd script, put the PATH launcher on `PATH` from a checkout of this repo (requires `jq`):

```
just install-launcher            # copies packages/cli/path-launcher.sh to ~/.local/bin/ccmsg
just install-launcher <dest>     # or to another path
```

On every run it reads which version of the plugin Claude Code has installed (`$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json`, `~/.claude` when `CLAUDE_CONFIG_DIR` is unset) and execs that version's `bin/ccmsg`, so a plugin update needs nothing done to `PATH`. A caller that does not pass on `CLAUDE_CONFIG_DIR` (launchd) has to set it when your config dir is not `~/.claude`. `install-launcher` refuses to overwrite anything at the destination but an earlier copy of the launcher. The plugin's own `bin/ccmsg` runs the CLI of the version it belongs to and never touches the `ccmsg` on `PATH`. See [DR-0032](./docs/decisions/DR-0032-repo-split-protocol-first.md) §2.2-4.

## Web UI

The daemon serves a web UI at `http://127.0.0.1:8642` by default (for the human user: browse sessions, files, transcripts, and the read-only logs of past rooms, and type into a session). Binding is loopback-only and browser access is gated by an `Origin` check: loopback origins pass by default, a `tailscale serve` front for this port is detected and allowed automatically (zero config for remote/phone access over your tailnet), and other reverse-proxy origins can be added with `CCMSG_HTTP_ALLOW_ORIGIN` (comma-separated). A source-IP allowlist (`CCMSG_HTTP_ALLOW`, default loopback) remains as defense in depth, and `CCMSG_HTTP_BIND` (comma-separated `host:port`, `off` to disable) overrides the bind. Paths are locators (`/r/<room>` = a room log, `/r/<room>/m<mid>` = a message in it, `/s/<sid>/files` / `/s/<sid>/timeline/…` / `/s/<sid>/status` = a session); see [webui-url-grammar](./docs/design/webui-url-grammar.md) and [DR-0004](./docs/decisions/DR-0004-webui-architecture.md).

## Speaking with `say`

`ccmsg say` forwards its arguments to macOS's `/usr/bin/say` in place, and first tells the daemon which session spoke. With several Claude Code sessions running, a spoken notification is otherwise anonymous — the web UI's Sessions list marks the session that spoke with 🔔, and that session's timeline shows what was said with a 既読 (read) button that clears the marker. The daemon keeps these records and their unread state in memory only, so a daemon restart forgets them. Before speaking, the words of the text are replaced by their readings from a dictionary so that terms like `daemon` or `1Password` are read correctly: `${XDG_CONFIG_HOME:-~/.config}/ccmsg/say-dictionary.tsv` (`$CCMSG_CONFIG_DIR/say-dictionary.tsv` when set), one `word<TAB>reading` per line, `#` for comments. Edit it directly; every speech reads it afresh. The file is laid over the dictionary shipped as `packages/cli/src/say-dictionary.default.tsv`: a word in the file wins over the same word shipped, so adding one line is enough to start ([DR-0042](./docs/decisions/DR-0042-say-reading-dictionary.md)).

Speech never depends on the recording: no session id, no running daemon, or a daemon that refuses the event all still speak. `bin/say` is a PATH shim that routes an ordinary `say` through this command, so every `say` on the machine — yours, a script's, an agent's — becomes attributable. Install it as a copy next to the `ccmsg` on your PATH (not a symlink: its target is a versioned plugin-cache dir that each update removes).

## Architecture (see [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md))

- **Single host** — laptop or workstation, no federation. Mobile access via tailscale over LAN.
- **Central daemon** (bun) — keeps the registry of live sessions, delivers messages between sessions, puts the person's web UI input into a session, and serves the web UI.
- **Storage** — the daemon keeps no message state of its own: a message lives in the transcripts of the sessions that sent and received it, and `ccmsg say` records are held in memory only. The room logs (`<data dir>/rooms/r<N>.jsonl`) are read-only: the web UI shows them, and nothing writes to them ([DR-0036](./docs/decisions/DR-0036-retire-rooms-for-p2p.md) §2).
- **Delivery** — a session sends to another session with the plugin's `send` tool; the daemon writes the message straight into the recipient's peer messaging socket and tells the sender whether it arrived, holding nothing for a later attempt ([DR-0034](./docs/decisions/DR-0034-peer-socket-injection.md), [DR-0036](./docs/decisions/DR-0036-retire-rooms-for-p2p.md) §1, [DR-0039](./docs/decisions/DR-0039-all-mods-and-typed-tools.md) §3). The person's input from the web UI is filled into the session's prompt box and submitted ([DR-0035](./docs/decisions/DR-0035-user-input-via-composer-fill.md)).
- **Transport** — UNIX Domain Socket (`0600` + UID check) for local clients. The web UI uses WebSocket (`/ws`) speaking the same protocol: the security layer is identity pinning to the User role, gated by loopback-only binds, a source-IP allowlist (loopback, `CCMSG_HTTP_ALLOW`) and browser `Origin` validation (loopback origins by default, extras via `CCMSG_HTTP_ALLOW_ORIGIN`, e.g. for tailscale serve).
- **Clients** — the plugin's hooks module (its `send` / `say` / `peers` / `launch` tools, and the sidecar that takes the person's input), a user-facing CLI (`peers`, `agents`, `dump`, `status`, `daemon`, `stop`, …, and `notify`, which puts a line into a session's conversation from a script such as a justfile), and the web UI. The CLI health-checks and auto-starts the daemon.

## Repository layout

```
packages/
  protocol/          # shared types (wire protocol / XDG paths / version), overview: docs/design/protocol-package.md
  daemon/            # central daemon (bun)
  cli/               # CLI client (session sidecar + user CLI)
  webui/             # web UI (hono + vanilla ESM, served by the daemon)
docs/
  decisions/         # DR-NNNN decision records
  research/          # primary sources (verbatim design statements)
  issue/             # active issues (claude-local-issue plugin)
  findings/          # confirmed facts
  journal/           # chronological notes
  runbooks/          # operational recipes
  knowledge/         # static knowledge
  design/            # design docs
```

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) Yoshiaki Kawazu.
