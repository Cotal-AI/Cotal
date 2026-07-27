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
WANT=()
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
node22~node:22-bookworm-slim~useradd -m -s /bin/bash tester~~installs_ok && used_system_node && contained
node24~node:24-bookworm-slim~useradd -m -s /bin/bash tester~~installs_ok && used_system_node
alpine-musl~alpine:3.21~apk add --no-cache curl >/dev/null && adduser -D tester~~refuses_musl
alpine-node~alpine:3.21~apk add --no-cache curl nodejs npm >/dev/null && adduser -D tester~~refuses_musl
wget-only~ubuntu:24.04~apt-get update -qq && apt-get install -y -qq wget ca-certificates >/dev/null && useradd -m -s /bin/bash tester~~installs_ok && vendored && contained
no-downloader~ubuntu:24.04~useradd -m -s /bin/bash tester~~fails_with 'Need curl or wget'
root-refused~ubuntu:24.04~apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null~AS_ROOT~fails_with 'Do not run this installer as root'
zsh~node:22-bookworm-slim~apt-get update -qq && apt-get install -y -qq zsh >/dev/null && useradd -m -s /bin/zsh tester~~installs_ok && wrote_rc .zshrc
fish~node:22-bookworm-slim~apt-get update -qq && apt-get install -y -qq fish >/dev/null && useradd -m -s /usr/bin/fish tester~~installs_ok && wrote_rc .config/fish/config.fish
no-rc-files~node:22-bookworm-slim~useradd -m -s /bin/bash tester && rm -f /home/tester/.bashrc /home/tester/.bash_profile~~installs_ok && wrote_rc .bashrc
ascii-locale~node:22-bookworm-slim~useradd -m -s /bin/bash tester~LC_ALL=C~installs_ok && no_mojibake
no-color~node:22-bookworm-slim~useradd -m -s /bin/bash tester~NO_COLOR=1~installs_ok && no_ansi
ci-mode~node:22-bookworm-slim~useradd -m -s /bin/bash tester~CI=1~installs_ok && no_setup_handoff
upgrade~node:22-bookworm-slim~useradd -m -s /bin/bash tester~TWICE~installs_ok && single_path_block && contained
pinned-version~node:22-bookworm-slim~useradd -m -s /bin/bash tester~--version 0.14.1~installs_ok && version_is 0.14.1
dry-run~node:22-bookworm-slim~useradd -m -s /bin/bash tester~--dry-run~changed_nothing
MATRIX
}

