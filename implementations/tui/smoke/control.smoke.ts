/**
 * Drives the real launcher in tmux against an open space on a broker this suite starts, with a real
 * Manager (pty runtime) hosting two seats that join presence, one unmanaged agent, and a second open
 * space with no manager. The manager is loaded from the manager's built package: this package does
 * not depend on it. Captures are kept under the printed directory.
 *
 * Needs Node >= 26.4, tmux and nats-server, and a built manager, so it is not part of smoke:ci.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { CotalEndpoint, isReachable, registry, setupSpaceStreams, type Connector, type LaunchOpts, type LaunchSpec, type Presence } from "@cotal-ai/core"
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui control smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

const pkg = fileURLToPath(new URL("..", import.meta.url))
const repo = join(pkg, "..", "..")
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-control-"))
const captures = join(work, "captures")
const home = join(work, "home")
const project = join(work, "project")
const bareProject = join(work, "project-bare")
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))
const socket = `cotal-tui-control-${process.pid}`
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: "pipe" })
const space = "ops"
const bare = "no-manager"

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass++
  else fail++
  console.log(ok ? `  ✓ ${name}` : `  ✗ FAIL: ${name}${detail ? `\n${detail}` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface ManagerLike {
  start(): Promise<void>
  stop(options?: { withAgents?: boolean }): Promise<void>
  startAgent(o: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>
}

// A seat that joins presence under the id and lifecycle the manager gave it, and idles until killed.
const coreDist = join(repo, "packages", "core", "dist", "index.js")
const SEAT = [
  "import(require('node:url').pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,",
  "watchPresence:false,heartbeatMs:500,ttlMs:3000,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent',role:'worker'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
].join("")
const seat: Connector = {
  kind: "connector",
  name: "seat",
  requires: ["node"],
  buildLaunch: (o: LaunchOpts): LaunchSpec => ({
    command: "node",
    args: ["-e", SEAT],
    env: { PATH: process.env.PATH ?? "", CORE_DIST: coreDist, COTAL_SPACE: o.space, COTAL_SERVERS: o.servers ?? "", COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name },
  }),
}
registry.register(seat)

const port = await freePort()
const server = `nats://127.0.0.1:${port}`
let broker: ChildProcess | undefined
let release = () => {}

const capture = () => tmux("capture-pane", "-p", "-t", "t")
async function waitFor(test: (frame: string) => boolean, what: string, timeout = 20000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const frame = capture()
    if (test(frame)) return frame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}:\n${frame}`)
    await sleep(50)
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

const peers: CotalEndpoint[] = []
function peer(at: string, name: string) {
  const ep = new CotalEndpoint({ space: at, servers: server, card: { name, kind: "agent", role: "planner", meta: { model: "claude-opus-5-5", connector: "claude-code" } }, channels: ["general"], heartbeatMs: 500, ttlMs: 3000 })
  ep.on("error", () => {})
  peers.push(ep)
  return ep
}

let manager: ManagerLike | undefined
let watcher: CotalEndpoint | undefined
const live = (name: string): Presence | undefined => watcher?.getRoster().find((p) => p.card.name === name && p.status !== "offline")
async function until(test: () => boolean, ms: number) {
  const start = Date.now()
  while (!test() && Date.now() - start < ms) await sleep(100)
  return test()
}

try {
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(join(project, ".cotal", "agents"), { recursive: true })
  for (const name of ["w1", "w2"]) writeFileSync(join(project, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\nagent: seat\n---\n`)
  mkdirSync(bareProject)
  let output = ""
  broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: ["ignore", "pipe", "pipe"] })
  broker.stdout!.on("data", (d) => (output += d))
  broker.stderr!.on("data", (d) => (output += d))
  release = teardownOnSignal(broker, store)
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100, output: () => output })
  await setupSpaceStreams({ servers: server, space })
  await setupSpaceStreams({ servers: server, space: bare })
  process.env.HOME = home
  delete process.env.COTAL_HOME
  const w = await import("@cotal-ai/workspace")
  const ts = new Date().toISOString()
  w.recordMesh({ space, server, root: project, mode: "open", origin: "manual", ts })
  w.recordMesh({ space: bare, server, root: bareProject, mode: "open", origin: "manual", ts })
  w.setCurrent(space)

  watcher = new CotalEndpoint({ space, servers: server, card: { name: "watcher", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true })
  watcher.on("error", () => {})
  await watcher.start()
  await peer(space, "planner").start()
  await peer(bare, "solo").start()

  const { Manager } = (await import(pathToFileURL(join(repo, "implementations", "manager", "dist", "index.js")).href)) as {
    Manager: new (o: { space: string; servers: string; runtime: string; workspaceRoot: string }) => ManagerLike
  }
  manager = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: project })
  await manager.start()
  const s1 = await manager.startAgent({ name: "w1", agent: "seat", cwd: project, events: false })
  const s2 = await manager.startAgent({ name: "w2", agent: "seat", cwd: project, events: false })
  const joined = await until(() => !!live("w1") && !!live("w2"), 15000)
  check("fixture: the manager hosts w1 and w2, and both joined presence", s1.ok && s2.ok && joined, JSON.stringify({ s1, s2, roster: watcher.getRoster().map((p) => p.card.name) }))
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, broker ${server}, captures in ${captures}`)

  launch(209, 52, join(work, "fixture.err"))
  const first = await waitFor((f) => f.includes(`● live · ${space}`) && f.includes("w1") && f.includes("w2") && f.includes("planner"), "the live roster with both seats")
  save(join(captures, "fixture"), "01-live")
  check("fixture: the app lists both seats and the unmanaged agent", true, first)
  keys("q")
  await waitFor(has("EXIT=0"), "q to quit with status 0")
} finally {
  try {
    tmux("kill-server")
  } catch {}
  await manager?.stop({ withAgents: true }).catch(() => {})
  await Promise.all([...peers, ...(watcher ? [watcher] : [])].map((ep) => ep.stop().catch(() => {})))
  if (broker) await killAndAwaitExit(broker)
  release()
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
}

console.log(`TUI CONTROL SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
