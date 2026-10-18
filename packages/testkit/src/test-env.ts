// Preloaded into every `bun test` run (bunfig.toml). Daemons spawned by tests
// inherit this process's environment, and an agents poll in one of them would
// register every live Claude Code session on the developer's machine into the
// test's registry — tests that exercise the poll opt back in with their own
// fake $HOME and `claude`.
import { setDefaultTimeout } from "bun:test";

process.env.CCMSG_AGENTS_POLL ??= "off";

// One timeout for every test, long enough for the ones that start a daemon or
// a CLI process. bun reads no `timeout` from bunfig.toml's [test] section, so
// it is set here, where every run passes. A test that needs longer passes its
// own with a comment saying why.
setDefaultTimeout(15_000);
