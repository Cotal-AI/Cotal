#!/bin/sh
# Cotal installer. The open web for agents.
#
#   curl -fsSL https://get.cotal.ai | sh
#
# Read this before you run it. That is the point of serving it as plain text:
#   source   https://github.com/Cotal-AI/Cotal/blob/main/install.sh
#   browser  https://get.cotal.ai  (served as text/plain so you can read it in a tab)
#
# WHAT IT DOES
#   1. Works out your platform, and refuses to guess if it is one we do not ship for.
#   2. Finds a Node >= 22.10. If your machine has one, it uses it. If not, it downloads the
#      official Node LTS build into Cotal's own directory and verifies it against the
#      SHASUMS256.txt published beside it on nodejs.org.
#   3. Installs the `cotal-ai` package from npm into a prefix Cotal owns.
#   4. Writes one launcher to ~/.local/bin/cotal that pins the Node it just verified.
#   5. Adds that directory to PATH, once, in a marked block you can delete.
#
# WHAT IT DOES NOT DO
#   No sudo. No system directories. No package manager. Nothing outside your home
#   directory. `curl ... | sudo sh` is refused outright; see require_unprivileged below.
#
# WHY THE LAUNCHER PINS NODE
#   npm silently skips an optional dependency whose `engines` the running Node does not
#   satisfy. Cotal's NATS broker binary is such a dependency. Install under Node 18 and
#   you get a Cotal with no broker and a confusing crash later. Pinning the Node that the
#   install was verified against is what makes that failure impossible rather than rare.
#
# UNINSTALL
#   Stop the local spaces and agents that use this installation.
#   Run cotal daemon status to check the machine daemon. If you installed it,
#   run cotal daemon uninstall from its owning installation before removing
#   any files. Pass the same --daemon-home if you set one at install time.
#   rm -rf ~/.local/share/cotal ~/.local/bin/cotal   # this installer's files
#   then delete the `# cotal` block from your shell rc.
#   This leaves project files, systemd linger, and the configuration directory.
#   Settings, installed extensions, and the connector seed store are in
#   $XDG_CONFIG_HOME/cotal (if set and non-empty), otherwise ~/.config/cotal.
#   Back up settings you want to keep. Delete that directory only if no other
#   Cotal installation or running Cotal process uses it.
#   Delete ~/.cotal separately only to remove your meshes, agents and credentials.
#   If the CLI is already gone, see https://docs.cotal.ai/docs/installation/#remove-cotal.
#
# Apache-2.0. Everything below runs inside main(), invoked by the brace-wrapped last line.
# A compound command is not executed until its closing brace is parsed, so any prefix that is
# missing a syntactically meaningful byte of that line defines some functions and then does
# nothing. (A prefix missing only the trailing newline is the whole program, and runs, with
# exactly the arguments the caller passed. What can never happen is main running with argv
# the caller did not give it, which is what a bare `main` at the end would allow.)

set -eu

# ---------------------------------------------------------------------------------------
# What we install
# ---------------------------------------------------------------------------------------

COTAL_PKG="cotal-ai"
NODE_MIN="22.10"                # cotal-ai's engines floor
NODE_MIN_RANK=22010             # the same floor as major*1000+minor, for one integer compare
NODE_PIN="v24.18.0"             # Node LTS ("Krypton"), vendored only when the box has none
NODE_DIST="https://nodejs.org/dist"
DOCS_URL="https://docs.cotal.ai"
ISSUES_URL="https://github.com/Cotal-AI/Cotal/issues"

# ---------------------------------------------------------------------------------------
# Terminal
#
# Colors match the Cotal CLI exactly (implementations/cli/src/lib/theme.ts): brand blue
# #58a6ff, success green #3fb950, 24-bit when the terminal advertises it and 16-color
# otherwise. Piped output is plain text; NO_COLOR keeps the layout but drops the color.
# ---------------------------------------------------------------------------------------

ESC=$(printf '\033')
C_OFF="" C_BRAND="" C_BOLD="" C_DIM="" C_GREEN="" C_RED="" C_YELLOW=""
TTY=0   # stdout is a terminal: drives the banner, the spinner, and in-place redraws
COLOR=0 # ...and we are also allowed to color it
UTF8=0
S_OK="+" S_NO="x" S_WARN="!" S_DOT="-" S_SEP="-"
SPIN_FRAMES="- \\ | /"

init_term() {
  [ -t 1 ] && TTY=1
  # NO_COLOR means plain text, not a downgrade to no feedback at all: someone who turns
  # color off still wants to watch the download happen.
  [ "$TTY" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ] && COLOR=1
  if [ "$COLOR" = 1 ]; then
    # Braces are load-bearing: `$ESC[0m` would be read as a name that includes the bracket.
    C_OFF="${ESC}[0m" C_BOLD="${ESC}[1m" C_DIM="${ESC}[2m"
    case "${COLORTERM:-}" in
      truecolor | 24bit)
        C_BRAND="${ESC}[38;2;88;166;255m"
        C_GREEN="${ESC}[38;2;63;185;80m"
        ;;
      *)
        C_BRAND="${ESC}[34m"
        C_GREEN="${ESC}[32m"
        ;;
    esac
    C_RED="${ESC}[31m"
    C_YELLOW="${ESC}[33m"
  fi
  # Effective locale, in POSIX precedence order. Matching all three at once let LC_ALL=C
  # with LANG=en_US.UTF-8 still print Unicode, which is exactly backwards.
  _loc="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
  case "$_loc" in
    *UTF-8* | *utf8* | *UTF8* | *utf-8*) UTF8=1 ;;
  esac
  if [ "$UTF8" = 1 ]; then
    S_OK="✓" S_NO="✗" S_WARN="!" S_DOT="·" S_SEP="·"
    SPIN_FRAMES="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"
  fi
}

