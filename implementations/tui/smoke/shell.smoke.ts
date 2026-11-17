/**
 * Drives the real launcher in tmux on a private server at 209x52, 97x49 and 80x24, against an
 * isolated HOME seeded with healthy, prepared and malformed registrations, and asserts the frame
 * text. The malformed records make every resolution refuse, and the healthy space points at a TCP
 * listener this suite owns, so a connection attempt fails the run. live.smoke.ts covers a reachable
 * space. Captures are kept under the printed directory.
 *
 * Needs Node >= 26.4 and tmux, so it is not part of smoke:ci, which runs Node 22.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui shell smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

const pkg = fileURLToPath(new URL("..", import.meta.url))
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-smoke-"))
const captures = join(work, "captures")
const socket = `cotal-tui-smoke-${process.pid}`
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass++
  else fail++
  console.log(ok ? `  ✓ ${name}` : `  ✗ FAIL: ${name}${detail ? `\n${detail}` : ""}`)
}

let connections = 0
const broker = createServer((socket) => {
  connections++
  socket.destroy()
})
await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve))
const brokerPort = (broker.address() as { port: number }).port
const silent = createServer(() => {})
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
const silentPort = (silent.address() as { port: number }).port

async function seed(home: string) {
  process.env.HOME = home
  process.env.COTAL_HOME = join(home, ".cotal")
  const w = await import("@cotal-ai/workspace")
  const ts = new Date(0).toISOString()
  w.recordMesh({ space: "team-alpha", server: `nats://127.0.0.1:${brokerPort}`, root: "/srv/alpha", mode: "auth", origin: "up", ts })
  w.recordMesh({ space: "research-lab", server: `nats://127.0.0.1:${brokerPort}`, root: "/home/op/research", mode: "user", origin: "manual", ts })
  w.recordPreparedSpace({ space: "staging", root: "/srv/staging", ts })
  w.setCurrent("team-alpha")
  writeFileSync(join(w.meshesDir(), "broken.json"), "{ not json")
  writeFileSync(join(w.meshesDir(), "space.68616c66.json"), JSON.stringify({ space: "half", mode: "auth", ts }))
  writeFileSync(join(w.preparedSpacesDir(), "broken-prep.json"), "{ not json")
}

const capture = () => tmux("capture-pane", "-p", "-t", "t")
async function waitFor(test: (frame: string) => boolean, what: string, timeout = 15000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const frame = capture()
    if (test(frame)) return frame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}:\n${frame}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
const has = (text: string) => (frame: string) => frame.includes(text)
// The middle column's title shares the row with the tree's SPACES header at every width.
const title = (frame: string) => frame.split("\n").find((line) => line.includes("SPACES")) ?? ""
const footer = (frame: string) => frame.trimEnd().split("\n").at(-1)!.trim()
const save = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), capture())
  writeFileSync(join(dir, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
}
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)

function launch(home: string, width: number, height: number, err: string, cwd = pkg) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${cwd} && env -u NODE_COMPILE_CACHE -u NODE_DISABLE_COMPILE_CACHE HOME=${home} COTAL_HOME=${join(home, ".cotal")} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
  tmux("new-session", "-d", "-s", "t", "-x", String(width), "-y", String(height), line)
  tmux("set-option", "-s", "escape-time", "10")
}

// Processes the launcher started: the re-exec'd renderer, and anything that renderer started.
function rendererChildren(): string[] {
  const pane = tmux("list-panes", "-t", "t", "-F", "#{pane_pid}").trim()
  const children = (ppid: string) => {
    try {
      return execFileSync("pgrep", ["-P", ppid], { encoding: "utf8" }).split("\n").filter(Boolean)
    } catch {
      return []
    }
  }
  const launcherPid = children(pane).find((pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("cotal-tui.mjs"))
  const renderer = launcherPid ? children(launcherPid)[0] : undefined
  return renderer ? children(renderer) : ["no renderer process found"]
}

try {
  const home = join(work, "home")
  mkdirSync(home, { mode: 0o700 })
  await seed(home)
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, captures in ${captures}`)

  for (const [width, height] of [[209, 52], [97, 49], [80, 24]] as const) {
    const size = `${width}x${height}`
    const dir = join(captures, size)
    console.log(size)
    launch(home, width, height, join(work, `${size}.err`))

    const first = await waitFor((f) => f.includes("✗ not connected") && f.includes("broken.json"), "the catalog rows and the refused resolution")
    save(dir, "01-catalog")
    for (const row of ["team-alpha", "research-lab", "staging", "prepared", "broken.json", "space.68616c66", "broken-prep.json"]) check(`${size}: the tree lists ${row}`, first.includes(row), first)
    check(`${size}: with no space resolvable the middle says why`, title(first).includes("No space open") && first.includes("does not parse as a"), first)
    if (width >= 97) check(`${size}: the inspector has nothing that needs you before a space is open`, first.includes("NEEDS YOU · 0") && first.includes("Nothing needs you."), first)
    else check(`${size}: with no inspector and nobody waiting, nothing names a waiting count`, !first.includes("NEEDS YOU") && !/needs? you/.test(first), first)
    check(`${size}: the footer says not connected on the left and the help keys on the right`, footer(first).startsWith("✗ not connected") && footer(first).endsWith("? help · ctrl+p commands"), footer(first))
    check(`${size}: with no space open there is no input box`, !first.includes("#general"), first)
    check(`${size}: the renderer started no process`, rendererChildren().length === 0, rendererChildren().join(", "))

    keys("j", "Enter")
    const prepared = await waitFor((f) => title(f).includes("staging"), "enter on the prepared space")
    check(`${size}: a prepared space says it is not started and where to start it`, prepared.includes('"staging" is prepared but not started.') && prepared.includes("cotal up"), prepared)

    keys("j", "j", "Enter")
    const opened = await waitFor((f) => title(f).includes("broken.json"), "enter on the malformed record")
    save(dir, "02-malformed-record")
    check(`${size}: a malformed record says why it cannot be used`, opened.includes("This registration cannot be used.") && opened.includes("does not parse as a"), opened)

    keys("k", "Enter")
    const refused = await waitFor((f) => f.includes("✗ not connected") && title(f).includes("team-alpha") && !f.includes("connecting"), "enter on a space this machine cannot open")
    save(dir, "03-open-refused")
    check(`${size}: opening a space it cannot reach shows the refusal, with no fake data`, !refused.includes("CHANNELS") && !refused.includes("AGENTS"), refused)

    // The inspector reads "Nothing needs you." too, so the toast is known by its border.
    keys("w")
    await waitFor((f) => f.split("\n").some((l) => l.includes("┃") && l.includes("Nothing needs you")), "w with nothing waiting")
    check(`${size}: w says when nothing needs you`, true)

    keys("?")
    const help = await waitFor(has("Open the next waiting agent"), "the help dialog")
    save(dir, "03-help")
    check(`${size}: ? opens the keys dialog`, help.includes("Keys") && help.includes("ctrl+p"), help)
    keys("Escape")
    await waitFor((f) => !f.includes("Open the next waiting agent"), "the help dialog to close")

    keys("C-p")
    await waitFor(has("Reread spaces"), "the palette")
    save(dir, "04-palette")
    tmux("send-keys", "-t", "t", "-l", "reread")
    await waitFor((f) => f.includes("Reread spaces") && !f.includes("Quit"), "the filtered palette")
    keys("Enter")
    const toast = await waitFor(has("Reread 6 registration(s)"), "the reread toast")
    save(dir, "05-reread-toast")
    check(`${size}: the palette runs a command and a toast reports it`, toast.includes(".cotal"), toast)

    keys("q")
    await waitFor(has("EXIT=0"), "q to quit with status 0")
    check(`${size}: q quits with status 0`, true)
  }

  const empty = join(work, "empty-home")
  mkdirSync(empty, { mode: 0o700 })
  launch(empty, 80, 24, join(work, "empty.err"))
  const none = await waitFor(has("cotal space create <name>"), "the empty catalog state")
  save(join(captures, "80x24"), "06-empty-home")
  check("empty home: the shell explains how to get a space", none.includes("cotal space create <name>") && footer(none).startsWith("✗ not connected") && !/needs? you/.test(none), none)
  keys("C-c")
  await waitFor(has("EXIT=0"), "ctrl+c to quit")
  check("empty home: ctrl+c quits with status 0", true)
  process.env.HOME = empty
  process.env.COTAL_HOME = join(empty, ".cotal")
  const { userCotalDir } = await import("@cotal-ai/workspace")
  const cache = join(userCotalDir(), "compile-cache")
  const wrote = readdirSync(empty, { recursive: true, encoding: "utf8" }).filter((f) => !f.startsWith(join(".cotal", "compile-cache") + sep)).sort()
  check("empty home: the shell wrote nothing under HOME but its compile cache", wrote.join() === [".cotal", join(".cotal", "compile-cache")].join(), wrote.join(", "))
  const mode = (statSync(cache).mode & 0o777).toString(8)
  check("empty home: the compile cache is compile-cache under the user's Cotal directory, mode 0700", readdirSync(cache).length > 0 && mode === "700", `${cache} mode ${mode}`)

  // A broker that takes the connection and never answers holds the space opening for 8 seconds,
  // before the box is on screen. The human types for the box all the same.
  const slow = join(work, "slow-home")
  const slowRoot = join(work, "slow-project")
  mkdirSync(slow, { mode: 0o700 })
  mkdirSync(slowRoot)
  process.env.HOME = slow
  process.env.COTAL_HOME = join(slow, ".cotal")
  const w = await import("@cotal-ai/workspace")
  w.recordMesh({ space: "slow", server: `nats://127.0.0.1:${silentPort}`, root: slowRoot, mode: "open", origin: "manual", ts: new Date(0).toISOString() })
  w.setCurrent("slow")
  launch(slow, 80, 24, join(work, "slow.err"), slowRoot)
  const opening = (f: string) => /Finding the space for this folder|Connecting to slow/.test(f)
  await waitFor(opening, "the space to start opening")
  tmux("send-keys", "-t", "t", "-l", "quick note")
  await new Promise((r) => setTimeout(r, 1500))
  const held = capture()
  save(join(captures, "80x24"), "07-typed-while-connecting")
  check("a space still opening: letters typed for the box run no tree key, so the q of quick note does not quit", !held.includes("EXIT=") && opening(held), held)
  keys("C-c")
  await waitFor(has("EXIT=0"), "ctrl+c to quit while the space opens")
  check("a space still opening: ctrl+c still quits with status 0", true)

  check("no run dialed the registered broker address", connections === 0, `${connections} connection(s)`)
} finally {
  try {
    tmux("kill-server")
  } catch {}
  broker.close()
  silent.close()
  rmSync(join(work, "slow-home"), { recursive: true, force: true })
  rmSync(join(work, "home"), { recursive: true, force: true })
  rmSync(join(work, "empty-home"), { recursive: true, force: true })
}

console.log(`TUI SHELL SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
