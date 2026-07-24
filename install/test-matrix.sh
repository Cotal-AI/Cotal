#!/usr/bin/env bash
# Onboarding matrix for install.sh.
#
# Every scenario runs in a throwaway container, so each one starts from a genuinely blank
# machine. That is the whole point: a clean slate should cost a second, not a reimage.
#
#   ./install/test-matrix.sh                 # all scenarios
#   ./install/test-matrix.sh node18 alpine   # just these
#   ./install/test-matrix.sh --list
#   ./install/test-matrix.sh --keep bare     # leave the container up to poke at
#
# Containers run the installer as an unprivileged user, never root. That is not incidental:
# it is the same claim the installer makes to users, so the harness has to hold it too.
#
# On a real machine (no Docker), the equivalent clean slate is a throwaway account:
#   sudo useradd -m cotaltest && sudo -u cotaltest -i sh -c 'curl -fsSL https://get.cotal.ai | sh'
#   sudo userdel -r cotaltest
# because the installer only ever writes inside $HOME, which `contained` below proves.

set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/../install.sh"
KEEP=0
FAILED=0
PASSED=0
SKIPPED=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m'
  DIM=$'\033[2m' BOLD=$'\033[1m' OFF=$'\033[0m'
else
  RED="" GREEN="" YELLOW="" DIM="" BOLD="" OFF=""
fi

# Columns, separated by `~` (a pipe would collide with the shell pipes in provisioning):
#   name ~ image ~ provisioning run as root ~ arg ~ expectation
#
# `arg` is one of: empty, AS_ROOT, TWICE, an installer flag (--dry-run), or an env
# assignment (CI=1). `expectation` is a shell snippet run after the installer with $out
# (combined output) and $rc (exit code) in scope; it must return 0 to pass.
scenarios() {
  cat <<'MATRIX'
bare~ubuntu:24.04~apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && useradd -m -s /bin/bash tester~~installs_ok && vendored && contained
node18~ubuntu:24.04~apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg >/dev/null && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null && useradd -m -s /bin/bash tester~~installs_ok && vendored && runs_on_22_plus
node22~node:22-bookworm-slim~useradd -m -s /bin/bash tester~~installs_ok && used_system_node
node24~node:24-bookworm-slim~useradd -m -s /bin/bash tester~~installs_ok && used_system_node
alpine-musl~alpine:3.21~apk add --no-cache curl >/dev/null && adduser -D tester~~refuses_musl
alpine-node~alpine:3.21~apk add --no-cache curl nodejs npm >/dev/null && adduser -D tester~~refuses_musl
wget-only~ubuntu:24.04~apt-get update -qq && apt-get install -y -qq wget ca-certificates >/dev/null && useradd -m -s /bin/bash tester~~installs_ok && vendored
no-downloader~ubuntu:24.04~useradd -m -s /bin/bash tester~~fails_with 'Need curl or wget'
root-refused~ubuntu:24.04~apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null~AS_ROOT~fails_with 'Do not run this installer as root'
zsh~node:22-bookworm-slim~apt-get update -qq && apt-get install -y -qq zsh >/dev/null && useradd -m -s /bin/zsh tester~~installs_ok && wrote_rc .zshrc
fish~node:22-bookworm-slim~apt-get update -qq && apt-get install -y -qq fish >/dev/null && useradd -m -s /usr/bin/fish tester~~installs_ok && wrote_rc .config/fish/config.fish
no-rc-files~node:22-bookworm-slim~useradd -m -s /bin/bash tester && rm -f /home/tester/.bashrc /home/tester/.bash_profile~~installs_ok && wrote_rc .bashrc
ascii-locale~node:22-bookworm-slim~useradd -m -s /bin/bash tester~LC_ALL=C~installs_ok && no_mojibake
no-color~node:22-bookworm-slim~useradd -m -s /bin/bash tester~NO_COLOR=1~installs_ok && no_ansi
ci-mode~node:22-bookworm-slim~useradd -m -s /bin/bash tester~CI=1~installs_ok && no_setup_handoff
upgrade~node:22-bookworm-slim~useradd -m -s /bin/bash tester~TWICE~installs_ok && single_path_block
pinned-version~node:22-bookworm-slim~useradd -m -s /bin/bash tester~--version 0.14.1~installs_ok && version_is 0.14.1
dry-run~node:22-bookworm-slim~useradd -m -s /bin/bash tester~--dry-run~changed_nothing
MATRIX
}

