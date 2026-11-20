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
  const { mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } = require("fs");
  const { basename, dirname, join, relative, resolve } = require("path");
  const root = realpathSync(join(__dirname, ".."));
  const modules = dirname(root);
  if (basename(root) === "cotal-ai" && basename(modules) === "node_modules" && basename(dirname(modules)) === "lib") {
    const link = join(dirname(dirname(modules)), "bin", "cotal");
    let target;
    try { target = resolve(dirname(link), readlinkSync(link)); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "EINVAL") throw error; }
    if (target === join(root, "dist", "cotal.js")) {
      const launcher = join(root, "dist", "cotal-npm");
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const node = realpathSync(process.execPath);
      writeFileSync(launcher, `#!/bin/sh
if command -v node >/dev/null 2>&1; then
  node=node
elif [ -x ${quote(node)} ]; then
  node=${quote(node)}
  PATH="$PATH":${quote(dirname(node))}
  export PATH
else
  printf '%s\\n' 'cotal: Node.js 22.10 or later is required. Restore Node to PATH and reinstall Cotal with npm.' >&2
  exit 127
fi

entry=$(
  launcher=$0
  while :; do
    case "$launcher" in /*) ;; *) launcher=./$launcher ;; esac
    # Resolve the directory before interpreting a relative symlink target.
    CDPATH= cd -P "\${launcher%/*}/" 2>/dev/null || exit 1
    launcher=$PWD/\${launcher##*/}
    if [ ! -L "$launcher" ]; then
      [ -f "$PWD/cotal.js" ] || exit 1
      printf '%s\\n' "$PWD/cotal.js"
      break
    fi
    launcher=$(PATH="\${PATH:+$PATH:}/usr/bin:/bin" readlink "$launcher" 2>/dev/null) || exit 1
  done
) || {
  printf 'cotal: cannot resolve the JavaScript entry from launcher %s\\n' "$0" >&2
  exit 1
}
exec "$node" "$entry" "$@"
`, { flag: "wx", mode: 0o755 });
      const temporary = mkdtempSync(join(dirname(link), ".cotal-node-"));
      try {
        const pending = join(temporary, "cotal");
        symlinkSync(relative(dirname(link), launcher), pending);
        if (resolve(dirname(link), readlinkSync(link)) === target) renameSync(pending, link);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
