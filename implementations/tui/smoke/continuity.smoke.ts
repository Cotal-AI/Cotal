/**
 * Direct messages survive the app quitting and starting again. On an open space on a broker this
 * suite starts, and on a static-auth space that a real `cotal up --detach` stack serves, the human
 * writes to an agent from the input box at 209x52 and the agent answers with a reply to it. The app
 * remembers the session in one private file under the Cotal home that holds no credential. After it
 * quits and starts again, the reply's card is back, the agent's conversation shows the message and
 * the reply, `↑` quotes the reply, and `enter` sends an answer that the agent receives with the
 * reply's id, from a new session under the same name. After the next restart the answer shows and
 * the answered card stays gone. The agent then writes to the first session: on the open space the
 * message shows as it arrives, and on the static space at the next start. On the open space two
 * copies of the app then write at once, each
 * under its own session, and both sessions' records read back whole. Last, the broker restarts with a
 * default user that may not read direct messages, and the agent's conversation says the earlier ones
 * were not read and why.
 *
 * On the open space the agent also writes to the human unprompted. The message is listed under unread
 * direct messages above the replies, and is still listed after a restart. `w` opens it, the card goes,
 * and a private file under the Cotal home records it as read, so it stays gone at the next start. Where
 * the broker refuses the read, the unread group says so. Captures are kept under the printed directory.
 *
 * Needs Node >= 26.4, tmux and nats-server, and the manager built, so it is not part of smoke:ci.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CotalEndpoint, dmStream, isReachable, setupSpaceStreams, type CotalMessage } from "@cotal-ai/core"
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, awaitBrokerReady, freePort, killAndAwaitExit, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit"
import { layoutFor } from "../src/layout.js"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui continuity smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

const pkg = fileURLToPath(new URL("..", import.meta.url))
const repo = join(pkg, "..", "..")
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const CLI = join(repo, "bin", "cotal.ts")
const TSX = join(repo, "node_modules", ".bin", "tsx")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-continuity-"))
const captures = process.env.CONTINUITY_CAPTURES ?? join(work, "captures")
const home = join(work, "home")
const cotalHome = join(home, ".cotal")
const xdg = join(home, ".config")
const roots = { open: join(work, "open"), static: join(work, "static") }
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))
const socket = `cotal-tui-continuity-${process.pid}`
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: "pipe" })
// Each project folder holds a `.cotal`, so a launch there opens its own space.
for (const dir of Object.values(roots)) mkdirSync(join(dir, ".cotal"), { recursive: true })
mkdirSync(home, { recursive: true, mode: 0o700 })
const anchor = recordSmokeSandbox({ root: roots.static, cotalHome, xdgConfigHome: xdg })
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_"))), HOME: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" }
Object.assign(process.env, { HOME: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdg })
const { recordMesh, spaceSegment } = await import("@cotal-ai/workspace")

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass++
  else fail++
  console.log(ok ? `  ✓ ${name}` : `  ✗ FAIL: ${name}${detail ? `\n${detail}` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(read: () => T | undefined, ms = 20000): Promise<T | undefined> {
  const start = Date.now()
  for (;;) {
    const v = read()
    if (v !== undefined || Date.now() - start > ms) return v
    await sleep(100)
  }
}
const textOf = (m: CotalMessage) => (m.parts ?? []).map((p) => ("text" in p ? p.text : "")).join("")
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)
/** The app's remembered-session files for `space`, each with its mode and its parsed record. */
function remembered(space: string) {
  const folder = join(cotalHome, "chat-sessions", spaceSegment(space))
  const files = existsSync(folder) ? readdirSync(folder).filter((f) => f !== "read.json") : []
  return { folder, mode: existsSync(folder) ? mode(folder) : "none", files: files.map((f) => ({ f, mode: mode(join(folder, f)), record: JSON.parse(readFileSync(join(folder, f), "utf8")) as Record<string, unknown> })) }
}

const cli = (...args: string[]) => {
  const options = { cwd: roots.static, env, encoding: "utf8" as const, timeout: 120_000 }
  assertSmokeSandboxDown(anchor, args, options)
  return spawnSync(TSX, [CLI, ...args], options)
}