# Every writer goes through printf '%s' so nothing we print is ever read as a format string.
blank() { printf '\n'; }
ok_line() { printf '  %s%s%s %s\n' "$C_GREEN" "$S_OK" "$C_OFF" "$*"; }
warn_line() { printf '  %s%s%s %s\n' "$C_YELLOW" "$S_WARN" "$C_OFF" "$*"; }
dim_line() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
head_line() { printf '  %s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }

# A failure always names the cause on the first line and the way out on the next.
die() {
  spin_stop
  blank
  printf '  %s%s %s%s\n' "$C_RED" "$S_NO" "$1" "$C_OFF"
  shift
  for line in "$@"; do printf '    %s\n' "$line"; done
  blank
  printf '  %sStuck? %s%s\n' "$C_DIM" "$ISSUES_URL" "$C_OFF"
  blank
  exit 1
}

# A value emitted as shell SOURCE (the launcher, an rc line) must be a safe literal, not
# pasted between quotes. A path may legally contain " $ ` \ and a newline, and pasting one
# into COTAL_ROOT="..." produces a launcher that does not parse, or worse, one that runs
# something. Single quotes with the '"'"' escape are the only form with no metacharacters.
shquote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# `~/x` instead of `/home/someone/x`, so paths stay readable and shareable.
tildify() {
  case "$1" in
    "$HOME"/*) printf '~%s\n' "${1#"$HOME"}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------------------
# Spinner: a background writer, always reaped by the EXIT trap.
# ---------------------------------------------------------------------------------------

SPIN_PID=""

spin_start() {
  if [ "$TTY" != 1 ]; then
    dim_line "$1"
    return 0
  fi
  # shellcheck disable=SC2016  # frames are re-read each loop, not expanded once
  (
    while :; do
      for frame in $SPIN_FRAMES; do
        printf '\r  %s%s%s %s' "$C_BRAND" "$frame" "$C_OFF" "$1"
        sleep 0.08 2>/dev/null || sleep 1
      done
    done
  ) &
  SPIN_PID=$!
}

spin_stop() {
  [ -n "$SPIN_PID" ] || return 0
  kill "$SPIN_PID" 2>/dev/null || true
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=""
  [ "$TTY" = 1 ] && printf '\r%s[2K' "$ESC"
  return 0
}

TMPDIR_SELF=""
STAGED_INSTALL=""
LOCKDIR=""
DOWNGRADE_PENDING=0
KEEP_STAGE=0
# shellcheck disable=SC2329,SC2317  # invoked from the EXIT/INT/TERM/HUP traps set in main
cleanup() {
  spin_stop
  if ! restore_downgrade; then
    warn_line "Could not restore the previous Cotal installation. The recovery files are in $(shquote "$STAGED_INSTALL")."
  fi
  [ -n "$TMPDIR_SELF" ] && [ -d "$TMPDIR_SELF" ] && rm -rf "$TMPDIR_SELF"
  [ "$KEEP_STAGE" = 0 ] && [ -n "$STAGED_INSTALL" ] && [ -d "$STAGED_INSTALL" ] && rm -rf "$STAGED_INSTALL"
  [ -n "$LOCKDIR" ] && [ -L "$LOCKDIR" ] && rm -f "$LOCKDIR"
  return 0
}

# Two installers writing the same prefix at once corrupt each other: npm stages and renames
# inside it, so a concurrent pair can finish "successfully" and leave no working cotal at
# all. Observed intermittently, which is worse than a clean failure. Creating a symlink is
# atomic, so one install proceeds and the rest say so and stop.
# The lock owner, as "<host>:<pid>". A bare pid says nothing off this machine: on a shared or
# NFS home, or across PID namespaces, another host's live pid simply does not exist here and
# `kill -0` would call a running install stale. Staleness is only ever judged for our own host.
lock_owner_id() {
  printf '%s:%s\n' "$(uname -n 2>/dev/null || printf 'unknown')" "$$"
}

acquire_install_lock() {
  _lock="$INSTALL_DIR/.install-lock"
  _tries=0
  while :; do
    # `ln -s target name` creates name INSIDE name when name is an existing directory, and
    # would then report success while holding no lock at all. A directory here is not ours
    # (an older version left it, or something unrelated did), so refuse rather than guess.
    if [ -d "$_lock" ] && [ ! -L "$_lock" ]; then
      die "Something is in the way of the install lock at $(tildify "$_lock")." \
        "Remove it if no other install is running:" \
        "  rm -rf $(shquote "$_lock")"
    fi
    # A symlink, not a directory: creating one is a single atomic operation that fails if the
    # name already exists, AND its target string carries the owner's pid. `mkdir` then
    # write-a-pid-file has a window between the two where the lock is held but unattributed,
    # and a second installer arriving in that window reads no owner, concludes "stale", and
    # steals a live lock. There is no such window here: the owner ships with the lock.
    if ln -s "$(lock_owner_id)" "$_lock" 2>/dev/null; then
      LOCKDIR="$_lock"
      return 0
    fi
    # ln -s failing with nothing at that path means the failure was not "already exists":
    # the filesystem has no symlinks, or the directory is not writable. Say which, rather
    # than blame a lock that is not there.
    if [ ! -e "$_lock" ] && [ ! -L "$_lock" ]; then
      die "Could not create the install lock at $(tildify "$_lock")." \
        "The filesystem may not support symlinks, or $(tildify "$INSTALL_DIR") may not be" \
        "writable by you. Install somewhere else:" \
        "  curl -fsSL https://get.cotal.ai | COTAL_INSTALL_DIR=/path/you/own sh"
    fi
    _owner=$(readlink "$_lock" 2>/dev/null || printf '')
    if [ -z "$_owner" ]; then
      die "Something is in the way of the install lock at $(tildify "$_lock")." \
        "Remove it if no other install is running:" \
        "  rm -rf $(shquote "$_lock")"
    fi
    _owner_host=${_owner%:*}
    _owner_pid=${_owner##*:}
    # Another host holds it: we cannot ask whether that process is alive, so we never assume
    # it is dead. Refusing is the only safe answer on a shared or networked home.
    if [ "$_owner_host" != "$(uname -n 2>/dev/null || printf 'unknown')" ]; then
      die "Another Cotal install holds the lock from host \"$_owner_host\" (pid $_owner_pid)." \
        "This install directory is shared with another machine, and whether that install is" \
        "still running cannot be determined from here." \
        "" \
        "Wait for it to finish. If you are sure it is gone, clear the lock:" \
        "  rm -f $(shquote "$_lock")"
    fi
    # kill -0 answers "may I signal this pid", not "is this my installer". A pid recycled by
    # an unrelated process therefore reads as a live owner. That is rare, and fail-closed is
    # the right default, but it must never be a dead end: print the way out every time.
    if kill -0 "$_owner_pid" 2>/dev/null; then
      die "Another Cotal install is already running (pid $_owner_pid)." \
        "They would overwrite each other inside $(tildify "$INSTALL_DIR")." \
        "Wait for it to finish, then run this again." \
        "" \
        "If you are sure no other install is running, clear the lock:" \
        "  rm -f $(shquote "$_lock")"
    fi
    # The owner is gone, so the lock is stale. Drop it and retry rather than assume the retry
    # wins: another installer may be doing exactly the same thing right now.
    rm -f "$_lock" 2>/dev/null || true
    _tries=$((_tries + 1))
    [ "$_tries" -lt 5 ] || die "Could not claim the install lock at $(tildify "$_lock")." \
      "Remove it by hand if no other install is running:" \
      "  rm -f $(shquote "$_lock")"
  done
}

# ---------------------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------------------

OPT_YES=0
OPT_SETUP=1
OPT_MODIFY_PATH=1
OPT_VENDOR_NODE=0
OPT_DRY_RUN=0
OPT_VERSION="latest"

usage() {
  cat <<EOF

  Cotal installer. The open web for agents.

  Usage
    curl -fsSL https://get.cotal.ai | sh
    curl -fsSL https://get.cotal.ai | sh -s -- [options]

  Options
    -y, --yes             non-interactive; take every default and skip guided setup
        --version <ver>   install a specific cotal-ai version (default: latest)
        --vendor-node     always install Cotal's own Node, even if this machine has one
        --no-modify-path  do not touch any shell rc; print the PATH line instead
        --no-setup        install only; do not run guided setup afterwards
        --dry-run         report what would happen and change nothing
    -h, --help            this text

  Environment
    COTAL_INSTALL_DIR     install root      (default: \${XDG_DATA_HOME:-~/.local/share}/cotal)
    COTAL_BIN_DIR         launcher location (default: ~/.local/bin)
    NO_COLOR              disable color

  Docs $DOCS_URL

EOF
  exit 0
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -y | --yes) OPT_YES=1 ;;
      --no-setup) OPT_SETUP=0 ;;
      --no-modify-path) OPT_MODIFY_PATH=0 ;;
      --vendor-node) OPT_VENDOR_NODE=1 ;;
      --dry-run) OPT_DRY_RUN=1 ;;
      --version | --version=*)
        case "$1" in
          --version)
            shift
            OPT_VERSION="${1-}"
            ;;
          *) OPT_VERSION="${1#--version=}" ;;
        esac
        [ -n "$OPT_VERSION" ] || die "--version needs a value" \
          "Provide a version such as --version 0.14.2, or omit --version to install the latest release."
        ;;
      -h | --help) usage ;;
      *)
        die "Unknown option: $1" "Run with --help to see what this installer accepts."
        ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# Piping an installer into a root shell is the thing every security guide tells you not to
# do, so we make it impossible rather than discouraged. It is also simply wrong here: it
# would install into root's home and leave every file unwritable by you.
require_unprivileged() {
  [ "$(id -u)" = "0" ] || return 0
  if [ -n "${COTAL_ALLOW_ROOT:-}" ]; then
    warn_line "running as root because COTAL_ALLOW_ROOT is set; installing into $HOME"
    return 0
  fi
  die "Do not run this installer as root." \
    "Cotal installs entirely inside your home directory and never needs elevation." \
    "Running it under sudo would install into root's home and leave the files" \
    "unwritable by you." \
    "" \
    "Run it as yourself:" \
    "  curl -fsSL https://get.cotal.ai | sh" \
    "" \
    "If you really do intend a root-owned install, set COTAL_ALLOW_ROOT=1."
}

# Only the vendored-Node path downloads and unpacks anything. A machine that already has a
# good Node needs none of this, and slim container images routinely ship Node without curl,
# so the requirement is stated where it is actually used, not as a blanket gate up front.
require_download_tools() {
  have curl || have wget ||
    die "Need curl or wget to download the Node runtime." \
      "This machine has no Node $NODE_MIN+, so one has to be fetched." \
      "Install curl or wget and run this again."
  have tar || die "Need tar to unpack the Node runtime." \
    "On Rocky Linux, Fedora or RHEL, install it first: sudo dnf install tar" \
    "On other systems, install tar with your system package manager." \
    "Then run this installer again as your own user, without sudo." \
    "Prerequisites: $DOCS_URL/docs/installation/#use-the-shell-installer"
  have mktemp || die "Need mktemp to stage the download safely." \
    "Install coreutils and run this again."
  have sha256sum || have shasum || have openssl ||
    die "Need a SHA-256 tool to verify the Node download." \
      "Install coreutils (sha256sum), perl (shasum), or openssl." \
      "This installer will not skip verification."
}

# One downloader interface over curl and wget so nothing below has to care which exists.
# --proto '=https' and --tlsv1.2 pin the transport: no plaintext, no protocol downgrade.
fetch_to() {
  _url=$1
  _out=$2
  if have curl; then
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --retry 3 --retry-connrefused --connect-timeout 15 -o "$_out" "$_url"
  else
    wget --quiet --https-only --tries=3 --timeout=15 -O "$_out" "$_url"
  fi
}

fetch_stdout() {
  if have curl; then
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --retry 3 --retry-connrefused --connect-timeout 15 "$1"
  else
    wget --quiet --https-only --tries=3 --timeout=15 -O - "$1"
  fi
}

# Visible byte progress for the one download big enough to notice.
fetch_with_progress() {
  if have curl && [ "$TTY" = 1 ]; then
    curl --fail --show-error --location --proto '=https' --tlsv1.2 \
      --retry 3 --retry-connrefused --connect-timeout 15 --progress-bar -o "$2" "$1"
  else
    fetch_to "$1" "$2"
  fi
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 "$1" | sed 's/.*= *//'
  fi
}

# ---------------------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------------------

OS="" ARCH="" PLATFORM_LABEL="" PLATFORM_NOTE=""

detect_platform() {
  _uname_s=$(uname -s)
  _uname_m=$(uname -m)

  case "$_uname_s" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    MINGW* | MSYS* | CYGWIN*)
      die "Windows shells are not supported by this installer." \
        "On Windows, install Node 22.10+ from https://nodejs.org and then run:" \
        "  npm install -g cotal-ai" \
        "Cotal itself runs fine on Windows; only this shell installer does not."
      ;;
    *)
      die "Unsupported operating system: $_uname_s" \
        "Cotal ships builds for macOS and Linux." \
        "If you have Node 22.10+ already: npm install -g cotal-ai"
      ;;
  esac

  case "$_uname_m" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      die "Unsupported CPU architecture: $_uname_m" \
        "Cotal ships x86_64 and arm64 builds." \
        "If you have Node 22.10+ already: npm install -g cotal-ai"
      ;;
  esac

  # An x86_64 process on Apple silicon is Rosetta. Install the native build, not the
  # emulated one, or every agent Cotal launches inherits the translation tax.
  if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    ARCH="arm64"
    PLATFORM_NOTE="this shell is under Rosetta; installing the native arm64 build"
  fi

  if [ "$OS" = "darwin" ]; then
    PLATFORM_LABEL="macOS $(sw_vers -productVersion 2>/dev/null || echo '') $S_SEP $ARCH"
  else
    # shellcheck source=/dev/null
    _distro=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-Linux}" || printf 'Linux')
    PLATFORM_LABEL="$_distro $S_SEP $ARCH"
    case "$(uname -r)" in
      *microsoft* | *Microsoft* | *WSL*) PLATFORM_NOTE="running under WSL" ;;
    esac
  fi
  # Collapse the double space a missing sw_vers would leave behind.
  PLATFORM_LABEL=$(printf '%s' "$PLATFORM_LABEL" | sed 's/  */ /g')

  # Checked here, not only on the download path: a musl box with a perfectly good system
  # Node still cannot run Cotal.
  is_musl && refuse_musl
  return 0
}

