# claude-ccmsg

> 🇯🇵 [README-ja.md](./README-ja.md)

Central-daemon messenger for Claude Code sessions.
A rewrite of [kawaz/claude-cmux-msg](https://github.com/kawaz/claude-cmux-msg) (p2p): all writes go through a single daemon, messaging happens in rooms, and the human user participates as a first-class member.

## Status

**MVP + web UI implemented.** Architecture is captured in [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md) / [DR-0002](./docs/decisions/DR-0002-daemon-supervision.md) / [DR-0003](./docs/decisions/DR-0003-wire-protocol.md) / [DR-0004](./docs/decisions/DR-0004-webui-architecture.md), grounded in the verbatim primary sources under [docs/research/](./docs/research/). The daemon, CLI, protocol, and webui packages under [packages/](./packages/) are implemented and tested.

The predecessor (`cmux-msg`) remains the stable p2p tool for inter-session messaging until `claude-ccmsg` reaches feature parity.

## Install

Requires [bun](https://bun.sh/) (the CLI and daemon run on bun).

```
claude plugin marketplace add kawaz/claude-ccmsg
claude plugin install ccmsg@ccmsg
```

Update:

```
claude plugin marketplace update ccmsg
claude plugin update ccmsg@ccmsg
```

The plugin's `bin/ccmsg` lives under a versioned plugin-cache path, so it isn't
on your shell `PATH` by default. If `PATH` has no `ccmsg` and a stable dir
(`~/.local/bin`, then `~/bin`) is on `PATH` and writable, a Claude Code session
will offer once to symlink one in (accept/decline via a prompt in-session; a
decline is remembered and not asked again). You can also do it by hand:

```
ln -sfn <plugin-cache>/bin/ccmsg ~/.local/bin/ccmsg
```

Once installed this way, the `ccmsg` launcher keeps that symlink pointed at
the newest version on its own — every invocation from a versioned cache path
re-points it if it's strictly newer than what the symlink currently targets
(see [DR-0007](./docs/decisions/DR-0007-path-installation.md)).

## Web UI

The daemon serves a web UI at `http://127.0.0.1:8642` by default (for the human user: browse rooms, sessions, files, and transcripts, and post as `u1` = User). Binding is loopback-only and browser access is gated by an `Origin` check: loopback origins pass by default, a `tailscale serve` front for this port is detected and allowed automatically (zero config for remote/phone access over your tailnet), and other reverse-proxy origins can be added with `CCMSG_HTTP_ALLOW_ORIGIN` (comma-separated). A source-IP allowlist (`CCMSG_HTTP_ALLOW`, default loopback) remains as defense in depth, and `CCMSG_HTTP_BIND` (comma-separated `host:port`, `off` to disable) overrides the bind. URL fragments are locators (`/#rXXXX` = room, `/#rXXXX-mNN` = message position, `/#s<sid>` = session files, `/#t<sid>` = session timeline). See [DR-0004](./docs/decisions/DR-0004-webui-architecture.md).

## Why a rewrite?

The p2p approach in `cmux-msg` worked for 1:1 messaging but exposed five structural problems during multi-session dogfooding:

1. **Cross-explosion** — adding a 4th or 5th peer multiplies pair-wise sends.
2. **Repeated instructions** — same prompt to N peers means N copy-pastes for the user and N duplicated actions from peers.
3. **AI-to-AI noise** — peers waste context comparing notes about a third peer.
4. **Mail-bloat** — `msg/send/reply` framing pushes models toward formal long messages.
5. **User-mixing overhead** — the human user can only target one peer at a time, while AIs gossip about what the user said.

Rooms solve (1) and (2) structurally: one post reaches every member. (3) loses its cause because history is shared, and the `to` delivery filter (DR-0011) now scopes noisy exchanges away from uninvolved peers on top of short-message culture. (4) is a hypothesis that the `post` short-message framing reduces bloat. (5) is addressed by the user posting directly — via CLI in the MVP, web UI later.

## Architecture (see [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md))

- **Single host** — laptop or workstation, no federation. Mobile access via tailscale over LAN.
- **Central daemon** (bun) — the only writer. Issues room IDs, serializes and deduplicates concurrent room creation, and assigns per-room monotonic message IDs (`mid`).
- **Storage** — one append-only `jsonl` file per room (`member` / `leave` / `msg` / thread-links `next`/`prev` / … events) as the **only persistent state**. No server-side read cursors — BBS model: each reader tracks its own position and reconnects with a since-mid.
- **Delivery** — `to`-less messages are pushed to all room members. A `to`-bearing message is delivered only to the listed member(s), the sender, and the admin User (`u1`, always exempt) — a delivery filter, not just an attention marker (DR-0011). Storage stays unfiltered: any member can `read` a message they weren't delivered, a skipped `mid` is a deliberate pull signal. No echo back of your own posts.
- **Transport** — UNIX Domain Socket (`0600` + UID check) for local clients. The web UI uses WebSocket (`/ws`) speaking the same protocol: the security layer is identity pinning to the User role, gated by loopback-only binds, a source-IP allowlist (loopback, `CCMSG_HTTP_ALLOW`) and browser `Origin` validation (loopback origins by default, extras via `CCMSG_HTTP_ALLOW_ORIGIN`, e.g. for tailscale serve).
- **Clients** — a per-session `subscribe` sidecar (feeds the Claude Code Monitor tool), a user-facing CLI (the human is reserved member `u1` of every room), and later a web UI. Every client silently health-checks and auto-starts the daemon.

## Repository layout

```
packages/
  protocol/          # shared types (wire protocol / XDG paths / version)
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