const port = await freePort()
const server = `nats://127.0.0.1:${port}`
let broker: ChildProcess | undefined
let release = () => {}
/** A configuration for the open space's broker on its store, written in the store's folder. */
function brokerConf(name: string, extra = "") {
  const path = join(store, name)
  writeFileSync(path, `listen: 127.0.0.1:${port}\njetstream { store_dir: "${store}" }\n${extra}`)
  return path
}
async function startBroker(conf: string) {
  let output = ""
  broker = spawn("nats-server", ["-c", conf], { stdio: ["ignore", "pipe", "pipe"] })
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

const W = 209
const H = 52
const L = layoutFor(W)
const capture = (t: string) => tmux("capture-pane", "-p", "-t", t)
const keys = (t: string, ...k: string[]) => tmux("send-keys", "-t", t, ...k)
const times = (n: number, key: string) => Array<string>(n).fill(key)
async function see(t: string, test: (frame: string) => boolean, ms = 20000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const frame = capture(t)
    if (test(frame) || Date.now() - start > ms) return frame
    await sleep(50)
  }
}
const titleOf = (frame: string) => frame.split("\n").find((l) => l.includes("SPACES")) ?? ""
const live = (space: string) => (frame: string) => titleOf(frame).includes(`#general  ${space}`) && frame.includes("reviewer")
const tree = (frame: string) => frame.split("\n").map((line) => [...line].slice(0, L.tree).join("").trim())
const inspector = (frame: string) => (L.kind === "three" ? frame.split("\n").map((line) => [...line].slice(W - L.inspector).join("").trim()) : [])
const middle = (frame: string) => frame.trimEnd().split("\n").slice(0, -1).map((line) => [...line].slice(L.tree, L.kind === "three" ? W - L.inspector : W).join("").trim())
// Spaces dropped, since the column may wrap a sentence inside a word.
const says = (frame: string, text: string) => middle(frame).join("").replace(/\s+/g, "").includes(text.replace(/\s+/g, ""))
const inFeed = (frame: string, text: string) => middle(frame).includes(`┃ ${text}`)
const replyCard = (frame: string) => inspector(frame).some((l) => /^\d+ ↩ reviewer\s+→ you$/.test(l))
const quoteLine = (frame: string) => middle(frame).find((l) => l.startsWith("↳ ")) ?? ""
const group = (frame: string, title: string) => inspector(frame).findIndex((l) => l.startsWith(title))
const unreadCard = (text: string) => (frame: string) => {
  const lines = inspector(frame)
  const at = lines.findIndex((l) => /^1 • reviewer$/.test(l))
  return group(frame, "UNREAD DMS · 1") >= 0 && at > group(frame, "UNREAD DMS") && lines[at + 1] === text
}
function save(t: string, dir: string, name: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), capture(t))
}

