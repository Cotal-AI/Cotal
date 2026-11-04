/**
 * Drives the real launcher in tmux at 209x52 and 80x24 against two spaces: an open space on a broker
 * this suite starts, and a static-auth space a real `cotal up --detach` stack serves, whose manager
 * admits the app's chat session. Peers it controls stand on both: a planner, a waiting coder-2, two
 * agents named reviewer with roles rev-a and rev-b, and ghost, which leaves before the human writes
 * to it. The human writes from the composer: a post to #general with a mention, a direct message to
 * one reviewer, an answer to the waiting agent, `/reply` to a direct message, and the refusals. Each
 * check reads its fact off the broker, never only off the screen: a channel's history, the space's
 * direct-message history (an admin reader on the static space), the roster a reader watches, and on
 * the open broker its connections. Captures are kept under the printed directory.
 *
 * Needs Node >= 26.4, tmux and nats-server, so it is not part of smoke:ci, which runs Node 22.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { layoutFor } from "../src/layout.js"
import { CotalEndpoint, isReachable, setupSpaceStreams, type CotalMessage, type Presence } from "@cotal-ai/core"
import {
  SMOKE_BROKER_TOKEN,
  assertSmokeSandboxDown,
  awaitBrokerReady,
  freePort,
  killAndAwaitExit,
  recordSmokeSandbox,
  teardownOnSignal,
} from "@cotal-ai/smoke-kit"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui composer smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

// The app's observer connects as `cotal:tui`, and an open-mode chat session as `cotal:<its name>`.
const login = userInfo().username.trim()
if (login === "tui") throw new Error("this smoke counts the chat session's connections by the name cotal:<OS login>, and the login tui is the app observer's own; run it under another login")

const pkg = fileURLToPath(new URL("..", import.meta.url))
const repo = join(pkg, "..", "..")
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const CLI = join(repo, "bin", "cotal.ts")
const TSX = join(repo, "node_modules", ".bin", "tsx")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-composer-"))
const captures = join(work, "captures")
const home = join(work, "home")
const cotalHome = join(home, ".cotal")
const xdg = join(home, ".config")
const roots = { alpha: join(work, "alpha"), beta: join(work, "beta"), static: join(work, "static") }
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))
const socket = `cotal-tui-composer-${process.pid}`
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: "pipe" })
// Each project folder holds a `.cotal`, so a launch there opens its own space, not the selected one.
for (const dir of Object.values(roots)) mkdirSync(join(dir, ".cotal"), { recursive: true })
mkdirSync(home, { recursive: true, mode: 0o700 })
const anchor = recordSmokeSandbox({ root: roots.static, cotalHome, xdgConfigHome: xdg })
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_"))), HOME: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" }
Object.assign(process.env, { HOME: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdg })

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass++
  else fail++
  console.log(ok ? `  ✓ ${name}` : `  ✗ FAIL: ${name}${detail ? `\n${detail}` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() - start > ms) return v
    await sleep(150)
  }
}

const cli = (...args: string[]) => {
  const options = { cwd: roots.static, env, encoding: "utf8" as const, timeout: 120_000 }
  assertSmokeSandboxDown(anchor, args, options)
  return spawnSync(TSX, [CLI, ...args], options)
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
async function stopBroker() {
  if (broker) await killAndAwaitExit(broker)
  release()
  broker = undefined
}
// Right after a restart a JetStream call can refuse while the server is still reconnecting.
async function settled(write: () => Promise<unknown>) {
  for (let i = 0; ; i++) {
    try {
      return await write()
    } catch (e) {
      if (i === 40) throw e
      await sleep(250)
    }
  }
}
async function chatConnections(): Promise<number> {
  const connz = (await (await fetch(`http://127.0.0.1:${monitor}/connz?limit=1024`)).json()) as { connections?: { name?: string }[] }
  return (connz.connections ?? []).filter((c) => c.name === `cotal:${login}`).length
}

const capture = () => tmux("capture-pane", "-p", "-t", "t")
/** The frame once `test` holds, or the last frame after `ms`. */
async function see(test: (frame: string) => boolean, ms = 8000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const frame = capture()
    if (test(frame) || Date.now() - start > ms) return frame
    await sleep(50)
  }
}
const has = (text: string) => (frame: string) => frame.includes(text)
/** The conversation column's text as one line, so a sentence the column wraps reads whole. */
function middle(frame: string, width: number): string {
  const l = layoutFor(width)
  const end = l.kind === "three" ? width - l.inspector : width
  return frame.split("\n").map((line) => [...line].slice(l.tree, end).join("").trim()).filter(Boolean).join(" ")
}
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)
const type = (text: string) => keys("-l", text)
// A key sent within tmux's escape-time after Escape would read as alt+<key>.
const esc = async () => {
  keys("Escape")
  await sleep(150)
}
const textOf = (m: CotalMessage) => (m.parts ?? []).map((p) => ("text" in p ? p.text : "")).join("")