# ---- assertions available to the expectation column -------------------------------------

installs_ok() {
  [ "$rc" = 0 ] || {
    echo "    installer exited $rc"
    return 1
  }
  grep -q 'cotal-ai ' <<<"$version_out" || {
    echo "    installed cotal did not report a version: $version_out"
    return 1
  }
}
vendored() { grep -q 'downloaded and verified against nodejs.org' <<<"$out"; }
used_system_node() { grep -q 'already on this machine' <<<"$out"; }
runs_on_22_plus() {
  # The point of the whole design: whatever the system Node is, cotal runs on a good one.
  local major=${node_used#v}
  [ "${major%%.*}" -ge 22 ] || {
    echo "    launcher ran on Node $node_used"
    return 1
  }
}
refuses_musl() { [ "$rc" != 0 ] && grep -q 'does not support musl' <<<"$out"; }
fails_with() { [ "$rc" != 0 ] && grep -q "$1" <<<"$out"; }
wrote_rc() { grep -q '# cotal' <<<"$(printf '%s' "$rc_files")" && grep -q "$1" <<<"$rc_touched"; }
no_mojibake() { ! grep -qP '[^\x00-\x7F]' <<<"$out"; }
no_ansi() { ! grep -q $'\033\[' <<<"$out"; }
no_setup_handoff() { ! grep -q 'Starting guided setup' <<<"$out"; }
single_path_block() { [ "$path_blocks" = 1 ] || {
  echo "    found $path_blocks '# cotal' blocks, want 1"
  return 1
}; }
version_is() { grep -q "cotal-ai $1" <<<"$version_out"; }
changed_nothing() { [ "$rc" = 0 ] && grep -qi 'nothing was changed' <<<"$out" && [ "$wrote_anything" = 0 ]; }
# Proof, not inspection: nothing the installer wrote may live outside $HOME.
contained() { [ "$outside_home" = 0 ] || {
  echo "    wrote outside \$HOME:"
  printf '%s\n' "$outside_home_list" | sed 's/^/      /'
  return 1
}; }

# ---- runner -----------------------------------------------------------------------------

run_scenario() {
  local name=$1 image=$2 provision=$3 arg=$4 expect=$5
  local as_root=0 twice=0 env_pairs="" install_args=""

  case "$arg" in
    AS_ROOT) as_root=1 ;;
    TWICE) twice=1 ;;
    --*) install_args="$arg" ;;
    *=*) env_pairs="$arg" ;;
  esac

  printf '  %-14s %s%s%s ' "$name" "$DIM" "$image" "$OFF"

  local user_prefix="su tester -c"
  [ "$as_root" = 1 ] && user_prefix="sh -c"

  # The installer under test is mounted read-only; a scenario can never edit it.
  local runner
  runner=$(
    cat <<INNER
set -u
${provision}
export ${env_pairs:-IGNORE=1}
mkdir -p /marker && touch /marker/start
${user_prefix} 'cd \$HOME && sh /install.sh --no-setup ${install_args} 2>&1'
echo "___RC=\$?"
$([ "$twice" = 1 ] && echo "${user_prefix} 'cd \$HOME && sh /install.sh --no-setup 2>&1 >/dev/null'; echo \"___RC=\\\$?\"")
echo "___VERSION=\$(${user_prefix} '\$HOME/.local/bin/cotal --version 2>/dev/null | head -1' || echo none)"
echo "___NODE=\$(${user_prefix} '\$HOME/.local/share/cotal/nodebin/node -v 2>/dev/null' || echo none)"
echo "___PATHBLOCKS=\$(cat /home/tester/.zshrc /home/tester/.bashrc /home/tester/.bash_profile /home/tester/.config/fish/config.fish 2>/dev/null | grep -c '^# cotal\$' || echo 0)"
echo "___RCTOUCHED=\$(cd /home/tester 2>/dev/null && grep -rl '# cotal' .zshrc .bashrc .bash_profile .config/fish/config.fish 2>/dev/null | tr '\n' ' ')"
echo "___RCFILES=\$(cat /home/tester/.zshrc /home/tester/.bashrc /home/tester/.bash_profile /home/tester/.config/fish/config.fish 2>/dev/null)"
echo "___WROTE=\$(${user_prefix} 'ls -A \$HOME/.local/share/cotal 2>/dev/null | wc -l' || echo 0)"
echo "___OUTSIDE_START"
find / -xdev -newer /marker/start \\( -type f -o -type l \\) \\
  -not -path '/home/*' -not -path '/root/*' -not -path '/tmp/*' -not -path '/marker/*' \\
  -not -path '/var/*' -not -path '/etc/*' -not -path '/usr/lib/node_modules/*' 2>/dev/null | head -20
echo "___OUTSIDE_END"
INNER
  )

  local raw
  raw=$(docker run --rm ${KEEP:+--name "cotal-test-$name"} \
    -v "$SCRIPT:/install.sh:ro" \
    "$image" sh -c "$runner" 2>&1)

  # Split the marker-delimited report back out of the container's combined output.
  local rc out version_out node_used path_blocks rc_files rc_touched wrote_anything
  local outside_home outside_home_list
  rc=$(grep '^___RC=' <<<"$raw" | head -1 | cut -d= -f2)
  out=$(sed -n '1,/^___RC=/p' <<<"$raw" | sed '$d')
  version_out=$(grep '^___VERSION=' <<<"$raw" | cut -d= -f2-)
  node_used=$(grep '^___NODE=' <<<"$raw" | cut -d= -f2-)
  path_blocks=$(grep '^___PATHBLOCKS=' <<<"$raw" | cut -d= -f2- | tr -dc '0-9')
  rc_touched=$(grep '^___RCTOUCHED=' <<<"$raw" | cut -d= -f2-)
  rc_files=$(sed -n '/^___RCFILES=/,/^___WROTE=/p' <<<"$raw")
  wrote_anything=$(grep '^___WROTE=' <<<"$raw" | cut -d= -f2- | tr -dc '0-9')
  outside_home_list=$(sed -n '/^___OUTSIDE_START$/,/^___OUTSIDE_END$/p' <<<"$raw" | sed '1d;$d')
  outside_home=$(printf '%s' "$outside_home_list" | grep -c . || true)

  : "${rc:=127}" "${path_blocks:=0}" "${wrote_anything:=0}" "${outside_home:=0}"

  local detail
  if detail=$(eval "$expect" 2>&1); then
    printf '%sPASS%s\n' "$GREEN" "$OFF"
    PASSED=$((PASSED + 1))
  else
    printf '%sFAIL%s\n' "$RED" "$OFF"
    [ -n "$detail" ] && printf '%s\n' "$detail"
    printf '%s' "$out" | tail -12 | sed "s/^/      $DIM/;s/\$/$OFF/"
    FAILED=$((FAILED + 1))
  fi
}

