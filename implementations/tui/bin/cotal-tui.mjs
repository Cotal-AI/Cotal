#!/usr/bin/env node
// OpenTUI loads its renderer through node:ffi, which needs Node >= 26.4 and --experimental-ffi. A
// shebang cannot portably carry the flag, so this entry re-execs Node with it.
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 26 || (major === 26 && minor < 4)) {
  process.stderr.write(`cotal-tui needs Node 26.4.0 or newer, because OpenTUI loads its renderer through node:ffi. This is Node ${process.versions.node}. Install Node 26.4 or newer (\`nvm install 26\`) and rerun.\n`)
  process.exit(1)
}

if (process.execArgv.includes("--experimental-ffi")) {
  // Imported after the version check: registerHooks arrived in Node 22.15, and a static import of a
  // missing export fails before any code here runs.
  const { constants, enableCompileCache, registerHooks } = await import("node:module")
  // Node resolves bare solid-js to its server build (the "node" export condition). OpenTUI and the
  // compiled app use the client build, and @opentui/keymap/solid imports the bare name, so without
  // this two Solid instances run and the keymap provider never mounts its children.
  const solid = { "solid-js": "solid-js/dist/solid.js", "solid-js/store": "solid-js/store/dist/store.js" }
  registerHooks({ resolve: (specifier, context, next) => next(solid[specifier] ?? specifier, context) })
  // Compiling OpenTUI, effect and the app is most of the time to the first frame, and Node's compile
  // cache reuses that work on the next launch. The cache follows the rule Cotal's seats use
  // (bin/smoke/seat-compile-cache.smoke.ts): compile-cache under this user's own Cotal directory, so
  // a reboot keeps it, created 0700 whatever the umask, and a cache that cannot be opened costs one
  // line. NODE_COMPILE_CACHE or NODE_DISABLE_COMPILE_CACHE decides first when set.
  if (!process.env.NODE_COMPILE_CACHE && !process.env.NODE_DISABLE_COMPILE_CACHE) {
    const { mkSecretDir } = await import("@cotal-ai/core/secret-fs")
    // userCotalDir() from @cotal-ai/workspace, repeated because importing workspace here would put
    // its whole load in front of the cache. The shell smoke checks that the two agree.
    const user = process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Cotal") : join(homedir(), ".cotal")
    const dir = join(user, "compile-cache")
    let failure
    try {
      mkSecretDir(dir)
      const result = enableCompileCache(dir)
      if (result.status === constants.compileCacheStatus.FAILED) failure = result.message ?? "no reason reported"
    } catch (e) {
      failure = e.message
    }
    if (failure) process.stderr.write(`cotal-tui: compile cache unavailable, continuing without it: ${failure}\n`)
  }
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
