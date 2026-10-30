#!/bin/zsh
# The built-in launch command (DR-0018 §3.1): what the daemon runs, as
# `zsh <this file>`, when the config names no `launch_command`. It reads the
# launch command's input on standard input (docs/design/launch-command.md) and
# starts claude in a detached hyoui terminal with the prompt on claude's
# standard input, ending with hyoui's exit code.
#
# It judges no cwd and answers no trust dialog: a setup that needs either (or
# its own claude, or its own session names) writes its own launch command.
# What it refuses (no jq, hyoui or claude in PATH) it refuses before claude
# starts, exiting 2 with the reason on standard error.
set -eu

# Run by bash by mistake (`bash <this file>`): stop before anything zsh-only.
[[ -n ${BASH:-} ]] && { echo "ccmsg default launch command: run it with zsh" >&2; exit 2; }

setopt extended_glob

fail() { print -ru2 -- "ccmsg default launch command: $*"; exit 2 }

(( $+commands[jq] )) || fail "jq is not found in PATH"
(( $+commands[hyoui] )) || fail "hyoui is not found in PATH"
(( $+commands[claude] )) || fail "claude is not found in PATH"

input_json=$(cat)

field() { jq -r --arg k "$1" '.[$k] // empty' <<< "$input_json" }
cwd=$(field cwd)
model=$(field model)
effort=$(field effort)
continue=$(field continue)
resume=$(field resume)
fork_session=$(field fork_session)
session_id=$(field session_id)
name=$(field name)
prompt=$(field prompt)

cd -- "$cwd"

opts=()

# Each model's effort when none is given.
if [[ -z $effort ]]; then
  case $model in
    fable) effort=low ;;
    opus) effort=medium ;;
    sonnet) effort=medium ;;
    haiku) effort=low ;;
  esac
fi

# Clean the environment claude inherits: other sessions' and terminals'
# variables, except the config dir the session belongs to. `unset -m` fails
# when nothing matches, which is nothing to clean.
unset CLAUDECODE
unset -m '(CLAUDE|ANTHROPIC|HYOUI|CCMSG)_*~(CLAUDE_CONFIG_DIR)' || :

# Through direnv when it is there, so the cwd's .envrc (the config dir, the
# keys of the account the repo belongs to) applies to claude.
run=()
(( $+commands[direnv] )) && run=(direnv exec .)

[[ -n $model ]] && opts+=(--model "$model")
[[ -n $effort ]] && opts+=(--effort "$effort")
[[ -n $name ]] && opts+=(--name "$name")
[[ $continue == true ]] && opts+=(--continue)
[[ -n $resume ]] && opts+=(--resume "$resume")
[[ $fork_session == true ]] && opts+=(--fork-session)
[[ -n $session_id ]] && opts+=(--session-id "$session_id")

[[ -z $prompt ]] && prompt="."

# The prompt on claude's standard input, not in its argv (out of ps, clear of
# the argument length limit, never read as an option). A here-string is a
# regular file, so claude reads all of it however late it starts.
exec "${run[@]}" hyoui run --detached -- claude "${opts[@]}" <<< "$prompt"
