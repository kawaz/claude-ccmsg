# claude-ccmsg

> 🇯🇵 [README-ja.md](./README-ja.md)

Central-daemon messenger for Claude Code sessions.
A rewrite of [kawaz/claude-cmux-msg](https://github.com/kawaz/claude-cmux-msg) (p2p): all writes go through a single daemon, messaging happens in rooms, and the human user participates as a first-class member.

## Status

**Pre-MVP / design phase.** Architecture is captured in [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md) (Proposed), grounded in the verbatim primary sources under [docs/research/](./docs/research/). Implementation under [packages/](./packages/) has not started.

The predecessor (`cmux-msg`) remains the stable p2p tool for inter-session messaging until `claude-ccmsg` reaches feature parity.

## Why a rewrite?

The p2p approach in `cmux-msg` worked for 1:1 messaging but exposed five structural problems during multi-session dogfooding:

1. **Cross-explosion** — adding a 4th or 5th peer multiplies pair-wise sends.
2. **Repeated instructions** — same prompt to N peers means N copy-pastes for the user and N duplicated actions from peers.
3. **AI-to-AI noise** — peers waste context comparing notes about a third peer.
4. **Mail-bloat** — `msg/send/reply` framing pushes models toward formal long messages.
5. **User-mixing overhead** — the human user can only target one peer at a time, while AIs gossip about what the user said.

Rooms solve (1) and (2) structurally: one post reaches every member. (3) loses its cause because history is shared, though residual AI chatter is an operational concern (mention semantics + short-message culture, verified by dogfooding). (4) is a hypothesis that the `post` short-message framing reduces bloat. (5) is addressed by the user posting directly — via CLI in the MVP, web UI later.

## Architecture (planned, see [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md))

- **Single host** — laptop or workstation, no federation. Mobile access via tailscale over LAN.
- **Central daemon** (bun) — the only writer. Issues room IDs, serializes and deduplicates concurrent room creation, and assigns per-room monotonic message IDs (`mid`).
- **Storage** — one append-only `jsonl` file per room (`member` / `leave` / `msg` / thread-links `next`/`prev` / … events) as the **only persistent state**. No server-side read cursors — BBS model: each reader tracks its own position and reconnects with a since-mid.
- **Delivery** — full message bodies are pushed to all room members; `to` is a mention (attention) marker, not a visibility filter. No echo back of your own posts.
- **Transport** — UNIX Domain Socket (`0600` + UID check) for local clients. HTTP arrives with the web UI phase: same protocol behind a security layer, bound to `127.0.0.1` + tailscale interface only.
- **Clients** — a per-session `subscribe` sidecar (feeds the Claude Code Monitor tool), a user-facing CLI (the human is reserved member `0` of every room), and later a web UI. Every client silently health-checks and auto-starts the daemon.

## Repository layout

```
packages/
  daemon/            # central daemon (bun)
  cli/               # CLI client (session sidecar + user CLI)
  webui/             # web UI (later phase)
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
