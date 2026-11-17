/**
 * Drives the real launcher in tmux against an open space on a broker this suite starts, with a real
 * Manager (pty runtime) hosting two seats that join presence, one unmanaged agent, and a second open
 * space with no manager. The stop scenario adds an unmanaged agent under a managed seat's name, a
 * second manager holding a seat under the same name as one of the first's, and a broker restart that
 * turns auth on. The manager is loaded from the manager's built package: this package does not
 * depend on it. Captures are kept under the printed directory.
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
import { control, controlPs, type ControlClient } from "@cotal-ai/workspace/control"
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
const project2 = join(work, "project-2")
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
const monitor = await freePort()
const server = `nats://127.0.0.1:${port}`
let broker: ChildProcess | undefined
let release = () => {}
async function startBroker(...auth: string[]) {
  let output = ""
  broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-m", String(monitor), "-sd", store, ...auth], { stdio: ["ignore", "pipe", "pipe"] })
  broker.stdout!.on("data", (d) => (output += d))
  broker.stderr!.on("data", (d) => (output += d))
  release = teardownOnSignal(broker, store)
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100, output: () => output })
}

// Every manager read dials the broker, so a read the app makes shows up in this count.
const dials = async () => ((await (await fetch(`http://127.0.0.1:${monitor}/varz`)).json()) as { total_connections: number }).total_connections
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
const footer = (frame: string) => frame.trimEnd().split("\n").at(-1)!.trim()
// A space is live once its conversation heads the middle column and the footer has nothing to report.
const liveOn = (at: string) => (frame: string) => (frame.split("\n").find((l) => l.includes("SPACES")) ?? "").includes(`#general  ${at}`) && footer(frame) === "? help · ctrl+p commands"

function launch(width: number, height: number, err: string) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${project} && env HOME=${home} COTAL_HOME=${join(home, ".cotal")} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
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
let manager2: ManagerLike | undefined
let watcher: CotalEndpoint | undefined
const live = (name: string): Presence | undefined => watcher?.getRoster().find((p) => p.card.name === name && p.status !== "offline")
const seatLive = (id: string) => !!watcher?.getRoster().some((p) => p.card.id === id && p.status !== "offline")
async function until(test: () => boolean, ms: number) {
  const start = Date.now()
  while (!test() && Date.now() - start < ms) await sleep(100)
  return test()
}

try {
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(join(project, ".cotal", "agents"), { recursive: true })
  mkdirSync(join(project2, ".cotal", "agents"), { recursive: true })
  for (const name of ["w1", "w2", "w3"]) writeFileSync(join(project, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\nagent: seat\n---\n`)
  writeFileSync(join(project2, ".cotal", "agents", "w3.md"), "---\nname: w3\nrole: worker\nagent: seat\n---\n")
  mkdirSync(bareProject)
  await startBroker()
  await setupSpaceStreams({ servers: server, space })
  await setupSpaceStreams({ servers: server, space: bare })
  process.env.HOME = home
  process.env.COTAL_HOME = join(home, ".cotal")
  const w = await import("@cotal-ai/workspace")
  const ts = new Date().toISOString()
  w.recordMesh({ space, server, root: project, mode: "open", origin: "up", ts })
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

  // Enter on a row opens it, and the open row's name heads the middle column at every width. Each try
  // counts down from the top past the two space rows, where Enter would switch spaces. Enter on the
  // row already open leaves the title as it was. Enter returns the keys to the box, so the pick ends
  // with them back in the tree, on the opened row, where D acts and where the 80x24 overview shows.
  // `want` tells apart rows under one name.
  const title = (frame: string) => frame.split("\n").find((l) => l.includes("SPACES")) ?? ""
  async function pick(name: string, at: string, want: (frame: string) => boolean = () => true) {
    for (let i = 0; i < 14; i++) {
      await toTree()
      keys(...times(20, "k"), ...times(2 + i, "j"))
      await sleep(80)
      const before = title(capture())
      keys("Enter")
      const opened = await waitFor((f) => title(f) !== before, "a row to open", 2000).catch(() => capture())
      if (!title(opened).includes(`${name}  ${at}`)) continue
      await toTree()
      if (await waitFor(want, `the overview of ${name}`, 2000).then(() => true, () => false)) return
    }
    throw new Error(`could not open ${name}:\n${capture()}`)
  }
  /** Enter on the space row that opens `at`, from the top of the tree. */
  async function pickSpace(at: string) {
    for (let i = 0; i < 2; i++) {
      await toTree()
      keys(...times(20, "k"), ...times(i, "j"), "Enter")
      if (await waitFor(liveOn(at), `the space ${at}`, 8000).then(() => true, () => false)) return
    }
    throw new Error(`could not open ${at}:\n${capture()}`)
  }
  const uptime = (frame: string) => {
    const m = /uptime\s+(\d+)s\b/.exec(frame)
    return m ? Number(m[1]) : undefined
  }
  // An overview value as one string: it wraps onto the next lines under its own column.
  const field = (frame: string, label: string) => {
    const lines = frame.split("\n")
    const at = lines.findIndex((l) => new RegExp(`(^|\\s)${label}\\s{2}`).test(l))
    if (at < 0) return undefined
    const col = lines[at]!.search(new RegExp(`${label}\\s{2}`)) + 9
    const parts = [lines[at]!.slice(col).trimEnd()]
    for (const l of lines.slice(at + 1)) {
      if (l.slice(col - 9, col).trim() !== "" || l.slice(col).trim() === "") break
      parts.push(l.slice(col).trimEnd())
    }
    return parts.map((p) => p.trim()).join(" ")
  }
  const confirm = (name: string) => `Stop agent ${name} via the manager?`

  for (const [width, height] of [[209, 52], [97, 49], [80, 24]] as const) {
    const size = `${width}x${height}`
    const dir = join(captures, size)
    console.log(size)
    launch(width, height, join(work, `${size}.err`))
    await waitFor((f) => liveOn(space)(f) && f.includes("w1") && f.includes("w2") && f.includes("planner"), "the live roster with both seats")

    await pick("w1", space)
    const managed = await waitFor((f) => /process\s+running/.test(f), "the manager's row for w1").catch(() => capture())
    save(dir, "01-managed-agent")
    check(`${size}: a managed agent shows its runtime and process from the manager`, /process\s+running/.test(managed) && /runtime\s+pty/.test(managed) && /harness\s+seat/.test(managed) && !managed.includes("managed  "), managed)
    if (width === 209) {
      // The display redraws on the 1s clock and on presence, and a manager read restarts the count
      // from the manager's figure, so reads 3s apart always differ by a whole second.
      const ticks: (number | undefined)[] = []
      for (let i = 0; i < 3; i++) {
        ticks.push(uptime(capture()))
        await sleep(3000)
      }
      check(`${size}: the managed uptime counts forward between reads`, ticks.every((t, i) => t !== undefined && (i === 0 || t > ticks[i - 1]!)), `uptimes: ${ticks.join(", ")}`)
    }

    keys("D")
    const asked = await waitFor(has(confirm("w1")), "D to ask before stopping w1").catch(() => capture())
    save(dir, "02-confirm")
    check(`${size}: D on an agent asks before stopping it`, asked.includes(confirm("w1")) && asked.includes("y stop · f force-kill · n esc enter cancel"), asked)
    keys("Enter")
    await waitFor((f) => !f.includes(confirm("w1")), "Enter to close the confirm")
    await sleep(3000)
    const kept = capture()
    check(`${size}: D then Enter does not stop the agent`, !!live("w1") && !kept.includes("stopping w1") && !kept.includes("stopped w1") && /process\s+running/.test(kept), kept)

    await pick("planner", space)
    const unmanaged = await waitFor((f) => title(f).includes(`planner  ${space}`) && field(f, "managed") === "not by a manager on this space", "the unmanaged agent's overview").catch(() => capture())
    save(dir, "03-unmanaged-agent")
    check(`${size}: an unmanaged agent says no manager runs it`, field(unmanaged, "managed") === "not by a manager on this space" && !/runtime\s+pty/.test(unmanaged), unmanaged)

    await pickSpace(bare)
    await pick("solo", bare)
    const unavailable = await waitFor((f) => !!field(f, "managed")?.startsWith("cannot ask the manager:"), "the reason no manager answers", 30000).catch(() => capture())
    save(dir, "04-no-manager")
    check(`${size}: a space with no manager says why, not a stuck loading line`, !!field(unavailable, "managed")?.includes("has no live registered instances"), unavailable)
    if (width === 209) {
      const before = await dials()
      await sleep(25000)
      const after = await dials()
      check(`${size}: a space whose managers cannot be asked is not asked again`, after === before, `broker connections ${before} -> ${after}`)
    }

    await toTree()
    keys("q")
    await waitFor(has("EXIT=0"), "q to quit with status 0")
  }

  console.log("stop")
  const dir = join(captures, "stop")
  launch(209, 52, join(work, "stop.err"))
  await waitFor((f) => liveOn(space)(f) && f.includes("w1") && f.includes("w2"), "the live roster with both seats")
  await pick("w1", space)
  await waitFor((f) => /process\s+running/.test(f), "the manager's row for w1")
  keys("D")
  await waitFor(has(confirm("w1")), "D to ask before stopping w1")
  keys("f")
  const killing = await waitFor((f) => f.includes("force-killing w1…") || f.includes("force-killed w1"), "the force-kill under way").catch(() => capture())
  check("D then f shows the force-kill under way until the manager answers", killing.includes("force-killing w1…"), killing)
  const killed = await waitFor(has("force-killed w1"), "the force-kill outcome", 30000).catch(() => capture())
  save(dir, "01-force-killed")
  check("D then f force-kills the agent and says so", killed.includes("force-killed w1"), killed)
  const gone = await until(() => !live("w1"), 15000)
  const left = await waitFor((f) => !/[○●◐] w1\b/.test(f), "w1 to leave the roster or go offline", 15000).catch(() => capture())
  save(dir, "02-w1-gone")
  check("the force-killed seat leaves the roster or goes offline", gone && !/[○●◐] w1\b/.test(left) && !!live("w2"), left)

  const w2 = live("w2")!.card.id
  const outsider = peer(space, "w2")
  await outsider.start()
  await waitFor((f) => (f.match(/[○●◐] w2\b/g) ?? []).length === 2, "the outsider named w2 in the roster")
  const unmanaged = (f: string) => field(f, "managed") === "not by a manager on this space"
  await pick("w2", space, unmanaged)
  keys("D")
  const refused = await waitFor(has("No manager on this space reports running w2"), "D refused on the outsider", 5000).catch(() => capture())
  save(dir, "03-outsider-refused")
  check("D on an unmanaged agent named like a managed seat does not offer to stop it", !refused.includes(confirm("w2")) && refused.includes("No manager on this space reports running w2"), refused)
  await sleep(2000)
  check("the managed seat under that name keeps running", seatLive(w2) && !capture().includes(confirm("w2")))
  await outsider.stop()

  await pick("w2", space, (f) => /process\s+running/.test(f))
  keys("D")
  await waitFor(has(confirm("w2")), "D to ask before stopping w2")
  keys("y")
  const stopping = await waitFor((f) => f.includes("stopping w2…") || f.includes("stopped w2"), "the stop under way").catch(() => capture())
  check("D then y shows the stop under way until the manager answers", stopping.includes("stopping w2…"), stopping)
  const stopped = await waitFor(has("stopped w2"), "the graceful stop outcome", 30000).catch(() => capture())
  save(dir, "04-stopped")
  check("D then y stops the agent and says so", stopped.includes("stopped w2"), stopped)
  check("the stopped seat leaves the roster or goes offline", await until(() => !seatLive(w2), 15000))

  // The human asks to stop w2, and a new run replaces it under the same name before they confirm.
  const runOf = (name: string) => live(name)?.lifecycleUid
  // The manager reuses a name once its own roster has the last run offline, which trails this
  // watcher by under a second. Sooner, it numbers the new run `w2_2`.
  const nameFree = async (name: string) => (await until(() => !runOf(name), 15000)) && (await sleep(3000), true)
  await nameFree("w2")
  const first = await manager.startAgent({ name: "w2", agent: "seat", cwd: project, events: false })
  const oldRun = (await until(() => !!runOf("w2"), 15000)) ? runOf("w2") : undefined
  // The app learns of the new run on its next manager read.
  await sleep(11000)
  await pick("w2", space, (f) => /process\s+running/.test(f))
  keys("D")
  const askedOld = await waitFor(has(confirm("w2")), "D to ask before stopping w2").catch(() => capture())
  const outside: ControlClient = { versionSkew: (detail) => detail, roster: async () => watcher!.getRoster() }
  const killedOld = await control(outside, { space, server }, "stop", { name: "w2", graceful: false })
  await nameFree("w2")
  const second = await manager.startAgent({ name: "w2", agent: "seat", cwd: project, events: false })
  const newRun = (await until(() => !!runOf("w2") && runOf("w2") !== oldRun, 15000)) ? runOf("w2") : undefined
  check("fixture: a new run of w2 replaces the one the human asked to stop", askedOld.includes(confirm("w2")) && first.ok && killedOld.ok && second.ok && !!oldRun && !!newRun, JSON.stringify({ first, killedOld, second, oldRun, newRun }))
  keys("y")
  const pinned = await waitFor((f) => f.includes("stop: ") || f.includes("stopped w2"), "the stop outcome", 30000).catch(() => capture())
  save(dir, "05-replaced-run")
  check("D then y on a replaced run stops nothing and says the run changed", pinned.includes("stop: ") && pinned.includes("replaced") && !pinned.includes("stopped w2"), pinned)
  // Presence trails a stop by seconds, so the manager's own list says whether the new run still runs.
  await sleep(2000)
  const after = await controlPs(outside, { space, server })
  check("the run that replaced it keeps running", after.ok && after.rows.some((r) => r.name === "w2"), JSON.stringify(after))
  // The app has no refresh key, so it reads the managers again after the refusal.
  const dropped = await waitFor((f) => field(f, "managed") === "not by a manager on this space", "the overview to drop the replaced run", 5000).catch(() => capture())
  check("after the refusal the replaced run's overview no longer shows it running", field(dropped, "managed") === "not by a manager on this space", dropped)
  await pick("w2", space, (f) => /process\s+running/.test(f))
  keys("D")
  await waitFor(has(confirm("w2")), "D to ask before stopping the new run of w2")
  keys("y")
  const current = await waitFor(has("stopped w2"), "the new run's stop outcome", 30000).catch(() => capture())
  const finished = await controlPs(outside, { space, server })
  check("D then y on the new run stops it", current.includes("stopped w2") && finished.ok && !finished.rows.some((r) => r.name === "w2"), current)

  manager2 = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: project2 })
  await manager2.start()
  // Started together, neither manager sees the other's seat in presence yet, so both keep the name.
  const held = await Promise.all([manager.startAgent({ name: "w3", agent: "seat", cwd: project, events: false }), manager2.startAgent({ name: "w3", agent: "seat", cwd: project2, events: false })])
  const both = await until(() => watcher!.getRoster().filter((p) => p.card.name === "w3" && p.status !== "offline").length === 2, 15000)
  check("fixture: two managers each hold a seat named w3", held.every((r) => r.ok) && both, JSON.stringify(held))
  // The app learns of the second seat on its next manager read.
  await sleep(11000)
  await pick("w3", space, (f) => /process\s+running/.test(f))
  keys("D")
  const twice = await waitFor(has("2 managed agents are named w3"), "D refused on a name two managers hold", 5000).catch(() => capture())
  save(dir, "05-held-twice")
  check("D on a name two managers hold says the app cannot pick one, and offers no stop", twice.includes("2 managed agents are named w3") && !twice.includes(confirm("w3")) && !twice.includes("--on"), twice)

  // As after a `cotal up`: one registered space at this address, so a broker that now wants auth
  // reads as that entry gone stale, which a pruning connect removes.
  console.log("registry")
  w.removeMesh(bare)
  await sleep(2000)
  if (broker) await killAndAwaitExit(broker)
  release()
  await startBroker("--user", "u", "--pass", "p")
  await sleep(25000)
  save(dir, "06-broker-wants-auth")
  check("the manager reads leave the space's registry entry when its broker turns auth on", !!w.findMesh(space), capture())
  await toTree()
  keys("?")
  const help = await waitFor(has("Stop the selected agent"), "? to list the keys").catch(() => capture())
  check("? lists D as the stop key", /D\s+Stop the selected agent/.test(help), help)
  keys("Escape")
  await waitFor((f) => !f.includes("Stop the selected agent"), "Esc to close the keys")
  await toTree()
  keys("q")
  await waitFor(has("EXIT=0"), "q to quit with status 0")
} finally {
  try {
    tmux("kill-server")
  } catch {}
  await manager?.stop({ withAgents: true }).catch(() => {})
  await manager2?.stop({ withAgents: true }).catch(() => {})
  await Promise.all([...peers, ...(watcher ? [watcher] : [])].map((ep) => ep.stop().catch(() => {})))
  if (broker) await killAndAwaitExit(broker)
  release()
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
}

console.log(`TUI CONTROL SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
