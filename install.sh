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
#   2. Finds a Node >= 22. If your machine has one, it uses it. If not, it downloads the
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
#   rm -rf ~/.local/share/cotal ~/.local/bin/cotal   # this installer's files
#   rm -rf ~/.cotal                                  # your meshes, agents and credentials
#   then delete the `# cotal` block from your shell rc.
#
# Apache-2.0. Everything below runs inside main(), which is invoked on the very last
# line, so a download cut short defines functions and then does nothing at all.

set -eu

# ---------------------------------------------------------------------------------------
# What we install
# ---------------------------------------------------------------------------------------

COTAL_PKG="cotal-ai"
NODE_MIN_MAJOR=22               # cotal-ai's engines floor
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
S_OK="+" S_NO="x" S_WARN="!" S_DOT="-"
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
  case "${LC_ALL:-}${LC_CTYPE:-}${LANG:-}" in
    *UTF-8* | *utf8* | *UTF8* | *utf-8*) UTF8=1 ;;
  esac
  if [ "$UTF8" = 1 ]; then
    S_OK="✓" S_NO="✗" S_WARN="!" S_DOT="·"
    SPIN_FRAMES="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"
  fi
}

# Every writer goes through printf '%s' so nothing we print is ever read as a format string.
say() { printf '%s\n' "$*"; }
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
cleanup() {
  spin_stop
  [ -n "$TMPDIR_SELF" ] && [ -d "$TMPDIR_SELF" ] && rm -rf "$TMPDIR_SELF"
  return 0
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
      --version)
        [ $# -ge 2 ] || die "--version needs a value" "For example: --version 0.14.2"
        OPT_VERSION="$2"
        shift
        ;;
      --version=*) OPT_VERSION="${1#--version=}" ;;
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
      "This machine has no Node $NODE_MIN_MAJOR+, so one has to be fetched." \
      "Install curl or wget and run this again."
  have tar || die "Need tar to unpack the Node runtime." "Install tar and run this again."
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
        "On Windows, install Node 22+ from https://nodejs.org and then run:" \
        "  npm install -g cotal-ai" \
        "Cotal itself runs fine on Windows; only this shell installer does not."
      ;;
    *)
      die "Unsupported operating system: $_uname_s" \
        "Cotal ships builds for macOS and Linux." \
        "If you have Node 22+ already: npm install -g cotal-ai"
      ;;
  esac

  case "$_uname_m" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      die "Unsupported CPU architecture: $_uname_m" \
        "Cotal ships x86_64 and arm64 builds." \
        "If you have Node 22+ already: npm install -g cotal-ai"
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
    PLATFORM_LABEL="macOS $(sw_vers -productVersion 2>/dev/null || echo '') · $ARCH"
  else
    # shellcheck source=/dev/null
    _distro=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-Linux}" || printf 'Linux')
    PLATFORM_LABEL="$_distro · $ARCH"
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

