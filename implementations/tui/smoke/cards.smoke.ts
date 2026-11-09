/**
 * Drives the real launcher in tmux at 209x52, 97x49 and 80x24 against an open space on a broker this
 * suite starts, with an isolated HOME and config folder. At each size the human posts to #general
 * from the input box under a name saved for that size, then watches all traffic while peers answer:
 * a reply to the post in #general, a mention in #design and a direct message that replies to the
 * post. A mention of someone else and a reply to a peer's own message must make no card. The
 * inspector lists the waiting agent first, then the replies and mentions newest first; at 80x24 one
 * line counts them. `w`, a click and a number open them in the middle, each card clears once its
 * conversation is open, and a mention that arrives in the open conversation never makes one.
 * Captures are kept under the printed directory.
 *
 * Needs Node >= 26.4, tmux and nats-server, so it is not part of smoke:ci, which runs Node 22.
 * Run: pnpm --filter @cotal-ai/tui smoke
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CotalEndpoint, isReachable, setupSpaceStreams, type CotalMessage } from "@cotal-ai/core"
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit"
import { layoutFor } from "../src/layout.js"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major! < 26 || (major === 26 && minor! < 4)) throw new Error(`the tui cards smoke needs Node >= 26.4.0, this is ${process.versions.node}`)
execFileSync("tmux", ["-V"])

const pkg = fileURLToPath(new URL("..", import.meta.url))
const launcher = join(pkg, "bin", "cotal-tui.mjs")
const work = mkdtempSync(join(tmpdir(), "cotal-tui-cards-"))
const captures = process.env.CARDS_CAPTURES ?? join(work, "captures")
const home = join(work, "home")
const xdg = join(home, ".config")
const project = join(work, "project")
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))
const socket = `cotal-tui-cards-${process.pid}`
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
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
async function until<T>(read: () => T | undefined, what: string, timeout = 10000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = read()
    if (v !== undefined) return v
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
const has = (text: string) => (frame: string) => frame.includes(text)
const titleOf = (frame: string) => frame.split("\n").find((l) => l.includes("SPACES")) ?? ""
const footer = (frame: string) => frame.trimEnd().split("\n").at(-1)!.trim()
const titled = (name: string) => (frame: string) => titleOf(frame).includes(`${name}  ${space}`)
/** The inspector column's lines, trimmed. */
function inspector(frame: string, width: number): string[] {
  const l = layoutFor(width)
  return l.kind === "three" ? frame.split("\n").map((line) => [...line].slice(width - l.inspector).join("").trim()) : []
}
/** The conversation column's lines, trimmed, without the footer. */
function middle(frame: string, width: number): string[] {
  const l = layoutFor(width)
  const end = l.kind === "three" ? width - l.inspector : width
  return frame.trimEnd().split("\n").slice(0, -1).map((line) => [...line].slice(l.tree, end).join("").trim())
}
/** The cards' first lines in the inspector, top to bottom, from the `REPLIES AND MENTIONS` header on. */
function cardHeads(frame: string, width: number): string[] {
  const lines = inspector(frame, width)
  const at = lines.findIndex((l) => l.startsWith("REPLIES AND MENTIONS"))
  return at < 0 ? [] : lines.slice(at + 1).filter((l) => /^\d+ [↩@] /.test(l))
}
const summaryOf = (frame: string, width: number) => middle(frame, width).find((l) => /need|repl|mention/.test(l) && !l.includes("  ")) ?? ""
const save = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), capture())
  writeFileSync(join(dir, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "t"))
}
const keys = (...k: string[]) => tmux("send-keys", "-t", "t", ...k)
const times = (n: number, key: string) => Array<string>(n).fill(key)
/** A click where `text` starts on screen, as a terminal reports it in SGR mouse mode. */
function click(text: string) {
  const rows = capture().split("\n")
  const y = rows.findIndex((l) => l.includes(text))
  if (y < 0) throw new Error(`nothing to click: ${text} is not on screen`)
  const x = [...rows[y]!.slice(0, rows[y]!.indexOf(text))].length + 1
  keys("-l", `\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`)
}
// A key sent within tmux's escape-time after Escape would read as alt+<key>.
async function toTree() {
  keys("Escape")
  await sleep(150)
  keys("Tab")
  await sleep(150)
}
/** Opens the tree row titled `name`, counting down from the top past the one space row. */
async function openRow(name: string): Promise<string> {
  for (let i = 0; i < 24; i++) {
    await toTree()
    keys(...times(40, "k"), ...times(1 + i, "j"))
    await sleep(80)
    const before = titleOf(capture())
    keys("Enter")
    const frame = await waitFor((f) => titleOf(f) !== before, "a row to open", 1500).catch(() => capture())
    if (titled(name)(frame)) return frame
  }
  throw new Error(`could not open ${name}:\n${capture()}`)
}