function launch(t: string, root: string, err: string) {
  try {
    tmux("kill-session", "-t", t)
  } catch {}
  const line = `cd ${root} && env -u XDG_CONFIG_HOME HOME=${home} COTAL_HOME=${cotalHome} XDG_CONFIG_HOME=${xdg} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
  tmux("new-session", "-d", "-s", t, "-x", String(W), "-y", String(H), line)
  tmux("set-option", "-s", "escape-time", "10")
}
async function toTree(t: string) {
  keys(t, "Escape")
  await sleep(150)
  keys(t, "Tab")
  await sleep(150)
}
/** Opens the tree row whose conversation is titled `name`, counting down past the space rows, where
 *  enter would switch spaces. */
async function openRow(t: string, space: string, name: string): Promise<string> {
  for (let i = 0; i < 16; i++) {
    await toTree(t)
    const lines = tree(capture(t))
    const spaces = lines.slice(lines.findIndex((l) => l.startsWith("SPACES")) + 1, lines.findIndex((l) => l.startsWith("CHANNELS"))).filter(Boolean).length
    keys(t, ...times(40, "k"), ...times(spaces + i, "j"))
    await sleep(80)
    const before = titleOf(capture(t))
    keys(t, "Enter")
    const frame = await see(t, (f) => titleOf(f) !== before, 1500)
    if (titleOf(frame).includes(`${name}  ${space}`)) return frame
  }
  throw new Error(`could not open ${name}:\n${capture(t)}`)
}
async function send(t: string, text: string) {
  keys(t, "-l", text)
  await sleep(200)
  keys(t, "Enter")
}
async function quit(t: string) {
  await toTree(t)
  keys(t, "q")
  await see(t, (f) => f.includes("EXIT=0"), 30000)
}

/** An agent that answers each direct message asking for a review with a reply to it. */
type Reviewer = { ep: CotalEndpoint; got: CotalMessage[]; replies: Map<string, string> }
function reviewer(ep: CotalEndpoint): Reviewer {
  const got: CotalMessage[] = []
  const replies = new Map<string, string>()
  ep.on("error", () => {})
  ep.on("message", (m: CotalMessage) => {
    got.push(m)
    if (m.channel === undefined && textOf(m).startsWith("can you review")) void ep.unicast(m.from.id, `LGTM: ${textOf(m)}`, { replyTo: m.id }).then((r) => replies.set(m.id, r.id))
  })
  return { ep, got, replies }
}

type Space = { mode: "open" | "static"; space: string; server: string; root: string; reviewer: Reviewer }

/** Run 1 asks, run 2 answers the reply, run 3 reads the conversation back, and then the agent writes
 *  to run 1's session. */
async function continuity(s: Space) {
  const at = s.mode
  const dir = join(captures, at)
  const t = "t"
  const ask = `can you review PR 42 (${at})`
  const reply = `LGTM: ${ask}`
  const answer = `thanks, fixed it (${at})`

  launch(t, s.root, join(work, `${at}-1.err`))
  await see(t, live(s.space), 30000)
  await openRow(t, s.space, "reviewer")
  await send(t, ask)
  const asked = await until(() => s.reviewer.got.find((m) => textOf(m) === ask), 30000)
  const replyId = await until(() => (asked ? s.reviewer.replies.get(asked.id) : undefined))
  const first = await see(t, (f) => replyCard(f) && inFeed(f, reply))
  save(t, dir, "01-run1-reply-card")
  check(`${at}: run 1: the agent's reply to the human's direct message makes a reply card`, asked !== undefined && replyId !== undefined && replyCard(first) && inFeed(first, reply), first)
  await quit(t)

  const saved = remembered(s.space)
  writeFileSync(join(dir, "remembered-record.json"), `${JSON.stringify(saved, null, 2)}\n`)
  const record = saved.files[0]?.record ?? {}
  check(
    `${at}: the app remembered the session in one 0600 file in a 0700 folder, with its principal and no credential`,
    saved.files.length === 1 && saved.mode === "700" && saved.files[0]!.mode === "600" && record.principal === asked?.from.id &&
      JSON.stringify(Object.keys(record).sort()) === JSON.stringify(["label", "lifecycleUid", "openedAt", "principal", "server", "space", "v"]),
    JSON.stringify(saved),
  )

  launch(t, s.root, join(work, `${at}-2.err`))
  await see(t, live(s.space), 30000)
  const back = await see(t, replyCard, 15000)
  save(t, dir, "02-run2-relaunched")
  check(`${at}: after a restart the reply card is back`, replyCard(back), back)
  await openRow(t, s.space, "reviewer")
  const history = await see(t, (f) => inFeed(f, ask) && inFeed(f, reply), 8000)
  save(t, dir, "03-run2-conversation")
  check(`${at}: after a restart the agent's conversation shows the message and the reply`, inFeed(history, ask) && inFeed(history, reply), history)
  keys(t, "Up")
  const quoted = await see(t, (f) => quoteLine(f).startsWith(`↳ reviewer: “${reply}`), 4000)
  save(t, dir, "04-run2-up-quotes")
  check(`${at}: after a restart ↑ quotes the reply`, quoteLine(quoted).startsWith(`↳ reviewer: “${reply}`), quoted)
  await send(t, answer)
  const answered = await until(() => s.reviewer.got.find((m) => textOf(m) === answer), 30000)
  check(
    `${at}: enter sends the answer, which the agent receives with the reply's id, from a new session under the same name`,
    answered !== undefined && answered.replyTo === replyId && answered.from.id !== asked?.from.id && answered.from.name === asked?.from.name,
    JSON.stringify({ answered, asked }),
  )
  const gone = await see(t, (f) => inFeed(f, answer) && !replyCard(f), 10000)
  save(t, dir, "05-run2-answered")
  check(`${at}: the card goes once the answer shows`, inFeed(gone, answer) && !replyCard(gone), gone)
  await quit(t)

  launch(t, s.root, join(work, `${at}-3.err`))
  await see(t, live(s.space), 30000)
  await openRow(t, s.space, "reviewer")
  const third = await see(t, (f) => inFeed(f, answer), 8000)
  save(t, dir, "06-run3-conversation")
  check(`${at}: after another restart the conversation keeps the message, the reply and the answer, and the answered card stays gone`, inFeed(third, ask) && inFeed(third, reply) && inFeed(third, answer) && !replyCard(third), third)

  // An agent finishing an earlier request writes to the session that asked.
  const late = `one more thing (${at})`
  if (asked) await s.reviewer.ep.unicast(asked.from.id, late)
  if (s.mode === "open") {
    const arrived = await see(t, (f) => inFeed(f, late), 8000)
    save(t, dir, "07-run3-late-message")
    check("open: a direct message to an earlier session shows in its conversation as it arrives", inFeed(arrived, late), arrived)
    return quit(t)
  }
  await quit(t)
  launch(t, s.root, join(work, `${at}-4.err`))
  await see(t, live(s.space), 30000)
  await openRow(t, s.space, "reviewer")
  const next = await see(t, (f) => inFeed(f, late), 8000)
  save(t, dir, "07-run4-late-message")
  check("static: a direct message to an earlier session shows at the next start", inFeed(next, late), next)
  await quit(t)
}

