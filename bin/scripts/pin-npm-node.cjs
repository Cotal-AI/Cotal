// Keep this check runnable on old Node releases that npm still uses to start lifecycle scripts.
const minimum = require("../package.json").engines.node.slice(2).trim();
const installed = process.versions.node;
function meetsNodeFloor(version, floor) {
  const [major, minor, patch] = version.split(".").map(Number);
  const [minMajor, minMinor = 0, minPatch = 0] = floor.split(".").map(Number);
  return major > minMajor || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
}

if (!meetsNodeFloor(installed, minimum)) {
  console.error(`cotal-ai requires Node.js ${minimum} or later, but npm is using v${installed}. Install a supported Node.js and retry npm install -g cotal-ai, or on Linux or macOS use the official installer: curl -fsSL https://get.cotal.ai | sh -s -- --no-setup`);
  process.exitCode = 1;
} else if (process.platform === "linux" || process.platform === "darwin") {
  // Leave Windows shims, local installs and script-disabled npm installs alone. The JavaScript
  // entry remains the declared bin and the stable entry for daemons and retained generations.
  const { mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } = require("fs");
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
      const probe = `(${meetsNodeFloor})(process.versions.node, ${JSON.stringify(minimum)}) ? "supported" : "old"`;
      // A regular file travels with the package, including in a retained execution generation.
      // An external symlink would make that generation fail inventory validation.
      const nodeBin = join(root, "dist", "npm-node-bin");
      mkdirSync(nodeBin);
      writeFileSync(join(nodeBin, "node"), `#!/bin/sh\nexec ${quote(node)} "$@"\n`, { flag: "wx", mode: 0o755 });
      writeFileSync(launcher, `#!/bin/sh
node_support() {
  # Do not run the user's preloads during the version probe. The CLI still inherits them.
  NODE_OPTIONS= command "$1" -p ${quote(probe)} </dev/null 2>/dev/null
}

node=node
recorded_support=
path_support=$(node_support "$node") || path_support=
if [ "$path_support" != supported ]; then
  recorded=${quote(node)}
  recorded_support=$(node_support "$recorded") || recorded_support=
  if [ "$recorded_support" = supported ]; then
    node=$recorded
  elif [ "$path_support" != old ]; then
    if [ "$recorded_support" != old ]; then
      printf '%s\\n' ${quote(`cotal: Node.js ${minimum} or later is required. Restore a supported Node to PATH and reinstall Cotal with npm.`)} >&2
      exit 127
    fi
    node=$recorded
  fi
  # A runnable old Node still enters the bootstrap to report its version and clean up a spawn handoff.
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
if [ "$recorded_support" = supported ]; then
  # Give children the chosen Node without shadowing their git, npm, or other tools.
  # Keep the runtime directory last so tools absent from PATH remain available there.
  PATH="\${entry%/*}/npm-node-bin\${PATH:+:$PATH}":${quote(dirname(node))}
  export PATH
fi
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
