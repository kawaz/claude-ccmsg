// Preloaded into every `bun test` run (bunfig.toml). Daemons spawned by tests
// inherit this process's environment, and an agents poll in one of them would
// register every live Claude Code session on the developer's machine into the
// test's registry — tests that exercise the poll opt back in with their own
// fake $HOME and `claude`.
process.env.CCMSG_AGENTS_POLL ??= "off";