type Peer = { name: string; id: string; ep: CotalEndpoint; got: CotalMessage[] }
type Space = {
  mode: "open" | "static"
  space: string
  root: string
  other: { space: string; row: number }
  row: number
  reader: CotalEndpoint
  peer: (name: string) => Peer
  namesake: (tag: string) => Promise<Peer>
  /** A fresh agent named ghost, which leaves while the app watches. */
  ghost: (tag: string) => Promise<Peer>
  connections?: () => Promise<number>
}

// A credential label takes letters and digits only.
const minted = (label: string, ...flags: string[]) => {
  const name = label.replace(/[^a-z0-9]/gi, "")
  const out = cli("auth", "mint", name, "--out", join(roots.static, `${name}.creds`), "--json", ...flags)
  if (out.status !== 0) throw new Error(`cotal auth mint ${name} failed:\n${out.stdout}${out.stderr}`)
  const r = (JSON.parse(out.stdout) as { result: { principal: string; lifecycleUid: string } }).result
  const [owner, ...actor] = r.principal.split(".")
  return { creds: readFileSync(join(roots.static, `${name}.creds`), "utf8"), lifecycleUid: r.lifecycleUid, owner: owner!, actor: actor.join(".") }
}

const started: CotalEndpoint[] = []
async function join_(ep: CotalEndpoint, name: string): Promise<Peer> {
  const got: CotalMessage[] = []
  ep.on("error", () => {})
  ep.on("message", (m: CotalMessage) => got.push(m))
  started.push(ep)
  await ep.start()
  return { name, id: ep.card.id, ep, got }
}

const AGENTS = [
  ["planner", "planner"],
  ["coder-2", "coder"],
  ["reviewer", "rev-a"],
  ["reviewer", "rev-b"],
] as const