# True when no filter was given, or when this name was asked for.
wanted() {
  [ ${#WANT[@]} -eq 0 ] && return 0
  local w
  for w in "${WANT[@]}"; do [ "$w" = "$1" ] && return 0; done
  return 1
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
no_mojibake() { ! LC_ALL=C grep -q '[^ -~]' <<<"$out"; }
no_ansi() { ! grep -q $'\033\[' <<<"$out"; }
no_setup_handoff() { ! grep -q 'Starting guided setup' <<<"$out"; }
single_path_block() { [ "$path_blocks" = 1 ] || {
  echo "    found $path_blocks '# cotal' blocks, want 1"
  return 1
}; }
version_is() { grep -q "cotal-ai $1" <<<"$version_out"; }
changed_nothing() { [ "$rc" = 0 ] && grep -qi 'nothing was changed' <<<"$out" &&
  [ "$wrote_anything" = 0 ] && [ "$launcher_exists" = 0 ] && [ "$path_blocks" = 0 ]; }
# Proof, not inspection: nothing the installer wrote may live outside $HOME.
contained() { [ "$outside_home" = 0 ] || {
  echo "    wrote outside \$HOME:"
  printf '%s\n' "$outside_home_list" | sed 's/^/      /'
  return 1
}; }

# ---- regressions ------------------------------------------------------------------------
#
# Defects found in review that the table's shape cannot express, because each needs its own
# container body rather than the standard install-and-inspect. Named after the defect, so a
# re-break reads plainly in the log.

# regression <name> <image> <body>. The body must print exactly `VERDICT=ok` to pass.
regression() {
  local name=$1 image=$2 body=$3
  wanted "$name" || {
    SKIPPED=$((SKIPPED + 1))
    return 0
  }
  printf '  %-14s %s%s%s ' "$name" "$DIM" "$image" "$OFF"
  local raw
  raw=$(docker run --rm -v "$SCRIPT:/install.sh:ro" "$image" sh -c "$body" 2>&1)
  if grep -q '^VERDICT=ok$' <<<"$raw"; then
    printf '%sPASS%s\n' "$GREEN" "$OFF"
    PASSED=$((PASSED + 1))
  else
    printf '%sFAIL%s\n' "$RED" "$OFF"
    tail -12 <<<"$raw" | sed "s/^/      $DIM/;s/\$/$OFF/"
    FAILED=$((FAILED + 1))
  fi
}

# shellcheck disable=SC2016  # bodies are single-quoted ON PURPOSE: they expand inside the
# container, not here. Expanding them in the harness would substitute the host's values.
regressions() {
  # A $HOME containing a space used to word-split the bash rc candidate list, so the
  # fallback named a TRUNCATED path outside the home directory and the PATH block was
  # appended there. Containment is the claim; this is the case that broke it.
  regression spaces-home node:22-bookworm-slim '
    useradd -m -s /bin/bash tester
    mkdir -p "/home/tester/my home" && chown -R tester /home/tester
    su tester -c "HOME=\"/home/tester/my home\" SHELL=/bin/bash sh /install.sh --no-setup" >/tmp/o 2>&1
    # Nothing may appear beside the real home directory.
    stray=$(find /home/tester -maxdepth 1 -type f -newer /etc/hostname 2>/dev/null | grep -v "^/home/tester/\.bash" || true)
    if [ -n "$stray" ]; then echo "STRAY: $stray"; cat $stray; exit 1; fi
    su tester -c "HOME=\"/home/tester/my home\" \"/home/tester/my home/.local/bin/cotal\" --version" >/dev/null 2>&1 || { echo "launcher broken"; exit 1; }
    echo VERDICT=ok
  '

  # Fault injection, because nodejs.org will not serve us a bad tarball on request. The
  # comparison itself is mutated so the computed digest cannot match, which proves the guard
  # is wired and fail-closed rather than merely present in the source.
  regression bad-checksum ubuntu:24.04 '
    apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null
    useradd -m -s /bin/bash tester
    sed "s|^  _got=\$(sha256_of \"\$_tmp\")|  _got=\"deadbeef\"|" /install.sh > /tmp/mutant.sh
    grep -q "deadbeef" /tmp/mutant.sh || { echo "fault injection missed its target line"; exit 1; }
    su tester -c "cd \$HOME && sh /tmp/mutant.sh --no-setup" >/tmp/o 2>&1
    rc=$?
    [ "$rc" != 0 ] || { echo "installer exited 0 despite a checksum mismatch"; exit 1; }
    grep -q "Checksum mismatch" /tmp/o || { echo "no checksum-mismatch message"; tail -5 /tmp/o; exit 1; }
    if [ -e "/home/tester/.local/bin/cotal" ]; then echo "installed anyway after a bad checksum"; exit 1; fi
    echo VERDICT=ok
  '

  # Concurrent installers used to race on the same prefix. npm stages and renames inside it,
  # so a racing pair could BOTH report success and leave no working cotal at all, which
  # happened intermittently. One install must now win and the rest must refuse, loudly.
  regression concurrent node:22-bookworm-slim '
    useradd -m -s /bin/bash tester
    for i in 1 2 3 4 5; do
      su tester -c "cd \$HOME && sh /install.sh --no-setup" >/tmp/o$i 2>&1 &
    done
    wait
    refused=$(grep -l "Another Cotal install is already running" /tmp/o1 /tmp/o2 /tmp/o3 /tmp/o4 /tmp/o5 2>/dev/null | wc -l)
    [ "$refused" -ge 1 ] || { echo "no run refused; the lock never engaged"; exit 1; }
    # Whatever the interleaving, the end state must be one working install.
    su tester -c "\$HOME/.local/bin/cotal --version" >/dev/null 2>&1 || { echo "no working cotal after 5 concurrent installs"; exit 1; }
    blocks=$(grep -c "^# cotal$" /home/tester/.bashrc 2>/dev/null | head -1)
    [ "${blocks:-0}" -le 1 ] || { echo "left ${blocks} PATH blocks"; exit 1; }
    # A refused run must not have left the lock behind for the next attempt.
    [ ! -d /home/tester/.local/share/cotal/.install-lock ] || { echo "install lock leaked"; exit 1; }
    echo VERDICT=ok
  '

  # Removal is caught by the launcher. REPLACEMENT with an older Node is the subtler case:
  # the pin still resolves, so cotal-ai own preflight is what must catch it, and because the
  # launcher exports COTAL_LAUNCHER it must name the installer rather than generic nvm advice.
  regression node-downgraded ubuntu:24.04 '
    apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    useradd -m -s /bin/bash tester
    # System Node is 18, so the installer vendors a good one and pins that.
    su tester -c "cd \$HOME && sh /install.sh --no-setup" >/tmp/o 2>&1
    # Now genuinely downgrade the pin to the real Node 18 on this box. A stub that merely
    # prints "v18" would not do: the preflight reads process.versions.node, so only a real
    # old runtime exercises it.
    ln -sf "$(command -v node)" /home/tester/.local/share/cotal/nodebin/node
    [ "$(/home/tester/.local/share/cotal/nodebin/node -v | cut -d. -f1)" = "v18" ] || { echo "pin was not actually downgraded"; exit 1; }
    msg=$(su tester -c "\$HOME/.local/bin/cotal --version" 2>&1 || true)
    # The invariant under test is the safety one: cotal must refuse to run on a Node below
    # the floor and say so plainly. The installer-aware wording of that message comes from
    # bin/cotal.ts and only reaches this test once cotal-ai publishes it, so asserting on it
    # here would be a knowingly-red test against the registry copy.
    case "$msg" in
      *"requires Node.js >= 22"*) echo VERDICT=ok ;;
      *) echo "preflight did not fire on a downgraded pin: $msg"; exit 1 ;;
    esac
  '

  # The install lock publishes its owner atomically (a symlink whose target IS the pid).
  # A mkdir-then-write-a-pid-file lock has a window where it is held but unattributed, and a
  # second installer arriving in that window reads no owner, calls it stale, and steals a
  # LIVE lock. All three states are checked here: live, stale, and not-ours.
  regression lock-states node:22-bookworm-slim '
    useradd -m -s /bin/bash tester
    mkdir -p /home/tester/.local/share/cotal && chown -R tester /home/tester
    # (a) live owner: must refuse
    LIVE=$(su tester -c "sleep 300 >/dev/null 2>&1 & echo \$!")
    su tester -c "ln -s $LIVE /home/tester/.local/share/cotal/.install-lock"
    out=$(su tester -c "cd \$HOME && sh /install.sh --no-setup" 2>&1 || true)
    case "$out" in *"Another Cotal install is already running"*) ;; *) echo "live lock not refused"; exit 1 ;; esac
    [ ! -e /home/tester/.local/bin/cotal ] || { echo "installed despite a live lock"; exit 1; }
    kill $LIVE 2>/dev/null || true
    # (b) not ours (a directory): must refuse, never ln -s INTO it
    su tester -c "rm -f /home/tester/.local/share/cotal/.install-lock; mkdir -p /home/tester/.local/share/cotal/.install-lock"
    out=$(su tester -c "cd \$HOME && sh /install.sh --no-setup" 2>&1 || true)
    case "$out" in *"in the way of the install lock"*) ;; *) echo "directory lock not refused"; exit 1 ;; esac
    [ ! -e /home/tester/.local/bin/cotal ] || { echo "installed despite a foreign lock"; exit 1; }
    # (c) stale owner: must take over and finish
    su tester -c "rm -rf /home/tester/.local/share/cotal/.install-lock; ln -s 999999 /home/tester/.local/share/cotal/.install-lock"
    su tester -c "cd \$HOME && sh /install.sh --no-setup" >/tmp/c 2>&1 || { echo "stale lock not recovered"; tail -4 /tmp/c; exit 1; }
    su tester -c "\$HOME/.local/bin/cotal --version" >/dev/null 2>&1 || { echo "no cotal after stale-lock recovery"; exit 1; }
    [ ! -e /home/tester/.local/share/cotal/.install-lock ] || { echo "lock leaked"; exit 1; }
    echo VERDICT=ok
  '

  # The launcher bakes its paths in and is then run from every directory on the machine, so a
  # relative override must be made absolute before anything records it.
  regression relative-dirs node:22-bookworm-slim '
    useradd -m -s /bin/bash tester
    su tester -c "cd \$HOME && mkdir -p work && cd work && COTAL_INSTALL_DIR=./cot COTAL_BIN_DIR=./cotbin sh /install.sh --no-setup --no-modify-path" >/tmp/o 2>&1
    root=$(grep "^COTAL_ROOT=" /home/tester/work/cotbin/cotal)
    case "$root" in *\"/home/tester/work/cot\"*) ;; *) echo "launcher kept a relative root: $root"; exit 1 ;; esac
    # The real test: run it from somewhere else entirely.
    su tester -c "cd / && /home/tester/work/cotbin/cotal --version" >/dev/null 2>&1 || { echo "launcher broken outside its install dir"; exit 1; }
    echo VERDICT=ok
  '

  # A lexical "starts with $HOME/" test is not containment. ZDOTDIR (or XDG_CONFIG_HOME) can
  # be $HOME/../elsewhere, which passes that test and still writes outside HOME, and either
  # can be a symlink pointing anywhere. Both escapes are checked.
  regression rc-escape node:22-bookworm-slim '
    useradd -m -s /bin/bash tester
    mkdir -p /home/tester/home /home/tester/escape && chown -R tester /home/tester
    su tester -c "HOME=/home/tester/home ZDOTDIR=/home/tester/home/../escape SHELL=/bin/zsh sh /install.sh --no-setup" >/tmp/o 2>&1
    if grep -q "^# cotal$" /home/tester/escape/.zshrc 2>/dev/null; then echo "dot-dot escaped HOME"; exit 1; fi
    su tester -c "ln -s /home/tester/escape /home/tester/home/link"
    su tester -c "HOME=/home/tester/home ZDOTDIR=/home/tester/home/link SHELL=/bin/zsh sh /install.sh --no-setup" >/tmp/o2 2>&1
    if grep -q "^# cotal$" /home/tester/escape/.zshrc 2>/dev/null; then echo "symlink escaped HOME"; exit 1; fi
    # Refusing must not mean failing: the install still lands, it just prints the PATH line.
    su tester -c "HOME=/home/tester/home /home/tester/home/.local/bin/cotal --version" >/dev/null 2>&1 || { echo "install did not complete"; exit 1; }
    echo VERDICT=ok
  '

  # `command -v node` returns a RELATIVE path when PATH holds a relative entry. A relative
  # symlink target in nodebin/ then resolves against nodebin/, where it does not exist, so
  # the install reports success and the launcher can never start.
  regression relative-path-node node:22-bookworm-slim '
    useradd -m -s /bin/bash tester && chown -R tester /home/tester
    su tester -c "cd \$HOME && mkdir -p relbin && ln -s /usr/local/bin/node relbin/node && ln -s /usr/local/bin/npm relbin/npm"
    su tester -c "cd \$HOME && PATH=relbin:\$PATH sh /install.sh --no-setup --no-modify-path" >/tmp/o 2>&1
    pin=$(readlink /home/tester/.local/share/cotal/nodebin/node)
    case "$pin" in /*) ;; *) echo "pinned a relative path: $pin"; exit 1 ;; esac
    su tester -c "cd / && \$HOME/.local/bin/cotal --version" >/dev/null 2>&1 || { echo "launcher broken after a relative-PATH install"; exit 1; }
    echo VERDICT=ok
  '

  # The pin can be a Node this installer does not own, and the user may remove it later.
  # That must produce the launcher own message, never the raw
  # "/usr/bin/env: node: No such file or directory" this whole installer exists to prevent.
  regression node-removed node:22-bookworm-slim '
    useradd -m -s /bin/bash tester
    su tester -c "cd \$HOME && sh /install.sh --no-setup" >/tmp/o 2>&1
    mv /usr/local/bin/node /usr/local/bin/node.gone
    msg=$(su tester -c "\$HOME/.local/bin/cotal --version" 2>&1 || true)
    case "$msg" in
      *"no longer there"*) ;;
      *) echo "unhelpful failure: $msg"; exit 1 ;;
    esac
    case "$msg" in
      *"get.cotal.ai"*) echo VERDICT=ok ;;
      *) echo "no repair instruction: $msg"; exit 1 ;;
    esac
  '
}

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

  # TWICE runs both installs inside one shell, ANDed, so a single exit code covers both.
  # Emitting two ___RC records and parsing them was how a failing second install stayed
  # invisible behind the first one's success.
  local install_cmd="sh /install.sh --no-setup ${install_args} 2>&1"
  [ "$twice" = 1 ] && install_cmd="sh /install.sh --no-setup 2>&1 && sh /install.sh --no-setup 2>&1"

  # The installer under test is mounted read-only; a scenario can never edit it.
  local runner
  runner=$(
    cat <<INNER
set -u
${provision}
export ${env_pairs:-IGNORE=1}
mkdir -p /marker && touch /marker/start
${user_prefix} 'cd \$HOME && ${install_cmd}'
echo "___RC=\$?"
echo "___VERSION=\$(${user_prefix} '\$HOME/.local/bin/cotal --version 2>/dev/null | head -1' || echo none)"
echo "___NODE=\$(${user_prefix} '\$HOME/.local/share/cotal/nodebin/node -v 2>/dev/null' || echo none)"
echo "___PATHBLOCKS=\$(cat /home/tester/.zshrc /home/tester/.bashrc /home/tester/.bash_profile /home/tester/.config/fish/config.fish 2>/dev/null | grep -c '^# cotal\$' || echo 0)"
echo "___RCTOUCHED=\$(cd /home/tester 2>/dev/null && grep -rl '# cotal' .zshrc .bashrc .bash_profile .config/fish/config.fish 2>/dev/null | tr '\n' ' ')"
echo "___RCFILES=\$(cat /home/tester/.zshrc /home/tester/.bashrc /home/tester/.bash_profile /home/tester/.config/fish/config.fish 2>/dev/null)"
echo "___WROTE=\$(${user_prefix} 'ls -A \$HOME/.local/share/cotal 2>/dev/null | wc -l' || echo 0)"
echo "___LAUNCHER=\$(${user_prefix} 'test -e \$HOME/.local/bin/cotal && echo 1 || echo 0')"
echo "___OUTSIDE_START"
# Exclusions are deliberately narrow: only the tester's own home (the permitted target),
# scratch that any process may use, this harness's own marker, and the login bookkeeping
# \`su\` writes. Anything else appearing under /usr, /etc, /opt or /var is a containment
# break and must show up here.
find / -xdev -newer /marker/start \\( -type f -o -type l \\) \\
  -not -path '/home/tester/*' -not -path '/root/*' -not -path '/tmp/*' \\
  -not -path '/marker/*' -not -path '/var/log/*' -not -path '/run/*' 2>/dev/null | head -20
echo "___OUTSIDE_END"
INNER
  )

  local raw
  raw=$(docker run --rm ${KEEP:+--name "cotal-test-$name"} \
    -v "$SCRIPT:/install.sh:ro" \
    "$image" sh -c "$runner" 2>&1)

  # Split the marker-delimited report back out of the container's combined output.
  local rc out version_out node_used path_blocks rc_files rc_touched wrote_anything launcher_exists
  local outside_home outside_home_list
  # TWICE emits two ___RC records. Take the first NON-ZERO one, so a second install that
  # fails cannot hide behind the first one's success.
  rc=$(grep '^___RC=' <<<"$raw" | cut -d= -f2 | grep -v '^0$' | head -1)
  # No non-zero record, but at least one record: every install in this scenario succeeded.
  # No records at all leaves rc empty, and the default below turns that into 127.
  if [ -z "$rc" ] && grep -q '^___RC=' <<<"$raw"; then rc=0; fi
  out=$(sed -n '1,/^___RC=/p' <<<"$raw" | sed '$d')
  version_out=$(grep '^___VERSION=' <<<"$raw" | cut -d= -f2-)
  node_used=$(grep '^___NODE=' <<<"$raw" | cut -d= -f2-)
  path_blocks=$(grep '^___PATHBLOCKS=' <<<"$raw" | cut -d= -f2- | tr -dc '0-9')
  rc_touched=$(grep '^___RCTOUCHED=' <<<"$raw" | cut -d= -f2-)
  rc_files=$(sed -n '/^___RCFILES=/,/^___WROTE=/p' <<<"$raw")
  wrote_anything=$(grep '^___WROTE=' <<<"$raw" | cut -d= -f2- | tr -dc '0-9')
  launcher_exists=$(grep '^___LAUNCHER=' <<<"$raw" | cut -d= -f2- | tr -dc '0-9')
  outside_home_list=$(sed -n '/^___OUTSIDE_START$/,/^___OUTSIDE_END$/p' <<<"$raw" | sed '1d;$d')
  outside_home=$(printf '%s' "$outside_home_list" | grep -c . || true)

  : "${rc:=127}" "${path_blocks:=0}" "${wrote_anything:=0}" "${outside_home:=0}" "${launcher_exists:=0}"

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
      *) WANT+=("$1") ;;
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
    wanted "$name" || {
      SKIPPED=$((SKIPPED + 1))
      continue
    }
    run_scenario "$name" "$image" "$provision" "$arg" "$expect"
  done <<<"$(scenarios)"

  regressions

  printf '\n  %s%d passed%s' "$GREEN" "$PASSED" "$OFF"
  [ "$FAILED" -gt 0 ] && printf ', %s%d failed%s' "$RED" "$FAILED" "$OFF"
  [ "$SKIPPED" -gt 0 ] && printf ', %s%d skipped%s' "$YELLOW" "$SKIPPED" "$OFF"
  printf '\n\n'
  [ "$FAILED" = 0 ]
}

main "$@"
