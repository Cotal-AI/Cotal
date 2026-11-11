/**
 * Drives the real launcher in tmux at 209x52, 97x49 and 80x24 against an open space on a broker this
 * suite starts, with an isolated HOME that registers only that space. Peers it controls put presence
 * and messages on the space, and the frame text must follow: the roster, the space opening on
 * #general with the input box under it, channel messages in the feed, a waiting agent in the
 * inspector (the waiting count at 80x24), and the footer saying reconnecting while the broker is
 * away and nothing once it returns. Letter keys type into the box and work only after `tab` moves
 * the keys to the tree. The app's own observer must stay off the roster. Switching spaces twice in
 * a row must end live on the space picked last, with one app connection on the broker. Captures are
 * kept under the printed directory.
 *
 * Needs Node >= 26.4, tmux and nats-server, so it is not part of smoke:ci, which runs Node 22.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CotalEndpoint, isReachable, setupSpaceStreams } from "@cotal-ai/core"
import { layoutFor } from "../src/layout.js"
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui live smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

const pkg = fileURLToPath(new URL("..", import.meta.url))
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-live-"))
const captures = join(work, "captures")
const home = join(work, "home")
const project = join(work, "project")
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))
const socket = `cotal-tui-live-${process.pid}`
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
const space = "team-alpha"

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass++
  else fail++
  console.log(ok ? `  ✓ ${name}` : `  ✗ FAIL: ${name}${detail ? `\n${detail}` : ""}`)
}

const port = await freePort()
const monitor = await freePort()
const server = `nats://127.0.0.1:${port}`
let broker: ChildProcess | undefined
let release = () => {}
async function startBroker() {
  let output = ""
  broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-m", String(monitor), "-sd", store], { stdio: ["ignore", "pipe", "pipe"] })
  broker.stdout!.on("data", (d) => (output += d))
  broker.stderr!.on("data", (d) => (output += d))
  release = teardownOnSignal(broker, store)
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100, output: () => output })
}
// SIGTERM first: the broker flushes its store on a clean stop, and the restart needs the streams.
async function stopBroker() {
  if (broker) await killAndAwaitExit(broker)
  release()
  broker = undefined
}

const capture = () => tmux("capture-pane", "-p", "-t", "t")
async function waitFor(test: (frame: string) => boolean, what: string, timeout = 20000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const frame = capture()
    if (test(frame)) return frame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}:\n${frame}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const has = (text: string) => (frame: string) => frame.includes(text)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// The middle column's title shares the row with the tree's SPACES header. A conversation's title is
// its name, two spaces and the space; the tree's count column sits at least three spaces before it.
const titleOf = (frame: string) => frame.split("\n").find((l) => l.includes("SPACES")) ?? ""
const footer = (frame: string) => frame.trimEnd().split("\n").at(-1)!.trim()
const showing = (at: string) => (frame: string) => new RegExp(`\\S  ${at}$`).test(titleOf(frame).replace(/\s+NEEDS YOU.*$/, "").trimEnd())
// The line under the box names where a message goes; it is the last middle-column line before the footer.
function boxLine(frame: string, width: number): string {
  const l = layoutFor(width)
  const end = l.kind === "three" ? width - l.inspector : width
  const lines = frame.trimEnd().split("\n").slice(0, -1).map((line) => [...line].slice(l.tree, end).join("").trim())
  return lines.filter(Boolean).at(-1) ?? ""
}
/** The colors a name is drawn in, wherever it starts a colored run, as in a tree row or a waiting entry. */
const colorsOf = (name: string) => [...tmux("capture-pane", "-p", "-e", "-t", "t").matchAll(new RegExp(`\\x1b\\[38;2;([\\d;]+)m ?${name}\\b`, "g"))].map((m) => m[1])
const live = (at: string) => (frame: string) => showing(at)(frame) && footer(frame) === "? help · ctrl+p commands"
const save = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), capture())
  writeFileSync(join(dir, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
}
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)
const times = (n: number, key: string) => Array<string>(n).fill(key)
// The keys go to the tree from either side: esc returns the tree to the box and does nothing in the
// box, then tab moves them to the tree. A key sent within tmux's escape-time after Escape would read
// as alt+<key>.
async function toTree() {
  keys("Escape")
  await sleep(150)
  keys("Tab")
  await sleep(150)
}
const SPACE_ROWS = 1
/** Opens the tree row whose conversation is titled `name`. Each try counts down from the top past the
 *  space rows, where enter would switch spaces, and enter returns the keys to the box. */