INSTALL_DIR="${COTAL_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cotal}"
BIN_DIR="${COTAL_BIN_DIR:-$HOME/.local/bin}"
NODE_BIN="" NPM_BIN="" NODE_LABEL="" NODE_VENDORED=0
LOG=""

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Prefer a Node already on the box: it is instant, and it is the Node the user maintains.
# Fall through to a vendored runtime only when there is nothing here good enough.
resolve_node() {
  if [ "$OPT_VENDOR_NODE" = 0 ] && have node && have npm; then
    _sys_node=$(command -v node)
    _sys_major=$(node_major "$_sys_node")
    if [ "$_sys_major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
      NODE_BIN="$_sys_node"
      NPM_BIN=$(command -v npm)
      NODE_LABEL="$("$NODE_BIN" -v) · already on this machine"
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
    NODE_LABEL="$NODE_PIN · already installed by Cotal"
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
      _why="this machine has no Node $NODE_MIN_MAJOR+"
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

  [ -x "$_dir/bin/node" ] && [ -x "$_dir/bin/npm" ] ||
    die "The unpacked Node archive has no node/npm where they were expected." \
      "Looked in: $_dir/bin"

  NODE_BIN="$_dir/bin/node"
  NPM_BIN="$_dir/bin/npm"
  NODE_LABEL="$NODE_PIN · downloaded and verified against nodejs.org"
  NODE_VENDORED=1
}

# A directory holding node, npm and npx and nothing else. The launcher puts this on PATH,
# so Cotal's child processes can find npm without us reordering the user's whole PATH and
# shadowing their other tools.
link_node_bin() {
  _nb="$INSTALL_DIR/nodebin"
  mkdir -p "$_nb"
  ln -sf "$NODE_BIN" "$_nb/node"
  ln -sf "$NPM_BIN" "$_nb/npm"
  _npx=$(dirname "$NPM_BIN")/npx
  [ -e "$_npx" ] && ln -sf "$_npx" "$_nb/npx"
  return 0
}

# ---------------------------------------------------------------------------------------
# Cotal
# ---------------------------------------------------------------------------------------

INSTALLED_VERSION="" PREVIOUS_VERSION=""

read_installed_version() {
  _pkg="$INSTALL_DIR/lib/node_modules/$COTAL_PKG/package.json"
  [ -f "$_pkg" ] || return 0
  # Read the file, do not resolve it as a module: cotal-ai is ESM, and this must not depend
  # on how the running Node treats `require` in an eval context.
  "$NODE_BIN" -e \
    'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||"")' \
    "$_pkg" 2>/dev/null || true
}

install_cotal() {
  PREVIOUS_VERSION=$(read_installed_version)
  _spec="$COTAL_PKG"
  [ "$OPT_VERSION" = "latest" ] || _spec="$COTAL_PKG@$OPT_VERSION"

  if [ -n "$PREVIOUS_VERSION" ]; then
    spin_start "Updating Cotal (installed: $PREVIOUS_VERSION)"
  else
    spin_start "Installing Cotal"
  fi

  # nodebin goes on PATH for exactly this call. npm's own entry point resolves `node` through
  # PATH, so on a machine with no system Node the vendored npm cannot start itself without
  # it. Prepending only that one directory keeps every other tool the user has intact.
  #
  # --prefix keeps this entirely inside a directory Cotal owns, which is what removes the
  # need for sudo. npm verifies the registry tarball against its published sha512 integrity
  # on the way in, so the package itself arrives checked without us re-implementing it.
  if ! PATH="$INSTALL_DIR/nodebin:$PATH" "$NPM_BIN" install -g --prefix "$INSTALL_DIR" \
    --no-fund --no-audit --loglevel=error "$_spec" >>"$LOG" 2>&1; then
    spin_stop
    show_log_tail
    die "npm could not install $_spec." \
      "Full output: $(tildify "$LOG")"
  fi
  spin_stop

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

# The launcher is the whole reason a Cotal installed today still works after you change
# your system Node tomorrow. It pins the runtime, and it points npm at Cotal's own prefix
# so `cotal update` and `cotal ext add` keep writing where this installer wrote.
write_launcher() {
  mkdir -p "$BIN_DIR"
  _tmp="$BIN_DIR/.cotal.$$"
  cat >"$_tmp" <<EOF
#!/bin/sh
# Cotal launcher, written by https://get.cotal.ai
# Pins the Node this install was verified against, so a change to the system Node
# can never leave Cotal running on a runtime it was not installed for.
COTAL_ROOT="$INSTALL_DIR"
PATH="\$COTAL_ROOT/nodebin:\$PATH"
export PATH
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

PATH_STATE="" # already | added:<file> | manual
PATH_RC=""

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# One marked block, appended once. Delete the block to undo it; re-running this installer
# will not stack a second copy.
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
  _marker="# cotal"
  case "$_shell" in
    zsh)
      PATH_RC="${ZDOTDIR:-$HOME}/.zshrc"
      _line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    bash)
      # Linux logs you into an interactive shell reading .bashrc; macOS Terminal starts a
      # login shell reading .bash_profile. Prefer whichever this box already uses.
      if [ "$OS" = "darwin" ]; then _candidates="$HOME/.bash_profile $HOME/.bashrc"; else _candidates="$HOME/.bashrc $HOME/.bash_profile"; fi
      PATH_RC=""
      for _c in $_candidates; do
        if [ -f "$_c" ]; then
          PATH_RC="$_c"
          break
        fi
      done
      [ -n "$PATH_RC" ] || PATH_RC=$(printf '%s' "$_candidates" | cut -d' ' -f1)
      _line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    fish)
      PATH_RC="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      _line="fish_add_path \"$BIN_DIR\""
      ;;
    *)
      PATH_STATE="manual"
      return 0
      ;;
  esac

  if [ -f "$PATH_RC" ] && grep -qF "$_marker" "$PATH_RC" 2>/dev/null; then
    PATH_STATE="already"
    return 0
  fi
  mkdir -p "$(dirname "$PATH_RC")"
  if ! { printf '\n%s\n%s\n' "$_marker" "$_line" >>"$PATH_RC"; } 2>/dev/null; then
    PATH_STATE="manual"
    return 0
  fi
  PATH_STATE="added:$PATH_RC"
  PATH="$BIN_DIR:$PATH"
  export PATH
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
  dim_line "$(tildify "$BIN_DIR/cotal") · installed in ${ELAPSED}s"

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
  blank
  head_line "Next"
  case "$PATH_STATE" in
    added:*)
      _rc=${PATH_STATE#added:}
      printf '    %s%s%s   %sreload your shell, once%s\n' "$C_BRAND" "exec $(basename "${SHELL:-sh}")" "$C_OFF" "$C_DIM" "$C_OFF"
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "cotal setup" "$C_OFF" "$C_DIM" "get your machine ready" "$C_OFF"
      blank
      dim_line "PATH updated in $(tildify "$_rc")"
      ;;
    manual)
      printf '    %s%s%s\n' "$C_BRAND" "export PATH=\"$BIN_DIR:\$PATH\"" "$C_OFF"
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "cotal setup" "$C_OFF" "$C_DIM" "get your machine ready" "$C_OFF"
      blank
      dim_line "Add that export to your shell rc to make it permanent."
      ;;
    *)
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "cotal setup" "$C_OFF" "$C_DIM" "get your machine ready" "$C_OFF"
      printf '    %s%s%s     %s%s%s\n' "$C_BRAND" "cotal up --detach" "$C_OFF" "$C_DIM" "start your mesh" "$C_OFF"
      printf '    %s%s%s          %s%s%s\n' "$C_BRAND" "cotal spawn" "$C_OFF" "$C_DIM" "put an agent on it" "$C_OFF"
      ;;
  esac
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
  dim_line "Starting guided setup. Ctrl-C to stop; run \`cotal setup\` whenever you like."
  blank
  "$BIN_DIR/cotal" setup </dev/tty || return 1
  return 0
}

