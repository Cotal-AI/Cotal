import { mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Leave Windows shims, local installs and script-disabled npm installs alone. The JavaScript
// entry remains the declared bin and the stable entry for daemons and retained generations.
if (process.platform === "linux" || process.platform === "darwin") {
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
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
  exec node ${quote(target)} "$@"
fi
if [ -x ${quote(node)} ]; then
  PATH="$PATH":${quote(dirname(node))}
  export PATH
  exec ${quote(node)} ${quote(target)} "$@"
fi
printf '%s\\n' 'cotal: Node.js 22.10 or later is required. Restore Node to PATH and reinstall Cotal with npm.' >&2
exit 127
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