main() {
  local want=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --list)
        scenarios | cut -d'~' -f1,2 | column -t -s'~'
        exit 0
        ;;
      --keep) KEEP=1 ;;
      -h | --help)
        sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      *) want+=("$1") ;;
    esac
    shift
  done

  [ -f "$SCRIPT" ] || {
    echo "no install.sh at $SCRIPT" >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Docker is not running. Start Docker/OrbStack and try again." >&2
    exit 1
  }

  printf '\n  %sinstall.sh onboarding matrix%s  %s(%s)%s\n\n' \
    "$BOLD" "$OFF" "$DIM" "$(uname -m)" "$OFF"

  while IFS='~' read -r name image provision arg expect; do
    [ -n "$name" ] || continue
    if [ ${#want[@]} -gt 0 ]; then
      local match=0
      for w in "${want[@]}"; do [ "$w" = "$name" ] && match=1; done
      [ "$match" = 1 ] || {
        SKIPPED=$((SKIPPED + 1))
        continue
      }
    fi
    run_scenario "$name" "$image" "$provision" "$arg" "$expect"
  done <<<"$(scenarios)"

  printf '\n  %s%d passed%s' "$GREEN" "$PASSED" "$OFF"
  [ "$FAILED" -gt 0 ] && printf ', %s%d failed%s' "$RED" "$FAILED" "$OFF"
  [ "$SKIPPED" -gt 0 ] && printf ', %s%d skipped%s' "$YELLOW" "$SKIPPED" "$OFF"
  printf '\n\n'
  [ "$FAILED" = 0 ]
}

main "$@"