# ---------------------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------------------

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
  dim_line "  anything outside \$HOME · any system directory · sudo"
  blank
}

# ---------------------------------------------------------------------------------------

ELAPSED=0

main() {
  init_term
  parse_args "$@"
  trap 'cleanup' EXIT
  trap 'cleanup; exit 130' INT TERM HUP

  banner
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] ||
    die "HOME is not set to a directory this installer can write to." \
      "Cotal installs entirely under \$HOME; set it and run this again."
  require_unprivileged
  detect_platform
  detect_agents

  _t0=$(date +%s)

  if [ "$OPT_DRY_RUN" = 1 ]; then
    # Report the runtime decision without acting on it: probe the system Node only.
    if [ "$OPT_VENDOR_NODE" = 0 ] && have node && have npm &&
      [ "$(node_major "$(command -v node)")" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
      NODE_LABEL="$(node -v) · already on this machine"
    else
      NODE_VENDORED=1
    fi
    dry_run_report
    exit 0
  fi

  mkdir -p "$INSTALL_DIR"
  LOG="$INSTALL_DIR/install.log"
  : >"$LOG"

  ok_line "$PLATFORM_LABEL"
  [ -n "$PLATFORM_NOTE" ] && dim_line "  $PLATFORM_NOTE"

  resolve_node
  ok_line "Node $NODE_LABEL"
  link_node_bin

  install_cotal
  ok_line "Cotal $INSTALLED_VERSION"

  write_launcher
  setup_path
  case "$PATH_STATE" in
    already) ok_line "$(tildify "$BIN_DIR") is on your PATH" ;;
    added:*) ok_line "Added $(tildify "$BIN_DIR") to your PATH" ;;
    manual) warn_line "$(tildify "$BIN_DIR") is not on your PATH yet" ;;
  esac

  ELAPSED=$(($(date +%s) - _t0))

  summary
  if hand_off_to_setup; then
    exit 0
  fi
  next_steps
}

main "$@"
