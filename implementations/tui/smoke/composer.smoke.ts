/**
 * Drives the real launcher in tmux at 209x52 and 80x24 against two spaces: an open space on a broker
 * this suite starts, and a static-auth space a real `cotal up --detach` stack serves, whose manager
 * admits the app's chat session. Peers it controls stand on both: a planner, a waiting coder-2, two
 * agents named reviewer with roles rev-a and rev-b, and ghost, which leaves before the human writes
 * to it. The human writes in the input box under the conversation, which has the keys from launch;
 * tab moves them to the tree. The first enter opens the chat session and sends: a post to #general
 * with a mention, then a direct message to one reviewer, an answer to the waiting agent, `/reply` to
 * a direct message, replies to a message picked with `↑` or a click, and the refusals. Every send is read off the broker: a channel's history, the
 * space's direct-message history (an admin reader on the static space), the roster a reader watches,
 * and on the open broker its connections. Every refusal is read off the screen. Captures are kept
 * under the printed directory.
 *
 * Needs Node >= 26.4, tmux and nats-server, so it is not part of smoke:ci, which runs Node 22.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: xdg })
process.env.COTAL_HOME = cotalHome

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass++
  else fail++
  console.log(ok ? `  ✓ ${name}` : `  ✗ FAIL: ${name}${detail ? `\n${detail}` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** `read` once `ok` holds, or its last value after `ms`. A read that throws, as a reader's does while
 *  it reconnects after a broker restart, is read again, and its error rethrown only at the end. */
