# claude-ccmsg

> 🇯🇵 [README-ja.md](./README-ja.md)

Central-daemon messenger for Claude Code sessions.
A rewrite of [kawaz/claude-cmux-msg](https://github.com/kawaz/claude-cmux-msg) (p2p) that consolidates writes into a single daemon process to eliminate p2p race conditions, simplify the model, and add room-based messaging with a web UI.

## Status

**Pre-MVP / design phase.** Architecture is captured in [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md). Implementation under [packages/](./packages/) has not started.

The predecessor (`cmux-msg`) remains the stable p2p tool for inter-session messaging until `claude-ccmsg` reaches feature parity.

## Why a rewrite?

The p2p approach in `cmux-msg` worked for 1:1 messaging but exposed five structural problems during multi-session dogfooding:

1. **Cross-explosion** — adding a 4th or 5th peer multiplies pair-wise sends.
2. **Repeated instructions** — same prompt to N peers means N copy-pastes for the user and N duplicated actions from peers.
3. **AI-to-AI noise** — peers waste context comparing notes about a third peer.
4. **Mail-bloat** — `msg/send/reply` framing pushes models toward formal long messages.
5. **User-mixing overhead** — the human user can only target one peer at a time, while AIs gossip about what the user said.

`claude-ccmsg` addresses (1)–(4) structurally with rooms and (5) with a single shared room the user can post into directly.

## Architecture (planned, see [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md))

- **Single host** — laptop or workstation, no federation. Mobile access via tailscale over LAN.
- **Central daemon** (bun + hono) — owns all writes to room logs and metadata.
- **Storage** — append-only `jsonl` per room (source of truth) + `sqlite` (regenerable cache for cursors, membership, etc.).
- **Transport** — UNIX Domain Socket (`0600` + UID check) for local clients, HTTP for the web UI (bound to `127.0.0.1` + tailscale interface).
- **Clients** — CLI (sidecar `subscribe` for each Claude session) and Web UI, both speaking the same protocol over different transports.

## Repository layout

```
.git/                  # bare repository
.jj/                   # jj default workspace
main/                  # primary jj workspace
  packages/
    daemon/            # central daemon (bun + hono)
    cli/               # CLI client (incl. session sidecar)
    webui/             # Web UI (hono SSR or SPA)
  docs/
    decisions/         # DR-NNNN (DR-0001 = central-daemon-architecture)
    issue/             # active issues (claude-local-issue plugin)
    findings/          # confirmed facts
    journal/           # chronological notes
    runbooks/          # operational recipes
    research/          # exploratory notes
    knowledge/         # static knowledge
    design/            # design docs
  README.md  README-ja.md  LICENSE
```

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) Yoshiaki Kawazu.
