#!/bin/zsh
# The built-in launch command (DR-0018 §3.1): what the daemon runs, as
# `zsh <this file>`, when the config names no `launch_command`. It reads the
# launch command's input on standard input (docs/design/launch-command.md) and
# starts claude in a detached hyoui terminal with the prompt on claude's
# standard input, ending with hyoui's exit code.
#
# A continue starts as the `--resume` of the session `claude --continue` would
# carry on, chosen beforehand by this plugin's `ccmsg launch-context` (or stays
# `--continue` when `--resume` would refuse that session), and a continue or a
# resume that names no model or effort takes the session's.
#
# It judges no cwd and answers no trust dialog: a setup that needs either (or
# its own claude, or its own session names) writes its own launch command.
# What it refuses (no jq, hyoui or claude in PATH, a launch context that does
# not come) it refuses before claude starts, exiting 2 with the reason on
# standard error.
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
settings=$(field settings)

cd -- "$cwd"

# Clean the environment claude inherits: other sessions' and terminals'
# variables, except the config dir the session belongs to. `unset -m` fails
# when nothing matches, which is nothing to clean.
unset CLAUDECODE
unset -m '(CLAUDE|ANTHROPIC|HYOUI|CCMSG)_*~(CLAUDE_CONFIG_DIR)' || :

# Through direnv when it is there, so the cwd's .envrc (the config dir, the
# keys of the account the repo belongs to) applies to claude.
run=()
(( $+commands[direnv] )) && run=(direnv exec .)

# The session a continue or a resume carries on from, asked of this plugin's
# CLI in the environment claude gets (the config dir the cwd's .envrc names).
# A continue becomes the `--resume` of the session it names, so claude carries
# on that one and no other, even where a later claude would choose another;
# one that names none stays `--continue`, for claude to say there is none to
# continue, and so does one whose session `--resume` refuses (`keep_continue`:
# a session with no conversation it can read, which `--continue` carries on
# under that same id). A model or effort the input leaves out is the
# session's, as the daemon fills a resume (DR-0018 §3.2): the daemon fills
# none for a continue, and a resume it read nothing for comes without them.
# A session that is running now is chosen as claude chooses it, and then two
# processes write it.
if [[ $continue == true || ( -n $resume && ( -z $model || -z $effort ) ) ]]; then
  ask=()
  if [[ $continue == true ]]; then ask+=(--continue); else ask+=(--resume "$resume"); fi
  [[ -n $model ]] && ask+=(--model "$model")
  [[ -n $effort ]] && ask+=(--effort "$effort")
  context=$("${run[@]}" "${0:A:h:h:h:h}/bin/ccmsg" launch-context "${ask[@]}") ||
    fail "ccmsg launch-context did not answer, so the session to carry on is not known"
  picked=$(jq -r '.session_id // empty' <<< "$context")
  keep_continue=$(jq -r '.keep_continue // empty' <<< "$context")
  if [[ $continue == true && -n $picked && $keep_continue != true ]]; then
    continue=
    resume=$picked
  fi
  [[ -z $model ]] && model=$(jq -r '.model // empty' <<< "$context")
  [[ -z $effort ]] && effort=$(jq -r '.effort // empty' <<< "$context")
fi

# Each model's effort when none is given.
if [[ -z $effort ]]; then
  case $model in
    mythos) effort=low ;;
    fable) effort=low ;;
    opus) effort=medium ;;
    sonnet) effort=medium ;;
    haiku) effort=low ;;
  esac
fi

opts=()
[[ -n $model ]] && opts+=(--model "$model")
[[ -n $effort ]] && opts+=(--effort "$effort")
[[ -n $name ]] && opts+=(--name "$name")
[[ $continue == true ]] && opts+=(--continue)
[[ -n $resume ]] && opts+=(--resume "$resume")
[[ $fork_session == true ]] && opts+=(--fork-session)
[[ -n $session_id ]] && opts+=(--session-id "$session_id")
# The project's autoMode the daemon made into a file (DR-0063 §5). This
# command gives claude no other --settings, so the file goes as it is.
[[ -n $settings ]] && opts+=(--settings "$settings")

[[ -z $prompt ]] && prompt="."

# The prompt on claude's standard input, not in its argv (out of ps, clear of
# the argument length limit, never read as an option). A here-string is a
# regular file, so claude reads all of it however late it starts.
exec "${run[@]}" hyoui run --detached -- claude "${opts[@]}" <<< "$prompt"
