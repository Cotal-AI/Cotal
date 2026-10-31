#!/usr/bin/env node
// OpenTUI loads its renderer through node:ffi, which needs Node >= 26.4 and --experimental-ffi. A
// shebang cannot portably carry the flag, so this entry re-execs Node with it.
import { spawnSync } from "node:child_process"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 26 || (major === 26 && minor < 4)) {
  process.stderr.write(`cotal-tui needs Node 26.4.0 or newer, because OpenTUI loads its renderer through node:ffi. This is Node ${process.versions.node}.\n`)
  process.exit(1)
}

if (process.execArgv.includes("--experimental-ffi")) {
  // Node resolves bare solid-js to its server build (the "node" export condition). OpenTUI and the
  // compiled app use the client build, and @opentui/keymap/solid imports the bare name, so without
  // this two Solid instances run and the keymap provider never mounts its children.
  const solid = { "solid-js": "solid-js/dist/solid.js", "solid-js/store": "solid-js/store/dist/store.js" }
  registerHooks({ resolve: (specifier, context, next) => next(solid[specifier] ?? specifier, context) })
  await import("../dist/src/main.js")
} else {
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, "--experimental-ffi", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  )
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}