async function openSpace(): Promise<Space> {
  await startBroker()
  const w = await import("@cotal-ai/workspace")
  for (const [space, root] of [["team-alpha", roots.alpha], ["team-beta", roots.beta]] as const) {
    await setupSpaceStreams({ servers: server, space })
    w.recordMesh({ space, server, root, mode: "open", origin: "manual", ts: new Date().toISOString() })
  }
  const space = "team-alpha"
  const peers = new Map<string, Peer>()
  for (const [name, role] of AGENTS)
    peers.set(`${name}/${role}`, await join_(new CotalEndpoint({ space, servers: server, card: { name, kind: "agent", role }, channels: ["general", "ops"], heartbeatMs: 500, ttlMs: 3000 }), name))
  const reader = new CotalEndpoint({ space, servers: server, card: { name: "reader", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true })
  reader.on("error", () => {})
  started.push(reader)
  await reader.start()
  return {
    mode: "open",
    space,
    root: roots.alpha,
    row: 0,
    other: { space: "team-beta", row: 1 },
    reader,
    peer: (key) => peers.get(key)!,
    namesake: () => join_(new CotalEndpoint({ space, servers: server, card: { name: login.toUpperCase(), kind: "endpoint" }, channels: [], heartbeatMs: 500, ttlMs: 3000 }), login.toUpperCase()),
    ghost: () => join_(new CotalEndpoint({ space, servers: server, card: { name: "ghost", kind: "agent", role: "ghost" }, channels: [], heartbeatMs: 500, ttlMs: 3000 }), "ghost"),
    connections: chatConnections,
  }
}

async function staticSpace(): Promise<Space> {
  const sport = await freePort()
  stackUp = true
  const up = cli("up", "--detach", "--space", "team-static", "--server", `nats://127.0.0.1:${sport}`)
  if (up.status !== 0) throw new Error(`cotal up failed:\n${up.stdout}${up.stderr}`)
  let answered = false
  for (let i = 0; i < 15 && !answered; i++) {
    answered = cli("ps").status === 0
    if (!answered) await sleep(2000)
  }
  if (!answered) throw new Error("the static stack's manager did not answer `cotal ps`")
  const space = "team-static"
  const servers = `nats://127.0.0.1:${sport}`
  const peers = new Map<string, Peer>()
  for (const [name, role] of AGENTS) {
    const m = minted(`${name}-${role}`, "--allow-subscribe", "general,ops", "--allow-publish", "general,ops", "--role", role, "--provision")
    const ep = new CotalEndpoint({ space, servers, creds: m.creds, lifecycleUid: m.lifecycleUid, card: { owner: m.owner, actor: m.actor, name, kind: "agent", role }, channels: ["general", "ops"] })
    peers.set(`${name}/${role}`, await join_(ep, name))
  }
  const r = minted("reader", "--profile", "admin")
  const reader = new CotalEndpoint({ space, servers, creds: r.creds, card: { owner: r.owner, actor: r.actor, name: "reader", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true })
  reader.on("error", () => {})
  started.push(reader)
  await reader.start()
  return {
    mode: "static",
    space,
    root: roots.static,
    row: 2,
    other: { space: "team-alpha", row: 0 },
    reader,
    peer: (key) => peers.get(key)!,
    namesake: async (tag) => {
      const m = minted(`namesake-${tag}`, "--allow-subscribe", "", "--allow-publish", "", "--provision")
      return join_(new CotalEndpoint({ space, servers, creds: m.creds, lifecycleUid: m.lifecycleUid, card: { owner: m.owner, actor: m.actor, name: login.toUpperCase(), kind: "endpoint" }, channels: [] }), login.toUpperCase())
    },
    ghost: async (tag) => {
      const m = minted(`ghost-${tag}`, "--allow-subscribe", "", "--allow-publish", "", "--role", "ghost", "--provision")
      return join_(new CotalEndpoint({ space, servers, creds: m.creds, lifecycleUid: m.lifecycleUid, card: { owner: m.owner, actor: m.actor, name: "ghost", kind: "agent", role: "ghost" }, channels: [] }), "ghost")
    },
  }
}

function launch(root: string, width: number, height: number, err: string) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${root} && env -u XDG_CONFIG_HOME HOME=${home} COTAL_HOME=${cotalHome} XDG_CONFIG_HOME=${xdg} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
  tmux("new-session", "-d", "-s", "t", "-x", String(width), "-y", String(height), line)
  tmux("set-option", "-s", "escape-time", "10")
}

const SPACE_ROWS = 3
const titleOf = (frame: string) => frame.split("\n").find((l) => l.includes("SPACES")) ?? ""
const composing = has("enter send · ctrl+j newline")
const row = (s: Space, name: string): Presence | undefined => s.reader.getRoster().find((p) => p.card.name === name && p.status !== "offline")
const chatRow = (s: Space) => s.reader.getRoster().find((p) => p.card.name === login && p.card.meta?.sessionKind === "chat" && p.status !== "offline")

/** Opens the tree row whose conversation is titled `name`, stepping down from all traffic, so Enter
 *  never lands on a space row. `want` tells apart rows under one name. */
async function openRow(s: Space, name: string, want: (frame: string) => boolean = () => true): Promise<string> {
  for (let i = 0; i < 40; i++) keys("k")
  for (let i = 0; i < SPACE_ROWS; i++) keys("j")
  for (let i = 0; i < 24; i++) {
    await sleep(80)
    const before = titleOf(capture())
    keys("Enter")
    const frame = await see((f) => titleOf(f) !== before, 1500)
    if (titleOf(frame).includes(`${name}  ${s.space}`) && want(frame)) return frame
    keys("j")
  }
  throw new Error(`could not open ${name}:\n${capture()}`)
}

async function run(s: Space, width: number, height: number, tag: string) {
  const size = `${width}x${height}`
  const at = `${s.mode} ${size}`
  const dir = join(captures, s.mode, size)
  let n = 0
  const save = (name: string) => {
    mkdirSync(dir, { recursive: true })
    const file = `${String(++n).padStart(2, "0")}-${name}`
    writeFileSync(join(dir, `${file}.txt`), capture())
    writeFileSync(join(dir, `${file}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
  }
  const general = () => s.reader.channelHistory("general", { limit: 200 })
  // Spaces dropped, since the column may wrap a sentence inside a word such as `/quit`.
  const says = (frame: string, text: string) => middle(frame, width).replace(/\s+/g, "").includes(text.replace(/\s+/g, ""))
  const dms = () => s.reader.dmHistory({ limit: 500 })
  const write = async () => {
    keys("c")
    return see(composing, 4000)
  }
  const enter = (text: string, done: (f: string) => boolean) => {
    type(text)
    keys("Enter")
    return see(done)
  }
  console.log(at)
  const ghost = await s.ghost(tag)

  launch(s.root, width, height, join(work, `${s.mode}-${size}.err`))
  const watching = await see((f) => f.includes(`● live · ${s.space}`) && f.includes("coder-2") && f.includes("you appear as"), 20000)
  save("watching")
  check(`${at}: the line under the conversation names the human's chat name before a session opens`, watching.includes(`c write · you appear as ${login}`), watching)
  const unseen = await s.connections?.()
  check(`${at}: watching stays invisible: no live roster row named ${login}${s.connections ? `, no cotal:${login} connection` : ""}`, !chatRow(s) && (unseen ?? 0) === 0, JSON.stringify({ unseen }))

  await openRow(s, "#general")
  await write()
  const self = await until(() => chatRow(s), (p) => p !== undefined)
  const opened = await see(has(`to #general · as ${login}`))
  const connected = await s.connections?.()
  save("compose-general")
  check(`${at}: c opens one chat session named ${login} with no suffix: a live roster row with sessionKind chat${s.connections ? " and one connection" : ""}`, !!self && self.card.kind === "endpoint" && (connected ?? 1) === 1, JSON.stringify({ self: self?.card, connected }))
  check(`${at}: the composer says where it writes and as whom`, opened.includes(`to #general · as ${login}`), opened)
  const principal = self?.card.id ?? "unknown"

  const post = `hi @planner the plan is ready (${tag})`
  const stored = await enter(post, has("stored"))
  const landed = await until(general, (h) => h.some((m) => textOf(m) === post))
  const msg = landed.find((m) => textOf(m) === post)
  save("post-stored")
  check(`${at}: a post to #general lands in its history from the session's principal with the mention`, stored.includes("stored") && msg?.from.id === principal && !!msg?.mentions?.includes("planner"), JSON.stringify(msg))

  if (s.mode === "static") {
    await esc()
    await openRow(s, "#ops")
    await write()
    const ops = `ops note (${tag})`
    const outside = await enter(ops, has("outside this session's post grant"))
    save("grant-outside")
    const opsHistory = await s.reader.channelHistory("ops", { limit: 200 })
    check(`${at}: a post outside the post grant refuses with the app's step and stores nothing`, says(outside, "denied: #ops is outside this session's post grant. /quit ends this session, then c on #ops opens one on it") && !opsHistory.some((m) => textOf(m) === ops), outside)
    keys("C-u")
  }

  await esc()
  await openRow(s, "reviewer", (f) => /role\s+rev-b/.test(f))
  await write()
  const dm = `please read the branch (${tag})`
  const dmStored = await enter(dm, has("stored"))
  const toReviewer = await until(dms, (h) => h.some((m) => textOf(m) === dm))
  const reviewerB = s.peer("reviewer/rev-b").id
  save("dm-stored")
  check(
    `${at}: a direct message to the open reviewer reaches its principal and not the other reviewer`,
    dmStored.includes("stored") && toReviewer.filter((m) => textOf(m) === dm).map((m) => `${m.from.id}>${m.to}`).join() === `${principal}>${reviewerB}`,
    JSON.stringify(toReviewer.filter((m) => textOf(m) === dm)),
  )

  await esc()
  keys("w")
  await see(has("◐ coder-2 is waiting"), 4000)
  keys("j")
  const answering = await write()
  save("answering")
  const answer = `approved, run it (${tag})`
  const answered = await enter(answer, has("stored"))
  const toCoder = await until(dms, (h) => h.some((m) => textOf(m) === answer))
  save("answer-stored")
  check(`${at}: the target line names the waiting agent's question`, answering.includes("to coder-2 · answering “needs approval"), answering)
  check(
    `${at}: w, then j off the row, then c answers the waiting agent at its principal`,
    answered.includes("stored") && toCoder.some((m) => textOf(m) === answer && m.from.id === principal && m.to === s.peer("coder-2/coder").id),
    JSON.stringify(toCoder.filter((m) => textOf(m) === answer)),
  )

  const planner = s.peer("planner/planner")
  // With no session there is no principal to write to, and /reply then has nothing to quote.
  const ask = self ? await planner.ep.unicast(principal, `can you approve 0042? (${tag})`) : undefined
  await until(dms, (h) => h.some((m) => m.id === ask?.id))
  await sleep(500)
  type("/reply")
  keys("Enter")
  const quoted = await see(has(`↳ planner: “can you approve 0042? (${tag})”`))
  save("reply-quote")
  const reply = `yes, go ahead (${tag})`
  const replied = await enter(reply, has("stored"))
  const toPlanner = await until(dms, (h) => h.some((m) => textOf(m) === reply))
  save("reply-stored")
  check(`${at}: /reply quotes the newest direct message`, quoted.includes("reply to planner"), quoted)
  check(
    `${at}: the reply reaches planner's principal with replyTo naming its message`,
    replied.includes("stored") && toPlanner.some((m) => textOf(m) === reply && m.to === planner.id && m.replyTo === ask?.id),
    JSON.stringify({ ask: ask?.id, got: toPlanner.filter((m) => textOf(m) === reply) }),
  )

  await esc()
  await openRow(s, login)
  await write()
  const note = `note to self (${tag})`
  const own = await enter(note, has("denied:"))
  await sleep(500)
  const toSelf = (await dms()).filter((m) => textOf(m) === note)
  save("own-dm")
  check(`${at}: a direct message to the session itself refuses, keeps the draft and stores nothing`, says(own, "denied: a direct message needs a principal other than this session") && own.includes(`› ${note}`) && toSelf.length === 0, own)
  keys("C-u")

  const before = (await general()).length
  const unknown = await enter("/foo", has("unknown command /foo"))
  save("unknown-slash")
  keys("C-u")
  const who = await enter("/who", has("is not in the app"))
  save("cli-only-slash")
  keys("C-u")
  check(`${at}: an unknown slash command refuses and keeps the line`, unknown.includes("unknown command /foo; try") && unknown.includes("› /foo"), unknown)
  check(`${at}: /who is not in the app and is not sent`, who.includes("/who is not in the app; the tree lists who is here") && (await general()).length === before, who)

  await esc()
  await openRow(s, "all traffic")
  await write()
  const nowhere = await enter(`hello all (${tag})`, has("choose a recipient first"))
  const picker = await see(has("Write to"), 2000)
  save("no-recipient")
  await esc()
  check(`${at}: Enter on all traffic asks for a recipient, opens the picker and stores nothing`, nowhere.includes("choose a recipient first (tab)") && picker.includes("#channel, a name or role:<role>") && (await general()).length === before, nowhere)
  await sleep(300)
  keys("C-u")

  await ghost.ep.stop()
  await see(has("⨯ ghost"), 10000)
  await esc()
  await openRow(s, "ghost")
  await write()
  const late = `are you there (${tag})`
  const offline = await enter(late, has("is offline"))
  const toGhost = await until(dms, (h) => h.some((m) => textOf(m) === late))
  save("offline-recipient")
  check(
    `${at}: a direct message to an offline agent is stored at its principal and says so`,
    says(offline, "ghost is offline. The message is stored and delivered when ghost reconnects") && toGhost.some((m) => textOf(m) === late && m.to === ghost.id),
    offline,
  )

  if (s.mode === "open") {
    await esc()
    await openRow(s, "#general")
    await write()
    await stopBroker()
    await see(has(`◐ reconnecting · ${s.space}`), 10000)
    // Enter before the session itself saw the outage would publish into the client's buffer, so
    // /connection, which runs offline, first shows the session disconnected.
    let state = ""
    for (let i = 0; i < 20 && !state.includes("disconnected as"); i++) {
      type("/connection")
      keys("Enter")
      state = await see(has("disconnected as"), 1000)
    }
    const queued = `during the outage (${tag})`
    const away = await enter(queued, has("not connected"))
    save("not-connected")
    check(`${at}: Enter while the broker is away refuses and keeps the draft`, away.includes("not connected: sending is off; your draft is kept") && away.includes(`› ${queued}`), away)
    await startBroker()
    await settled(() => setupSpaceStreams({ servers: server, space: s.space }))
    await see(has(`● live · ${s.space}`), 30000)
    let back = ""
    for (let i = 0; i < 20 && !back.includes("stored"); i++) {
      keys("Enter")
      back = await see(has("stored"), 1500)
    }
    const once = await until(general, (h) => h.some((m) => textOf(m) === queued))
    save("sent-after-reconnect")
    check(`${at}: once the broker is back, Enter stores the kept draft once`, back.includes("stored") && once.filter((m) => textOf(m) === queued).length === 1, back)
  }

  const namesake = await s.namesake(tag)
  await until(() => row(s, login.toUpperCase()), (p) => p !== undefined)
  const quit = await enter("/quit", has("session ended"))
  const gone = await until(() => s.reader.getRoster().find((p) => p.card.id === principal), (p) => p === undefined || p.status === "offline")
  const left = await until(async () => (await s.connections?.()) ?? 0, (c) => c === 0)
  save("quit")
  check(`${at}: /quit ends the session: its roster row goes offline${s.connections ? " and its connection closes" : ""}`, quit.includes("you ended it") && (gone === undefined || gone.status === "offline") && left === 0, quit)

  await esc()
  keys("w")
  await see(has("◐ coder-2 is waiting"), 4000)
  const reopened = await write()
  const next = await until(() => chatRow(s), (p) => p !== undefined && p.card.id !== principal)
  const warned = await see(has("already in use"))
  save("reopened-name-in-use")
  check(`${at}: the next c opens a new session under a new principal and sends nothing`, !!next && next.card.id !== principal && reopened.includes("to coder-2"), JSON.stringify({ next: next?.card.id, principal }))
  check(`${at}: a name another participant holds is warned`, warned.includes("already in use"), warned)
  // The toast covers the conversation title at 80x24, which the row picker reads.
  await see((f) => !f.includes("already in use"), 15000)
  await namesake.ep.stop()
  const principal2 = next?.card.id ?? "unknown"

  await esc()
  await openRow(s, "#general")
  await write()
  const after = `after the end (${tag})`
  if (s.mode === "static") {
    const none = await enter(after, has("denied:"))
    save("grant-none")
    check(
      `${at}: a session opened on an agent cannot post to a channel, with the app's step, and stores nothing`,
      says(none, "denied: this session was opened on no channel, so it cannot post to #general. /quit ends this session, then c on #general opens one on it") && !(await general()).some((m) => textOf(m) === after),
      none,
    )
  } else {
    const sent = await enter(after, has("stored"))
    const fromNew = await until(general, (h) => h.some((m) => textOf(m) === after))
    save("post-from-new-session")
    check(`${at}: the new session posts from its own principal`, sent.includes("stored") && fromNew.some((m) => textOf(m) === after && m.from.id === principal2), sent)
  }
  keys("C-u")
  const kept = `saved draft (${tag})`
  type(kept)
  await esc()

  for (let i = 0; i < 40; i++) keys("k")
  for (let i = 0; i < s.other.row; i++) keys("j")
  keys("Enter")
  await see(has(`● live · ${s.other.space}`), 20000)
  const closed = await until(() => s.reader.getRoster().find((p) => p.card.id === principal2), (p) => p === undefined || p.status === "offline", 15000)
  const none = await until(async () => (await s.connections?.()) ?? 0, (c) => c === 0)
  save("switched-away")
  check(`${at}: switching spaces closes the chat session: its roster row goes offline${s.connections ? " and no cotal:" + login + " connection is left" : ""}`, (closed === undefined || closed.status === "offline") && none === 0, JSON.stringify(closed?.status))
  for (let i = 0; i < 40; i++) keys("k")
  for (let i = 0; i < s.row; i++) keys("j")
  keys("Enter")
  await see(has(`● live · ${s.space}`), 20000)
  await openRow(s, "#general")
  const again = await write()
  save("draft-kept")
  check(`${at}: the draft stays with its conversation across the switch`, again.includes(`› ${kept}`), again)
  await esc()

  keys("q")
  const asked = await see(has("Quit with 1 unsent draft?"), 4000)
  save("quit-asks")
  keys("y")
  const exited = await see(has("EXIT=0"), 15000)
  save("exited")
  check(`${at}: quitting with a draft asks first, then exits 0 and prints how the session closed`, asked.includes("y quit · n esc enter stay") && exited.includes(`${s.space}: `) && exited.replace(/\n/g, "").includes("messages already sent remain"), exited)
}

async function rename(s: Space, tag: string) {
  const at = `${s.mode} 209x52`
  const dir = join(captures, s.mode, "209x52")
  // The palette lists Change your name too, so the dialog is known by its own line.
  const dialog = async () => {
    keys("C-p")
    await see(has("Commands"), 4000)
    type("Change your name")
    keys("Enter")
    await see(has("You appear as"), 4000)
    await sleep(300)
  }
  launch(s.root, 209, 52, join(work, `${s.mode}-rename.err`))
  await see((f) => f.includes(`● live · ${s.space}`) && f.includes("you appear as"), 20000)
  await dialog()
  type("Ops Lead")
  keys("Enter")
  const line = await see((f) => !f.includes("You appear as") && f.includes("you appear as Ops Lead"))
  await openRow(s, "#general")
  keys("c")
  const named = await until(() => s.reader.getRoster().find((p) => p.card.name === "Ops Lead" && p.status !== "offline"), (p) => p !== undefined)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `renamed-${tag}.txt`), capture())
  writeFileSync(join(dir, `renamed-${tag}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
  check(`${at}: Change your name saves the name preference, and the next session appears under it on the roster`, line.includes("you appear as Ops Lead") && named?.card.meta?.sessionKind === "chat", line)
  await esc()
  await dialog()
  keys("Enter")
  await see((f) => !f.includes("You appear as"), 4000)
  keys("q")
  await see(has("EXIT=0"), 15000)
}

let stackUp = false
try {
  const open = await openSpace()
  await open.peer("planner/planner").ep.multicast("Sprint plan is up", { channel: "general" })
  await open.peer("planner/planner").ep.multicast("ops are green", { channel: "ops" })
  await open.peer("coder-2/coder").ep.setStatus("waiting", "needs approval: run migration 0042 on staging?")
  const stat = await staticSpace()
  await stat.peer("planner/planner").ep.multicast("Sprint plan is up", { channel: "general" })
  await stat.peer("planner/planner").ep.multicast("ops are green", { channel: "ops" })
  await stat.peer("coder-2/coder").ep.setStatus("waiting", "needs approval: run migration 0042 on staging?")
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, login ${login}, open broker ${server}, captures in ${captures}`)

  const tags = ["ra", "rb", "rc", "rd"]
  for (const s of [open, stat])
    for (const [width, height] of [[209, 52], [80, 24]] as const) {
      try {
        await run(s, width, height, tags.shift()!)
      } catch (e) {
        check(`${s.mode} ${width}x${height}: the flow ran to its end`, false, `${(e as Error).message}\n${capture()}`)
      }
    }
  for (const s of [open, stat]) await rename(s, s.mode)
} finally {
  try {
    tmux("kill-server")
  } catch {}
  await Promise.all(started.map((ep) => ep.stop().catch(() => {})))
  if (stackUp) cli("down")
  await stopBroker()
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
}

console.log(`TUI COMPOSER SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
