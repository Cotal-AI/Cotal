#!/usr/bin/env bash
# A disposable Ubuntu desktop for trying the Cotal app by hand, running live from a checkout.
#   create          make the VM, its desktop and dev tools, then save the 'clean' starting point
#   reset [name]    put the VM back to a saved starting point (default: clean) and start it
#   save <name>     save the VM as it is now as a named starting point
#   list            the saved starting points
#   app             run the desktop app from the checkout on the VM's screen, with live reload
#   dev <command>   run cotal-dev inside the VM: update, build, status
#   shell           a terminal inside the VM
#   run <command>   run one shell command inside the VM as its desktop user
#   view            how to see the VM's screen
#   start | stop | delete
set -euo pipefail
export PATH=$PATH:/snap/bin

here=$(dirname "$(readlink -f "$0")")
vm=${COTAL_DESKTOP_VM:-cotal-dev-ubuntu}
work=${COTAL_DESKTOP_WORK:-$HOME/cotal-test-machines/ubuntu-desktop}
state=$HOME/.cache/cotal-test-machines
secret=$HOME/.config/cotal-test-machines/$vm.vnc-password
port=${COTAL_DESKTOP_PORT:-5901}
uid=1000

die() { echo "ubuntu-desktop.sh: $*" >&2; exit 1; }
exists() { lxc info "$vm" >/dev/null 2>&1; }
pool() { if lxc storage show cotal-test >/dev/null 2>&1; then echo cotal-test; else echo default; fi; }
as_user() { lxc exec "$vm" --user $uid --group $uid --cwd /home/tester --env HOME=/home/tester --env USER=tester --env XDG_RUNTIME_DIR=/run/user/$uid -- "$@"; }
wait_ready() {
  for _ in $(seq 1 180); do
    if lxc exec "$vm" -- true >/dev/null 2>&1; then
      lxc exec "$vm" -- systemctl is-system-running --wait >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
  die "$vm did not answer within three minutes"
}
one_at_a_time() {
  local others
  others=$(lxc list --format csv -c ns | awk -F, -v self="$vm" '$1 ~ /^cotal-(test|dev)-/ && $1 != self && $2 == "RUNNING" {print $1}')
  [ -z "$others" ] || die "another test machine is running ($others). Stop it first."
}

background() {
  local name=$1 pid=$state/$vm.$1.pid
  shift
  mkdir -p "$state"
  if [ -f "$pid" ] && kill -0 "$(cat "$pid")" 2>/dev/null; then return 0; fi
  setsid "$@" >"$state/$vm.$name.log" 2>&1 < /dev/null &
  echo $! > "$pid"
}
background_stop() {
  local pid=$state/$vm.$1.pid
  [ -f "$pid" ] && kill "$(cat "$pid")" 2>/dev/null || true
  rm -f "$pid"
}
# The VNC display listens only on the VM's own loopback. The forward serves 127.0.0.1:$port on the
# host through `lxc exec`, so no network ever reaches the display directly. The nudge passes file
# changes made on the host to the dev app's watchers in the VM.
helpers_start() {
  mkdir -p "$state"
  printf '#!/bin/sh\nexec lxc exec %s -- socat STDIO TCP:127.0.0.1:5901\n' "$vm" > "$state/$vm.connect"
  chmod 700 "$state/$vm.connect"
  background forward socat "TCP-LISTEN:$port,bind=127.0.0.1,reuseaddr,fork" "EXEC:$state/$vm.connect"
  background nudge node "$here/ubuntu-desktop/nudge.mjs" "$vm" "$work/Cotal" /work/Cotal
}
helpers_stop() { background_stop forward; background_stop nudge; }

# The VM's tools live in the shared folder, so a change here reaches the VM without a new snapshot.
install_tools() {
  mkdir -p "$work/bin"
  install -m 0755 "$here/ubuntu-desktop/cotal-dev" "$here/ubuntu-desktop/cotal" "$work/bin/"
}

