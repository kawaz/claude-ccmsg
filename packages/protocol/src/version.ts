// The wire/plugin version is the monorepo root package.json version. daemon and
// cli both read it from the same source so version-mismatch detection (DR-0002 §4)
// compares apples to apples. bump-semver bumps package.json on release, so this
// value tracks the plugin version without a second file to keep in sync.
import pkg from "../../../package.json";

export const VERSION: string = (pkg as { version: string }).version;