/** The agent writes to the human's earlier session `to` unprompted, then the app restarts around
 *  opening it. */
async function unreadDm(s: Space, to: string) {
  const dir = join(captures, "unread")
  const t = "t"
  const text = `are you around? (${s.mode})`
  launch(t, s.root, join(work, "unread-1.err"))
  await see(t, live(s.space), 30000)
  await see(t, (f) => group(f, "REPLIES AND MENTIONS") >= 0, 15000)
  const sent = await s.reviewer.ep.unicast(to, text)
  const listed = await see(t, unreadCard(text))
  save(t, dir, "01-listed")
  check(`${s.mode}: an agent's direct message to the human is listed under unread DMs, above the replies`, unreadCard(text)(listed) && group(listed, "UNREAD DMS") < group(listed, "REPLIES AND MENTIONS"), listed)
  await quit(t)

  launch(t, s.root, join(work, "unread-2.err"))
  await see(t, live(s.space), 30000)
  const kept = await see(t, unreadCard(text), 15000)
  save(t, dir, "02-after-restart")
  check(`${s.mode}: after a restart the unread direct message is still listed`, unreadCard(text)(kept), kept)
  await toTree(t)
  keys(t, "w")
  const opened = await see(t, (f) => titleOf(f).includes(`reviewer  ${s.space}`) && inFeed(f, text) && group(f, "UNREAD DMS") < 0, 8000)
  save(t, dir, "03-opened")
  check(`${s.mode}: w opens the agent's conversation and the card goes`, titleOf(opened).includes(`reviewer  ${s.space}`) && inFeed(opened, text) && group(opened, "UNREAD DMS") < 0, opened)
  await quit(t)
  const path = join(cotalHome, "chat-sessions", spaceSegment(s.space), "read.json")
  const marks = existsSync(path) ? { mode: mode(path), record: JSON.parse(readFileSync(path, "utf8")) as { read?: Record<string, number> } } : undefined
  check(`${s.mode}: the read message is recorded by id in a 0600 file`, marks?.mode === "600" && marks.record.read?.[sent.id] !== undefined, JSON.stringify(marks))

  launch(t, s.root, join(work, "unread-3.err"))
  await see(t, live(s.space), 30000)
  const after = await see(t, (f) => group(f, "REPLIES AND MENTIONS") >= 0, 15000)
  save(t, dir, "04-after-second-restart")
  check(`${s.mode}: after another restart the opened message stays read while the replies are still listed`, group(after, "REPLIES AND MENTIONS") >= 0 && group(after, "UNREAD DMS") < 0, after)
  await quit(t)
}

