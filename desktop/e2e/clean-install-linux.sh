#!/usr/bin/env bash
set -euo pipefail
format=$1
candidate=$2
old=$3
broker=$4
image=ubuntu:24.04
[[ $format != rpm ]] || image=fedora:45
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || { echo 'Use a disposable hosted runner for native container services.' >&2; exit 1; }
scratch=$(mktemp -d)
container=
trap 'if [[ -n $container ]]; then docker rm -f "$container" >/dev/null; fi; rm -rf "$scratch"' EXIT
cp "$candidate" "$scratch/candidate.$format"
if [[ -n $old ]]; then cp "$old" "$scratch/older.$format"; old=/acceptance/older.$format; fi
cp "$(command -v node)" "$scratch/test-driver"
cp "$broker" "$scratch/broker"
chmod a+rx "$scratch" "$scratch/test-driver" "$scratch/broker"
container=$(docker run -d --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -v "$PWD:/source:ro" -v "$scratch:/acceptance:ro" "$image" \
  /bin/bash -ec '
    if command -v apt-get >/dev/null; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq systemd dbus dbus-user-session sudo xvfb xauth python3-pyatspi at-spi2-core xdg-utils
    else
      dnf -y -q install systemd dbus-daemon sudo xorg-x11-server-Xvfb xorg-x11-xauth python3-pyatspi at-spi2-core shadow-utils xdg-utils
    fi
    exec /usr/lib/systemd/systemd
  ')
for ((attempt=0; attempt<120; attempt++)); do
  if [[ $(docker inspect -f '{{.State.Running}}' "$container") != true ]]; then
    echo 'The clean OS container stopped before its systemd user session came up.' >&2
    exit 1
  fi
  if docker exec "$container" /bin/bash -ec '[[ $(cat /proc/1/comm) == systemd ]] && systemctl is-active --quiet systemd-logind'; then break; fi
  sleep 2
done
docker exec "$container" /bin/bash -ec '
  systemctl is-active --quiet systemd-logind || { echo "The clean container did not establish a real systemd user session." >&2; exit 1; }
  useradd -m -s /bin/bash desktop-test
  uid=$(id -u desktop-test)
  mkdir -p /home/desktop-test/.local/share/applications
  printf "%s\n" "[Desktop Entry]" "Type=Application" "Name=Loopback acceptance browser" \
    "Exec=/usr/bin/python3 /source/desktop/e2e/clean-install-linux-ui.py open %u" "MimeType=x-scheme-handler/http;" \
    > /home/desktop-test/.local/share/applications/fixture-browser.desktop
  chown -R desktop-test:desktop-test /home/desktop-test/.local
  printf "%s\n" "desktop-test ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/dnf" > /etc/sudoers.d/desktop-test
  chmod 440 /etc/sudoers.d/desktop-test
  loginctl enable-linger desktop-test
  systemctl start "user@$uid.service"
  exec runuser -u desktop-test -- env -i HOME=/home/desktop-test USER=desktop-test LOGNAME=desktop-test \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" LANG=C.UTF-8 \
    DO_NOT_TRACK=1 DESKTOP_DISPOSABLE=1 GTK_A11Y=1 OLD_VERSION="$4" \
    xvfb-run -a /bin/bash -ec "xdg-mime default fixture-browser.desktop x-scheme-handler/http; cd /source; exec /acceptance/test-driver --import tsx desktop/e2e/clean-install.mjs \"\$1\" \"\$2\" \"\$3\"" -- "$@"
' -- "/acceptance/candidate.$format" "$old" /acceptance/broker "${OLD_VERSION:-}"
