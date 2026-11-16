/**
 * Drives the real launcher in tmux against an open space on a broker this suite starts, with a real
 * Manager (pty runtime) hosting seats that join presence and echo what reaches their terminal. It
 * attaches with `a` at 209x52 and 80x24 through the manager's real attach session and reads what the
 * person sees: the seat's screen in the middle column, typed text, a burst of keys and ctrl+c
 * reaching the seat, a lone esc reaching it after the hold, esc esc leaving with the seat still
 * running and neither esc delivered, the seat's PTY following the pane's size and a window resize,
 * the wheel scrolling the pane's scrollback, a session that ends when the seat exits, and the keys
 * in `?`. The manager is loaded from the manager's built package: this package does not
 * depend on it. No model runs. Captures are kept under the printed directory.
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
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui attach smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

const pkg = fileURLToPath(new URL("..", import.meta.url))
const repo = join(pkg, "..", "..")
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-attach-"))
const captures = join(work, "captures")
const home = join(work, "home")
const project = join(work, "project")
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))
const socket = `cotal-tui-attach-${process.pid}`
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: "pipe" })
const space = "ops"

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

// A seat that joins presence under the id, lifecycle and holding manager the manager gave it, as a
// connector does, and reports what reaches its terminal: its size, each line typed, each esc and
// ctrl+c, numbered. `fill` prints 120 rows and `quit` exits it.
const coreDist = join(repo, "packages", "core", "dist", "index.js")
const SEAT = [
  "import(require('node:url').pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,",
  "watchPresence:false,heartbeatMs:500,ttlMs:3000,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent',role:'worker',",
  "meta:{'ai.cotal.manager.instance':process.env.COTAL_MANAGER_INSTANCE}}});",
  "ep.on('error',()=>{});await ep.start();",
  "const out=(s)=>process.stdout.write(s+'\\r\\n');const size=()=>process.stdout.columns+'x'+process.stdout.rows;",
  "let line='',esc=0,ctrlc=0;process.stdin.setRawMode(true);process.stdin.resume();out('seat ready');",
  "process.stdout.on('resize',()=>out('size '+size()));",
  "process.stdin.on('data',(d)=>{for(const c of d.toString('latin1')){",
  "if(c==='\\x1b')out('esc '+(++esc));else if(c==='\\x03')out('ctrl-c '+(++ctrlc));",
  "else if(c==='\\r'){if(line==='quit')process.exit(0);if(line==='fill')for(let i=1;i<=120;i++)out('row '+i);",
  "else out('line '+line);line='';}else line+=c;}});});",
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
const settle = (test: (frame: string) => boolean, what: string, timeout = 8000) => waitFor(test, what, timeout).catch(() => capture())
const has = (text: string) => (frame: string) => frame.includes(text)
const save = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), capture())
  writeFileSync(join(dir, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
}
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)
const times = (n: number, key: string) => Array<string>(n).fill(key)
// A key sent within tmux's escape-time after Escape would read as alt+<key>.
async function toTree() {
  keys("Escape")
  await sleep(150)
  keys("Tab")
  await sleep(150)
}
const footer = (frame: string) => frame.trimEnd().split("\n").at(-1)!.trim()
const title = (frame: string) => frame.split("\n").find((l) => l.includes("SPACES")) ?? ""
const liveOn = (frame: string) => title(frame).includes(`#general  ${space}`) && footer(frame) === "? help · ctrl+p commands"
// The pane's header names the agent, the size the seat's PTY was given and where the keys go.
const header = (name: string) => (frame: string) => new RegExp(`${name} · (\\d+)x(\\d+) · keys go to ${name}`).exec(frame)
// The last size the seat reported for its own terminal.
const seatSize = (frame: string) => [...frame.matchAll(/size (\d+x\d+)/g)].at(-1)?.[1]
const count = (frame: string, re: RegExp) => [...frame.matchAll(re)].length

function launch(width: number, height: number, err: string) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${project} && env HOME=${home} COTAL_HOME=${join(home, ".cotal")} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
  tmux("new-session", "-d", "-s", "t", "-x", String(width), "-y", String(height), line)
  tmux("set-option", "-s", "escape-time", "10")
}

let manager: ManagerLike | undefined
let watcher: CotalEndpoint | undefined
let planner: CotalEndpoint | undefined
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
  let output = ""
  broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: ["ignore", "pipe", "pipe"] })
  broker.stdout!.on("data", (d) => (output += d))
  broker.stderr!.on("data", (d) => (output += d))
  release = teardownOnSignal(broker, store)
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100, output: () => output })
  await setupSpaceStreams({ servers: server, space })
  process.env.HOME = home
  process.env.COTAL_HOME = join(home, ".cotal")
  const w = await import("@cotal-ai/workspace")
  w.recordMesh({ space, server, root: project, mode: "open", origin: "up", ts: new Date().toISOString() })
  w.setCurrent(space)

  watcher = new CotalEndpoint({ space, servers: server, card: { name: "watcher", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true })
  watcher.on("error", () => {})
  await watcher.start()
  planner = new CotalEndpoint({ space, servers: server, card: { name: "planner", kind: "agent", role: "planner" }, channels: ["general"], heartbeatMs: 500, ttlMs: 3000 })
  planner.on("error", () => {})
  await planner.start()

  const { Manager } = (await import(pathToFileURL(join(repo, "implementations", "manager", "dist", "index.js")).href)) as {
    Manager: new (o: { space: string; servers: string; runtime: string; workspaceRoot: string }) => ManagerLike
  }
  manager = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: project })
  await manager.start()
  const started = await Promise.all(["w1", "w2"].map((name) => manager!.startAgent({ name, agent: "seat", cwd: project, events: false })))
  const joined = await until(() => !!live("w1") && !!live("w2"), 15000)
  check("fixture: the manager hosts w1 and w2, and both joined presence", started.every((s) => s.ok) && joined, JSON.stringify({ started, roster: watcher.getRoster().map((p) => p.card.name) }))
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, broker ${server}, captures in ${captures}`)

  /** Opens `name`'s conversation from the tree and leaves the keys in the tree, on its row. */
  async function pick(name: string) {
    for (let i = 0; i < 12; i++) {
      await toTree()
      keys(...times(20, "k"), ...times(1 + i, "j"))
      await sleep(80)
      const before = title(capture())
      keys("Enter")
      const opened = await waitFor((f) => title(f) !== before, "a row to open", 2000).catch(() => capture())
      if (!title(opened).includes(`${name}  ${space}`)) continue
      await toTree()
      return
    }
    throw new Error(`could not open ${name}:\n${capture()}`)
  }

  for (const [width, height, agent] of [[209, 52, "w1"], [80, 24, "w2"]] as const) {
    const size = `${width}x${height}`
    const dir = join(captures, size)
    console.log(size)
    launch(width, height, join(work, `${size}.err`))
    await waitFor((f) => liveOn(f) && f.includes("w1") && f.includes("w2") && f.includes("planner"), "the live roster with both seats")

    if (width === 209) {
      await toTree()
      keys("?")
      const help = await settle((f) => f.includes("Attach to the selected agent's terminal"), "the keys dialog")
      save(dir, "00-help")
      check(`${size}: ? lists a and esc esc under Agents`, /a\s+Attach to the selected agent's terminal/.test(help) && /esc esc\s+Leave the agent's terminal; one esc goes to the agent/.test(help), help)
      keys("Escape")
      await sleep(300)
      await pick("planner")
      keys("a")
      const refused = await settle(has("No manager on this space reports running planner"), "the refusal for an unmanaged agent")
      save(dir, "00-unmanaged")
      check(`${size}: a on an agent no manager runs opens no pane and says why`, refused.includes("No manager on this space reports running planner") && !refused.includes("keys go to"), refused)
    }

    await pick(agent)
    keys("a")
    const opened = await settle((f) => !!header(agent)(f) && f.includes("seat ready") && !!seatSize(f), `the pane on ${agent}`)
    save(dir, "01-attached")
    const pane = header(agent)(opened)
    check(
      `${size}: a opens ${agent}'s live terminal in the middle column, with its size and where the keys go, and the footer hint`,
      !!pane && opened.includes("seat ready") && footer(opened).startsWith(`${agent} attached · esc esc back`) && !footer(opened).includes("ctrl+p"),
      opened,
    )
    check(`${size}: the seat's PTY takes the pane's size`, !!pane && seatSize(opened) === `${pane[1]}x${pane[2]}`, `header ${pane?.[0]}, seat ${seatSize(opened)}\n${opened}`)
    if (width === 80) check(`${size}: the pane fits beside the tree`, !!pane && Number(pane[1]) <= 80 - 24 - 4 && Number(pane[2]) <= 24 - 3, opened)

    keys("-l", "hello")
    keys("Enter")
    const typed = await settle(has("line hello"), "typed text at the seat")
    save(dir, "02-typed")
    check(`${size}: typed text and enter reach the seat`, typed.includes("line hello"), typed)

    if (width === 209) {
      // One send-keys burst is many key events in one read, more than the session's 64-frame window.
      const burst = Array.from({ length: 18 }, (_, i) => `k${String(i).padStart(2, "0")}`).join("-").padEnd(90, "x")
      keys("-l", burst)
      keys("Enter")
      const got = await settle(has(`line ${burst}`), "a 90-key burst at the seat")
      check(`${size}: a burst of 90 keys in one read reaches the seat whole`, got.includes(`line ${burst}`), got)
    }

    keys("C-c")
    const ctrlc = await settle(has("ctrl-c 1"), "ctrl+c at the seat")
    check(`${size}: ctrl+c goes to the seat and the app stays open`, ctrlc.includes("ctrl-c 1") && !!header(agent)(ctrlc), ctrlc)

    keys("Escape")
    await sleep(120)
    check(`${size}: a lone esc is held at first`, !capture().includes("esc 1"), capture())
    const esc = await settle(has("esc 1"), "the held esc at the seat")
    save(dir, "03-esc")
    check(`${size}: a lone esc reaches the seat after the hold, and the pane stays`, esc.includes("esc 1") && !!header(agent)(esc), esc)

    // A person's esc esc arrives as two reads; over a slow link both can land in one.
    if (width === 80) tmux("send-keys", "-t", "t", "-H", "1b", "1b")
    else {
      keys("Escape")
      await sleep(100)
      keys("Escape")
    }
    const conversation = (f: string) => title(f).includes(`${agent}  ${space}`) && footer(f) === "? help · ctrl+p commands"
    const back = await settle(conversation, "esc esc back to the conversation")
    save(dir, "04-back")
    check(`${size}: esc esc ${width === 80 ? "in one read " : ""}closes the pane and returns to the conversation`, conversation(back) && !back.includes("keys go to"), back)
    await sleep(1500)
    check(`${size}: the seat keeps running after esc esc`, !!live(agent), JSON.stringify(watcher.getRoster().map((p) => [p.card.name, p.status])))

    keys("a")
    const again = await settle((f) => !!header(agent)(f) && f.includes("line hello"), "the pane again")
    save(dir, "05-again")
    check(`${size}: a attaches again, the seat's screen is kept, and neither esc of esc esc reached it`, !!header(agent)(again) && again.includes("esc 1") && count(again, /esc \d+/g) === 1, again)

    if (width === 209) {
      keys("-l", "fill")
      keys("Enter")
      await settle(has("row 120"), "the seat's 120 rows")
      // An SGR wheel report over the pane. The seat tracks no mouse, so the wheel scrolls the pane.
      const wheel = (button: number, n: number) => tmux("send-keys", "-t", "t", "-l", `\x1b[<${button};80;20M`.repeat(n))
      wheel(64, 10)
      const up = await settle((f) => !f.includes("row 120") && f.includes("row 60"), "the wheel to scroll the pane back")
      save(dir, "06-scrolled")
      check(`${size}: the wheel scrolls the pane's scrollback when the agent tracks no mouse`, !up.includes("row 120") && up.includes("row 60") && !!header(agent)(up), up)
      wheel(65, 10)
      const down = await settle(has("row 120"), "the wheel to scroll the pane forward")
      check(`${size}: and scrolls it forward again`, down.includes("row 120"), down)
    }

    if (width === 80) {
      tmux("resize-window", "-t", "t", "-x", "160", "-y", "48")
      const grown = await settle((f) => {
        const h = header(agent)(f)
        return !!h && Number(h[1]) > 60 && seatSize(f) === `${h[1]}x${h[2]}`
      }, "the pane to follow the window")
      save(dir, "06-resized")
      const h = header(agent)(grown)
      check(`${size}: the pane and the seat's PTY follow a window resize`, !!h && Number(h[1]) > 60 && seatSize(grown) === `${h[1]}x${h[2]}`, grown)
    }

    keys("-l", "quit")
    keys("Enter")
    // The manager ends the session as `process-exit` or, when it frees the seat first, `target-despawn`.
    const gone = new RegExp(`${agent} · session ended: the agent (exited|is gone) · esc closes`)
    const ended = await settle((f) => gone.test(f), "the end of the session")
    save(dir, "07-ended")
    check(`${size}: when the seat exits the pane says so`, gone.test(ended) && footer(ended).startsWith(`${agent} session ended · esc back`), ended)
    keys("Escape")
    const closed = await settle(conversation, "one esc to close an ended pane", 3000)
    save(dir, "08-closed")
    check(`${size}: one esc closes an ended pane`, conversation(closed) && !closed.includes("session ended"), closed)

    keys("q")
    await waitFor(has("EXIT=0"), "the app to quit", 10000).catch(() => undefined)
  }
} finally {
  try {
    tmux("kill-server")
  } catch {}
  await manager?.stop({ withAgents: true }).catch(() => {})
  await Promise.all([planner, watcher].map((ep) => ep?.stop().catch(() => {})))
  if (broker) await killAndAwaitExit(broker)
  release()
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
}

console.log(`TUI ATTACH SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
