#!/bin/zsh
# The built-in btw command (DR-0060 §2): what the daemon runs, as
# `zsh -f <this file>`, when the config names no `btw_command`. It reads the
# btw on standard input (docs/design/btw-command.md) and forks the session
# with `claude -p --resume <sid> --fork-session --no-session-persistence`,
# claude's stream-json on standard output and the prompt on claude's standard
# input.
#
# The model goes to claude as the daemon names it (the id the session
# answered as, `[1m]` kept for a 1M session: DR-0060 §2), and no
# option that changes the tools is given: the fork's requests then match the
# session's up to the new prompt, and read its prompt cache.
# What it refuses (no jq or claude in PATH) it refuses before claude starts,
# exiting 2 with the reason on standard error.
set -eu

# Run by bash by mistake (`bash <this file>`): stop before anything zsh-only.
[[ -n ${BASH:-} ]] && { echo "ccmsg default btw command: run it with zsh" >&2; exit 2; }

setopt extended_glob

fail() { print -ru2 -- "ccmsg default btw command: $*"; exit 2 }

(( $+commands[jq] )) || fail "jq is not found in PATH"
(( $+commands[claude] )) || fail "claude is not found in PATH"

input_json=$(cat)

field() { jq -r --arg k "$1" '.[$k] // empty' <<< "$input_json" }
cwd=$(field cwd)
config_dir=$(field config_dir)
resume=$(field resume)
model=$(field model)
effort=$(field effort)
prompt=$(field prompt)
settings=$(field settings)

[[ -n $cwd && -n $config_dir && -n $resume ]] || fail "the input names no cwd, config_dir or resume"

cd -- "$cwd"

# Clean the environment claude inherits as the built-in launch command does:
# other sessions' and terminals' variables go. The config dir is the
# session's, set last (below) so the cwd's .envrc does not move it.
unset CLAUDECODE
unset -m '(CLAUDE|ANTHROPIC|HYOUI|CCMSG)_*' || :

# Through direnv when it is there, so the cwd's .envrc (the keys of the
# account the repo belongs to) applies to the tools the fork runs.
run=()
(( $+commands[direnv] )) && run=(direnv exec .)

opts=(-p --resume "$resume" --fork-session --no-session-persistence)
[[ -n $model ]] && opts+=(--model "$model")
[[ -n $effort ]] && opts+=(--effort "$effort")
# The session's project's autoMode the daemon made into a file (DR-0063 §8).
# This command gives claude no other --settings, so the file goes as it is.
[[ -n $settings ]] && opts+=(--settings "$settings")
opts+=(--permission-prompts none --output-format stream-json --verbose --include-partial-messages)

# The prompt on claude's standard input, not in its argv (out of ps, clear of
# the argument length limit, never read as an option).
exec "${run[@]}" env CLAUDE_CONFIG_DIR="$config_dir" claude "${opts[@]}" <<< "$prompt"