# Cotal does not run on musl. Its terminal layer (node-pty) ships prebuilt native binaries
# for glibc only, so on Alpine `cotal` installs cleanly and then throws on first use, with
# or without this installer; `npm i -g cotal-ai` fails there the same way. Refusing up front
# is the honest outcome: better no install than one that cannot start.
#
# Official Node builds are glibc-only too, so this also covers the vendored runtime.
is_musl() {
  [ "$OS" = "linux" ] || return 1
  if have ldd && ldd --version 2>&1 | grep -qi musl; then return 0; fi
  [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]
}

refuse_musl() {
  die "Cotal does not support musl systems (Alpine and similar) yet." \
    "Its terminal layer ships prebuilt native binaries for glibc only, so Cotal would" \
    "install here and then fail to start. That is true of \`npm i -g cotal-ai\` too, not" \
    "just this installer." \
    "" \
    "Use a glibc distribution (Debian, Ubuntu, Fedora, Arch) or a glibc container:" \
    "  docker run -it debian:stable bash" \
    "" \
    "Track musl support: $ISSUES_URL"
}

# ---------------------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------------------

# ${HOME:-} rather than $HOME: these are evaluated when the script loads, before main() can
# run its checks, and under `set -u` a bare $HOME with HOME unset would abort here with a raw
# "HOME: unbound variable" instead of the readable message main() has waiting.
INSTALL_DIR="${COTAL_INSTALL_DIR:-${XDG_DATA_HOME:-${HOME:-}/.local/share}/cotal}"
BIN_DIR="${COTAL_BIN_DIR:-${HOME:-}/.local/bin}"

