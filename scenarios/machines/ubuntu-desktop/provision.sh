#!/bin/bash
# Runs once as root inside a new Ubuntu 24.04 VM: a desktop on a localhost-only VNC display, the
# Tauri build dependencies, Node 24 and the `tester` account. Toolchains and the checkout live in
# /work, a folder shared from the host, so they survive every reset. The host keeps cotal-dev and
# the cotal command in /work/bin current.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
user=tester
node_version=v24.22.3
node_sha256=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb

cloud-init status --wait >/dev/null 2>&1 || true
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  xfce4 xfce4-terminal xfce4-notifyd dbus-user-session dbus-x11 at-spi2-core fonts-dejavu-core \
  tigervnc-standalone-server tigervnc-tools socat x11-utils xauth \
  build-essential pkg-config file curl wget git ca-certificates xz-utils \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev >/dev/null

# The checkout on the host belongs to uid 1000, so the desktop account takes that uid.
if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu >/dev/null 2>&1 || true; fi
id "$user" >/dev/null 2>&1 || useradd -m -u 1000 -s /bin/bash "$user"
echo "$user ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$user" && chmod 0440 "/etc/sudoers.d/$user"
loginctl enable-linger "$user"

cd /tmp
curl -fsSLo node.tar.xz "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz"
echo "$node_sha256  node.tar.xz" | sha256sum -c - >/dev/null
rm -rf /opt/node24 && mkdir -p /opt/node24 && tar -xJf node.tar.xz -C /opt/node24 --strip-components=1 && rm node.tar.xz
PATH=/opt/node24/bin:$PATH corepack enable --install-directory /opt/node24/bin

# One environment for login shells, the desktop session and every user service.
env_lines='PATH=/work/bin:/work/cargo/bin:/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CARGO_HOME=/work/cargo
RUSTUP_HOME=/work/rustup
COREPACK_HOME=/work/corepack
DISPLAY=:1'
printf '%s\n' "$env_lines" | sed 's/^/export /' > /etc/profile.d/cotal-dev.sh
home=/home/$user
install -d -o "$user" -g "$user" "$home/.config" "$home/.config/environment.d" "$home/.config/systemd/user" "$home/.config/tigervnc"
printf '%s\n' "$env_lines" > "$home/.config/environment.d/cotal-dev.conf"
grep -qF cotal-dev.sh "$home/.bashrc" || echo '. /etc/profile.d/cotal-dev.sh' >> "$home/.bashrc"

cat > "$home/.config/systemd/user/cotal-vnc.service" <<'UNIT'
[Unit]
Description=Desktop display :1, VNC on 127.0.0.1:5901 only
[Service]
ExecStart=/usr/bin/Xtigervnc :1 -interface 127.0.0.1 -rfbport 5901 -SecurityTypes VncAuth -PasswordFile %h/.config/tigervnc/passwd -geometry 1440x900 -depth 24 -AlwaysShared
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
cat > "$home/.config/systemd/user/cotal-desktop.service" <<'UNIT'
[Unit]
Description=Xfce desktop on display :1
Requires=cotal-vnc.service
After=cotal-vnc.service
[Service]
ExecStartPre=/bin/sh -c 'for i in $(seq 50); do xdpyinfo -display :1 >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1'
ExecStart=/usr/bin/startxfce4
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
install -d -o "$user" -g "$user" "$home/.config/systemd/user/default.target.wants"
ln -sf ../cotal-vnc.service "$home/.config/systemd/user/default.target.wants/cotal-vnc.service"
ln -sf ../cotal-desktop.service "$home/.config/systemd/user/default.target.wants/cotal-desktop.service"
chown -R "$user:$user" "$home"

echo 'Disposable Cotal test machine made by scenarios/machines/ubuntu-desktop.sh' > /etc/cotal-scenario-machine