function launch(width: number, height: number, err: string) {
  try {
    tmux("kill-session", "-t", "t")
  } catch {}
  const line = `cd ${project} && env -u COTAL_HOME HOME=${home} XDG_CONFIG_HOME=${xdg} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
  tmux("new-session", "-d", "-s", "t", "-x", String(width), "-y", String(height), line)
  tmux("set-option", "-s", "escape-time", "10")
}

const peers: CotalEndpoint[] = []
function peer(name: string, role: string) {
  const got: CotalMessage[] = []
  const ep = new CotalEndpoint({ space, servers: server, card: { name, kind: "agent", role }, channels: ["general", "design"], heartbeatMs: 500, ttlMs: 3000 })
  ep.on("error", () => {})
  ep.on("message", (m: CotalMessage) => got.push(m))
  peers.push(ep)
  return { ep, got }
}
const textOf = (m: CotalMessage) => (m.parts ?? []).map((p) => ("text" in p ? p.text : "")).join("")

try {
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(project)
  await startBroker()
  await setupSpaceStreams({ servers: server, space })
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: xdg })
  delete process.env.COTAL_HOME
  const w = await import("@cotal-ai/workspace")
  w.recordMesh({ space, server, root: project, mode: "open", origin: "manual", ts: new Date().toISOString() })
  w.setCurrent(space)

  const planner = peer("planner", "planner")
  const reviewer = peer("reviewer", "reviewer")
  const coder = peer("coder-2", "coder")
  for (const ep of peers) await ep.start()
  await coder.ep.setStatus("waiting", "needs approval: run migration 0042 on staging?")
  console.log(`node ${process.versions.node}, tmux ${tmux("-V").trim()}, broker ${server}, captures in ${captures}`)

  for (const [width, height] of [[209, 52], [97, 49], [80, 24]] as const) {
    const size = `${width}x${height}`
    const dir = join(captures, size)
    // A name per size, so the history of the sizes before makes no card for this one.
    const me = `lead-${width}`
    w.writePreference({}, "name", me, w.readPreferences().revision)
    const three = layoutFor(width).kind === "three"
    console.log(size)
    launch(width, height, join(work, `${size}.err`))
    await waitFor((f) => titled("#general")(f) && f.includes("coder-2") && footer(f) === "? help · ctrl+p commands", "the live space")

    const post = `standup notes are in (${size})`
    keys("-l", post)
    keys("Enter")
    const mine = await until(() => planner.got.find((m) => textOf(m) === post), "the human's post on the broker")
    const theirs = await planner.ep.multicast(`planner's own note (${size})`, { channel: "general" })
    await openRow("all traffic")

    await planner.ep.multicast(`on it (${size})`, { channel: "general", replyTo: mine.id })
    await reviewer.ep.multicast(`@${me} can you check the mockup (${size})`, { channel: "design", mentions: [me] })
    await reviewer.ep.unicast(mine.from.id, `notes look right (${size})`, { replyTo: mine.id })
    await reviewer.ep.multicast(`@someone-else unrelated (${size})`, { channel: "general", mentions: ["someone-else"] })
    await planner.ep.multicast(`follow-up to myself (${size})`, { channel: "general", replyTo: theirs.id })
    const cards = await waitFor((f) => f.includes(`follow-up to myself (${size})`) && (three ? f.includes("REPLIES AND MENTIONS · 3") : summaryOf(f, width) === "1 needs you · 2 replies · 1 mention"), "three cards")
    save(dir, "01-cards")
    if (three) {
      const lines = inspector(cards, width)
      const needs = lines.findIndex((l) => l.startsWith("NEEDS YOU · 1"))
      const replies = lines.findIndex((l) => l.startsWith("REPLIES AND MENTIONS · 3"))
      check(`${size}: the waiting agent comes first, then the replies and mentions`, needs >= 0 && replies > needs && lines.some((l) => l.startsWith("1 ◐ coder-2")), cards)
      const heads = cardHeads(cards, width)
      check(
        `${size}: the cards are the DM reply, the mention and the channel reply, newest first, numbered after the waiting agent`,
        heads.length === 3 && /^2 ↩ reviewer\s+→ you$/.test(heads[0]!) && /^3 @ reviewer\s+#design$/.test(heads[1]!) && /^4 ↩ planner\s+#general$/.test(heads[2]!),
        heads.join("\n"),
      )
      check(`${size}: a card shows the start of the message`, cards.includes(`@${me} can you check the`) && cards.includes(`notes look right (${size})`), cards)
    } else {
      check(`${size}: with no inspector, one line counts who waits, the replies and the mentions`, summaryOf(cards, width) === "1 needs you · 2 replies · 1 mention" && !cards.includes("REPLIES AND MENTIONS"), cards)
    }
    check(`${size}: a mention of someone else and a reply to a peer's own message make no card`, three ? cardHeads(cards, width).length === 3 : summaryOf(cards, width).endsWith("2 replies · 1 mention"), cards)

    await toTree()
    keys("w")
    await waitFor(has("◐ coder-2 is waiting"), "w to open the waiting agent first")
    check(`${size}: w opens the waiting agent first`, true)
    keys("w")
    const cleared = (f: string) => (three ? cardHeads(f, width).length === 2 && /^2 @ reviewer/.test(cardHeads(f, width)[0]!) : summaryOf(f, width) === "1 needs you · 1 reply · 1 mention")
    const dm = await waitFor((f) => titled("reviewer")(f) && f.includes(`notes look right (${size})`) && cleared(f), "w to open the DM reply in reviewer's conversation", 5000).catch(() => capture())
    save(dir, "02-dm-reply-opened")
    check(`${size}: w next opens the newest card, the DM reply, and it clears`, titled("reviewer")(dm) && cleared(dm), dm)

    if (three) click("@ reviewer")
    else keys("w")
    const design = await waitFor((f) => titled("#design")(f) && f.includes("can you check the mockup"), "the mention to open in #design")
    save(dir, "03-mention-opened")
    check(`${size}: ${three ? "a click on the mention card" : "w again"} opens #design, and the card clears`, three ? cardHeads(design, width).length === 1 && /^2 ↩ planner\s+#general$/.test(cardHeads(design, width)[0]!) : summaryOf(design, width) === "1 needs you · 1 reply", three ? inspector(design, width).join("\n") : design)

    keys("2")
    const general = await waitFor((f) => titled("#general")(f) && f.includes(`on it (${size})`), "2 to open the reply in #general")
    await reviewer.ep.multicast(`@${me} while you are here (${size})`, { channel: "general", mentions: [me] })
    const here = await waitFor(has(`while you are here (${size})`), "a mention in the open conversation")
    await sleep(300)
    const after = capture()
    save(dir, "04-reply-opened")
    check(`${size}: 2 opens the reply in #general, which shows whom it answers`, general.includes(`↩ ${me}`), general)
    check(
      `${size}: a mention in the open conversation makes no card, and only the waiting agent is left`,
      here.includes(`@you`) && (three ? !after.includes("REPLIES AND MENTIONS") && after.includes("NEEDS YOU · 1") : summaryOf(after, width) === "1 needs you"),
      after,
    )

    const back = await openRow("all traffic")
    await sleep(300)
    check(`${size}: opened cards stay cleared after leaving their conversations`, three ? !capture().includes("REPLIES AND MENTIONS") : summaryOf(capture(), width) === "1 needs you", back)

    await toTree()
    keys("q")
    await waitFor(has("EXIT=0"), "q to quit with status 0")
    check(`${size}: q quits with status 0`, true)
  }
} finally {
  try {
    tmux("kill-server")
  } catch {}
  await Promise.all(peers.map((ep) => ep.stop().catch(() => {})))
  if (broker) await killAndAwaitExit(broker)
  release()
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
}

console.log(`TUI CARDS SMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
