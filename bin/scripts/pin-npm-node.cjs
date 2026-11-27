// Keep this check runnable on old Node releases that npm still uses to start lifecycle scripts.
const minimum = require("../package.json").engines.node.slice(2).trim();
const installed = process.versions.node;
const [major, minor, patch] = installed.split(".").map(Number);
const [minMajor, minMinor = 0, minPatch = 0] = minimum.split(".").map(Number);

if (major < minMajor || (major === minMajor && (minor < minMinor || (minor === minMinor && patch < minPatch)))) {
  console.error(`cotal-ai requires Node.js ${minimum} or later, but npm is using v${installed}. Install a supported Node.js and retry npm install -g cotal-ai, or on Linux or macOS use the official installer: curl -fsSL https://get.cotal.ai | sh -s -- --no-setup`);
  process.exitCode = 1;
} else if (process.platform === "linux" || process.platform === "darwin") {
  // Leave Windows shims, local installs and script-disabled npm installs alone. The JavaScript
  // entry remains the declared bin and the stable entry for daemons and retained generations.
  const { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } = require("fs");
  const { basename, dirname, isAbsolute, join, relative, resolve } = require("path");
  const refreshing = process.argv[2] === "--refresh";
  const root = realpathSync(refreshing ? process.argv[3] : join(__dirname, ".."));
  const modules = dirname(root);
  if (basename(root) === "cotal-ai" && basename(modules) === "node_modules" && basename(dirname(modules)) === "lib") {
    const link = join(dirname(dirname(modules)), "bin", "cotal");
    let target;
    try { target = resolve(dirname(link), readlinkSync(link)); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "EINVAL") throw error; }
    const launcher = join(root, "dist", "cotal-npm");
    if (target === (refreshing ? launcher : join(root, "dist", "cotal.js"))) {
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      let node = realpathSync(process.execPath);
      let previous;
      if (refreshing) {
        const info = lstatSync(launcher);
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) return;
        previous = readFileSync(launcher, "utf8");
        const pin = previous.match(/^  node=('(?:[^'\n]|'\\'')*')$/m);
        if (!pin) return;
        const recorded = pin[1].slice(1, -1).replaceAll("'\\''", "'");
        // A recorded Node that is still on disk stays pinned, including when this refresh runs
        // under a different Node. A recorded path that is gone cannot start the launcher, so the
        // supported Node running this refresh takes its place.
        if (!isAbsolute(recorded)) return;
        if (existsSync(recorded)) node = recorded;
      }
      // Linux's cwd link names the current inode even after its directory entry is removed.
      // Give it to sh before startup, then restore the caller's PWD without changing directories.
      const split = 'COTAL_NPM_PWD=${PWD} PWD=/proc/self/cwd /bin/sh';
      const supportsCwdLink = process.platform === "linux" && existsSync("/proc/self/cwd") &&
        require("child_process").spawnSync("/usr/bin/env", ["-S", split, "-c", '[ "$PWD" = /proc/self/cwd ] && [ . -ef . ] && exit 0'], {
          timeout: 1000, killSignal: "SIGKILL", stdio: "ignore",
        }).status === 0;
      const shell = supportsCwdLink
        ? `#!/usr/bin/env -S ${split}
if [ "\${COTAL_NPM_PWD#/}" != "$COTAL_NPM_PWD" ] && [ "$COTAL_NPM_PWD" -ef . ]; then
  PWD=$COTAL_NPM_PWD
else
  PWD=$(pwd -P 2>/dev/null) || unset PWD
fi
unset COTAL_NPM_PWD`
        : "#!/bin/sh";
      const contents = `${shell}
node_supported() {
  version=$("$1" --version 2>/dev/null) || return 1
  major=\${version%%.*}
  version=\${version#*.}
  minor=\${version%%.*}
  [ "\${major#v}" -gt ${minMajor} ] 2>/dev/null ||
    { [ "\${major#v}" -eq ${minMajor} ] && [ "$minor" -ge ${minMinor} ]; } 2>/dev/null
}

if path_node=$(command -v node) && {
  [ "$path_node" -ef ${quote(node)} ] || [ ! -x ${quote(node)} ] || node_supported node || ! node_supported ${quote(node)}
}; then
  node=node
elif [ -x ${quote(node)} ]; then
  node=${quote(node)}
  PATH="$PATH":${quote(dirname(node))}
  export PATH
else
  printf '%s\\n' 'cotal: Node.js 22.10 or later is required. Restore Node to PATH and reinstall Cotal with npm.' >&2
  exit 127
fi

# Keep case outside command substitutions for Bash 3.2's parser.
resolve_entry() {
  launcher=$1
  while :; do
    case "$launcher" in /*) ;; *) launcher=./$launcher ;; esac
    # Resolve the directory before interpreting a relative symlink target.
    CDPATH= cd -P "\${launcher%/*}/" 2>/dev/null || return 1
    launcher=$PWD/\${launcher##*/}
    if [ ! -L "$launcher" ]; then
      [ -f "$PWD/cotal.js" ] || return 1
      printf '%s\\n' "$PWD/cotal.js"
      break
    fi
    launcher=$(PATH="\${PATH:+$PATH:}/usr/bin:/bin" readlink "$launcher" 2>/dev/null) || return 1
  done
}

entry=$(resolve_entry "$0") || {
  printf 'cotal: cannot resolve the JavaScript entry from launcher %s\\n' "$0" >&2
  exit 1
}
exec "$node" "$entry" "$@"
`;
      if (refreshing) {
        if (previous !== contents) {
          const temporary = mkdtempSync(join(dirname(launcher), ".cotal-node-"));
          try {
            const pending = join(temporary, "cotal-npm");
            writeFileSync(pending, contents, { flag: "wx", mode: 0o755 });
            if (resolve(dirname(link), readlinkSync(link)) !== target) throw new Error("npm launcher link changed during update");
            renameSync(pending, launcher);
          } finally { rmSync(temporary, { recursive: true, force: true }); }
        }
        return;
      }
      writeFileSync(launcher, contents, { flag: "wx", mode: 0o755 });
      const temporary = mkdtempSync(join(dirname(link), ".cotal-node-"));
      try {
        const pending = join(temporary, "cotal");
        symlinkSync(relative(dirname(link), launcher), pending);
        if (resolve(dirname(link), readlinkSync(link)) === target) renameSync(pending, link);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
