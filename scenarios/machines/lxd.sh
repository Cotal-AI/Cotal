#!/usr/bin/env bash
# Disposable Ubuntu and Fedora test machines in LXD, each with a "clean" snapshot.
# Usage: scenarios/machines/lxd.sh <create|reset|run|shell|stop|delete|list> [os] [scenario] [runner options]
set -euo pipefail
export PATH=$PATH:/snap/bin

here=$(dirname "$(readlink -f "$0")")
scenarios=$(dirname "$here")
node_version=v24.22.3
node_sha256=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
user=tester
uid=2000

die() { echo "lxd.sh: $*" >&2; exit 1; }
name_of() {
  case "$1" in
    ubuntu) echo cotal-test-ubuntu ;;
    fedora) echo cotal-test-fedora ;;
    *) die "unknown machine '$1' (ubuntu or fedora)" ;;
  esac
}
image_of() {
  case "$1" in
    ubuntu) echo ubuntu:24.04 ;;
    fedora) echo images:fedora/45/cloud ;;
  esac
}
exists() { lxc info "$1" >/dev/null 2>&1; }
# The copy-on-write pool from the README makes resets take seconds; without it LXD's default pool works, slowly.
pool() { if lxc storage show cotal-test >/dev/null 2>&1; then echo cotal-test; else echo default; fi; }
wait_agent() {
  for _ in $(seq 1 180); do
    if lxc exec "$1" -- true >/dev/null 2>&1; then
      lxc exec "$1" -- systemctl is-system-running --wait >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
  die "$1 did not answer within three minutes"
}
as_user() { local vm=$1; shift; lxc exec "$vm" ${SCENARIO_JOB_URL:+--env SCENARIO_JOB_URL="$SCENARIO_JOB_URL"} ${token_file:+--env GITHUB_TOKEN_FILE="$token_file"} --user $uid --group $uid --cwd /home/$user --env HOME=/home/$user --env USER=$user --env XDG_RUNTIME_DIR=/run/user/$uid --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus -- "$@"; }
running_others() {
  lxc list --format csv -c ns | awk -F, -v self="$1" '$1 ~ /^cotal-(test|dev)-/ && $1 != self && $2 == "RUNNING" {print $1}'
}
one_at_a_time() {
  local others
  others=$(running_others "$1")
  [ -z "$others" ] || die "another test machine is running ($others). Stop it first: scenarios/machines/lxd.sh stop <os>"
}

# Runs a root command in the VM and shows its output only when it fails.
quiet() {
  local out
  out=$(lxc exec "$1" -- sh -c "$2" 2>&1) || { printf '%s\n' "$out" | tail -30 >&2; die "setup step failed in $1"; }
}

provision_linux() {
  local os=$1 vm=$2
  lxc exec "$vm" -- cloud-init status --wait >/dev/null 2>&1 || true
  if [ "$os" = ubuntu ]; then
    quiet "$vm" 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq xvfb xauth x11-utils curl xz-utils ca-certificates'
  else
    quiet "$vm" 'dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth xwininfo xdpyinfo curl xz ca-certificates which procps-ng'
  fi
  lxc exec "$vm" -- sh -c "id $user >/dev/null 2>&1 || useradd -m -u $uid -s /bin/bash $user"
  lxc exec "$vm" -- sh -c "echo '$user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/$user && chmod 0440 /etc/sudoers.d/$user && loginctl enable-linger $user"
  lxc exec "$vm" -- sh -c "set -e; cd /tmp; curl -fsSLo node.tar.xz https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz
    echo '$node_sha256  node.tar.xz' | sha256sum -c - >/dev/null
    mkdir -p /opt/cotal-scenario-node && tar -xJf node.tar.xz -C /opt/cotal-scenario-node --strip-components=1 && rm node.tar.xz"
  lxc exec "$vm" -- sh -c "echo 'Disposable Cotal test machine made by scenarios/machines/lxd.sh' > /etc/cotal-scenario-machine"
}

create() {
  local os=$1 vm
  vm=$(name_of "$os")
  exists "$vm" && die "$vm already exists. Use reset, or delete it first."
  one_at_a_time "$vm"
  lxc launch "$(image_of "$os")" "$vm" --vm -s "$(pool)" -c limits.cpu=2 -c limits.memory=3GiB -d root,size=24GiB
  wait_agent "$vm"
  provision_linux "$os" "$vm"
  lxc stop "$vm"
  lxc snapshot "$vm" clean
  echo "$vm is ready and stopped. Its clean snapshot is 'clean'."
}

reset() {
  local vm
  vm=$(name_of "$1")
  exists "$vm" || die "$vm does not exist. Create it first: scenarios/machines/lxd.sh create $1"
  one_at_a_time "$vm"
  lxc stop --force "$vm" 2>/dev/null || true
  lxc restore "$vm" clean
  lxc start "$vm"
  wait_agent "$vm"
  echo "$vm is back to clean and running."
}

run() {
  local os=$1 scenario=$2 vm out
  shift 2
  vm=$(name_of "$os")
  reset "$os"
  out="$scenarios/results/$os-$scenario"
  rm -rf "$out" && mkdir -p "$out"
  lxc exec "$vm" -- rm -rf /home/$user/scenarios
  lxc file push -r -p "$scenarios" "$vm/home/$user/" >/dev/null
  lxc exec "$vm" -- sh -c "rm -rf /home/$user/scenarios/results; chown -R $user:$user /home/$user/scenarios"
  # Unauthenticated release listings share one small hourly limit per runner address. The token
  # goes in through stdin into a 0600 file, never through a command line.
  local status=0 token=${GITHUB_TOKEN:-${GH_TOKEN:-}} token_file=
  if [ -n "$token" ]; then
    token_file=/home/$user/.github-token
    printf '%s' "$token" | lxc exec "$vm" -- sh -c "umask 077; cat > $token_file; chown $user:$user $token_file"
  fi
  as_user "$vm" /opt/cotal-scenario-node/bin/node /home/$user/scenarios/run.mjs run "$scenario" --out /home/$user/result "$@" || status=$?
  [ -z "$token_file" ] || lxc exec "$vm" -- rm -f "$token_file"
  lxc file pull -r "$vm/home/$user/result/." "$out/" >/dev/null 2>&1 || true
  lxc stop "$vm"
  echo "Result: $out/result.json"
  return "$status"
}

shell() {
  local vm
  vm=$(name_of "$1")
  as_user "$vm" bash -l
}

cmd=${1:-}
case "$cmd" in
  create) create "${2:?os}" ;;
  reset) reset "${2:?os}" ;;
  run) shift; run "${1:?os}" "${2:?scenario}" "${@:3}" ;;
  shell) shell "${2:?os}" ;;
  stop) lxc stop "$(name_of "${2:?os}")" ;;
  delete) lxc delete --force "$(name_of "${2:?os}")" ;;
  list) lxc list cotal-test- -c nsS ;;
  *) sed -n '2,3p' "$0"; exit 2 ;;
esac
