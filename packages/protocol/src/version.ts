// The wire/plugin version is the monorepo root package.json version. daemon and
// cli both read it from the same source so version-mismatch detection (DR-0002 §4)
// compares apples to apples. bump-semver bumps package.json on release, so this
// value tracks the plugin version without a second file to keep in sync.
import pkg from "../../../package.json";

// Design rationale: `CCMSG_VERSION_OVERRIDE` is a test-only seam that lets a
// spawned daemon subprocess advertise a synthetic version, so the DR-0002 §4
// version-mismatch/upgrade path can be exercised in automated tests without
// installing two real builds. Production code never sets this env var; the
// override is applied at module load, so a fresh subprocess picks it up from
// its own env while the parent test process (which doesn't set it) still
// reports the real version. Kept as an env var to match the existing
// CCMSG_STATE_DIR / CCMSG_DATA_DIR / CCMSG_DEDUP_WINDOW_MS pattern instead of
// threading a version parameter through startDaemon (which would leak a
// test-only knob into the public API).
// `typeof process` guard: this module is part of the browser bundle too (the
// webui imports protocol constants as values, e.g. FS_READ_MAX_BYTES / ADMIN_ID),
// and browsers have no `process` global — an unguarded access at module load
// crashes the whole app before render.
const versionOverride =
  typeof process !== "undefined" ? process.env.CCMSG_VERSION_OVERRIDE : undefined;
export const VERSION: string =
  versionOverride && versionOverride !== ""
    ? versionOverride
    : (pkg as { version: string }).version;