create() {
  exists && die "$vm already exists. Use reset, or delete it first."
  one_at_a_time
  command -v socat >/dev/null || die "socat is needed on this host for the screen forward"
  mkdir -p "$work" "$(dirname "$secret")"
  chmod 700 "$(dirname "$secret")"
  [ -d "$work/Cotal/.git" ] || git clone --quiet --filter=blob:none -b main https://github.com/Cotal-AI/Cotal.git "$work/Cotal"
  git -C "$work/Cotal" checkout --quiet -B live --track origin/main
  [ -s "$secret" ] || (umask 077; head -c 6 /dev/urandom | base64 | tr '+/' 'xy' | cut -c1-8 > "$secret")
  install_tools
  lxc init ubuntu:24.04 "$vm" --vm -s "$(pool)" -c limits.cpu=4 -c limits.memory=6GiB -d root,size=24GiB
  lxc config device add "$vm" work disk source="$work" path=/work >/dev/null
  lxc start "$vm"
  wait_ready
  lxc file push "$here/ubuntu-desktop/provision.sh" "$vm/root/provision.sh" >/dev/null
  lxc exec "$vm" -- bash /root/provision.sh
  lxc exec "$vm" -- sh -c 'vncpasswd -f > /home/tester/.config/tigervnc/passwd && chown tester:tester /home/tester/.config/tigervnc/passwd && chmod 600 /home/tester/.config/tigervnc/passwd' < "$secret"
  as_user bash -lc '[ -x /work/cargo/bin/cargo ] || curl -fsSL --proto =https --tlsv1.2 https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal'
  lxc stop "$vm"
  lxc snapshot "$vm" clean
  echo "$vm is ready. Next: $0 reset, then $0 dev build, then $0 app"
}

reset() {
  local name=${1:-clean}
  exists || die "$vm does not exist. Create it first: $0 create"
  one_at_a_time
  lxc stop --force "$vm" 2>/dev/null || true
  lxc restore "$vm" "$name"
  install_tools
  lxc start "$vm"
  wait_ready
  helpers_start
  echo "$vm is at '$name' and running."
}

save() {
  local name=${1:?name}
  [[ $name =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "a starting point name is lowercase letters, digits and dashes"
  lxc stop "$vm"
  lxc snapshot "$vm" "$name"
  lxc start "$vm"
  wait_ready
  helpers_start
  echo "saved '$name'. Go back to it any time: $0 reset $name"
}

app() {
  as_user systemctl --user stop cotal-dev-app.service >/dev/null 2>&1 || true
  as_user systemd-run --user --quiet --unit=cotal-dev-app --collect --setenv=WEBKIT_DISABLE_DMABUF_RENDERER=1 /work/bin/cotal-dev app
  echo "starting on the VM's screen. Follow it with: $0 shell, then: journalctl --user -fu cotal-dev-app"
}

view() {
  [ "$(lxc list "^$vm\$" --format csv -c s)" = RUNNING ] || die "$vm is not running. Start it: $0 start"
  helpers_start
  cat <<TEXT
The VM's screen is a VNC display on this PC at 127.0.0.1:$port, reachable only from this PC.
From another computer: ssh -L $port:127.0.0.1:$port <you>@<this PC>, then open vnc://localhost:$port
(on a Mac, paste it into Finder > Go > Connect to Server). The password is in $secret.
TEXT
}

case ${1:-} in
  create) create ;;
  reset) reset "${2:-}" ;;
  save) save "${2:-}" ;;
  list) lxc info "$vm" | sed -n '/^Snapshots:/,$p' ;;
  app) app ;;
  dev) shift; as_user bash -lc "cotal-dev $*" ;;
  shell) as_user bash -l ;;
  run) shift; as_user bash -lc "$*" ;;
  view) view ;;
  start) one_at_a_time; lxc start "$vm"; wait_ready; helpers_start ;;
  stop) helpers_stop; lxc stop "$vm" ;;
  delete) helpers_stop; lxc delete --force "$vm" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
