/**
 * Drives the real launcher in tmux at 209x52, 97x49 and 80x24 against an open space on a broker this
 * suite starts, with an isolated HOME that registers only that space. Peers it controls put presence
 * and messages on the space, and the frame text must follow: the roster, a channel message in the
 * feed, a waiting agent in the inspector (the one-line summary at 80x24), and the connection going
 * from live to reconnecting when the broker stops and back to live when it returns. The app's own
 * observer must stay off the roster. Captures are kept under the printed directory.
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
const server = `nats://127.0.0.1:${port}`
let broker: ChildProcess | undefined
let release = () => {}
async function startBroker() {
  let output = ""
  broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: ["ignore", "pipe", "pipe"] })
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
const save = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), capture())
  writeFileSync(join(dir, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
}
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)

function launch(width: number, height: number, err: string) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${project} && env -u COTAL_HOME HOME=${home} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
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
  mkdirSync(home)
  mkdirSync(project)
  await startBroker()
  await setupSpaceStreams({ servers: server, space })
  process.env.HOME = home
  delete process.env.COTAL_HOME
  const w = await import("@cotal-ai/workspace")
  w.recordMesh({ space, server, root: project, mode: "open", origin: "manual", ts: new Date().toISOString() })
  w.setCurrent(space)

  const planner = peer("planner", "planner", "agent", { model: "claude-opus-5-5", connector: "claude-code" })
  const coder = peer("coder-2", "coder", "agent", { connector: "opencode" })
  const reviewer = peer("reviewer", "reviewer", "agent")
  const linear = peer("linear", "tracker", "endpoint")
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

    const first = await waitFor((f) => f.includes(`● live · ${space}`) && f.includes("coder-2") && f.includes("linear"), "the live roster")
    save(dir, "01-live")
    for (const name of ["planner", "coder-2", "reviewer", "linear"]) check(`${size}: the tree lists ${name}`, first.includes(name), first)
    check(`${size}: the app's own observer stays off the roster`, !/\btui\b/.test(first), first)
    if (width >= 97) {
      check(`${size}: the inspector lists the waiting agent first`, first.includes("NEEDS YOU · 1") && first.includes("1 ◐ coder-2") && first.includes("needs approval: run"), first)
    } else {
      check(`${size}: the inspector shrinks to a one-line summary`, !first.includes("NEEDS YOU") && first.includes("1 needs you · w opens the next"), first)
    }

    const text = `Sprint 14 plan is up (${++n})`
    await settled(() => planner.multicast(text, { channel: "general" }))
    const fed = await waitFor(has(text), "the channel message in the feed")
    save(dir, "02-feed")
    check(`${size}: a channel message appears in the all-traffic feed with its channel`, fed.includes("planner #general"), fed)

    for (let i = 1; i <= 30; i++) await planner.multicast(`burst ${n}-${String(i).padStart(2, "0")}`, { channel: "general" })
    const burst = await waitFor(has(`burst ${n}-30`), "the newest message of a burst")
    check(`${size}: the feed keeps the newest message in view`, !burst.includes(`burst ${n}-01`), burst)

    keys("j", "j", "Enter")
    const general = await waitFor((f) => (f.split("\n").find((l) => l.includes("SPACES")) ?? "").includes("#general"), "enter on # general to open the channel")
    save(dir, "03-channel")
    const row = general.split("\n").find((l) => l.includes("# general")) ?? ""
    check(`${size}: opening a channel shows its feed and clears its unread badge`, general.includes(`burst ${n}-30`) && !/\+\d/.test(row), general)

    await settled(() => reviewer.setStatus("waiting", "which branch should I review first?"))
    const two = await waitFor(has(width >= 97 ? "NEEDS YOU · 2" : "2 need you"), "a second waiting agent")
    save(dir, "04-second-waiting")
    check(`${size}: a newly waiting agent shows without a restart`, width >= 97 ? two.includes("2 ◐ reviewer") : two.includes("2 need you · w opens the next"), two)

    keys("w")
    const opened = await waitFor(has("◐ coder-2 is waiting"), "w to open the first waiting agent")
    save(dir, "05-w-waiting-agent")
    check(`${size}: w opens the waiting agent with its question`, opened.includes("“needs approval: run migration 0042 on"), opened)
    if (width < 97) check(`${size}: the agent overview moves into the conversation`, opened.includes("harness  opencode") && opened.includes("model    not reported"), opened)
    keys("w")
    await waitFor(has("◐ reviewer is waiting"), "w again to open the second waiting agent")
    check(`${size}: w again opens the next waiting agent`, true)

    if (width >= 97) {
      for (let i = 0; i < 40 && !capture().includes("AGENT"); i++) {
        keys("j")
        await new Promise((r) => setTimeout(r, 30))
      }
      const agent = await waitFor((f) => f.includes("AGENT") && f.includes("uptime"), "an agent overview in the inspector")
      save(dir, "06-agent-overview")
      check(`${size}: selecting an agent adds its overview`, /status\s+[●◐○⨯]/.test(agent) && agent.includes("model"), agent)
      for (let i = 0; i < 40 && !/status\s+● working/.test(capture()); i++) {
        keys("k")
        await new Promise((r) => setTimeout(r, 30))
      }
      const working = await waitFor((f) => /status\s+● working/.test(f), "a working agent's overview")
      const lines = working.split("\n").map((l) => l.trimEnd())
      const at = lines.findIndex((l) => /status\s+● working/.test(l))
      const shown = lines[at].endsWith("● working · progress unknown") || (lines[at].endsWith("● working ·") && /\s{2}progress unknown$/.test(lines[at + 1] ?? ""))
      check(`${size}: a working agent's overview names its progress as unknown`, shown, working)
    }

    await stopBroker()
    const down = await waitFor(has(`◐ reconnecting · ${space}`), "the reconnecting state")
    save(dir, "07-reconnecting")
    check(`${size}: the connection shows reconnecting when the broker stops`, !down.includes("● live"), down)
    await startBroker()
    // The presence bucket is memory-backed and does not survive a restart; `cotal up` provisions it again.
    await setupSpaceStreams({ servers: server, space })
    await waitFor(has(`● live · ${space}`), "live again once the broker is back", 30000)
    save(dir, "08-live-again")
    check(`${size}: the connection returns to live when the broker returns`, true)

    keys("q")
    await waitFor(has("EXIT=0"), "q to quit with status 0")
    check(`${size}: q quits with status 0`, true)
  }
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