const started: CotalEndpoint[] = []
let stackUp = false
try {
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, captures in ${captures}`)
  await startBroker(brokerConf("open.conf"))
  const open: Space = {
    mode: "open",
    space: "team-alpha",
    server,
    root: roots.open,
    reviewer: reviewer(new CotalEndpoint({ space: "team-alpha", servers: server, card: { name: "reviewer", kind: "agent", role: "reviewer" }, channels: ["general"], heartbeatMs: 500, ttlMs: 3000 })),
  }
  await setupSpaceStreams({ servers: server, space: open.space })
  recordMesh({ space: open.space, server, root: open.root, mode: "open", origin: "manual", ts: new Date().toISOString() })
  started.push(open.reviewer.ep)
  await open.reviewer.ep.start()
  await continuity(open)

  // Two copies of the app on one space, each writing.
  const both = ["a", "b"].map((t) => ({ t, ask: `can you review PR 43 (${t})` }))
  for (const { t } of both) launch(t, open.root, join(work, `two-${t}.err`))
  for (const { t, ask } of both) {
    await see(t, live(open.space), 30000)
    await openRow(t, open.space, "reviewer")
    await send(t, ask)
  }
  const asks = await until(() => {
    const got = both.map(({ ask }) => open.reviewer.got.find((m) => textOf(m) === ask))
    return got.every(Boolean) ? (got as CotalMessage[]) : undefined
  }, 30000)
  const frames = await Promise.all(both.map(({ t, ask }) => see(t, (f) => inFeed(f, `LGTM: ${ask}`))))
  both.forEach(({ t }) => save(t, join(captures, "two"), `app-${t}`))
  check(
    "open: two copies of the app on one space each send under their own session and show the reply",
    asks !== undefined && asks[0]!.from.id !== asks[1]!.from.id && frames.every((f, i) => inFeed(f, `LGTM: ${both[i]!.ask}`)),
    frames.join("\n"),
  )
  for (const { t } of both) await quit(t)
  const records = remembered(open.space)
  check(
    "open: both sessions' records read back whole, beside the two the runs before opened",
    asks !== undefined && records.files.length === 4 && records.files.every((r) => r.f.endsWith(".json") && r.mode === "600") && asks.every((m) => records.files.some((r) => r.record.principal === m.from.id)),
    JSON.stringify(records),
  )

  if (asks) await unreadDm(open, asks[0]!.from.id)

  // The broker comes back with a default user that may not create consumers on the DM stream.
  await stopBroker()
  const dm = dmStream(open.space)
  await startBroker(
    brokerConf(
      "no-dm-reads.conf",
      `authorization {\n  users = [ { user: "anon", password: "anon", permissions: { publish: { allow: ">", deny: ["$JS.API.CONSUMER.CREATE.${dm}", "$JS.API.CONSUMER.CREATE.${dm}.>"] }, subscribe: { allow: ">" } } } ]\n}\nno_auth_user: "anon"\n`,
    ),
  )
  launch("t", open.root, join(work, "denied.err"))
  await see("t", live(open.space), 30000)
  await openRow("t", open.space, "reviewer")
  const denied = await see("t", (f) => says(f, "Your direct messages from earlier sessions were not read"), 15000)
  save("t", join(captures, "denied"), "01-reviewer-conversation")
  check(
    "open: where the broker refuses the read, the agent's conversation says the earlier direct messages were not read and why, and shows none",
    says(denied, "Your direct messages from earlier sessions were not read: the broker does not let this app read direct messages") && says(denied, "Permissions Violation") && !inFeed(denied, `can you review PR 42 (open)`),
    denied,
  )
  await sleep(11_000)
  const later = capture("t")
  save("t", join(captures, "denied"), "02-after-the-toast")
  check("open: the conversation still says so after the toast has gone", says(later, "Your direct messages from earlier sessions were not read"), later)
  check(
    "open: where the broker refuses the read, the unread direct messages say they were not read rather than listing none",
    group(later, "UNREAD DMS · 0") >= 0 && inspector(later).join("").replace(/\s+/g, "").includes("Yourdirectmessagesfromearliersessionswerenotread"),
    later,
  )
  await quit("t")
  await stopBroker()

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
  const out = cli("auth", "mint", "reviewer", "--out", join(roots.static, "reviewer.creds"), "--json", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "reviewer", "--provision")
  if (out.status !== 0) throw new Error(`cotal auth mint reviewer failed:\n${out.stdout}${out.stderr}`)
  const minted = (JSON.parse(out.stdout) as { result: { principal: string; lifecycleUid: string } }).result
  const [owner, ...actor] = minted.principal.split(".")
  const sserver = `nats://127.0.0.1:${sport}`
  const fixed: Space = {
    mode: "static",
    space: "team-static",
    server: sserver,
    root: roots.static,
    reviewer: reviewer(new CotalEndpoint({ space: "team-static", servers: sserver, creds: readFileSync(join(roots.static, "reviewer.creds"), "utf8"), lifecycleUid: minted.lifecycleUid, card: { owner: owner!, actor: actor.join("."), name: "reviewer", kind: "agent", role: "reviewer" }, channels: ["general"] })),
  }
  started.push(fixed.reviewer.ep)
  await fixed.reviewer.ep.start()
  await continuity(fixed)
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

console.log(`TUI CONTINUITY SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