async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    let v: { value: T } | { error: unknown }
    try {
      v = { value: await read() }
    } catch (error) {
      v = { error }
    }
    const done = Date.now() - start > ms
    if ("value" in v && (ok(v.value) || done)) return v.value
    if ("error" in v && done) throw v.error
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
/** The conversation column's lines, trimmed, from the title to the box, without the footer. */
function middleLines(frame: string, width: number): string[] {
  const l = layoutFor(width)
  const end = l.kind === "three" ? width - l.inspector : width
  return frame.trimEnd().split("\n").slice(0, -1).map((line) => [...line].slice(l.tree, end).join("").trim()).filter(Boolean)
}
const treeLines = (frame: string, width: number) => frame.split("\n").map((line) => [...line].slice(0, layoutFor(width).tree).join("").trim())
/** The conversation column's text as one line, so a sentence the column wraps reads whole. */
const middle = (frame: string, width: number) => middleLines(frame, width).join(" ")
/** The toast's text as one line: what sits between the last two `┃` of each line it covers. */
const toastOf = (frame: string) =>
  frame
    .split("\n")
    .map((l) => l.split("┃"))
    .filter((parts) => parts.length >= 3)
    .map((parts) => parts.at(-2)!.trim())
    .join(" ")
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)
const type = (text: string) => keys("-l", text)
// A key sent within tmux's escape-time after Escape would read as alt+<key>.
const esc = async () => {
  keys("Escape")
  await sleep(150)
}
/** A click where `text` starts on screen, as a terminal reports it in SGR mouse mode. */
function click(text: string) {
  const rows = capture().split("\n")
  const y = rows.findIndex((l) => l.includes(text))
  if (y < 0) throw new Error(`nothing to click: ${text} is not on screen`)
  const x = [...rows[y]!.slice(0, rows[y]!.indexOf(text))].length + 1
  type(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`)
}
/** Mouse-wheel turns up over the conversation column, as a terminal reports them in SGR mouse mode. */
const wheelUp = (width: number, n: number) => type(`\x1b[<64;${layoutFor(width).tree + 4};6M`.repeat(n))
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
const footer = (frame: string) => frame.trimEnd().split("\n").at(-1)!.trim()
// A space is live once its conversation heads the middle column and the footer has nothing to report.
// While a switch closes the last space's session, the title already names the next space.
const live = (space: string) => (frame: string) => titleOf(frame).includes(`  ${space}`) && !/Connecting to|Leaving /.test(frame) && footer(frame) === "? help · ctrl+p commands"
const row = (s: Space, name: string): Presence | undefined => s.reader.getRoster().find((p) => p.card.name === name && p.status !== "offline")
const chatRow = (s: Space) => s.reader.getRoster().find((p) => p.card.name === login && p.card.meta?.sessionKind === "chat" && p.status !== "offline")
const times = (n: number, key: string) => Array<string>(n).fill(key)

// The keys go to the tree from either side: esc returns the tree to the box and does nothing in the
// box, then tab moves them to the tree.
async function toTree() {
  await esc()
  keys("Tab")
  await sleep(150)
}
const toBox = esc

/** Opens the tree row whose conversation is titled `name`. Each try counts down from the top past the
 *  space rows, where enter would switch spaces; enter returns the keys to the box. `want`, read with
 *  the tree focused so the 80x24 overview shows, tells apart rows under one name. */
async function openRow(s: Space, name: string, want?: (frame: string) => boolean): Promise<string> {
  for (let i = 0; i < 24; i++) {
    await toTree()
    keys(...times(40, "k"), ...times(SPACE_ROWS + i, "j"))
    await sleep(80)
    const before = titleOf(capture())
    keys("Enter")
    const frame = await see((f) => titleOf(f) !== before, 1500)
    if (!titleOf(frame).includes(`${name}  ${s.space}`)) continue
    if (!want) return frame
    await toTree()
    const ok = want(await see(want, 1500))
    await toBox()
    if (ok) return capture()
  }
  throw new Error(`could not open ${name}:\n${capture()}`)
}
/** Enter on a space row, counted from the top of the tree. */
async function openSpaceRow(at: number) {
  await toTree()
  keys(...times(40, "k"), ...times(at, "j"), "Enter")
}

const strip = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "")
const fgBefore = (line: string, text: string) => new RegExp(`\\x1b\\[38;2;([\\d;]+)m${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(line)?.[1]
/** The human's name at the bottom of the tree, with its color and the gold the open space's marker has. */
function nameAtBottom(width: number): { name: string; fg?: string; gold?: string } {
  const raw = tmux("capture-pane", "-p", "-e", "-t", "t").split("\n")
  const tree = layoutFor(width).tree
  const lines = raw.map((l) => [...strip(l)].slice(0, tree).join("").trim())
  const last = raw.map(strip).findLastIndex((l) => l.trim() !== "")
  const at = lines.slice(0, last).findLastIndex(Boolean)
  const name = lines[at] ?? ""
  return { name, fg: fgBefore(raw[at] ?? "", name), gold: raw.map((l) => fgBefore(l, "▸")).find(Boolean) }
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
  const lines = (frame: string) => middleLines(frame, width)
  // A feed row's text sits after the row's border; the box holds the draft with no border.
  const inFeed = (frame: string, text: string) => lines(frame).includes(`┃ ${text}`)
  const inBox = (frame: string, text: string) => lines(frame).includes(text)
  const target = (frame: string, line: string) => lines(frame).some((l) => l === line || l.startsWith(`${line} · ends `))
  const dms = () => s.reader.dmHistory({ limit: 500 })
  const enter = (text: string, done: (f: string) => boolean) => {
    type(text)
    keys("Enter")
    return see(done)
  }
  const clear = async () => {
    keys("C-u")
    await sleep(150)
  }
  console.log(at)
  const ghost = await s.ghost(tag)

  launch(s.root, width, height, join(work, `${s.mode}-${size}.err`))
  const watching = await see((f) => live(s.space)(f) && f.includes("coder-2") && nameAtBottom(width).name === login, 20000)
  const dim = nameAtBottom(width)
  save("watching")
  check(`${at}: the space opens on #general with the box under it and the human's name, not gold, at the bottom of the tree`, titleOf(watching).includes(`#general  ${s.space}`) && target(watching, "#general") && dim.name === login && !!dim.fg && dim.fg !== dim.gold, JSON.stringify(dim))
  const unseen = await s.connections?.()
  check(`${at}: watching stays invisible: no live roster row named ${login}${s.connections ? `, no cotal:${login} connection` : ""}`, !chatRow(s) && (unseen ?? 0) === 0, JSON.stringify({ unseen }))

  const post = `hi @planner the plan is ready (${tag})`
  type(post)
  const drafted = await see((f) => inBox(f, post))
  await sleep(1000)
  const typing = await s.connections?.()
  save("draft")
  check(`${at}: typing a draft opens no session`, inBox(drafted, post) && !chatRow(s) && (typing ?? 0) === 0, JSON.stringify({ typing }))

  keys("Enter")
  const landed = await until(general, (h) => h.some((m) => textOf(m) === post))
  const self = await until(() => chatRow(s), (p) => p !== undefined)
  const connected = await s.connections?.()
  const first = await see((f) => inFeed(f, post) && !inBox(f, post) && nameAtBottom(width).fg === nameAtBottom(width).gold)
  const gold = nameAtBottom(width)
  save("first-send")
  const principal = self?.card.id ?? "unknown"
  const msg = landed.find((m) => textOf(m) === post)
  check(`${at}: the first enter opens one chat session named ${login} with no suffix: a live roster row with sessionKind chat${s.connections ? " and one connection" : ""}`, !!self && self.card.kind === "endpoint" && (connected ?? 1) === 1, JSON.stringify({ self: self?.card, connected }))
  check(`${at}: the same enter sends: the post lands in #general's history from the session's principal with the mention, and the box empties`, msg?.from.id === principal && !!msg?.mentions?.includes("planner") && inFeed(first, post) && !inBox(first, post), JSON.stringify(msg))
  check(`${at}: on the roster, the name at the bottom of the tree turns gold`, gold.name === login && gold.fg === gold.gold, JSON.stringify(gold))
  if (s.mode === "static") check(`${at}: a static session's box names its end time`, lines(first).some((l) => /^#general · ends \d\d:\d\d$/.test(l)), first)

  // The quoted row's text sits on the gold wash, accent 800 on a dark or a light terminal.
  const lit = (text: string) => tmux("capture-pane", "-p", "-e", "-t", "t").split("\n").some((l) => strip(l).includes(`┃ ${text}`) && /48;2;(63;58;23|238;208;159)[m;]/.test(l))
  const quoting = (who: string, start: string) => has(`↳ ${who}: “${start}`)
  const planner = s.peer("planner/planner")
  const pair = `who can pair on ingest? (${tag})`
  const pairMsg = await planner.ep.multicast(pair, { channel: "general" })
  await see((f) => inFeed(f, pair))
  keys("Up")
  const picked = await see((f) => quoting("planner", "who can pair")(f) && lit(pair))
  save("quote-selected")
  check(
    `${at}: ↑ on an empty box quotes the newest message and highlights it; the line under the box names #general, no "replying to" line, and the footer is unchanged`,
    quoting("planner", "who can pair")(picked) && lit(pair) && target(picked, "#general") && !picked.includes("replying to") && footer(picked) === "? help · ctrl+p commands",
    picked,
  )
  keys("Up")
  const older = await see(quoting(login, "hi @planner"))
  keys("Down")
  await see(quoting("planner", "who can pair"))
  keys("Down")
  const dropped = await see((f) => !f.includes("↳ "))
  check(`${at}: ↑ moves the quote to an older message, and ↓ past the newest drops it`, quoting(login, "hi @planner")(older) && !dropped.includes("↳ "), `${older}\n${dropped}`)
  keys("Up")
  await see(quoting("planner", "who can pair"))
  const pairReply = `I can pair (${tag})`
  type(pairReply)
  await see((f) => inBox(f, pairReply))
  keys("Up")
  await sleep(300)
  const typed = capture()
  save("quote-drafted")
  check(`${at}: typing goes into the box under the quote, and with text in the box ↑ moves no quote`, inBox(typed, pairReply) && quoting("planner", "who can pair")(typed) && !typed.includes(`↳ ${login}:`), typed)
  await esc()
  const bare = await see((f) => !f.includes("↳ "))
  keys("Up")
  await sleep(300)
  const still = capture()
  check(`${at}: esc drops the quote and keeps the draft, and with text in the box ↑ quotes nothing`, !bare.includes("↳ ") && inBox(bare, pairReply) && !still.includes("↳ ") && inBox(still, pairReply), still)
  click(pair)
  const clicked = await see((f) => quoting("planner", "who can pair")(f) && lit(pair))
  check(`${at}: a click quotes a message mid-draft and keeps the draft`, quoting("planner", "who can pair")(clicked) && lit(pair) && inBox(clicked, pairReply), clicked)
  keys("Enter")
  const replied = await until(general, (h) => h.some((m) => textOf(m) === pairReply))
  const threaded = await see((f) => inFeed(f, pairReply) && !f.includes("↳ "))
  await sleep(500)
  const strays = (await dms()).filter((m) => textOf(m) === pairReply)
  save("quote-sent")
  const pairSent = replied.find((m) => textOf(m) === pairReply)
  check(
    `${at}: enter sends the reply to #general with replyTo naming the quoted message, sends no direct message, and its row shows ↩ planner`,
    pairSent?.replyTo === pairMsg.id && pairSent.from.id === principal && strays.length === 0 && lines(threaded).some((l) => l.startsWith(`┃ ${login}  ↩ planner`)),
    JSON.stringify({ want: pairMsg.id, got: pairSent, strays }),
  )

  if (s.mode === "static") {
    await openRow(s, "#ops")
    const ops = `ops note (${tag})`
    const outside = await enter(ops, (f) => says(f, "denied:"))
    save("grant-outside")
    const opsHistory = await s.reader.channelHistory("ops", { limit: 200 })
    check(`${at}: a post outside the post grant refuses with the app's step, keeps the draft and stores nothing`, says(outside, "denied: #ops is outside this session's post grant. /quit ends this session, then enter in #ops opens one there") && inBox(outside, ops) && !opsHistory.some((m) => textOf(m) === ops), outside)
    await clear()
  }

  await openRow(s, "reviewer", (f) => /role\s+rev-b/.test(f))
  const dm = `please read the branch (${tag})`
  type(dm)
  keys("Enter")
  const toReviewer = await until(dms, (h) => h.some((m) => textOf(m) === dm))
  const dmShown = await see((f) => inFeed(f, dm) && !inBox(f, dm))
  const reviewerB = s.peer("reviewer/rev-b").id
  save("dm-sent")
  check(
    `${at}: a direct message to the open reviewer reaches its principal, not the other reviewer, and shows in the conversation`,
    inFeed(dmShown, dm) && toReviewer.filter((m) => textOf(m) === dm).map((m) => `${m.from.id}>${m.to}`).join() === `${principal}>${reviewerB}`,
    JSON.stringify(toReviewer.filter((m) => textOf(m) === dm)),
  )

  await toTree()
  keys("w")
  await see(has("◐ coder-2 is waiting"), 4000)
  keys("j")
  await sleep(100)
  await toBox()
  const answering = await see((f) => target(f, "answering coder-2"), 4000)
  save("answering")
  check(`${at}: w in the tree, then j off the row, then esc: the box answers the waiting agent`, target(answering, "answering coder-2") && answering.includes("◐ coder-2 is waiting"), answering)
  const answer = `approved, run it (${tag})`
  type(answer)
  keys("Enter")
  const toCoder = await until(dms, (h) => h.some((m) => textOf(m) === answer))
  save("answer-sent")
  check(`${at}: the answer reaches the waiting agent's principal`, toCoder.some((m) => textOf(m) === answer && m.from.id === principal && m.to === s.peer("coder-2/coder").id), JSON.stringify(toCoder.filter((m) => textOf(m) === answer)))

  const ask = await planner.ep.unicast(principal, `can you approve 0042? (${tag})`)
  await until(dms, (h) => h.some((m) => m.id === ask?.id))
  await sleep(500)
  type("/reply")
  keys("Enter")
  const quoted = await see(has(`↳ planner: “can you approve 0042? (${tag})”`))
  save("reply-quote")
  check(`${at}: /reply quotes the newest direct message and the line under the box names where it goes`, quoted.includes(`↳ planner: “can you approve 0042? (${tag})”`) && target(quoted, "@planner") && !quoted.includes("replying to"), quoted)
  const reply = `yes, go ahead (${tag})`
  type(reply)
  keys("Enter")
  const toPlanner = await until(dms, (h) => h.some((m) => textOf(m) === reply))
  const unquoted = await see((f) => !f.includes("↳ planner:"))
  save("reply-sent")
  check(
    `${at}: the reply reaches planner's principal with replyTo naming its message, and the quote goes`,
    toPlanner.some((m) => textOf(m) === reply && m.to === planner.id && m.replyTo === ask?.id) && !unquoted.includes("↳ planner:"),
    JSON.stringify({ ask: ask?.id, got: toPlanner.filter((m) => textOf(m) === reply) }),
  )

  await openRow(s, "planner")
  const ship = `ship it today? (${tag})`
  const shipMsg = await planner.ep.unicast(principal, ship)
  await see((f) => inFeed(f, ship))
  keys("Up")
  const dmPicked = await see((f) => quoting("planner", "ship it today?")(f) && lit(ship))
  save("dm-quote-selected")
  check(`${at}: in planner's conversation, ↑ quotes its newest direct message and the line under the box names @planner`, lit(ship) && target(dmPicked, "@planner"), dmPicked)
  const shipReply = `shipping now (${tag})`
  type(shipReply)
  await see((f) => inBox(f, shipReply))
  save("dm-quote-drafted")
  keys("Enter")
  const toPlanner2 = await until(dms, (h) => h.some((m) => textOf(m) === shipReply))
  const dmThreaded = await see((f) => inFeed(f, shipReply) && !f.includes("↳ "))
  save("dm-quote-sent")
  check(
    `${at}: the picked direct message's reply reaches planner's principal with replyTo naming it, and its row shows ↩ planner`,
    toPlanner2.some((m) => textOf(m) === shipReply && m.from.id === principal && m.to === planner.id && m.replyTo === shipMsg?.id) && lines(dmThreaded).some((l) => l.startsWith(`┃ ${login}`) && l.includes("↩ planner")),
    JSON.stringify({ want: shipMsg?.id, got: toPlanner2.filter((m) => textOf(m) === shipReply) }),
  )

  const coder = s.peer("coder-2/coder").id
  if (s.mode === "open") {
    const burst = `standup in 5 (${tag})`
    await planner.ep.unicast(coder, burst)
    await planner.ep.unicast(principal, burst)
    await see((f) => inFeed(f, burst))
    keys("Up")
    const burstPick = await see(has("↳ "), 3000).catch(() => capture())
    save("burst-quote")
    check(`${at}: ↑ passes over a direct-message burst whose first copy went to another agent, so no reply names that copy`, !burstPick.includes("↳ planner: “standup in 5") && quoting("planner", "ship it today?")(burstPick), burstPick)
    await esc()
    click(burst)
    const refusal = await see((f) => says(f, "several recipients"), 3000)
    save("burst-click")
    check(`${at}: a click on that burst in planner's own conversation says to answer planner here, not to open it in the tree`, says(refusal, "that message went to several recipients; answer its sender here without a quote") && !refusal.includes("↳ planner: “standup in 5"), refusal)

    const retro = `retro at 4 (${tag})`
    const yours = await planner.ep.unicast(principal, retro)
    await planner.ep.unicast(coder, retro)
    await see((f) => lines(f).some((l) => l.includes(`→ ${login}, coder-2 ×2`)))
    keys("Up")
    const retroPick = await see(quoting("planner", "retro at 4"), 3000)
    const retroReply = `retro works (${tag})`
    type(retroReply)
    keys("Enter")
    const toPlanner3 = await until(dms, (h) => h.some((m) => textOf(m) === retroReply))
    save("burst-yours-sent")
    check(
      `${at}: ↑ quotes a burst whose first copy came to the human, and the reply reaches planner with replyTo naming that copy`,
      quoting("planner", "retro at 4")(retroPick) && toPlanner3.some((m) => textOf(m) === retroReply && m.to === planner.id && m.replyTo === yours?.id),
      JSON.stringify({ want: yours?.id, got: toPlanner3.filter((m) => textOf(m) === retroReply) }),
    )
  } else {
    const burst = `standup in 5 (${tag})`
    await planner.ep.unicast(coder, burst)
    const yours = await planner.ep.unicast(principal, burst)
    await see((f) => inFeed(f, burst))
    keys("Up")
    const burstPick = await see(quoting("planner", "standup in 5"), 3000)
    const burstReply = `standup works (${tag})`
    type(burstReply)
    keys("Enter")
    const toPlanner3 = await until(dms, (h) => h.some((m) => textOf(m) === burstReply))
    save("burst-sent")
    check(
      `${at}: the observer sees no direct messages here, so ↑ quotes the copy of a burst that came to the human, and the reply names that copy`,
      quoting("planner", "standup in 5")(burstPick) && toPlanner3.some((m) => textOf(m) === burstReply && m.to === planner.id && m.replyTo === yours?.id),
      JSON.stringify({ want: yours?.id, got: toPlanner3.filter((m) => textOf(m) === burstReply) }),
    )
  }
  await see((f) => !f.includes("↳ "))
  const walkedDms: string[] = []
  for (let i = 0; i < 10; i++) {
    keys("Up")
    await sleep(200)
    walkedDms.push(capture())
  }
  save("dm-walk")
  check(
    `${at}: in planner's conversation ↑ quotes only direct messages, never planner's #general posts`,
    walkedDms.some((f) => f.includes("↳ planner:")) && walkedDms.every((f) => !target(f, "#general")),
    walkedDms.find((f) => target(f, "#general")) ?? walkedDms.at(-1)!,
  )
  await esc()
  if (width === 209) {
    click(pair)
    const post = await see((f) => says(f, "#general post"), 3000)
    save("post-click-in-dm")
    check(`${at}: a click on planner's #general post in planner's conversation refuses and says where to reply`, says(post, "that is a #general post; reply to it in #general") && !post.includes("↳ "), post)
  }

  const before = (await general()).length
  const unknown = await enter("/foo", (f) => says(f, "unknown command /foo"))
  save("unknown-slash")
  const who = await enter("/who", (f) => says(f, "is not in the app"))
  save("cli-only-slash")
  await clear()
  check(`${at}: an unknown slash command refuses and clears the line`, says(unknown, "unknown command /foo; try") && !inBox(unknown, "/foo"), unknown)
  check(`${at}: /who is not in the app and is not sent`, says(who, "/who is not in the app; the tree lists who is here") && (await general()).length === before, who)

  const aside = `between agents (${tag})`
  if (s.mode === "open") await planner.ep.unicast(coder, aside)
  const traffic = await openRow(s, "all traffic")
  if (s.mode === "open") {
    await see((f) => inFeed(f, aside))
    keys("Up")
    await sleep(300)
    const up = capture()
    click(aside)
    const elsewhere = await see((f) => says(f, "not sent to you"), 3000)
    save("between-agents")
    check(
      `${at}: in all traffic a direct message between two agents cannot be quoted: ↑ passes over it and a click refuses`,
      !up.includes("↳ planner: “between agents") && says(elsewhere, "that direct message was not sent to you") && !elsewhere.includes("↳ planner: “between agents"),
      `${up}\n${elsewhere}`,
    )
    await esc()
  }
  const nowhere = await enter(`hello all (${tag})`, (f) => says(f, "choose a recipient first"))
  save("no-recipient")
  check(`${at}: all traffic has no recipient: the box says so, and enter refuses, keeps the draft and stores nothing`, target(traffic, "no recipient in all traffic") && says(nowhere, "choose a recipient first (open a channel or an agent)") && inBox(nowhere, `hello all (${tag})`) && (await general()).length === before, nowhere)
  await clear()

  await ghost.ep.stop()
  await see(has("⨯ ghost"), 10000)
  await openRow(s, "ghost")
  const late = `are you there (${tag})`
  const offline = await enter(late, (f) => says(f, "is offline"))
  const toGhost = await until(dms, (h) => h.some((m) => textOf(m) === late))
  save("offline-recipient")
  check(
    `${at}: a direct message to an offline agent is stored at its principal and says so`,
    says(offline, "ghost is offline. The message is stored, but delivery is not confirmed.") && toGhost.some((m) => textOf(m) === late && m.to === ghost.id),
    offline,
  )

  if (s.mode === "open") {
    await openRow(s, "#general")
    await stopBroker()
    await see((f) => footer(f).startsWith("◐ reconnecting"), 10000)
    // Enter before the session itself saw the outage would publish into the client's buffer, so
    // /connection, which runs offline, first shows the session disconnected.
    let state = ""
    for (let i = 0; i < 20 && !says(state, "disconnected as"); i++) {
      type("/connection")
      keys("Enter")
      state = await see((f) => says(f, "disconnected as"), 1000)
    }
    const queued = `during the outage (${tag})`
    const away = await enter(queued, (f) => says(f, "not connected"))
    save("not-connected")
    check(`${at}: enter while the broker is away refuses and keeps the draft`, says(away, "not connected: sending is off; your draft is kept") && inBox(away, queued), away)
    await startBroker()
    await settled(() => setupSpaceStreams({ servers: server, space: s.space }))
    await see(live(s.space), 30000)
    let stored = false
    for (let i = 0; i < 20 && !stored; i++) {
      keys("Enter")
      stored = (await until(general, (h) => h.some((m) => textOf(m) === queued), 1500)).some((m) => textOf(m) === queued)
    }
    const once = await until(general, (h) => h.some((m) => textOf(m) === queued))
    const back = await see((f) => inFeed(f, queued) && !inBox(f, queued))
    save("sent-after-reconnect")
    check(`${at}: once the broker is back, enter sends the kept draft once`, once.filter((m) => textOf(m) === queued).length === 1 && inFeed(back, queued), back)
  }

  const namesake = await s.namesake(tag)
  await until(() => row(s, login.toUpperCase()), (p) => p !== undefined)
  // At 80x24 the name-in-use toast later opens where this click leaves the pointer, and a toast
  // under the pointer does not time out.
  if (s.mode === "open" && width === 209) {
    const hello = `same name, other session (${tag})`
    await namesake.ep.unicast(principal, hello)
    await openRow(s, login.toUpperCase())
    await see((f) => inFeed(f, hello))
    click(hello)
    const named = await see((f) => says(f, "under your name"), 3000)
    save("namesake-click")
    check(
      `${at}: a direct message from another session under the human's name, in other letter case, refuses with a line that says so`,
      says(named, "that is from another session under your name") && !named.includes(`↳ ${login.toUpperCase()}:`),
      named,
    )
    const toNamesake = `for the other ${login.toUpperCase()} (${tag})`
    await planner.ep.unicast(namesake.id, toNamesake)
    await openRow(s, "all traffic")
    await see((f) => inFeed(f, toNamesake))
    keys("Up")
    await sleep(300)
    const up = capture()
    click(toNamesake)
    const notYours = await see((f) => says(f, "not sent to you"), 3000)
    save("namesake-recipient")
    check(
      `${at}: in all traffic a direct message to another session under the human's name cannot be quoted: ↑ passes over it and a click refuses`,
      !up.includes("↳ planner: “for the other") && says(notYours, "that direct message was not sent to you") && !notYours.includes("↳ planner: “for the other"),
      `${up}\n${notYours}`,
    )
    await esc()
  }
  const quit = await enter("/quit", (f) => says(f, "you ended it"))
  const gone = await until(() => s.reader.getRoster().find((p) => p.card.id === principal), (p) => p === undefined || p.status === "offline")
  const left = await until(async () => (await s.connections?.()) ?? 0, (c) => c === 0)
  save("quit")
  check(`${at}: /quit ends the session: its roster row goes offline${s.connections ? " and its connection closes" : ""}, and the box says enter opens a new one`, says(quit, `you ended it · enter opens a new one as ${login}`) && (gone === undefined || gone.status === "offline") && left === 0, quit)

  await openRow(s, "planner")
  const walked: string[] = []
  for (let i = 0; i < 8; i++) {
    keys("Up")
    await sleep(250)
    walked.push(capture())
  }
  save("quote-after-quit")
  check(`${at}: after /quit, ↑ in planner's conversation quotes none of the human's own direct messages from the ended session`, walked.every((f) => !f.includes(`↳ ${login}:`)), walked.find((f) => f.includes(`↳ ${login}:`)) ?? walked.at(-1)!)
  await esc()

  await toTree()
  keys("w")
  await see(has("◐ coder-2 is waiting"), 4000)
  await toBox()
  const again = `still there? (${tag})`
  const reopened = await enter(again, (f) => says(f, "new session as"))
  const next = await until(() => chatRow(s), (p) => p !== undefined && p.card.id !== principal)
  const warned = await see(has("already in use"))
  await sleep(1000)
  const early = (await dms()).filter((m) => textOf(m) === again)
  save("reopened-name-in-use")
  check(`${at}: after /quit, enter opens a new session under a new principal, keeps the draft and sends nothing`, !!next && next.card.id !== principal && says(reopened, `new session as ${login}; enter sends`) && inBox(reopened, again) && early.length === 0, JSON.stringify({ next: next?.card.id, principal, early }))
  check(`${at}: a name another participant holds is warned`, warned.includes("already in use"), warned)
  const principal2 = next?.card.id ?? "unknown"
  keys("Enter")
  const sentAgain = await until(dms, (h) => h.some((m) => textOf(m) === again))
  check(`${at}: the second enter sends from the new session`, sentAgain.some((m) => textOf(m) === again && m.from.id === principal2 && m.to === s.peer("coder-2/coder").id), JSON.stringify(sentAgain.filter((m) => textOf(m) === again)))
  await sleep(1500)
  const ownRows = treeLines(capture(), width).filter((l) => new RegExp(`^⚙ ${login}( |$)`).test(l))
  save("own-sessions-in-tree")
  check(`${at}: the tree lists none of the human's chat sessions, the ended one or the open one`, ownRows.length === 0, ownRows.join("\n"))
  if (s.mode === "open") {
    const colleague = new CotalEndpoint({ space: s.space, servers: server, card: { name: "dana", kind: "endpoint", meta: { sessionKind: "chat" } }, channels: [], heartbeatMs: 500, ttlMs: 3000 })
    colleague.on("error", () => {})
    started.push(colleague)
    await colleague.start()
    const danaRow = (f: string) => treeLines(f, width).some((l) => /^⚙ dana( |$)/.test(l))
    const listed = await see(danaRow, 8000).catch(() => capture())
    check(`${at}: another human's live chat session has a row in the tree`, danaRow(listed), treeLines(listed, width).join("\n"))
    await colleague.stop()
    const dropped = await see((f) => !danaRow(f), 8000).catch(() => capture())
    check(`${at}: once that session ends, its row goes`, !danaRow(dropped), treeLines(dropped, width).join("\n"))
  }
  // The toast covers the conversation title at 80x24, which the row picker reads.
  await see((f) => !f.includes("already in use"), 15000)
  await namesake.ep.stop()

  await openRow(s, "#general")
  const after = `after the end (${tag})`
  if (s.mode === "static") {
    const none = await enter(after, (f) => says(f, "denied:"))
    save("grant-none")
    check(
      `${at}: a session opened on an agent cannot post to a channel, with the app's step, keeps the draft and stores nothing`,
      says(none, "denied: this session was opened on no channel, so it cannot post to #general. /quit ends this session, then enter in #general opens one there") && inBox(none, after) && !(await general()).some((m) => textOf(m) === after),
      none,
    )
  } else {
    type(after)
    keys("Enter")
    const fromNew = await until(general, (h) => h.some((m) => textOf(m) === after))
    save("post-from-new-session")
    check(`${at}: the new session posts from its own principal`, fromNew.some((m) => textOf(m) === after && m.from.id === principal2), JSON.stringify(fromNew.filter((m) => textOf(m) === after)))
  }
  await clear()
  const kept = `saved draft (${tag})`
  type(kept)
  await see((f) => inBox(f, kept))

  await openSpaceRow(s.other.row)
  await see(live(s.other.space), 20000)
  const closed = await until(() => s.reader.getRoster().find((p) => p.card.id === principal2), (p) => p === undefined || p.status === "offline", 15000)
  const none = await until(async () => (await s.connections?.()) ?? 0, (c) => c === 0)
  save("switched-away")
  check(`${at}: switching spaces closes the chat session: its roster row goes offline${s.connections ? " and no cotal:" + login + " connection is left" : ""}`, (closed === undefined || closed.status === "offline") && none === 0, JSON.stringify(closed?.status))
  await openSpaceRow(s.row)
  const back = await see((f) => live(s.space)(f) && inBox(f, kept), 20000)
  save("draft-kept")
  check(`${at}: the draft stays with its conversation across the switch`, titleOf(back).includes(`#general  ${s.space}`) && inBox(back, kept), back)

  await toTree()
  keys("w")
  await see(has("◐ coder-2 is waiting"), 4000)
  await toBox()
  const bye = `signing off (${tag})`
  type(bye)
  keys("Enter")
  const third = await until(() => chatRow(s), (p) => p !== undefined && p.card.id !== principal && p.card.id !== principal2)
  const byeSent = await until(dms, (h) => h.some((m) => textOf(m) === bye))
  check(`${at}: back on the space, the first enter opens a new session and answers in one step`, !!third && byeSent.some((m) => textOf(m) === bye && m.from.id === third.card.id), JSON.stringify(byeSent.filter((m) => textOf(m) === bye)))

  const backlog = Array.from({ length: 50 }, (_, i) => `ops line ${i} (${tag})`)
  for (const t of backlog) await planner.ep.multicast(t, { channel: "ops" })
  await openRow(s, "#ops")
  const newest = backlog.at(-1)!
  await see((f) => inFeed(f, newest))
  wheelUp(width, 20)
  const scrolled = await see((f) => !inFeed(f, newest), 3000).catch(() => capture())
  await planner.ep.multicast(`meanwhile in general (${tag})`, { channel: "general" })
  await sleep(1500)
  const held = capture()
  save("scrolled-back")
  check(`${at}: the conversation scrolled back with the wheel stays there while the space updates`, !inFeed(scrolled, newest) && !inFeed(held, newest), held)
  keys("Up")
  await see(has("↳ "))
  await esc()
  await see((f) => inFeed(f, newest))

  keys("C-c")
  const asked = await see(has("Quit with 1 unsent draft?"), 4000)
  save("quit-asks")
  keys("y")
  const exited = await see(has("EXIT=0"), 15000)
  save("exited")
  check(`${at}: ctrl+c in the box with a draft asks first, then exits 0 and prints how the session closed`, asked.includes("y quit · n esc enter stay") && exited.includes(`${s.space}: `) && exited.replace(/\n/g, "").includes("messages already sent remain"), exited)
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
    await see(has("Your name is"), 4000)
    await sleep(300)
  }
  launch(s.root, 209, 52, join(work, `${s.mode}-rename.err`))
  await see((f) => live(s.space)(f) && nameAtBottom(209).name === login, 20000)
  await dialog()
  type("Ops Lead")
  keys("Enter")
  const refused = await see(has('invalid name "Ops Lead"'), 4000)
  check(`${at}: Change your name refuses a name an @mention cannot reach and keeps the dialog open`, refused.includes("Your name is") && nameAtBottom(209).name === login, refused)
  keys("C-u")
  type("ops-lead")
  keys("Enter")
  const renamed = await see((f) => !f.includes("Your name is") && nameAtBottom(209).name === "ops-lead")
  const hello = `hello as ops-lead (${tag})`
  type(hello)
  const typed = await see((f) => middleLines(f, 209).includes(hello), 4000)
  keys("Enter")
  const named = await until(() => s.reader.getRoster().find((p) => p.card.name === "ops-lead" && p.status !== "offline"), (p) => p !== undefined)
  const landed = await until(() => s.reader.channelHistory("general", { limit: 200 }), (h) => h.some((m) => textOf(m) === hello))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `renamed-${tag}.txt`), capture())
  writeFileSync(join(dir, `renamed-${tag}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
  check(`${at}: Change your name shows the new name at the bottom of the tree, and the box still takes text once the dialog closes`, nameAtBottom(209).name === "ops-lead" && middleLines(typed, 209).includes(hello), renamed)
  check(`${at}: the next session appears under the new name on the roster and posts from it`, named?.card.meta?.sessionKind === "chat" && landed.some((m) => textOf(m) === hello && m.from.id === named.card.id), JSON.stringify(named?.card))

  await openRow(s, "planner")
  const dm = `from ops-lead (${tag})`
  type(dm)
  keys("Enter")
  await until(() => s.reader.dmHistory({ limit: 500 }), (h) => h.some((m) => textOf(m) === dm && m.from.id === named?.card.id))
  const back = `noted, ops-lead (${tag})`
  await s.peer("planner/planner").ep.unicast(named?.card.id ?? "unknown", back)
  await see((f) => middleLines(f, 209).includes(`┃ ${back}`))
  await dialog()
  keys("Enter")
  await see((f) => !f.includes("Your name is"), 4000)
  type("/quit")
  keys("Enter")
  await see((f) => middle(f, 209).includes("you ended it"))
  const walked: string[] = []
  for (let i = 0; i < 8; i++) {
    keys("Up")
    await sleep(250)
    walked.push(capture())
  }
  writeFileSync(join(dir, `renamed-quote-after-quit-${tag}.txt`), walked.find((f) => f.includes("↳ ops-lead:")) ?? walked.at(-1)!)
  check(
    `${at}: after Change your name and /quit, ↑ in planner's conversation quotes none of the direct messages the ended ops-lead session sent`,
    walked.some((f) => f.includes("↳ planner:")) && walked.every((f) => !f.includes("↳ ops-lead:")),
    walked.find((f) => f.includes("↳ ops-lead:")) ?? walked.at(-1)!,
  )
  await esc()

  const outside = cli("config", "set", "name", "ops-lead-2")
  if (outside.status !== 0) throw new Error(`cotal config set name failed:\n${outside.stdout}${outside.stderr}`)
  const offered = await see((f) => /enter opens a new one as \S+/.test(middle(f, 209)), 4000)
  const shown = /enter opens a new one as (\S+)/.exec(middle(offered, 209))?.[1]
  keys("Enter")
  const opened = await see((f) => /new session as \S+; enter sends/.test(middle(f, 209)))
  const told = /new session as (\S+); enter sends/.exec(middle(opened, 209))?.[1]
  const joined = await until(
    () => s.reader.getRoster().find((p) => p.card.meta?.sessionKind === "chat" && p.status !== "offline" && p.card.id !== named?.card.id && [login, "ops-lead-2"].includes(p.card.name)),
    (p) => p !== undefined,
  )
  writeFileSync(join(dir, `renamed-outside-${tag}.txt`), opened)
  check(
    `${at}: with the name changed outside the app, the session enter opens joins under the name the box gave before and after the enter`,
    !!shown && shown === told && joined?.card.name === told,
    JSON.stringify({ shown, told, joined: joined?.card.name }),
  )
  cli("config", "unset", "name")
  keys("C-c")
  await see(has("EXIT=0"), 15000)
}

/** Enter on the first message, then a switch to the other space before the session that enter opens
 *  is up. The message still goes where it was typed, and the box sends again in the new space. */
async function switchWhileOpening(s: Space, tag: string) {
  const at = `${s.mode} 209x52`
  const err = join(work, `${s.mode}-switch.err`)
  launch(s.root, 209, 52, err)
  await see((f) => live(s.space)(f) && nameAtBottom(209).name === login, 20000)
  const first = `sent as the space switched (${tag})`
  type(first)
  await see((f) => middleLines(f, 209).includes(first), 4000)
  // One write, so the switch lands while the session the enter opens is still coming up.
  keys("Enter", "Tab", ...times(40, "k"), ...times(s.other.row, "j"), "Enter")
  const switched = await see(live(s.other.space), 20000)
  const landed = await until(() => s.reader.channelHistory("general", { limit: 200 }), (h) => h.some((m) => textOf(m) === first))
  check(
    `${at}: enter, then a switch to ${s.other.space} while the session opens: the message lands once in #general on ${s.space}`,
    landed.filter((m) => textOf(m) === first).length === 1,
    `stderr: ${readFileSync(err, "utf8")}\n${switched}`,
  )
  const other = new CotalEndpoint({ space: s.other.space, servers: server, card: { name: "reader", kind: "endpoint" }, consume: false, registerPresence: false })
  other.on("error", () => {})
  started.push(other)
  await other.start()
  const next = `first on ${s.other.space} (${tag})`
  type(next)
  keys("Enter")
  const there = await until(() => other.channelHistory("general", { limit: 200 }), (h) => h.some((m) => textOf(m) === next))
  const after = capture()
  writeFileSync(join(captures, `${s.mode}-switch-while-opening.txt`), after)
  check(
    `${at}: after that switch, enter on ${s.other.space} opens a session there and sends`,
    there.some((m) => textOf(m) === next) && !middle(after, 209).includes("still being sent"),
    `stderr: ${readFileSync(err, "utf8")}\n${after}`,
  )
  keys("C-c")
  await see(has("EXIT=0"), 15000)
}

/** A first message whose session cannot open, because the static space's manager is held. A switch
 *  and a quit each stop waiting for it after 5 seconds and say it was not sent, and the space the
 *  switch opens sends at once. */
async function heldManager(s: Space, tag: string) {
  const at = `${s.mode} 209x52`
  const dot = join(s.root, ".cotal")
  const pidFile = readdirSync(dot).find((f) => /^manager\.[^.]+\.pid$/.test(f))
  if (!pidFile) throw new Error(`no manager pidfile in ${dot}`)
  const manager = Number(readFileSync(join(dot, pidFile), "utf8").trim())
  const other = new CotalEndpoint({ space: s.other.space, servers: server, card: { name: "reader", kind: "endpoint" }, consume: false, registerPresence: false })
  other.on("error", () => {})
  started.push(other)
  await other.start()
  const notSent = (frame: string) => toastOf(frame).replace(/\s+/g, "").includes("yourmessagewasnotsent")
  const opening = (frame: string) => frame.includes(`joining ${s.space} as ${login}`)
  const dir = join(captures, s.mode, "209x52")
  mkdirSync(dir, { recursive: true })

  launch(s.root, 209, 52, join(work, `${s.mode}-held.err`))
  await see((f) => live(s.space)(f) && nameAtBottom(209).name === login, 20000)
  const first = `sent while the manager is held (${tag})`
  type(first)
  await see((f) => middleLines(f, 209).includes(first), 4000)
  process.kill(manager, "SIGSTOP")
  try {
    keys("Enter")
    await see(opening, 4000)
    keys("Tab", ...times(40, "k"), ...times(s.other.row, "j"), "Enter")
    const waited: string[] = []
    const start = Date.now()
    while (!live(s.other.space)(waited.at(-1) ?? "") && Date.now() - start < 20000) {
      waited.push(capture())
      await sleep(200)
    }
    const next = `sent on ${s.other.space} at once (${tag})`
    type(next)
    keys("Enter")
    const after = await see(has("still being sent"), 1000)
    const there = await until(() => other.channelHistory("general", { limit: 200 }), (h) => h.some((m) => textOf(m) === next), 4000)
    writeFileSync(join(dir, `held-switch-${tag}.txt`), [...waited, after].join("\n----\n"))
    check(
      `${at}: while the switch waits for the first message, the conversation says it is leaving ${s.space}, not that it is finding the space for this folder`,
      waited.some((f) => middle(f, 209).includes(`Leaving ${s.space}…`)) && !waited.some((f) => f.includes("Finding the space for this folder")),
      waited.find((f) => f.includes("Finding the space for this folder")) ?? waited.at(-1)!,
    )
    check(`${at}: the switch says the first message was not sent`, [...waited, after].some(notSent), [...waited, after].map(toastOf).filter(Boolean).join("\n") || after)
    check(
      `${at}: on ${s.other.space}, enter sends at once while the message on ${s.space} still waits for its session`,
      !after.includes("still being sent") && there.some((m) => textOf(m) === next),
      `${Date.now() - start}ms after the switch\n${after}`,
    )
  } finally {
    process.kill(manager, "SIGCONT")
  }
  keys("C-c")
  await see(has("Quit with"), 4000)
  keys("y")
  await see(has("EXIT=0"), 15000)

  launch(s.root, 209, 52, join(work, `${s.mode}-held-quit.err`))
  await see((f) => live(s.space)(f) && nameAtBottom(209).name === login, 20000)
  const last = `sent as the app quits (${tag})`
  type(last)
  await see((f) => middleLines(f, 209).includes(last), 4000)
  process.kill(manager, "SIGSTOP")
  let exited = ""
  try {
    keys("Enter")
    await see(opening, 4000)
    keys("C-c")
    await see(has("Quit with 1 unsent draft?"), 4000)
    keys("y")
    exited = await see(has("EXIT=0"), 20000)
  } finally {
    process.kill(manager, "SIGCONT")
  }
  writeFileSync(join(dir, `held-quit-${tag}.txt`), exited)
  check(
    `${at}: quitting while the first message waits for its session says, as the app exits, that it was not sent`,
    exited.replace(/\s+/g, "").includes(`${s.space}:thesessionwasstillopeningafter5seconds,soyourmessagewasnotsent`),
    exited,
  )
  await sleep(3000)
  const stored = (await s.reader.channelHistory("general", { limit: 200 })).filter((m) => textOf(m) === first || textOf(m) === last)
  check(`${at}: neither message the app said was not sent was stored`, stored.length === 0, JSON.stringify(stored))
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
  await switchWhileOpening(open, "sw")
  try {
    await heldManager(stat, "held")
  } catch (e) {
    check(`${stat.mode} 209x52: the held-manager flow ran to its end`, false, `${(e as Error).message}\n${capture()}`)
  }
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
