/**
 * Drives the real launcher in tmux against three open spaces on a broker this suite starts: one with
 * a real Manager (pty runtime), one whose policy requires the event plane with its own Manager, and
 * one with no manager. It spawns from the tree key and the palette: the persona list, the settings
 * form with its defaults, enter from any row, a cycled model and effort, a typed prompt of two lines
 * and an edited name, a name refused as it is typed, an application with no event plane, one the
 * manager does not have, one a space's policy refuses, and a seat that outlives its join window and
 * then exits, which the notice line follows to its exit. The manager runs in this process, so the launch each spawn reached is
 * read here. It also checks the event-plane decision and the form's defaults as functions. Captures
 * are kept under the printed directory.
 *
 * Needs Node >= 26.4, tmux and nats-server, and a built manager, so it is not part of smoke:ci.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { CotalEndpoint, eventChannel, isReachable, registry, setupSpaceStreams, spawnNameError, type Connector, type LaunchOpts, type LaunchSpec, type Presence } from "@cotal-ai/core"
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit"
import { applicationsOf, cycleApp, cycleModel, eventsFor, FEED_REQUIRED, resolve, type Draft, type SpawnSetup } from "../src/spawn.js"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui spawn smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

const pkg = fileURLToPath(new URL("..", import.meta.url))
const repo = join(pkg, "..", "..")
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-spawn-"))
const captures = join(work, "captures")
const home = join(work, "home")
const project = join(work, "project")
const strictProject = join(work, "project-strict")
const bareProject = join(work, "project-bare")
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))
const socket = `cotal-tui-spawn-${process.pid}`
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: "pipe" })
const space = "ops"
const strict = "strict"
const bare = "no-manager"

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass++
  else fail++
  console.log(ok ? `  ✓ ${name}` : `  ✗ FAIL: ${name}${detail ? `\n${detail}` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log("the event plane and the form's defaults")
check("an application with an event plane leaves events unset, on any space", eventsFor(true, false) === undefined && eventsFor(true, true) === undefined)
check("one without an event plane sends events: false", eventsFor(false, false) === false)
check("one without an event plane is refused on a space that requires it", JSON.stringify(eventsFor(false, true)) === JSON.stringify({ refused: FEED_REQUIRED }))
{
  const rows = [
    { agent: "claude", state: "available", eventPlane: true },
    { agent: "hermes", state: "available", eventPlane: false },
    { agent: "codex", state: "unavailable", eventPlane: true, reason: "codex is not on PATH" },
  ]
  const setup = (required: boolean): SpawnSetup => ({ dir: "", personas: [], defaultPersona: "", applications: applicationsOf(rows, new Map([["claude", [{ id: "opus", variants: ["low", "high"] }, { id: "sonnet", variants: [] }]]]), required), defaultApplication: "claude" })
  const nameError = (n: string) => spawnNameError(n, { userMode: false })
  const plain = { name: "helper", def: { name: "helper" } }
  const pinned = { name: "scribe", def: { name: "scribe", agent: "hermes", model: "hermes-4" } }
  const fresh = resolve(setup(false), { persona: plain, prompt: "", name: "helper" }, nameError)
  check(
    "a persona with no pins runs on your default application and model under its own name, and the request sends only the persona and your default",
    fresh.app.id === "claude" && fresh.model === "" && fresh.name === "helper" && !Object.values(fresh.changed).some(Boolean) && "request" in fresh && JSON.stringify(fresh.request) === JSON.stringify({ persona: "helper", defaultAgent: "claude" }),
    JSON.stringify(fresh),
  )
  const quiet = resolve(setup(false), { persona: pinned, prompt: " notes please ", name: "" }, nameError)
  check(
    "a persona's application and model are its defaults, and one with no event plane sends events: false with the prompt",
    quiet.app.id === "hermes" && quiet.model === "hermes-4" && quiet.changed.prompt && !quiet.changed.app && "request" in quiet && JSON.stringify(quiet.request) === JSON.stringify({ persona: "scribe", defaultAgent: "claude", prompt: "notes please", events: false }),
    JSON.stringify(quiet),
  )
  const refusedFeed = resolve(setup(true), { persona: pinned, prompt: "", name: "" }, nameError)
  check("on a space that requires an event plane, a persona pinned to an application without one is refused on the application row", "refused" in refusedFeed && refusedFeed.refused.row === "app" && refusedFeed.refused.reason === FEED_REQUIRED, JSON.stringify(refusedFeed))
  const moved = resolve(setup(true), { persona: pinned, prompt: "", name: "s2", app: "claude", model: "opus" }, nameError)
  check(
    "a changed application, model and name are sent and marked changed, and events stay unset",
    moved.changed.app && moved.changed.model && moved.changed.name && "request" in moved && JSON.stringify(moved.request) === JSON.stringify({ persona: "scribe", defaultAgent: "claude", name: "s2", harness: "claude", model: "opus" }),
    JSON.stringify(moved),
  )
  const down = resolve(setup(false), { persona: plain, prompt: "", name: "", app: "codex" }, nameError)
  check("an application the manager reports unavailable is refused with the manager's reason", "refused" in down && down.refused.reason === "codex is not on PATH", JSON.stringify(down))
  const badName = resolve(setup(false), { persona: plain, prompt: "", name: "bad name" }, nameError)
  const effort = (d: Draft, required = false) => resolve(setup(required), d, nameError)
  const disabled = (d: Draft) => {
    const e = effort(d).effort
    return "disabled" in e ? e.disabled : undefined
  }
  check("effort is disabled until a model is chosen", disabled({ persona: plain, prompt: "", name: "" }) === "choose a model first")
  check("effort is disabled for a model that offers none", disabled({ persona: plain, prompt: "", name: "", model: "sonnet" }) === "not offered for sonnet")
  check("effort is disabled on an application that offers none for any model", disabled({ persona: pinned, prompt: "", name: "" }) === "not offered by hermes")
  const opus = effort({ persona: plain, prompt: "", name: "", model: "opus" })
  check(
    "a model with efforts offers them after its default, and the default sends no variant",
    JSON.stringify(opus.effort) === JSON.stringify({ choices: ["", "low", "high"], value: "" }) && !opus.changed.effort && "request" in opus && opus.request.variant === undefined,
    JSON.stringify(opus),
  )
  const high = effort({ persona: plain, prompt: "", name: "", model: "opus", variant: "high" })
  check("a changed effort is marked changed and sent as the variant", high.changed.effort && "request" in high && high.request.variant === "high", JSON.stringify(high))
  const highDraft: Draft = { persona: plain, prompt: "", name: "", model: "opus", variant: "high" }
  check("changing the model or the application puts the effort back to its default", cycleModel(highDraft, high, 1).variant === undefined && cycleApp(setup(false), highDraft, high, 1).variant === undefined)
  const keen = { name: "keen", def: { name: "keen", model: "opus", variant: "high" } }
  const keenR = effort({ persona: keen, prompt: "", name: "" })
  check(
    "a persona's variant is its default effort, which the request leaves to the manager",
    "choices" in keenR.effort && keenR.effort.value === "high" && keenR.effort.choices[0] === "high" && "request" in keenR && keenR.request.variant === undefined,
    JSON.stringify(keenR),
  )
  check("a name the mesh cannot carry is refused on the name row", "refused" in badName && badName.refused.row === "name" && badName.refused.reason.startsWith('unsafe name "bad name"'), JSON.stringify(badName))
}

interface ManagerLike {
  start(): Promise<void>
  stop(options?: { withAgents?: boolean }): Promise<void>
}

// A seat that joins presence under the id and lifecycle the manager gave it, and idles until killed.
const coreDist = join(repo, "packages", "core", "dist", "index.js")
const SEAT = [
  "import(require('node:url').pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,",
  "watchPresence:false,heartbeatMs:500,ttlMs:3000,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent',role:process.env.COTAL_ROLE||undefined}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
].join("")
// It names an event plane as a real connector does and lists two models. The seat never publishes on
// the plane.
const launches = new Map<string, Pick<LaunchOpts, "events" | "model" | "variant" | "prompt">>()
const seat: Connector = {
  kind: "connector",
  name: "seat",
  requires: ["node"],
  eventChannel,
  supportsPrompt: true,
  supportsModelVariant: true,
  listModels: async () => ({ models: [{ id: "m1", variants: [{ name: "low" }, { name: "high" }] }, { id: "m2" }] }),
  buildLaunch: (o: LaunchOpts): LaunchSpec => (launches.set(o.name, { events: o.events, model: o.model, variant: o.variant, prompt: o.prompt }), {
    command: "node",
    args: ["-e", SEAT],
    env: { PATH: process.env.PATH ?? "", CORE_DIST: coreDist, COTAL_SPACE: o.space, COTAL_SERVERS: o.servers ?? "", COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name, COTAL_ROLE: o.role ?? "" },
  }),
}
registry.register(seat)
// A seat with no event plane, as Hermes has none.
const { eventChannel: _plane, listModels: _models, ...plain } = seat
registry.register({ ...plain, name: "quiet" } satisfies Connector)
// A seat whose process runs past its connector's join window without joining, then exits with a
// diagnostic, as an OpenCode 2.x seat that refuses the event plane after a slow start does.
const LATE_MS = 6000
const late: Connector = {
  kind: "connector",
  name: "late",
  requires: ["node"],
  eventChannel,
  readinessTimeoutMs: 2000,
  buildLaunch: (): LaunchSpec => ({
    command: "node",
    args: ["-e", `setTimeout(()=>{console.error("late: refused after a slow start");process.exit(1)},${LATE_MS})`],
    env: { PATH: process.env.PATH ?? "" },
  }),
}
registry.register(late)
// A seat that joins a few seconds after its 2 s join window.
const tardy: Connector = { ...seat, name: "tardy", readinessTimeoutMs: 2000, buildLaunch: (o) => {
  const spec = seat.buildLaunch(o)
  return { ...spec, args: ["-e", `setTimeout(()=>{${SEAT}},4000)`] }
} }
registry.register(tardy)

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
const save = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), capture())
  writeFileSync(join(dir, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
}
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)
const type = (text: string) => tmux("send-keys", "-t", "t", "-l", text)
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
const title = (frame: string) => frame.split("\n").find((l) => l.includes("SPACES")) ?? ""
// A space is live once its conversation heads the middle column and the footer has nothing to report.
const liveOn = (at: string) => (frame: string) => title(frame).includes(`#general  ${at}`) && footer(frame) === "? help · ctrl+p commands"
// The line above the status bar, where a spawn says how it goes.
const notice = (frame: string) => frame.trimEnd().split("\n").at(-2)!.trim()
const joinedAs = (name: string) => (frame: string) => notice(frame) === `${name} joined`

function launch(width: number, height: number, err: string) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${project} && env -u COTAL_HOME HOME=${home} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
  tmux("new-session", "-d", "-s", "t", "-x", String(width), "-y", String(height), line)
  tmux("set-option", "-s", "escape-time", "10")
}

let managers: ManagerLike[] = []
let watcher: CotalEndpoint | undefined
const live = (name: string): Presence | undefined => watcher?.getRoster().find((p) => p.card.name === name && p.status !== "offline")

const PICK = "Spawn agent"
const formFor = (persona: string) => (frame: string) => frame.includes(`Spawn ${persona}`) && frame.includes("Prompt")
// The rest of a settings row after its label, its whitespace collapsed, read below the form's title.
const row = (frame: string, label: string) => {
  const lines = frame.split("\n")
  const from = lines.findIndex((l) => /Spawn \S+\s+esc/.test(l))
  const line = lines.slice(from + 1).find((l) => new RegExp(`\\b${label}\\b`).test(l)) ?? ""
  return line.slice(line.indexOf(label) + label.length).replace(/\s+/g, " ").trim()
}

try {
  mkdirSync(home, { mode: 0o700 })
  for (const root of [project, strictProject, bareProject]) mkdirSync(join(root, ".cotal", "agents"), { recursive: true })
  const persona = (root: string, name: string, agent: string, description?: string) =>
    writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\nagent: ${agent}\n${description ? `description: ${description}\n` : ""}---\n`)
  for (const name of ["w1", "w2"]) persona(project, name, "seat", `a ${name} worker`)
  persona(project, "q1", "quiet", "keeps quiet notes")
  persona(project, "ghost", "no-such-harness")
  persona(project, "late", "late")
  persona(project, "tardy", "tardy")
  persona(strictProject, "q2", "quiet")
  persona(bareProject, "w1", "seat")
  await startBroker()
  for (const s of [space, strict, bare]) await setupSpaceStreams({ servers: server, space: s })
  process.env.HOME = home
  delete process.env.COTAL_HOME
  const w = await import("@cotal-ai/workspace")
  const ts = new Date().toISOString()
  w.recordMesh({ space, server, root: project, mode: "open", origin: "up", ts })
  w.recordMesh({ space: strict, server, root: strictProject, mode: "open", origin: "up", ts, policy: { events: "required" } })
  w.recordMesh({ space: bare, server, root: bareProject, mode: "open", origin: "manual", ts })
  w.setCurrent(space)

  watcher = new CotalEndpoint({ space, servers: server, card: { name: "watcher", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true })
  watcher.on("error", () => {})
  await watcher.start()

  const { Manager } = (await import(pathToFileURL(join(repo, "implementations", "manager", "dist", "index.js")).href)) as {
    Manager: new (o: { space: string; servers: string; runtime: string; workspaceRoot: string; eventsRequired?: boolean }) => ManagerLike
  }
  managers = [new Manager({ space, servers: server, runtime: "pty", workspaceRoot: project }), new Manager({ space: strict, servers: server, runtime: "pty", workspaceRoot: strictProject, eventsRequired: true })]
  for (const m of managers) await m.start()
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, broker ${server}, captures in ${captures}`)

  /** Opens the persona list with `S` in the tree. */
  async function openPicker() {
    await toTree()
    keys("S")
    return waitFor((f) => f.includes(PICK) && f.includes("Search"), "S to list the personas", 8000)
  }
  /** Picks `persona` from the open list by typing it, and waits for its form. */
  async function pick(persona: string) {
    type(persona)
    await sleep(200)
    keys("Enter")
    return waitFor(formFor(persona), `the form for ${persona}`, 5000).catch(() => capture())
  }
  /** Opens the space named `to` from the tree. */
  async function switchTo(to: string) {
    for (let i = 0; i < 3 && !liveOn(to)(capture()); i++) {
      await toTree()
      keys(...times(20, "k"), ...times(i, "j"), "Enter")
      await waitFor(liveOn(to), `the space ${to}`, 8000).catch(() => undefined)
    }
  }
  const noSpawn = (frame: string) => !notice(frame).startsWith("spawning")

  for (const [width, height, w] of [[209, 52, "w1"], [80, 24, "w2"]] as const) {
    const size = `${width}x${height}`
    const dir = join(captures, size)
    const suffix = width === 209 ? "" : "b"
    console.log(size)
    launch(width, height, join(work, `${size}.err`))
    await waitFor(liveOn(space), "the space to open")

    if (width === 209) {
      // The seat runs past its 2 s join window and exits 6 s after launch, so the launch's answer is
      // that it runs and has not joined, and the exit comes after it.
      await openPicker()
      await pick("late")
      keys("Enter")
      const running = await waitFor((f) => notice(f).startsWith("late is running but has not joined yet"), "the launch's answer", 10000).catch(() => capture())
      save(dir, "00-late-running")
      check(`${size}: a seat that has not joined in its window is followed`, notice(running).startsWith("late is running but has not joined yet"), running)
      const exited = await waitFor((f) => notice(f).startsWith("late exited before it joined"), "the exit", 20000).catch(() => capture())
      save(dir, "00-late-exited")
      check(`${size}: when that seat exits, the notice line says it exited before it joined and where its reason is`, notice(exited) === "late exited before it joined; `cotal manager logs` shows why" && !live("late"), exited)

      await openPicker()
      await pick("tardy")
      keys("Enter")
      const slow = await waitFor((f) => notice(f).startsWith("tardy is running but has not joined yet"), "the launch's answer", 10000).catch(() => capture())
      const came = await waitFor(joinedAs("tardy"), "the late join", 20000).catch(() => capture())
      save(dir, "00-tardy-joined")
      check(`${size}: a seat that joins after its window is followed until the notice says it joined`, notice(slow).startsWith("tardy is running") && joinedAs("tardy")(came) && !!live("tardy"), `${slow}\n${came}`)
    }

    const listed = await openPicker().catch(() => capture())
    save(dir, "01-personas")
    check(`${size}: S in the tree lists the space's personas with each one's description and application`, ["w1", "w2", "q1", "ghost", "a w1 worker", "keeps quiet notes", "no-such-harness"].every((t) => listed.includes(t)) && /q1 keeps quiet notes\s+quiet/.test(listed), listed)
    check(`${size}: the list has no key hints`, !/tab|enter|customize/i.test(listed), listed)
    const form = await pick(w)
    save(dir, "02-form")
    check(
      `${size}: enter opens the settings for the persona picked, under its description, with each default`,
      formFor(w)(form) && form.includes(`a ${w} worker`) && row(form, "Prompt") === "what it should do first (optional)" && row(form, "Application") === "seat" && row(form, "Model") === "default" && row(form, "Effort") === "choose a model first" && row(form, "Name") === w,
      form,
    )
    check(`${size}: the form has no Events row and no key hints`, !/Events|tab |enter |space /.test(form), form)
    keys("Enter")
    const launching = await waitFor((f) => notice(f).startsWith(`spawning ${w}`) || joinedAs(w)(f), "the spawn under way", 5000).catch(() => capture())
    check(`${size}: a second enter spawns with every default and the notice says it is under way`, /^spawning \S+… · \d+s$/.test(notice(launching)) || joinedAs(w)(launching), launching)
    const joined = await waitFor(joinedAs(w), "the join", 40000).catch(() => capture())
    const opened = await waitFor((f) => title(f).includes(`${w}  ${space}`), "the new agent's conversation", 5000).catch(() => capture())
    save(dir, "03-joined")
    check(`${size}: the persona joins and its conversation opens`, joinedAs(w)(joined) && !!live(w) && title(opened).includes(`${w}  ${space}`), `${joined}\n${opened}`)
    check(`${size}: that spawn left the event plane to the manager, which armed it, with no prompt and no variant`, launches.get(w)?.events === true && launches.get(w)?.prompt === undefined && launches.get(w)?.variant === undefined, JSON.stringify(launches.get(w)))

    const named = `scout${suffix}`
    const again = await openPicker()
    save(dir, "04-recent")
    const lines = again.split("\n")
    const under = lines[lines.findIndex((l) => /\bRecent\b/.test(l)) + 1] ?? ""
    check(`${size}: the persona just spawned is listed first, under Recent, above the other personas`, under.includes(`${w} a ${w} worker`) && again.includes("Personas"), again)
    await pick("w2")
    type("check the parser")
    keys("M-Enter")
    type("then the lexer")
    const twoLines = await waitFor((f) => f.includes("then the lexer"), "the prompt's second line", 5000).catch(() => capture())
    save(dir, "05-prompt")
    const promptAt = twoLines.split("\n").findIndex((l) => /\bPrompt\b/.test(l))
    check(`${size}: alt+enter types a newline in the prompt, which grows to show both lines`, twoLines.split("\n")[promptAt]!.includes("check the parser") && twoLines.split("\n")[promptAt + 1]!.includes("then the lexer"), twoLines)
    keys("Down", "Down")
    await sleep(150)
    keys("Right")
    await sleep(150)
    const modelPicked = capture()
    check(`${size}: a model that offers efforts enables the effort row on its default`, row(modelPicked, "Effort") === "default", modelPicked)
    keys("Down")
    await sleep(150)
    keys("Right")
    await sleep(150)
    save(dir, "05-effort")
    const effortPicked = capture()
    check(`${size}: → on the effort row picks the model's next effort`, row(effortPicked, "Effort") === "‹ low ›", effortPicked)
    keys("Down")
    const editing = await waitFor((f) => row(f, "Name") === "w2", "the name row prefilled", 5000).catch(() => capture())
    save(dir, "05-name")
    check(`${size}: the name row opens on the persona's name, ready to edit`, row(editing, "Name") === "w2", editing)
    keys("BSpace", "BSpace")
    type("bad name")
    const bad = await waitFor((f) => f.includes('unsafe name "bad name"'), "the name refusal as it is typed", 5000).catch(() => capture())
    save(dir, "05-name-refused")
    check(`${size}: a cycled model and effort and a typed prompt show on their rows`, row(bad, "Model") === "m1" && row(bad, "Effort") === "low" && row(bad, "Prompt") === "check the parser then the lexer", bad)
    keys("Up", "Up", "Up", "Up")
    await sleep(150)
    keys("Enter")
    await sleep(600)
    const held = capture()
    save(dir, "06-enter-refused")
    check(`${size}: enter in the prompt with a refused name launches nothing and goes to the name row`, held.includes('unsafe name "bad name"') && formFor("w2")(held) && noSpawn(held) && !live("bad name"), held)
    keys(...times(8, "BSpace"))
    type(named)
    keys("Up", "Up")
    await sleep(150)
    keys("Enter")
    const renamed = await waitFor(joinedAs(named), "the named join", 40000).catch(() => capture())
    save(dir, "07-named")
    const sent = launches.get(named)
    check(
      `${size}: enter from the model row launches with the name, the model, the effort and both lines of the prompt`,
      joinedAs(named)(renamed) && live(named)?.card.role === "worker" && sent?.model === "m1" && sent.variant === "low" && sent.prompt === "check the parser\nthen the lexer" && sent.events === true,
      `${renamed}\n${JSON.stringify(sent)}`,
    )

    await openPicker()
    const quiet = await pick("q1")
    save(dir, "08-no-feed")
    check(`${size}: an application with no event plane says so on its row`, row(quiet, "Application") === "no activity feed quiet", quiet)
    check(`${size}: on an application with no efforts, the effort row says so`, row(quiet, "Effort") === "not offered by quiet", quiet)
    keys("Enter")
    const q = `q1${suffix ? "_2" : ""}`
    const quietJoined = await waitFor(joinedAs(q), "the quiet join", 40000).catch(() => capture())
    check(`${size}: it launches with events: false`, joinedAs(q)(quietJoined) && launches.get(q)?.events === false, `${quietJoined}\n${JSON.stringify(launches.get(q))}`)

    await openPicker()
    const ghost = await pick("ghost")
    keys("Enter")
    await sleep(600)
    const ghostHeld = capture()
    save(dir, "09-not-installed")
    check(`${size}: an application the manager does not have is refused on its row and enter launches nothing`, row(ghost, "Application") === "no-such-harness" && ghost.includes("not installed on the space's manager") && noSpawn(ghostHeld) && formFor("ghost")(ghostHeld), ghostHeld)
    keys("Right")
    await sleep(150)
    const moved = capture()
    check(`${size}: enter put the application row up, and → moves it to an application the manager has, which clears the refusal`, row(moved, "Application") === "‹ late ›" && !moved.includes("not installed on the space's manager"), moved)
    keys("Escape")
    const back = await waitFor((f) => f.includes(PICK) && f.includes("Search"), "esc back to the personas", 5000).catch(() => capture())
    check(`${size}: esc in the form returns to the persona list`, back.includes(PICK) && !back.includes("Prompt"), back)
    keys("Escape")
    await waitFor((f) => !f.includes("Search"), "esc to close the list", 5000)

    if (width === 209) {
      keys("C-p")
      await waitFor((f) => f.includes("Commands"), "ctrl+p to list the commands", 4000)
      type(PICK)
      await sleep(200)
      keys("Enter")
      const palette = await waitFor((f) => f.includes("Search") && f.includes("ghost"), "the palette to list the personas", 5000).catch(() => capture())
      save(dir, "10-palette")
      check(`${size}: ctrl+p, Spawn agent, opens the persona list`, palette.includes(PICK) && palette.includes("w2"), palette)
      keys("Escape")
      await waitFor((f) => !f.includes("Search"), "esc to close the list", 5000)
      await toTree()
      keys("?")
      const help = await waitFor((f) => /S\s+Spawn agent/.test(f), "? to list the keys", 5000).catch(() => capture())
      check(`${size}: ? lists S as Spawn agent`, /S\s+Spawn agent/.test(help), help)
      keys("Escape")
      await waitFor((f) => !/S\s+Spawn agent/.test(f), "esc to close the keys", 5000)
    }

    await switchTo(strict)
    await openPicker()
    const required = await pick("q2")
    keys("Enter")
    await sleep(600)
    const requiredHeld = capture()
    save(dir, "11-feed-required")
    check(`${size}: on a space that requires an activity feed, an application without one is refused on its row and enter launches nothing`, row(required, "Application") === "quiet" && required.includes(FEED_REQUIRED) && noSpawn(requiredHeld) && formFor("q2")(requiredHeld), requiredHeld)
    keys("Right")
    await sleep(150)
    const toSeat = capture()
    keys("Enter")
    const q2 = `q2${suffix ? "_2" : ""}`
    const strictJoined = await waitFor(joinedAs(q2), "the join on the strict space", 40000).catch(() => capture())
    check(`${size}: enter there had put the application row up, → skips to the next application with a feed, and it launches with the event plane armed`, row(toSeat, "Application") === "‹ seat ›" && joinedAs(q2)(strictJoined) && launches.get(q2)?.events === true, `${toSeat}\n${strictJoined}\n${JSON.stringify(launches.get(q2))}`)

    await switchTo(bare)
    await toTree()
    keys("S")
    const none = await waitFor((f) => f.includes("Spawning is not available"), "the refusal on a space with no manager", 20000).catch(() => capture())
    save(dir, "12-no-manager")
    check(`${size}: on a space with no manager, S says why spawning is not available and opens nothing`, none.includes("Spawning is not available") && !none.includes("Search"), none)

    await toTree()
    keys("q")
    await waitFor((f) => f.includes("EXIT=0"), "q to quit with status 0")
  }
} catch (e) {
  check("the suite ran to the end", false, (e as Error).stack)
} finally {
  try {
    tmux("kill-server")
  } catch {}
  for (const m of managers) await m.stop({ withAgents: true }).catch(() => {})
  await watcher?.stop().catch(() => {})
  if (broker) await killAndAwaitExit(broker)
  release()
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
}

console.log(`TUI SPAWN SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