async function openRow(name: string): Promise<string> {
  for (let i = 0; i < 24; i++) {
    await toTree()
    keys(...times(40, "k"), ...times(SPACE_ROWS + i, "j"))
    await sleep(80)
    const before = titleOf(capture())
    keys("Enter")
    const frame = await waitFor((f) => titleOf(f) !== before, "a row to open", 1500).catch(() => capture())
    if (titleOf(frame).includes(`${name}  ${space}`)) return frame
  }
  throw new Error(`could not open ${name}:\n${capture()}`)
}
// An open-mode endpoint names its broker connection after its card, and the app's observer is "tui".
async function appConnections(): Promise<number> {
  const connz = (await (await fetch(`http://127.0.0.1:${monitor}/connz?limit=1024`)).json()) as { connections?: { name?: string }[] }
  return (connz.connections ?? []).filter((c) => c.name === "cotal:tui").length
}

function launch(width: number, height: number, err: string) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${project} && env HOME=${home} COTAL_HOME=${join(home, ".cotal")} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
  tmux("new-session", "-d", "-s", "t", "-x", String(width), "-y", String(height), line)
  tmux("set-option", "-s", "escape-time", "10")
}

// After a broker restart a peer's first presence write can time out while it re-binds.
async function settled(write: () => Promise<unknown>) {
  for (let i = 0; ; i++) {
    try {
      return await write()
    } catch (e) {
      if (i === 20) throw e
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

const peers: CotalEndpoint[] = []
function peer(name: string, role: string, kind: "agent" | "endpoint", meta?: Record<string, string>) {
  const ep = new CotalEndpoint({ space, servers: server, card: { name, kind, role, ...(meta ? { meta } : {}) }, channels: ["general"], heartbeatMs: 500, ttlMs: 3000 })
  ep.on("error", () => {})
  peers.push(ep)
  return ep
}

try {
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(project)
  await startBroker()
  await setupSpaceStreams({ servers: server, space })
  process.env.HOME = home
  process.env.COTAL_HOME = join(home, ".cotal")
  const w = await import("@cotal-ai/workspace")
  w.recordMesh({ space, server, root: project, mode: "open", origin: "manual", ts: new Date().toISOString() })
  w.setCurrent(space)

  const planner = peer("planner", "planner", "agent", { model: "claude-opus-5-5", connector: "claude-code" })
  const coder = peer("coder-2", "coder", "agent", { connector: "opencode" })
  const reviewer = peer("reviewer", "reviewer", "agent")
  peer("linear", "tracker", "endpoint")
  for (const ep of peers) await ep.start()
  await planner.setStatus("working", "planning sprint 14")
  await coder.setStatus("waiting", "needs approval: run migration 0042 on staging?")
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, broker ${server}, captures in ${captures}`)

  let n = 0
  for (const [width, height] of [[209, 52], [97, 49], [80, 24]] as const) {
    const size = `${width}x${height}`
    const dir = join(captures, size)
    console.log(size)
    await settled(() => reviewer.setStatus("idle"))
    launch(width, height, join(work, `${size}.err`))

    const first = await waitFor((f) => live(space)(f) && f.includes("coder-2") && f.includes("linear"), "the live roster")
    save(dir, "01-live")
    for (const name of ["planner", "coder-2", "reviewer", "linear"]) check(`${size}: the tree lists ${name}`, first.includes(name), first)
    check(`${size}: the app's own observer stays off the roster`, !/\btui\b/.test(first), first)
    check(`${size}: the space opens on #general with the input box naming it, and a quiet footer`, titleOf(first).includes(`#general  ${space}`) && boxLine(first, width) === "#general" && footer(first) === "? help · ctrl+p commands", first)
    if (width >= 97) {
      check(`${size}: the inspector lists the waiting agent first`, first.includes("NEEDS YOU · 1") && first.includes("1 ◐ coder-2") && first.includes("needs approval: run"), first)
      const tints = colorsOf("coder-2")
      check(`${size}: the waiting entry draws coder-2 in the same color as its tree row`, tints.length === 2 && tints[0] === tints[1], tints.join(" | "))
    } else {
      check(`${size}: with no inspector the conversation counts who waits`, !first.includes("NEEDS YOU") && first.includes("1 needs you"), first)
    }

    keys("-l", "qw?")
    const typed = await waitFor(has("qw?"), "letters typed into the box")
    await sleep(500)
    const still = capture()
    check(`${size}: in the box, q, w and ? are text: no quit, no waiting agent, no help`, typed.includes("qw?") && !still.includes("EXIT=") && titleOf(still).includes(`#general  ${space}`) && !still.includes("Open the next waiting agent"), still)
    keys("C-u")
    await waitFor((f) => !f.includes("qw?"), "ctrl+u to clear the draft")

    const text = `Sprint 14 plan is up (${++n})`
    await settled(() => planner.multicast(text, { channel: "general" }))
    const fed = await waitFor(has(text), "the channel message in the feed")
    save(dir, "02-feed")
    check(`${size}: a channel message appears in the open #general feed`, fed.includes("planner"), fed)

    await settled(() => planner.multicast(`tab\tseparated (${n})`, { channel: "general" }))
    const tabbed = await waitFor(has(`separated (${n})`), "a message with a tab")
    check(`${size}: a tab in message text shows as space, not as an escape`, !tabbed.includes("\\u0009") && /tab\s+separated/.test(tabbed), tabbed)

    for (let i = 1; i <= 30; i++) await planner.multicast(`burst ${n}-${String(i).padStart(2, "0")}`, { channel: "general" })
    const burst = await waitFor(has(`burst ${n}-30`), "the newest message of a burst")
    check(`${size}: the feed keeps the newest message in view`, !burst.includes(`burst ${n}-01`), burst)

    const traffic = await openRow("all traffic")
    for (let i = 1; i <= 3; i++) await planner.multicast(`unread ${n}-${i}`, { channel: "general" })
    const unread = await waitFor((f) => f.includes(`unread ${n}-3`) && /# general\s+\+3/.test(f), "all traffic with an unread badge on #general")
    save(dir, "03-all-traffic")
    check(`${size}: all traffic shows each message with its channel, and #general counts what arrived unseen`, traffic.includes("planner #general") && /# general\s+\+3/.test(unread), unread)

    const general = await openRow("#general")
    const seen = await waitFor((f) => f.includes(`unread ${n}-3`) && !/\+\d/.test(f.split("\n").find((l) => l.includes("# general")) ?? ""), "#general with its badge cleared").catch(() => capture())
    save(dir, "04-channel")
    check(`${size}: opening a channel shows its feed and clears its unread badge`, general.includes(`#general  ${space}`) && seen.includes(`unread ${n}-3`) && !/\+\d/.test(seen.split("\n").find((l) => l.includes("# general")) ?? "+"), seen)

    await settled(() => reviewer.setStatus("waiting", "which branch should I review first?"))
    const two = await waitFor(has(width >= 97 ? "NEEDS YOU · 2" : "2 need you"), "a second waiting agent")
    save(dir, "05-second-waiting")
    check(`${size}: a newly waiting agent shows without a restart`, width >= 97 ? two.includes("2 ◐ reviewer") : two.includes("2 need you") && !two.includes("needs you"), two)

    keys("w")
    await sleep(300)
    check(`${size}: w in the box does not open a waiting agent`, !capture().includes("◐ coder-2 is waiting"), capture())
    keys("C-u")
    await toTree()
    keys("w")
    const opened = await waitFor(has("◐ coder-2 is waiting"), "w in the tree to open the first waiting agent")
    save(dir, "06-w-waiting-agent")
    check(`${size}: w in the tree opens the waiting agent with its question`, opened.includes("“needs approval: run migration 0042 on"), opened)
    if (width < 97) check(`${size}: with the tree focused, the agent overview moves into the conversation`, opened.includes("harness  opencode") && opened.includes("model    not reported"), opened)
    keys("w")
    await waitFor(has("◐ reviewer is waiting"), "w again to open the second waiting agent")
    check(`${size}: w again opens the next waiting agent`, true)

    if (width >= 97) {
      for (let i = 0; i < 40 && !capture().includes("AGENT"); i++) {
        keys("j")
        await sleep(30)
      }
      const agent = await waitFor((f) => f.includes("AGENT") && f.includes("uptime"), "an agent overview in the inspector")
      save(dir, "07-agent-overview")
      check(`${size}: selecting an agent adds its overview`, /status\s+[●◐○⨯]/.test(agent) && agent.includes("model"), agent)
      for (let i = 0; i < 40 && !/status\s+● working/.test(capture()); i++) {
        keys("k")
        await sleep(30)
      }
      const working = await waitFor((f) => /status\s+● working/.test(f), "a working agent's overview")
      const lines = working.split("\n").map((l) => l.trimEnd())
      const at = lines.findIndex((l) => /status\s+● working/.test(l))
      const shown = lines[at].endsWith("● working · progress unknown") || (lines[at].endsWith("● working ·") && /\s{2}progress unknown$/.test(lines[at + 1] ?? ""))
      check(`${size}: a working agent's overview names its progress as unknown`, shown, working)
    }

    await stopBroker()
    const down = await waitFor((f) => footer(f).startsWith("◐ reconnecting"), "the reconnecting footer")
    save(dir, "08-reconnecting")
    check(`${size}: the footer says reconnecting while the broker is away, over the conversation it still shows`, /^◐ reconnecting\s+\? help · ctrl\+p commands$/.test(footer(down)) && titleOf(down).includes(`  ${space}`), down)
    await startBroker()
    // The presence bucket is memory-backed and does not survive a restart; `cotal up` provisions it again.
    await setupSpaceStreams({ servers: server, space })
    await waitFor(live(space), "a quiet footer again once the broker is back", 30000)
    save(dir, "09-live-again")
    check(`${size}: the footer goes quiet again when the broker returns`, true)

    await toTree()
    keys("q")
    await waitFor(has("EXIT=0"), "q to quit with status 0")
    check(`${size}: q quits with status 0`, true)
  }

  console.log("fast space switch")
  const other = "team-beta"
  mkdirSync(join(work, "project-beta"))
  await setupSpaceStreams({ servers: server, space: other })
  w.recordMesh({ space: other, server, root: join(work, "project-beta"), mode: "open", origin: "manual", ts: new Date().toISOString() })
  launch(209, 52, join(work, "switch.err"))
  await waitFor(live(space), "the launch folder's space live")
  await toTree()
  // The enter that opens a space hands the keys to the box, as a space still opening does, so tab
  // takes them back to the tree for the quick switch home.
  keys(...times(40, "k"), "j", "Enter", "Tab", ...times(40, "k"), "Enter")
  await waitFor((f) => live(space)(f) || live(other)(f), "a space live after two quick switches")
  // A switch that finishes late lands after the first live frame, so give it time to.
  await new Promise((r) => setTimeout(r, 3000))
  const switched = capture()
  save(join(captures, "switch"), "01-after-two-switches")
  check("switching away and back quickly ends live on the space picked last", live(space)(switched) && switched.includes(`▸ ${space}`), switched)
  const open = await appConnections()
  check("switching quickly leaves one app connection on the broker", open === 1, `app connections: ${open}`)
  await toTree()
  keys("q")
  await waitFor(has("EXIT=0"), "q to quit after the switches")
} finally {
  try {
    tmux("kill-server")
  } catch {}
  await Promise.all(peers.map((ep) => ep.stop().catch(() => {})))
  await stopBroker()
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
}

console.log(`TUI LIVE SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
