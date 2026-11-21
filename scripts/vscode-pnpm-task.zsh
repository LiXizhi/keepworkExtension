#!/bin/zsh
# VS Code macOS shell tasks run `/bin/zsh -l -c`. That login shell reads
# .zprofile and skips .zshrc, so `pnpm` installed by the official installer,
# nvm, or fnm is missing and the task exits 127. Find that pnpm, keep the
# working directory VS Code already set, and exec the original arguments.
emulate -L zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL

task_cwd="$PWD"
ZSH_BIN="$(whence -p zsh 2>/dev/null || true)"
if [[ -z "$ZSH_BIN" || ! -x "$ZSH_BIN" ]]; then
  ZSH_BIN="/bin/zsh"
fi

executable_pnpm() {
  local dir node_bin candidate
  for dir in "${path[@]}"; do
    candidate="$dir/pnpm"
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
    # A PATH shim may expose just Node. Its installation can also contain the
    # Corepack pnpm shim needed by both this task and Tauri's beforeDevCommand.
    node_bin="$dir/node"
    if [[ -L "$node_bin" && -x "$node_bin" ]]; then
      candidate="${node_bin:A:h}/pnpm"
      if [[ -f "$candidate" && -x "$candidate" ]]; then
        print -r -- "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

# First match wins. Login PATH stays ahead of default install locations, and
# the official installer stays ahead of a leftover nvm/fnm binary.
choose_known_pnpm() {
  local dir candidate
  local -a dirs nvm_pnpm
  dirs=(
    "${PNPM_HOME:-}"
    "$HOME/Library/pnpm"
    "$HOME/.local/share/pnpm"
    "/opt/homebrew/bin"
    "/usr/local/bin"
    "$HOME/.volta/bin"
    "$HOME/.asdf/shims"
    "$HOME/.local/share/fnm/aliases/default/bin"
    "$HOME/Library/Application Support/fnm/aliases/default/bin"
    "$HOME/.fnm/aliases/default/bin"
  )
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    nvm_pnpm=("$HOME"/.nvm/versions/node/*/bin/pnpm(Nn))
    if (( ${#nvm_pnpm} )); then
      dirs+=("$(dirname "${nvm_pnpm[-1]}")")
    fi
  fi
  for dir in "${dirs[@]}"; do
    [[ -n "$dir" ]] || continue
    candidate="$dir/pnpm"
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done
  return 1
}

load_interactive_path() {
  local marker="__KP_PATH_$$__"
  local end="__KP_END_$$__"
  local code dump line extracted
  local -a lines
  # ~/.zshrc often returns immediately unless the shell is interactive, which
  # is where the official pnpm installer, nvm, and fnm export PATH.
  code='print -r -- "'"$marker"'"$PATH"'"$end"'"'
  dump="$(DEBIAN_PREVENT_KEYBOARD_CHANGES=1 "$ZSH_BIN" -ilc "$code" </dev/null 2>/dev/null || true)"
  extracted=""
  lines=("${(f)dump}")
  for line in "${lines[@]}"; do
    if [[ "$line" == *"$marker"* && "$line" == *"$end"* ]]; then
      extracted="${line#*"$marker"}"
      extracted="${extracted%%"$end"*}"
    fi
  done
  [[ -n "$extracted" ]] || return 1
  PATH="$extracted"
  hash -r
}

pnpm_path=""
if ! pnpm_path="$(executable_pnpm)"; then
  if ! pnpm_path="$(choose_known_pnpm)"; then
    load_interactive_path || true
    if ! pnpm_path="$(executable_pnpm)"; then
      print -u2 -- "pnpm was not found for keepwork Rust Desktop: Start."
      print -u2 -- "VS Code starts this task with a login shell (zsh -l), which does not read ~/.zshrc."
      print -u2 -- "Checked the login PATH, ~/Library/pnpm, Homebrew, nvm, fnm, volta, and an interactive zsh PATH."
      exit 127
    fi
  fi
fi

# Discovery runs in command substitutions; update the parent shell so pnpm's
# env-node shebang can also find the Node installed beside the selected pnpm.
PATH="${pnpm_path:h}:$PATH"
export PATH
hash -r
# A newly installed Xcode can be selected before its compiler is usable.
# Prefer the selected toolchain, then try standalone Command Line Tools.
clt_dir=/Library/Developer/CommandLineTools
if [[ -z "${DEVELOPER_DIR:-}" && -x /usr/bin/xcrun && -d "$clt_dir" ]] &&
    ! /usr/bin/xcrun --sdk macosx clang --version >/dev/null 2>&1 &&
    DEVELOPER_DIR="$clt_dir" /usr/bin/xcrun --sdk macosx clang --version >/dev/null 2>&1; then
  export DEVELOPER_DIR="$clt_dir"
  print -u2 -- "Using standalone Command Line Tools for this desktop build."
fi
cd "$task_cwd"
exec "$pnpm_path" "$@"