# The launcher bakes these paths in and is then run from every directory on the machine, so a
# relative override (COTAL_INSTALL_DIR=./cotal) has to become absolute before anything records
# it. Otherwise the install works from the directory it was made in and nowhere else.
absolutize() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    ./*) printf '%s\n' "$PWD/${1#./}" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}
INSTALL_DIR=$(absolutize "$INSTALL_DIR")
BIN_DIR=$(absolutize "$BIN_DIR")

# Resolve a path COMPLETELY, following the final component too. Used for anything we are
# about to write through, because `>>` follows a symlink and lands wherever it points:
# ~/.zshrc can be a link out of $HOME, and containment has to see the real destination.
# The opposite of canonical_file below, which is for paths we only need to name.
# When checking a new link target, stop if the chain reaches the link being replaced.
resolved_target() {
  _rt="$1"
  _rt_hops=0
  while [ -L "$_rt" ]; do
    [ -z "${2:-}" ] || [ "$(canonical_file "$_rt")" != "$2" ] || return 1
    # Linux follows 40 links. Stopping short and then treating the still-unresolved link as
    # canonical is how a long chain walks straight past a containment check, so running out
    # of hops is a refusal, not an answer.
    [ "$_rt_hops" -lt 40 ] || return 1
    _rt_link=$(readlink "$_rt" 2>/dev/null) || return 1
    case "$_rt_link" in
      /*) _rt="$_rt_link" ;;
      *) _rt="$(dirname "$_rt")/$_rt_link" ;;
    esac
    _rt_hops=$((_rt_hops + 1))
  done
  _rt=$(canonical_file "$_rt")
  [ -z "${2:-}" ] || [ "$_rt" != "$2" ] || return 1
  printf '%s\n' "$_rt"
}

# Resolve a file's DIRECTORY physically (killing `..` and symlinks) while keeping its
# basename, so a path becomes canonical without repointing at a symlink's versioned target.
# Falls back to the input when the directory does not exist; callers check what they need.
canonical_file() {
  _cf_dir=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || {
    printf '%s\n' "$1"
    return 0
  }
  [ -n "$_cf_dir" ] || {
    printf '%s\n' "$1"
    return 0
  }
  printf '%s\n' "$_cf_dir/$(basename "$1")"
}
NODE_BIN="" NPM_BIN="" NODE_LABEL="" NODE_VENDORED=0
LOG=""

# `22.10.0` ranks 22010 and `22.9.0` ranks 22009, so the floor's minor is part of the compare.
node_rank() { "$1" -p 'const [m,n]=process.versions.node.split(".");m*1000+ +n' 2>/dev/null || echo 0; }

# Prefer a Node already on the box: it is instant, and it is the Node the user maintains.
# Fall through to a vendored runtime only when there is nothing here good enough.
resolve_node() {
  if [ "$OPT_VENDOR_NODE" = 0 ] && have node && have npm; then
    _sys_node=$(canonical_file "$(command -v node)")
    _sys_rank=$(node_rank "$_sys_node")
    if [ "$_sys_rank" -ge "$NODE_MIN_RANK" ] 2>/dev/null; then
      NODE_BIN="$_sys_node"
      NPM_BIN=$(canonical_file "$(command -v npm)")
      NODE_LABEL="$("$NODE_BIN" -v) $S_SEP already on this machine"
      return 0
    fi
  fi
  vendor_node
}

vendor_node() {
  require_download_tools
  TMPDIR_SELF=$(mktemp -d "${TMPDIR:-/tmp}/cotal-install.XXXXXX")
  chmod 700 "$TMPDIR_SELF"

  _dir="$INSTALL_DIR/runtime/node-$NODE_PIN-$OS-$ARCH"
  if [ -x "$_dir/bin/node" ] && [ -x "$_dir/bin/npm" ]; then
    NODE_BIN="$_dir/bin/node"
    NPM_BIN="$_dir/bin/npm"
    NODE_LABEL="$NODE_PIN $S_SEP already installed by Cotal"
    NODE_VENDORED=1
    return 0
  fi

  # .tar.gz rather than the smaller .tar.xz: every tar in the wild reads gzip, while xz
  # support depends on the build. One code path that always works beats a probe.
  _file="node-$NODE_PIN-$OS-$ARCH.tar.gz"
  _url="$NODE_DIST/$NODE_PIN/$_file"
  _tmp="$TMPDIR_SELF/$_file"

  if [ "$TTY" = 1 ]; then
    if [ "$OPT_VENDOR_NODE" = 1 ]; then
      _why="--vendor-node"
    else
      _why="this machine has no Node $NODE_MIN+"
    fi
    printf '  %s%s%s Downloading Node %s (%s)\n' \
      "$C_BRAND" "$S_DOT" "$C_OFF" "$NODE_PIN" "$_why"
  fi
  fetch_with_progress "$_url" "$_tmp" ||
    die "Could not download Node $NODE_PIN." \
      "Tried: $_url" \
      "Check your connection or any proxy, then run this again."
  [ "$TTY" = 1 ] && printf '%s[1A%s[2K' "$ESC" "$ESC"

  spin_start "Verifying Node $NODE_PIN"
  # The authority is the SHASUMS256.txt the Node project publishes beside the tarball,
  # fetched over the same pinned TLS. A mismatch aborts; it is never a warning.
  _want=$(fetch_stdout "$NODE_DIST/$NODE_PIN/SHASUMS256.txt" | grep " $_file\$" | cut -d' ' -f1) ||
    die "Could not fetch Node's published checksums." \
      "Tried: $NODE_DIST/$NODE_PIN/SHASUMS256.txt"
  spin_stop
  [ -n "$_want" ] ||
    die "Node's checksum file does not list $_file." \
      "That should not happen for a published release; please report it:" \
      "$ISSUES_URL"
  _got=$(sha256_of "$_tmp")
  [ "$_want" = "$_got" ] ||
    die "Checksum mismatch on the Node download. Refusing to install it." \
      "expected $_want" \
      "got      $_got" \
      "Delete any proxy cache in front of nodejs.org and try again."

  spin_start "Unpacking Node $NODE_PIN"
  mkdir -p "$INSTALL_DIR/runtime"
  rm -rf "$_dir.partial"
  mkdir -p "$_dir.partial"
  tar -xzf "$_tmp" -C "$_dir.partial" --strip-components=1 ||
    die "Could not unpack the Node archive." "The download may be truncated; run this again."
  rm -rf "$_dir"
  mv "$_dir.partial" "$_dir"
  spin_stop

  if [ ! -x "$_dir/bin/node" ] || [ ! -x "$_dir/bin/npm" ]; then
    die "The unpacked Node archive has no node/npm where they were expected." \
      "Looked in: $_dir/bin"
  fi

  # A correct checksum says the bytes are authentic, not that they run here. Official Node 22.10+
  # is built against glibc 2.28, so on an older distribution the download and the checksum both
  # succeed and npm then dies with "version GLIBC_2.28 not found" several steps later, after we
  # have already announced the runtime as good. Ask the binary itself, now.
  if ! _node_check=$("$_dir/bin/node" -v 2>&1); then
    rm -rf "$_dir"
    die "Node $NODE_PIN downloaded and verified, but it cannot run on this system." \
      "$(printf '%s' "$_node_check" | head -1)" \
      "" \
      "Official Node $NODE_MIN+ builds require glibc 2.28 or newer (Debian 10," \
      "Ubuntu 18.10, RHEL 8 and later). This machine is older than that." \
      "" \
      "Install a Node $NODE_MIN+ built for this distribution, then run this again;" \
      "it will use yours instead of downloading one."
  fi

  NODE_BIN="$_dir/bin/node"
  NPM_BIN="$_dir/bin/npm"
  NODE_LABEL="$NODE_PIN $S_SEP downloaded and verified against nodejs.org"
  NODE_VENDORED=1
}

# An installer from before the umask in main, run under a umask of 0002, left the install
# group-writable, and a folder another account can write makes Cotal refuse the Node runtime in
# it as an endpoint handler. Remove that write from this account's own entries; links are not
# followed.
repair_install_modes() {
  find "$INSTALL_DIR" \( -type d -o -type f \) -user "$(id -u)" \( -perm -020 -o -perm -002 \) \
    -exec chmod go-w {} + ||
    warn_line "could not remove group and other write from everything in $(tildify "$INSTALL_DIR")"
}

# A directory holding node, npm and npx and nothing else. The launcher puts this on PATH,
# so Cotal's child processes can find npm without us reordering the user's whole PATH and
# shadowing their other tools.
link_node_bin() {
  _nb="$INSTALL_DIR/nodebin"
  mkdir -p "$_nb"
  # Keep the selected Node entry, not the current version behind a distro's `node` symlink.
  # Leave the link in place if the selected entry already points through it.
  if resolved_target "$NODE_BIN" "$(canonical_file "$_nb/node")" >/dev/null; then
    ln -sf "$NODE_BIN" "$_nb/node"
  fi
  ln -sf "$(resolved_target "$NPM_BIN")" "$_nb/npm"
  _npx=$(dirname "$NPM_BIN")/npx
  [ -e "$_npx" ] && ln -sf "$(resolved_target "$_npx")" "$_nb/npx"
  return 0
}

# ---------------------------------------------------------------------------------------
# Cotal
# ---------------------------------------------------------------------------------------

INSTALLED_VERSION="" PREVIOUS_VERSION=""

read_installed_version() {
  _entry="$INSTALL_DIR/lib/node_modules/$COTAL_PKG/dist/cotal.js"
  if [ -f "$_entry" ]; then
    _in_use=$(COTAL_SKIP_CONNECTOR_SEED=1 COTAL_NO_UPDATE_CHECK=1 "$NODE_BIN" "$_entry" --version 2>/dev/null | sed -n '1s/^cotal-ai //p' || true)
    if [ -n "$_in_use" ]; then
      printf '%s' "$_in_use"
      return 0
    fi
  fi
  _pkg="$INSTALL_DIR/lib/node_modules/$COTAL_PKG/package.json"
  [ -f "$_pkg" ] || return 0
  # Read the file, do not resolve it as a module: cotal-ai is ESM, and this must not depend
  # on how the running Node treats `require` in an eval context.
  "$NODE_BIN" -e \
    'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||"")' \
    "$_pkg" 2>/dev/null || true
}

check_connector_downgrade() {
  [ -n "$PREVIOUS_VERSION" ] && [ "$PREVIOUS_VERSION" != "$1" ] || return 0
  if ! COTAL_SKIP_CONNECTOR_SEED=1 COTAL_NO_UPDATE_CHECK=1 DO_NOT_TRACK=1 \
    "$NODE_BIN" - "$PREVIOUS_VERSION" "$1" "$INSTALL_DIR/lib/node_modules/$COTAL_PKG" \
    "$STAGED_INSTALL" <<'NODE'
const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [previous, requested, installed, stage] = process.argv.slice(2);

// The bootstrap has no dependencies of its own. Compare release and prerelease identifiers
// from the installed packages, rather than the requested npm tag or range.
function versionParts(version) {
  const parts = typeof version === 'string' && /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!parts || parts[0] !== version) throw new Error(`invalid version ${JSON.stringify(version)}`);
  const release = parts[1].split('.'), pre = parts[2]?.split('.') ?? [];
  if ([...release, ...pre].some(part => /^0\d+$/.test(part)))
    throw new Error(`invalid version ${JSON.stringify(version)}`);
  return [release, pre];
}

function compareIdentifiers(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an !== bn) return an ? -1 : 1;
    if (an && a[i].length !== b[i].length) return a[i].length - b[i].length;
    return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function compare(a, b) {
  const [releaseA, preA] = versionParts(a), [releaseB, preB] = versionParts(b);
  return compareIdentifiers(releaseA, releaseB) ||
    (preA.length && preB.length ? compareIdentifiers(preA, preB) : Number(!preA.length) - Number(!preB.length));
}

function targetExtensions(logicalEntry) {
  const modules = fs.realpathSync.native(path.dirname(installed));
  const packageName = path.basename(installed);
  const staged = path.join(stage, 'lib/node_modules', packageName);
  const store = path.join(path.dirname(modules), '.cotal-generations');
  let created = false;
  try { fs.mkdirSync(store, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(store);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022))
    throw new Error(`the execution store is not an owned, protected directory: ${store}`);
  const probe = path.join(store, randomBytes(16).toString('hex'));
  const candidate = path.join(probe, packageName);
  fs.mkdirSync(probe, { mode: 0o700 });
  try {
    // The target's resolver keys connector state by logical entry, not by the physical stage.
    // Use the existing retained layout, without publishing an execution descriptor or running
    // a command that can inherit or seed a set.
    fs.renameSync(staged, candidate);
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { realpathSync } from 'node:fs';
        const loadedEntry = realpathSync.native('dist/cotal.js');
        const workspace = import.meta.resolve('@cotal-ai/workspace');
        // Resolve package imports from the stage, but relative config paths as at launch.
        process.chdir(process.argv[2]);
        Object.defineProperty(globalThis, Symbol.for('cotal.execution.identity'), {
          value: Object.freeze({ logicalEntry: process.argv[1], loadedEntry }),
        });
        const { extensionsDir } = await import(workspace);
        process.stdout.write(extensionsDir());
      `, logicalEntry, process.cwd()], { cwd: candidate, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
      if (result.error || result.status !== 0)
        throw new Error(`could not resolve the requested release's extension prefix: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`);
      if (!result.stdout || path.basename(result.stdout) !== 'extensions')
        throw new Error('the requested release did not resolve an extension prefix');
      return result.stdout;
    } finally { fs.renameSync(candidate, staged); }
  } finally {
    fs.rmdirSync(probe);
    if (created) fs.rmdirSync(store);
  }
}

function readRecord(file, privateFile = false) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const bytes = Buffer.alloc(8193);
  let fd;
  try { fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (privateFile && (stat.uid !== process.getuid() || (stat.mode & 0o077))))
      throw new Error(`not an owned, private connector record: ${file}`);
    let length = 0;
    for (let count; length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length)); ) length += count;
    if (length === bytes.length) throw new Error(`connector record is too large: ${file}`);
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

try {
  if (compare(requested, previous) >= 0) process.exit(0);
  const logicalEntry = fs.realpathSync.native(path.join(installed, 'dist/cotal.js'));
  const extensions = targetExtensions(logicalEntry);
  const stamp = path.join(path.dirname(extensions), 'seed', 'stamp.json');
  const state = readRecord(stamp);
  if (state) {
    const { generation } = JSON.parse(state);
    if (compare(generation, requested) > 0)
      throw new Error(`the connector seed store is at generation ${generation}, newer than the requested release ${requested}: ${path.dirname(stamp)}`);
  }
  const config = path.resolve(process.env.XDG_CONFIG_HOME?.trim() || path.join(process.env.HOME, '.config'), 'cotal');
  const key = createHash('sha256').update(logicalEntry).digest('hex');
  const current = path.join(config, 'installs', key, 'sets/current.json');
  const selection = readRecord(current, true);
  if (selection) fs.writeFileSync(path.join(stage, 'previous-connectors'), selection, { mode: 0o600 });
  fs.writeFileSync(path.join(stage, 'connector-selection'), current);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
NODE
  then
    die "Could not select Cotal $1. Cotal $PREVIOUS_VERSION was kept." \
      "Keep using the installed release, or restore compatible connector state from a backup before retrying the older release."
  fi
}

# The staging directory already holds the previous package. Keep the other cutover
# paths there too, until the selected release has started and reconciled.
save_downgrade_links() {
  mkdir "$STAGED_INSTALL/links" || return 1
  _saved=0
  for _path in "$BIN_DIR/cotal" "$INSTALL_DIR/bin/cotal" "$INSTALL_DIR/nodebin/node" "$INSTALL_DIR/nodebin/npm" "$INSTALL_DIR/nodebin/npx"; do
    _saved=$((_saved + 1))
    if [ -e "$_path" ] || [ -L "$_path" ]; then
      cp -pP "$_path" "$STAGED_INSTALL/links/$_saved" || return 1
    fi
  done
}

restore_downgrade() {
  [ "$DOWNGRADE_PENDING" = 1 ] || return 0
  DOWNGRADE_PENDING=0
  [ -e "$STAGED_INSTALL/previous" ] || [ -L "$STAGED_INSTALL/previous" ] || return 0
  KEEP_STAGE=1
  _restore_package="$INSTALL_DIR/lib/node_modules/$COTAL_PKG"
  if [ -e "$_restore_package" ] || [ -L "$_restore_package" ]; then
    mv "$_restore_package" "$STAGED_INSTALL/rejected" || return 1
  fi
  mv "$STAGED_INSTALL/previous" "$_restore_package" || return 1
  _saved=0
  for _path in "$BIN_DIR/cotal" "$INSTALL_DIR/bin/cotal" "$INSTALL_DIR/nodebin/node" "$INSTALL_DIR/nodebin/npm" "$INSTALL_DIR/nodebin/npx"; do
    _saved=$((_saved + 1))
    _backup="$STAGED_INSTALL/links/$_saved"
    if [ -e "$_backup" ] || [ -L "$_backup" ]; then
      # POSIX mv treats a symlink to a directory as a directory destination.
      if [ -L "$_path" ]; then rm -f "$_path" || return 1; fi
      mv -f "$_backup" "$_path" || return 1
    else
      rm -f "$_path" || return 1
    fi
  done
  _selection=$(cat "$STAGED_INSTALL/connector-selection") || return 1
  if [ -f "$STAGED_INSTALL/previous-connectors" ]; then
    if ! cmp -s "$STAGED_INSTALL/previous-connectors" "$_selection"; then
      _restore_temp=$(mktemp "${_selection}.restore.XXXXXX") || return 1
      cp -p "$STAGED_INSTALL/previous-connectors" "$_restore_temp" && mv -f "$_restore_temp" "$_selection" || return 1
    fi
  else
    rm -f "$_selection" || return 1
  fi
  KEEP_STAGE=0
}

install_cotal() {
  PREVIOUS_VERSION=$(read_installed_version)
  STAGED_INSTALL=$(mktemp -d "$INSTALL_DIR/.install-stage.XXXXXX")
  _spec="$COTAL_PKG"
  [ "$OPT_VERSION" = "latest" ] || _spec="$COTAL_PKG@$OPT_VERSION"

  if [ -n "$PREVIOUS_VERSION" ]; then
    spin_start "Updating Cotal (installed: $PREVIOUS_VERSION)"
  else
    spin_start "Installing Cotal"
  fi

  # npm's entry point resolves node through PATH. Use the selected runtime while staging,
  # without changing the active installation's runtime links before verification.
  #
  # --prefix keeps this entirely inside a directory Cotal owns, which is what removes the
  # need for sudo. npm verifies the registry tarball against its published sha512 integrity
  # on the way in, so the package itself arrives checked without us re-implementing it.
  if ! PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install -g --prefix "$STAGED_INSTALL" \
    --no-fund --no-audit --loglevel=error "$_spec" >>"$LOG" 2>&1; then
    spin_stop
    show_log_tail
    die "npm could not install $_spec." \
      "Full output: $(tildify "$LOG")"
  fi
  spin_stop

  # The active package and launcher stay intact until the requested release can start.
  if ! _version_output=$(COTAL_SKIP_CONNECTOR_SEED=1 COTAL_NO_UPDATE_CHECK=1 "$NODE_BIN" "$STAGED_INSTALL/lib/node_modules/$COTAL_PKG/dist/cotal.js" --version); then
    printf '%s\n' "$_version_output" >&2
    if [ "$OPT_VERSION" != latest ]; then
      die "The installed Cotal could not start." \
        "Run the installer again without --version to install the latest release."
    fi
    die "The latest Cotal release could not start." \
      "Report the error above at https://github.com/Cotal-AI/Cotal/issues."
  fi
  [ -x "$STAGED_INSTALL/bin/cotal" ] || [ -L "$STAGED_INSTALL/bin/cotal" ] ||
    die "$COTAL_PKG installed without its cotal executable."
  _staged_version=$(printf '%s\n' "$_version_output" | sed -n '1s/^cotal-ai //p')
  [ -n "$_staged_version" ] || die "The staged Cotal did not report its version."
  check_connector_downgrade "$_staged_version"
  mkdir -p "$INSTALL_DIR/lib/node_modules" "$INSTALL_DIR/bin"
  _active="$INSTALL_DIR/lib/node_modules/$COTAL_PKG"
  if [ -e "$_active" ] || [ -L "$_active" ]; then
    if [ -f "$STAGED_INSTALL/connector-selection" ]; then
      save_downgrade_links || die "Could not save the current Cotal launcher and runtime links. The installation was not changed."
      DOWNGRADE_PENDING=1
    fi
    mv "$_active" "$STAGED_INSTALL/previous"
  fi
  if ! mv "$STAGED_INSTALL/lib/node_modules/$COTAL_PKG" "$_active"; then
    if [ "$DOWNGRADE_PENDING" = 0 ]; then
      [ ! -e "$STAGED_INSTALL/previous" ] && [ ! -L "$STAGED_INSTALL/previous" ] || mv "$STAGED_INSTALL/previous" "$_active"
    fi
    die "Could not select the verified Cotal package."
  fi
  ln -sf "../lib/node_modules/$COTAL_PKG/dist/cotal.js" "$INSTALL_DIR/bin/cotal"
  INSTALLED_VERSION=$(read_installed_version)
  [ -n "$INSTALLED_VERSION" ] ||
    die "npm reported success but $COTAL_PKG is not in the install prefix." \
      "Looked in: $(tildify "$INSTALL_DIR/lib/node_modules")" \
      "Full output: $(tildify "$LOG")"
  [ -x "$INSTALL_DIR/bin/cotal" ] || [ -L "$INSTALL_DIR/bin/cotal" ] ||
    die "$COTAL_PKG@$INSTALLED_VERSION installed without its cotal executable." \
      "Looked for: $(tildify "$INSTALL_DIR/bin/cotal")"
}

show_log_tail() {
  [ -f "$LOG" ] || return 0
  blank
  dim_line "last lines of $(tildify "$LOG"):"
  tail -n 12 "$LOG" | while IFS= read -r line; do printf '    %s%s%s\n' "$C_DIM" "$line" "$C_OFF"; done
  return 0
}

# The launcher selects the installed runtime link and points npm at Cotal's own prefix
# so `cotal update` and `cotal ext add` keep writing where this installer wrote.
write_launcher() {
  mkdir -p "$BIN_DIR"
  _tmp="$BIN_DIR/.cotal.$$"
  _root_lit=$(shquote "$INSTALL_DIR")
  cat >"$_tmp" <<EOF
#!/bin/sh
# Cotal launcher, written by https://get.cotal.ai
# Uses the Node executable selected by the installer. The CLI checks its version on launch.
COTAL_ROOT=${_root_lit}

# When the pin was a Node this installer did not own, the user can still remove it later.
# Say so in one clear line instead of letting them hit the raw
# "/usr/bin/env: 'node': No such file or directory", which is the exact confusion this
# whole installer exists to prevent.
if [ ! -x "\$COTAL_ROOT/nodebin/node" ]; then
  echo "cotal: the Node runtime this install was pinned to is no longer there." >&2
  echo "       (expected \$COTAL_ROOT/nodebin/node)" >&2
  echo "" >&2
  echo "Repair it by re-running the installer:" >&2
  echo "  curl -fsSL https://get.cotal.ai | sh" >&2
  echo "" >&2
  echo "To stop depending on the system Node entirely, add --vendor-node:" >&2
  echo "  curl -fsSL https://get.cotal.ai | sh -s -- --vendor-node" >&2
  exit 1
fi

PATH="\$COTAL_ROOT/nodebin:\$PATH"
export PATH
# Tells cotal-ai's own Node-version preflight that this install pinned a runtime, so if the
# pin is ever REPLACED by an older Node (rather than removed, which is caught above) it can
# point at the installer instead of at generic nvm advice.
COTAL_LAUNCHER=1
export COTAL_LAUNCHER
# Keep \`cotal update\` and \`cotal ext add\` inside the prefix this installer created,
# rather than a system-wide npm root that would need sudo.
npm_config_prefix="\$COTAL_ROOT"
export npm_config_prefix
exec "\$COTAL_ROOT/bin/cotal" "\$@"
EOF
  chmod 755 "$_tmp"
  mv "$_tmp" "$BIN_DIR/cotal"
}

# ---------------------------------------------------------------------------------------
# PATH
# ---------------------------------------------------------------------------------------

PATH_STATE="" # already | added | manual | unverified
PATH_RC=""
PATH_UPDATED=""
PATH_MANUAL=""
PATH_UNVERIFIED=""

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

setup_path() {
  if on_path; then
    PATH_STATE="already"
    return 0
  fi
  if [ "$OPT_MODIFY_PATH" = 0 ]; then
    PATH_STATE="manual"
    return 0
  fi

  _shell=$(basename "${SHELL:-sh}")
  _bin_quoted=$(shquote "$BIN_DIR")
  _path_command="export PATH=$_bin_quoted:\"\$PATH\""
  _login_rc=""
  case "$_shell" in
    zsh)
      PATH_RC="${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      if [ "$OS" = "linux" ]; then
        # An interactive non-login shell reads .bashrc. A login shell reads the first
        # readable login file, which need not source .bashrc. Default to .profile so
        # creating a file does not mask an existing lower-priority profile.
        PATH_RC="$HOME/.bashrc"
        _login_rc="$HOME/.profile"
        for _profile in "$HOME/.bash_profile" "$HOME/.bash_login"; do
          if [ -f "$_profile" ] && [ -r "$_profile" ]; then
            _login_rc="$_profile"
            break
          fi
        done
      elif [ -f "$HOME/.bash_profile" ] || [ ! -f "$HOME/.bashrc" ]; then
        PATH_RC="$HOME/.bash_profile"
      else
        PATH_RC="$HOME/.bashrc"
      fi
      ;;
    fish)
      PATH_RC="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      _path_command="fish_add_path $_bin_quoted"
      ;;
    *)
      PATH_STATE="manual"
      return 0
      ;;
  esac

  _line="$_path_command"
  if [ -n "$_login_rc" ]; then
    # A login profile can also source .bashrc. Add the directory only once.
    _line="case \":\$PATH:\" in *:$_bin_quoted:*) ;; *) $_path_command ;; esac"
  fi

  write_path_block || PATH_MANUAL=$(tildify "$PATH_RC")
  if [ -n "$_login_rc" ]; then
    PATH_RC="$_login_rc"
    write_path_block || PATH_MANUAL="${PATH_MANUAL:+$PATH_MANUAL, }$(tildify "$PATH_RC")"
  fi
  if [ -n "$PATH_MANUAL" ]; then
    PATH_STATE="manual"
  elif [ -n "$PATH_UPDATED" ]; then
    PATH_STATE="added"
  else
    PATH_STATE="unverified"
  fi
  if [ -n "$PATH_UPDATED" ]; then
    PATH="$BIN_DIR:$PATH"
    export PATH
  fi
}

# Append the marked block unless this startup file already has one for this launcher.
write_path_block() {
  _marker="# cotal"

  # Containment, enforced rather than assumed: this installer writes nothing outside $HOME,
  # so a computed rc path that escaped it is a bug, and appending to it would be the damage.
  # Refuse and fall back to printing the line for the user to add.
  #
  # Three checks, because a lexical prefix test alone is not containment. ZDOTDIR (or
  # XDG_CONFIG_HOME) can be $HOME/../elsewhere, which starts with "$HOME/" and still lands
  # outside it; and either could be a symlink pointing anywhere. So: reject `..` outright,
  # THEN prefix-test (both before anything is created), and finally re-test the physically
  # resolved path against the physically resolved $HOME to catch a symlinked escape.
  case "$PATH_RC" in
    ../* | */../* | */..)
      return 1
      ;;
  esac
  case "$PATH_RC" in
    "$HOME"/*) ;;
    *)
      return 1
      ;;
  esac

  _real_home=$(cd "$HOME" 2>/dev/null && pwd -P) || _real_home="$HOME"

  # Resolve the nearest EXISTING ancestor before creating anything. mkdir -p on a path that
  # runs through a symlink out of $HOME creates directories out there, and discovering the
  # escape afterwards does not un-create them. `$HOME/link -> /tmp/outside` with
  # ZDOTDIR=$HOME/link/newdir made /tmp/outside/newdir before the check ever ran.
  _anc=$(dirname "$PATH_RC")
  while [ ! -d "$_anc" ] && [ "$_anc" != "/" ] && [ "$_anc" != "." ]; do
    _anc=$(dirname "$_anc")
  done
  _anc_real=$(cd "$_anc" 2>/dev/null && pwd -P) || _anc_real=""
  case "$_anc_real" in
    "$_real_home" | "$_real_home"/*) ;;
    *)
      return 1
      ;;
  esac

  mkdir -p "$(dirname "$PATH_RC")" 2>/dev/null || return 1

  # And the final destination itself, following the rc file if it is a link. A refusal from
  # resolved_target (an unresolvable chain) is a refusal here too.
  _rc_real=$(resolved_target "$PATH_RC") || return 1
  case "$_rc_real" in
    "$_real_home"/*) ;;
    *)
      return 1
      ;;
  esac

  # Checking for the block and then appending is a read-modify-write, and two installers
  # racing can both see "absent" and both append, leaving two blocks. mkdir is atomic on
  # every POSIX filesystem, so it is the lock. A stale lock is not worth a reaper: fall back
  # to printing the line rather than risk a duplicate.
  _lock="$PATH_RC.cotal-lock"
  if ! mkdir "$_lock" 2>/dev/null; then
    return 1
  fi

  if [ -f "$PATH_RC" ]; then
    if ! _rc_contents=$(cat "$PATH_RC" 2>/dev/null); then
      rmdir "$_lock" 2>/dev/null || true
      return 1
    fi
    # Match the marker and command verbatim on adjacent lines. Also accept the plain
    # export from before Bash on Linux started guarding against duplicate PATH entries.
    _nl='
'
    case "$_nl$_rc_contents$_nl" in
      *"$_nl$_marker$_nl$_line$_nl"* | *"$_nl$_marker$_nl$_path_command$_nl"*)
        rmdir "$_lock" 2>/dev/null || true
        PATH_UNVERIFIED="${PATH_UNVERIFIED:+$PATH_UNVERIFIED, }$(tildify "$PATH_RC")"
        return 0
        ;;
    esac
  fi
  if ! { printf '\n%s\n%s\n' "$_marker" "$_line" >>"$PATH_RC"; } 2>/dev/null; then
    rmdir "$_lock" 2>/dev/null || true
    return 1
  fi
  rmdir "$_lock" 2>/dev/null || true
  PATH_UPDATED="${PATH_UPDATED:+$PATH_UPDATED, }$(tildify "$PATH_RC")"
}

report_path_setup() {
  case "$PATH_STATE" in
    already) ok_line "$(tildify "$BIN_DIR") is on your PATH" ;;
    added) ok_line "Added $(tildify "$BIN_DIR") to your shell's PATH configuration" ;;
    manual) warn_line "PATH setup for $(tildify "$BIN_DIR") needs a manual step" ;;
  esac
  if [ -n "$PATH_UNVERIFIED" ]; then
    dim_line "Found matching Cotal PATH lines in $PATH_UNVERIFIED. The installer does not run startup files."
  fi
  if [ "$PATH_STATE" = manual ]; then
    dim_line "To set PATH in your current shell, run:"
  elif [ -n "$PATH_UNVERIFIED" ]; then
    dim_line "If a new shell cannot find cotal, run:"
  else
    return 0
  fi
  dim_line "  export PATH=$(shquote "$BIN_DIR"):\"\$PATH\""
}

# The child shell can inspect PATH, but cannot clear its parent's command cache or aliases.
report_path_selection() {
  _selected=$(command -v cotal 2>/dev/null || true)
  _selected_target=""
  case "$_selected" in
    /*) _selected_target=$(resolved_target "$_selected") || _selected_target="" ;;
  esac
  _installed_target=$(resolved_target "$BIN_DIR/cotal") || _installed_target=""
  if [ -z "$_selected_target" ] || [ "$_selected_target" != "$_installed_target" ]; then
    warn_line "Your PATH does not select the Cotal just installed."
    dim_line "Use $(shquote "$BIN_DIR/cotal") instead of plain cotal."
  fi
  dim_line "Check \`type -a cotal\` in your shell; this installer cannot change its cached commands, aliases or functions."
}

# ---------------------------------------------------------------------------------------
# What is already on this machine
#
# The agents Cotal has a connector for. Anything else is real, but we would be claiming a
# connection we do not have, so we do not list it.
# ---------------------------------------------------------------------------------------

AGENTS_FOUND=""
AGENTS_COUNT=0

detect_agents() {
  for _pair in "claude:Claude Code" "opencode:OpenCode" "pi:pi" "hermes:Hermes"; do
    _bin=${_pair%%:*}
    _name=${_pair#*:}
    if have "$_bin"; then
      AGENTS_FOUND="$AGENTS_FOUND$_bin|$_name
"
      AGENTS_COUNT=$((AGENTS_COUNT + 1))
    fi
  done
}

# ---------------------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------------------

banner() {
  [ "$TTY" = 1 ] || return 0
  printf '%s' "$C_BRAND"
  cat <<'WORDMARK'

            _        _
   ___ ___ | |_ __ _| |
  / __/ _ \| __/ _`| |
 | (_| (_) | || (_| | |
  \___\___/ \__\__,_|_|
WORDMARK
  printf '%s\n' "$C_OFF"
  printf '  %sthe web for agents%s\n' "$C_DIM" "$C_OFF"
  printf '  %s%s%s\n\n' "$C_BRAND" "$(rule)" "$C_OFF"
}

rule() {
  if [ "$UTF8" = 1 ]; then
    printf '%s' '──────────────────────────────────────────'
  else
    printf '%s' '------------------------------------------'
  fi
}

summary() {
  blank
  if [ -n "$PREVIOUS_VERSION" ] && [ "$PREVIOUS_VERSION" != "$INSTALLED_VERSION" ]; then
    head_line "Cotal $PREVIOUS_VERSION → $INSTALLED_VERSION"
  else
    head_line "Cotal $INSTALLED_VERSION"
  fi
  dim_line "$(tildify "$BIN_DIR/cotal") $S_SEP installed in ${ELAPSED}s"

  if [ -n "$AGENTS_FOUND" ]; then
    blank
    head_line "Agents on this machine"
    printf '%s' "$AGENTS_FOUND" | while IFS='|' read -r _bin _name; do
      [ -n "$_bin" ] || continue
      printf '    %s%-12s%s %s\n' "$C_GREEN" "$_bin" "$C_OFF" "$_name"
    done
    blank
    if [ "$AGENTS_COUNT" -gt 1 ]; then
      dim_line "They cannot see each other yet. Cotal is where they meet."
    else
      dim_line "Put it on the mesh, then give it teammates."
    fi
  fi
}

next_steps() {
  _cotal=$(shquote "$BIN_DIR/cotal")
  blank
  head_line "Next"
  case "$PATH_STATE" in
    added)
      _reload="exec $_shell"
      if [ -n "$_login_rc" ]; then _reload="exec bash -l"; fi
      printf '    %s%s%s   %sreload your shell, once%s\n' "$C_BRAND" "$_reload" "$C_OFF" "$C_DIM" "$C_OFF"
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "$_cotal setup" "$C_OFF" "$C_DIM" "get your machine ready" "$C_OFF"
      ;;
    manual | unverified)
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "$_cotal setup" "$C_OFF" "$C_DIM" "get your machine ready" "$C_OFF"
      if [ -n "$PATH_MANUAL" ]; then
        blank
        dim_line "Add that export to: $PATH_MANUAL"
      elif [ "$PATH_STATE" = manual ]; then
        blank
        dim_line "Add that export to your shell rc to make it permanent."
      fi
      ;;
    already)
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "$_cotal setup" "$C_OFF" "$C_DIM" "get your machine ready" "$C_OFF"
      printf '    %s%s%s     %s%s%s\n' "$C_BRAND" "$_cotal up --detach" "$C_OFF" "$C_DIM" "start your mesh" "$C_OFF"
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "$_cotal spawn" "$C_OFF" "$C_DIM" "put an agent on it" "$C_OFF"
      ;;
  esac
  if [ -n "$PATH_UPDATED" ]; then
    blank
    dim_line "PATH updated in $PATH_UPDATED"
  fi
  blank
  dim_line "Docs $DOCS_URL"
  blank
}

# `curl … | sh` gives the script a pipe on stdin, so an interactive child would read the
# rest of the script instead of the keyboard. /dev/tty is the terminal itself; this is the
# same technique the Deno installer uses for its shell setup.
hand_off_to_setup() {
  [ "$OPT_SETUP" = 1 ] || return 1
  [ "$OPT_YES" = 0 ] || return 1
  [ -z "${CI:-}" ] || return 1
  [ -r /dev/tty ] || return 1
  [ "$TTY" = 1 ] || return 1

  blank
  dim_line "Starting guided setup. Ctrl-C to stop; run $(shquote "$BIN_DIR/cotal") setup whenever you like."
  blank
  "$BIN_DIR/cotal" setup </dev/tty || return 1
  return 0
}

# ---------------------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------------------

# A real path-boundary test. "$HOME"* would call /tmp/h-escape a child of /tmp/h.
under_home() {
  [ -n "${HOME:-}" ] || return 1
  case "$1" in
    "$HOME" | "$HOME"/*) return 0 ;;
    *) return 1 ;;
  esac
}

plan_line() { printf '    %s%-46s%s %s%s%s\n' "$C_OFF" "$1" "$C_OFF" "$C_DIM" "$2" "$C_OFF"; }

dry_run_report() {
  blank
  head_line "Dry run. Nothing was changed."
  blank
  ok_line "$PLATFORM_LABEL"
  [ -n "$PLATFORM_NOTE" ] && dim_line "  $PLATFORM_NOTE"
  if [ "$NODE_VENDORED" = 1 ]; then
    warn_line "would download Node $NODE_PIN from $NODE_DIST and verify its SHA-256"
  else
    ok_line "Node $NODE_LABEL"
  fi
  blank
  head_line "Would write"
  plan_line "$(tildify "$INSTALL_DIR")/lib/node_modules/$COTAL_PKG" "the npm package, into a prefix Cotal owns"
  plan_line "$(tildify "$INSTALL_DIR")/nodebin/{node,npm,npx}" "symlinks to the Node above"
  plan_line "$(tildify "$BIN_DIR/cotal")" "the launcher that pins that Node"
  if [ "$OPT_MODIFY_PATH" = 1 ] && ! on_path; then
    plan_line "a '# cotal' block in your shell rc" "so \`cotal\` is on your PATH"
  fi
  blank
  head_line "Would not touch"
  # Report the boundary that actually applies. The default install is contained in $HOME, but
  # COTAL_INSTALL_DIR / COTAL_BIN_DIR / XDG_DATA_HOME can point anywhere, and claiming
  # containment we are not delivering would be the wrong kind of reassuring.
  if under_home "$INSTALL_DIR" && under_home "$BIN_DIR"; then
    dim_line "  anything outside \$HOME $S_SEP any system directory $S_SEP sudo"
  else
    dim_line "  any system directory $S_SEP sudo"
    warn_line "you have redirected the install outside \$HOME, so the usual containment does not apply"
  fi
  blank
}

# ---------------------------------------------------------------------------------------

ELAPSED=0

main() {
  # Nothing this installer creates is writable by group or others, even under a umask of 0002.
  # Without a user private group, a group-writable install tree is one other accounts can change.
  umask 022
  init_term
  parse_args "$@"
  trap 'cleanup' EXIT
  trap 'cleanup; exit 130' INT TERM HUP

  banner
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    die "HOME is not set to a directory this installer can write to." \
      "Cotal installs entirely under \$HOME; set it and run this again."
  fi
  require_unprivileged
  detect_platform
  detect_agents

  _t0=$(date +%s)

  if [ "$OPT_DRY_RUN" = 1 ]; then
    # Report the runtime decision without acting on it: probe the system Node only.
    if [ "$OPT_VENDOR_NODE" = 0 ] && have node && have npm &&
      [ "$(node_rank "$(command -v node)")" -ge "$NODE_MIN_RANK" ] 2>/dev/null; then
      NODE_LABEL="$(node -v) $S_SEP already on this machine"
    else
      NODE_VENDORED=1
    fi
    dry_run_report
    exit 0
  fi

  if [ -d "$BIN_DIR/cotal" ]; then
    die "$(shquote "$BIN_DIR/cotal") is a directory." \
      "Move the directory aside or set COTAL_BIN_DIR to a different launcher directory."
  fi

  # A recorded service may still run the npm installation after the shell install. Do not
  # replace its visible command with a launcher for a different package before reconciliation.
  _daemon_receipt="${COTAL_HOME:-$HOME/.cotal}/daemon/service-unit.json"
  if [ -L "$BIN_DIR/cotal" ] && { [ -e "$_daemon_receipt" ] || [ -L "$_daemon_receipt" ]; }; then
    _current_entry=$(resolved_target "$BIN_DIR/cotal") || _current_entry=""
    _shell_entry=$(resolved_target "$INSTALL_DIR/lib/node_modules/$COTAL_PKG/dist/cotal.js") || _shell_entry=""
    case "$_current_entry" in
      */lib/node_modules/"$COTAL_PKG"/dist/cotal.js|*/lib/node_modules/"$COTAL_PKG"/dist/cotal-npm)
        if [ "${_current_entry%/*}" != "${_shell_entry%/*}" ]; then
          die "$(shquote "$BIN_DIR/cotal") belongs to an npm installation and a Cotal daemon service is recorded. The launcher was not changed." \
            "Keep this installation and run $(shquote "$BIN_DIR/cotal") update --self." \
            "To switch installers, stop your Cotal spaces and uninstall the recorded daemon from its owning installation before running this installer again."
        fi
        ;;
    esac
  fi

  # First write of the run. A read-only or unwritable home is common enough (locked-down
  # images, a misowned $HOME) that it deserves a real message rather than a raw mkdir error.
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    die "Cannot create $(tildify "$INSTALL_DIR")." \
      "This installer writes only inside your home directory, so it needs that to be" \
      "writable by you. Check the permissions:" \
      "  ls -ld $(shquote "$(dirname "$INSTALL_DIR")")" \
      "" \
      "Or send it somewhere else:" \
      "  curl -fsSL https://get.cotal.ai | COTAL_INSTALL_DIR=/path/you/own sh"
  fi
  acquire_install_lock
  repair_install_modes
  LOG="$INSTALL_DIR/install.log"
  : >"$LOG" 2>/dev/null || die "Cannot write $(tildify "$LOG")." \
    "The install directory exists but is not writable by you."

  ok_line "$PLATFORM_LABEL"
  [ -n "$PLATFORM_NOTE" ] && dim_line "  $PLATFORM_NOTE"

  resolve_node
  ok_line "Node $NODE_LABEL"
  install_cotal
  link_node_bin
  write_launcher
  if ! _version_output=$(COTAL_SKIP_CONNECTOR_SEED=1 COTAL_NO_UPDATE_CHECK=1 "$BIN_DIR/cotal" --version 2>&1); then
    printf '%s\n' "$_version_output" >&2
    if [ "$OPT_VERSION" != latest ]; then
      die "The installed Cotal could not start." \
        "Run the installer again without --version to install the latest release."
    fi
    die "The latest Cotal release could not start." \
      "Report the error above at https://github.com/Cotal-AI/Cotal/issues."
  fi
  if [ -n "$PREVIOUS_VERSION" ] || [ -e "${COTAL_HOME:-$HOME/.cotal}/daemon/service-unit.json" ]; then
    if ! COTAL_INSTALL_RECONCILE=1 "$BIN_DIR/cotal" update; then
      if [ "$DOWNGRADE_PENDING" = 1 ]; then
        if ! restore_downgrade; then
          die "Reconciliation failed and the previous Cotal installation could not be restored." \
            "The recovery files are in $(shquote "$STAGED_INSTALL")."
        fi
        if [ -f "$_daemon_receipt" ] && ! COTAL_INSTALL_RECONCILE=1 "$BIN_DIR/cotal" update; then
          die "Reconciliation failed. Cotal $PREVIOUS_VERSION was restored, but its daemon did not reconcile." \
            "Run $(shquote "$BIN_DIR/cotal") daemon status to inspect the service."
        fi
        die "Reconciliation failed. Cotal $PREVIOUS_VERSION was restored." \
          "Keep using the installed release, or address the error above before retrying the older release."
      fi
      die "Cotal was installed, but reconciliation did not complete." \
        "Run $(shquote "$BIN_DIR/cotal") update to finish this update."
    fi
  fi
  DOWNGRADE_PENDING=0
  ok_line "Cotal $INSTALLED_VERSION"
  setup_path
  report_path_setup
  report_path_selection
  ELAPSED=$(($(date +%s) - _t0))

  summary
  if hand_off_to_setup; then
    exit 0
  fi
  next_steps
}

# The brace group is what makes truncation safety hold at BYTE granularity, not just at line
# boundaries. A bare `main "$@"` can be cut to a bare `main`, which is a complete command: the
# installer would then run with NO arguments, silently turning `sh -s -- --dry-run` into a real
# install. A compound command is not executed until its closing brace is parsed, so every
# partial prefix of this line is a syntax error that does nothing.
{ main "$@"; exit $?; }
