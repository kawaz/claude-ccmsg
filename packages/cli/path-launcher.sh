#!/bin/sh
# ccmsg PATH launcher (just install-launcher)
#
# The `ccmsg` to put on PATH (`just install-launcher` copies this file there).
# Each run reads which version of the ccmsg-v1 plugin Claude Code has installed
# and execs that version's `bin/ccmsg`, so a plugin update needs nothing done to
# PATH (DR-0032 §2.2-4). It runs without bun; the launcher it hands over to
# needs bun and says so itself.
#
# Which config dir: CLAUDE_CONFIG_DIR, or Claude Code's default `~/.claude`
# without it — the same dir a claude started in this environment uses, and the
# one the CLI itself falls back to. Nothing scans `~/.claude*` for another one.
#
# The plugin record is `<config dir>/plugins/installed_plugins.json`, Claude
# Code's own: `plugins["ccmsg-v1@ccmsg-v1"]` lists the installs, and the
# user-scope one's `installPath` is the version's directory in the plugin cache.

plugin=ccmsg-v1@ccmsg-v1
config_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
record=$config_dir/plugins/installed_plugins.json

fail() {
  printf 'ccmsg: %s\n' "$1" >&2
  exit 1
}

[ -f "$record" ] ||
  fail "$record not found: set CLAUDE_CONFIG_DIR to the Claude Code config dir $plugin is installed in"
command -v jq >/dev/null 2>&1 ||
  fail "jq not found: install jq (the launcher reads $record with it)"

# jq fails on a file that is not JSON or not of the record's shape; a plugin
# with no user-scope install prints nothing.
root=$(jq -r --arg plugin "$plugin" \
  '.plugins[$plugin] // [] | map(select(.scope == "user"))[0].installPath // empty | strings' \
  "$record" 2>/dev/null) ||
  fail "$record does not read as Claude Code's plugin record: check the file, or reinstall with: claude plugin install $plugin"
[ -n "$root" ] ||
  fail "$plugin is not installed in $config_dir: install it with: CLAUDE_CONFIG_DIR=$config_dir claude plugin install $plugin"
[ -x "$root/bin/ccmsg" ] ||
  fail "$root/bin/ccmsg not found (the plugin cache is gone): reinstall with: CLAUDE_CONFIG_DIR=$config_dir claude plugin install $plugin"

exec "$root/bin/ccmsg" "$@"
