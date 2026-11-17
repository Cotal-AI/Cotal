/**
 * Drives the real launcher in tmux at 209x52, 97x49 and 80x24 against an open space on a broker this
 * suite starts, with an isolated HOME and config folder. At each size the human posts to #general
 * from the input box under a name saved for that size, then watches all traffic while peers answer:
 * a reply to the post in #general, a mention in #design and a direct message that replies to the
 * post. A mention of someone else and a reply to a peer's own message must make no card. The
 * inspector lists the waiting agent first, then the replies and mentions newest first; at 80x24 one
 * line counts them. `tab` reaches the inspector from the tree where it is on screen, the arrows and
 * `j` `k` move its highlight, and `enter` opens the item with the keys in the box: a card's message
 * is quoted, so the next `enter` sends a reply to it, and a waiting agent opens with no quote.
 * `w`, a click and a number open and quote too. An opened card stays listed, drawn dimmer than an
 * unseen one, after its conversation is left. A quoted reply reaches the peer with the card's id and
 * the card leaves the list, while a post without the quote leaves it listed. A mention that arrives
 * in the open conversation makes a card already drawn as seen. `x` in the inspector dismisses a card
 * and leaves a waiting agent, and sixteen more cards are all reached by the arrows. After the app
 * quits and starts again on the same space, the replied card stays gone and the dismissed ones are
 * back. At 209x52 the relaunched app then gets two new mentions and an agent posts 250 messages in
 * #ops: both cards stay listed, one is answered and goes, and after 250 more posts in #design it
 * stays gone. The other, whose message has left the loaded rows and #design's history, is still
 * listed after a switch to another space and back, and still opens, quotes and takes a reply. The
 * human then posts, the agent posts 250 more in #ops, and a peer's reply to that post makes a card.
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
// A second space, which a switch opens and leaves.
const other = "team-beta"
// The space rows at the top of the tree.
const SPACE_ROWS = 2
// Posts in another channel, more than the 200 rows of all traffic the app reads.
const FLOOD = 250

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
/** The first lines of the cards on screen in the inspector, top to bottom. */
const cardHeads = (frame: string, width: number) => inspector(frame, width).filter((l) => /^\d+ [↩@] /.test(l))
/** The screen with each cell's background and foreground, read from one capture's SGR escapes. */
function painted(): { text: string[]; bg: string[][]; fg: string[][] } {
  const text: string[] = []
  const bg: string[][] = []
  const fg: string[][] = []
  for (const line of tmux("capture-pane", "-p", "-e", "-t", "t").split("\n")) {
    const back: string[] = []
    const fore: string[] = []
    let b = ""
    let f = ""
    for (const part of line.split(/(\x1b\[[\d;:]*m)/)) {
      const sgr = /^\x1b\[([\d;:]*)m$/.exec(part)
      if (!sgr) {
        for (const _ of part) {
          back.push(b)
          fore.push(f)
        }
        continue
      }
      const p = sgr[1]!.split(";").map(Number)
      for (let k = 0; k < p.length; k++) {
        if (p[k] === 0) b = f = ""
        else if (p[k] === 49) b = ""
        else if (p[k] === 39) f = ""
        else if (p[k] === 38 || p[k] === 48) {
          const n = p[k + 1] === 2 ? 4 : 2
          const color = p.slice(k + 1, k + 1 + n).join(";")
          if (p[k] === 48) b = color
          else f = color
          k += n
        }
      }
    }
    text.push(line.replace(/\x1b\[[\d;:]*m/g, ""))
    bg.push(back)
    fg.push(fore)
  }
  return { text, bg, fg }
}
const luminance = (color: string) => {
  const [r, g, b] = color.split(";").slice(1).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
/** How strongly the inspector draws the sender's name on the card whose first line matches `head`:
 *  its color's contrast with the background. A dimmer card scores lower; no such card is NaN. */
function strength(width: number, head: RegExp): number {
  const l = layoutFor(width)
  if (l.kind !== "three") return NaN
  const from = width - l.inspector
  const s = painted()
  for (let y = 0; y < s.text.length; y++) {
    const cells = [...s.text[y]!].slice(from).join("")
    const line = cells.trim()
    const lead = /^\d+ [↩@] /.exec(line)
    if (!lead || !head.test(line)) continue
    const x = from + cells.indexOf(line) + lead[0].length
    return contrast(s.fg[y]![x]!, s.bg[y]![x]!)
  }
  return NaN
}
/** The background of the tree row showing `name`, which is the tree's highlight while it has the keys. */
function treeRowBg(name: string, width: number): string {
  const s = painted()
  const y = s.text.findIndex((l) => [...l].slice(0, layoutFor(width).tree).join("").includes(name))
  return y < 0 ? "" : s.bg[y]![1]!
}
/** The inspector lines painted `bg` where its items start, trimmed: the item that has the keys. */
function lit(width: number, bg: string): string[] {
  const l = layoutFor(width)
  if (l.kind !== "three") return []
  const at = width - l.inspector + 2
  const s = painted()
  return s.text.flatMap((line, y) => (s.bg[y]![at] === bg ? [[...line].slice(at).join("").trim()] : []))
}
/** The quote line under the input box, `↳ <name>: “…”`, cut to the conversation column. */
const quoteLine = (frame: string, width: number) => middle(frame, width).find((l) => l.startsWith("↳ ")) ?? ""
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
/** Opens the tree row titled `name`, counting down from the top past the space rows. */
async function openRow(name: string): Promise<string> {
  for (let i = 0; i < 24; i++) {
    await toTree()
    keys(...times(40, "k"), ...times(SPACE_ROWS + i, "j"))
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
  const line = `cd ${project} && env HOME=${home} COTAL_HOME=${join(home, ".cotal")} XDG_CONFIG_HOME=${xdg} node ${launcher} 2>${err}; echo EXIT=$?; sleep 3600`
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
  await setupSpaceStreams({ servers: server, space: other })
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: xdg })
  process.env.COTAL_HOME = join(home, ".cotal")
  const w = await import("@cotal-ai/workspace")
  const { forgetChatSessions } = await import("@cotal-ai/workspace/chat")
  for (const s of [space, other]) w.recordMesh({ space: s, server, root: project, mode: "open", origin: "manual", ts: new Date().toISOString() })
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
    // A name per size, with the sessions of the sizes before forgotten, so their history makes no card
    // for this one.
    const me = `lead-${width}`
    w.writePreference({}, "name", me, w.readPreferences().revision)
    forgetChatSessions(space)
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

    const onIt = await planner.ep.multicast(`on it (${size})`, { channel: "general", replyTo: mine.id })
    await reviewer.ep.multicast(`@${me} can you check the mockup (${size})`, { channel: "design", mentions: [me] })
    const dmReply = await reviewer.ep.unicast(mine.from.id, `notes look right (${size})`, { replyTo: mine.id })
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
    /** Types `text` in the box and checks it shows there, then deletes it: the box has the keys. */
    const boxHasKeys = async () => {
      const probe = `probe-${width}`
      keys("-l", probe)
      const typed = await waitFor((f) => middle(f, width).includes(probe), "the probe in the box", 3000).catch(() => capture())
      keys(...times(probe.length, "BSpace"))
      await waitFor((f) => !f.includes(probe), "the probe deleted", 3000).catch(() => {})
      return middle(typed, width).includes(probe)
    }
    /** Types `text` in the box, which has the keys, and sends it. */
    const send = (text: string) => {
      keys("-l", text)
      keys("Enter")
    }
    let keysBg = ""
    /** The first line of the inspector item that has the keys, once it starts with `head`. */
    const highlight = (head: string, what: string) => waitFor(() => (lit(width, keysBg)[0] ?? "").startsWith(head), what, 3000).then(() => lit(width, keysBg)[0]!).catch(() => lit(width, keysBg)[0] ?? "(none)")
    // The unseen mention's strength, which every seen card from reviewer is measured against.
    let unseen = NaN

    if (three) {
      await toTree()
      keysBg = treeRowBg("all traffic", width)
      keys("Tab")
      const first = await highlight("1 ◐ coder-2", "tab to move the keys to the inspector")
      save(dir, "02-inspector-focused")
      check(`${size}: tab from the tree moves the keys to the inspector, on its first item, and the tree's row lets go`, first.startsWith("1 ◐ coder-2") && treeRowBg("all traffic", width) !== keysBg, `${first}\n${capture()}`)
      keys("Down")
      const down = await highlight("2 ↩ reviewer", "down to move the highlight")
      keys("j")
      const j = await highlight("3 @ reviewer", "j to move the highlight")
      keys("k")
      const k = await highlight("2 ↩ reviewer", "k to move the highlight back")
      save(dir, "03-inspector-highlight")
      check(`${size}: down, j and k move the highlight over the inspector's items`, down.startsWith("2 ↩ reviewer") && j.startsWith("3 @ reviewer") && k.startsWith("2 ↩ reviewer"), [down, j, k].join("\n"))
      keys("Escape")
      await sleep(150)
      const left = capture()
      check(`${size}: esc in the inspector returns the keys to the box and opens nothing`, titled("all traffic")(left) && lit(width, keysBg).length === 0 && (await boxHasKeys()), left)

      keys("Tab")
      await sleep(150)
      keys("Tab")
      await highlight("2 ↩ reviewer", "the highlight kept on the DM reply")
      keys("Up")
      await highlight("1 ◐ coder-2", "up to the waiting agent")
      keys("Enter")
      const agent = await waitFor(has("◐ coder-2 is waiting"), "enter to open the waiting agent", 5000).catch(() => capture())
      check(`${size}: enter on the waiting agent opens it with no quote`, agent.includes("◐ coder-2 is waiting") && quoteLine(agent, width) === "", agent)
      const approve = `approved (${size})`
      send(approve)
      const approved = await until(() => coder.got.find((m) => textOf(m) === approve), "the answer at coder-2", 5000).catch(() => undefined)
      check(`${size}: after enter on the waiting agent the box has the keys, and its enter answers the agent with no reply id`, approved !== undefined && approved.replyTo === undefined, JSON.stringify(approved))

      keys("Tab")
      await sleep(150)
      keys("Tab")
      await highlight("1 ◐ coder-2", "the highlight on the waiting agent")
      keys("Down")
      await highlight("2 ↩ reviewer", "down to the DM reply")
      keys("Enter")
      const dm = await waitFor((f) => titled("reviewer")(f) && quoteLine(f, width).startsWith("↳ reviewer: “notes look right"), "enter to open and quote the DM reply", 5000).catch(() => capture())
      check(`${size}: enter on the DM reply opens reviewer's conversation and quotes the message under the box`, titled("reviewer")(dm) && middle(dm, width).includes(`┃ notes look right (${size})`) && quoteLine(dm, width).startsWith("↳ reviewer: “notes look right"), dm)
      await sleep(300)
      const opened = capture()
      const heads = cardHeads(opened, width)
      unseen = strength(width, /^3 @ reviewer/)
      const seen = strength(width, /^2 ↩ reviewer/)
      save(dir, "04-seen-next-to-unseen")
      check(
        `${size}: the opened DM reply stays listed, drawn dimmer than the unseen mention from the same sender`,
        heads.length === 3 && /^2 ↩ reviewer/.test(heads[0]!) && /^3 @ reviewer/.test(heads[1]!) && seen < unseen,
        `seen ${seen.toFixed(2)}, unseen ${unseen.toFixed(2)}\n${opened}`,
      )
      const thanks = `thanks (${size})`
      send(thanks)
      const answered = await until(() => reviewer.got.find((m) => textOf(m) === thanks), "the reply at reviewer", 5000).catch(() => undefined)
      check(`${size}: the next enter sends a reply to that message`, answered?.replyTo === dmReply.id, JSON.stringify(answered))
      const replied = await waitFor((f) => cardHeads(f, width).length === 2 && /^2 @ reviewer\s+#design$/.test(cardHeads(f, width)[0]!), "the replied card to leave", 5000).catch(() => capture())
      save(dir, "05-after-reply")
      check(`${size}: once the reply is in the feed the DM reply's card leaves the list`, cardHeads(replied, width).length === 2 && /^2 @ reviewer\s+#design$/.test(cardHeads(replied, width)[0]!) && replied.includes("REPLIES AND MENTIONS · 2"), replied)

      keys("Tab")
      await sleep(150)
      keys("Tab")
      const slid = await highlight("2 @ reviewer", "the highlight on the card that slid in")
      check(`${size}: after the replied card leaves, the highlight stays in its slot, on the card that slid in`, slid.startsWith("2 @ reviewer"), slid)
      keys("Escape")
      await sleep(150)

      click("@ reviewer")
      const design = await waitFor((f) => titled("#design")(f) && quoteLine(f, width).startsWith(`↳ reviewer: “@${me} can you`), "a click to open and quote the mention in #design", 5000).catch(() => capture())
      save(dir, "06-mention-opened")
      check(`${size}: a click on the mention card opens #design and quotes the mention`, titled("#design")(design) && quoteLine(design, width).startsWith(`↳ reviewer: “@${me} can you`), design)
      check(`${size}: after a click on a card the box has the keys`, await boxHasKeys(), capture())
    } else {
      await toTree()
      keys("Tab")
      await sleep(150)
      check(`${size}: with no inspector, tab from the tree returns the keys to the box`, await boxHasKeys(), capture())

      await toTree()
      keys("w")
      const agent = await waitFor(has("◐ coder-2 is waiting"), "w to open the waiting agent first", 5000).catch(() => capture())
      check(`${size}: w opens the waiting agent first, with no quote`, agent.includes("◐ coder-2 is waiting") && quoteLine(agent, width) === "", agent)
      keys("w")
      const dm = await waitFor((f) => titled("reviewer")(f) && quoteLine(f, width).startsWith("↳ reviewer: “notes look right"), "w to open and quote the DM reply", 5000).catch(() => capture())
      await sleep(300)
      save(dir, "02-dm-reply-quoted")
      check(`${size}: w next opens the newest card, the DM reply, quotes it, and it is still counted`, titled("reviewer")(dm) && quoteLine(dm, width).startsWith("↳ reviewer: “notes look right") && summaryOf(capture(), width) === "1 needs you · 2 replies · 1 mention", capture())
      keys("Escape")
      await sleep(150)
      const thanks = `thanks (${size})`
      send(thanks)
      const answered = await until(() => reviewer.got.find((m) => textOf(m) === thanks), "the reply at reviewer", 5000).catch(() => undefined)
      check(`${size}: enter in the box sends a reply to the quoted message`, answered?.replyTo === dmReply.id, JSON.stringify(answered))
      const replied = await waitFor((f) => summaryOf(f, width) === "1 needs you · 1 reply · 1 mention", "the replied card to leave the count", 5000).catch(() => capture())
      save(dir, "03-after-reply")
      check(`${size}: once the reply is in the feed the count drops the DM reply`, summaryOf(replied, width) === "1 needs you · 1 reply · 1 mention", replied)

      await toTree()
      keys("w")
      const design = await waitFor((f) => titled("#design")(f) && quoteLine(f, width).startsWith(`↳ reviewer: “@${me} can you`), "w to open and quote the mention in #design", 5000).catch(() => capture())
      await sleep(300)
      save(dir, "04-mention-opened")
      check(`${size}: w then opens the item that slid into the replied card's slot, the mention in #design, quotes it, and it is still counted`, titled("#design")(design) && quoteLine(design, width).startsWith(`↳ reviewer: “@${me} can you`) && summaryOf(capture(), width) === "1 needs you · 1 reply · 1 mention", capture())
    }

    await toTree()
    keys("3")
    const general = await waitFor((f) => titled("#general")(f) && quoteLine(f, width).startsWith(`↳ planner: “on it (${size})`), "3 to open and quote the reply in #general", 5000).catch(() => capture())
    await sleep(300)
    const left = capture()
    save(dir, "07-reply-opened")
    check(`${size}: 3 opens the reply in #general, which shows whom it answers, and quotes it`, general.includes(`↩ ${me}`) && quoteLine(general, width).startsWith(`↳ planner: “on it (${size})`), general)
    const mentionLeft = strength(width, /^2 @ reviewer\s+#design$/)
    check(
      `${size}: the mention opened before stays listed after another card is opened${three ? ", drawn dimmer than when it was unseen" : ""}`,
      three ? /^2 @ reviewer\s+#design$/.test(cardHeads(left, width)[0] ?? "") && mentionLeft < unseen : summaryOf(left, width) === "1 needs you · 1 reply · 1 mention",
      `seen ${mentionLeft.toFixed(2)}, unseen ${unseen.toFixed(2)}\n${left}`,
    )

    keys("Escape")
    await sleep(150)
    keys("Escape")
    await waitFor((f) => quoteLine(f, width) === "", "esc to drop the quote", 3000).catch(() => {})
    const plain = `plain note (${size})`
    send(plain)
    const plainGot = await until(() => planner.got.find((m) => textOf(m) === plain), "the plain post at planner", 5000).catch(() => undefined)
    await sleep(500)
    const unquoted = capture()
    check(
      `${size}: a post in #general without the quote carries no reply id and leaves the reply's card listed`,
      plainGot !== undefined && plainGot.replyTo === undefined && (three ? cardHeads(unquoted, width).some((h) => /^3 ↩ planner\s+#general$/.test(h)) : summaryOf(unquoted, width) === "1 needs you · 1 reply · 1 mention"),
      `${JSON.stringify(plainGot)}\n${unquoted}`,
    )

    await reviewer.ep.multicast(`@${me} while you are here (${size})`, { channel: "general", mentions: [me] })
    const here = await waitFor((f) => f.includes(`while you are here (${size})`) && (three ? f.includes("REPLIES AND MENTIONS · 3") : summaryOf(f, width) === "1 needs you · 1 reply · 2 mentions"), "a card for the mention in the open conversation", 5000).catch(() => capture())
    await sleep(300)
    const arrived = strength(width, /^2 @ reviewer\s+#general$/)
    save(dir, "08-mention-in-open-conversation")
    check(
      `${size}: a mention that arrives in the open conversation makes a card${three ? ", listed first and already drawn as seen" : ", counted"}`,
      here.includes("@you") && (three ? /^2 @ reviewer\s+#general$/.test(cardHeads(capture(), width)[0] ?? "") && arrived < unseen : summaryOf(capture(), width) === "1 needs you · 1 reply · 2 mentions"),
      `arrived ${arrived.toFixed(2)}, unseen ${unseen.toFixed(2)}\n${capture()}`,
    )

    await toTree()
    keys("4")
    await waitFor((f) => quoteLine(f, width).startsWith(`↳ planner: “on it (${size})`), "4 to quote the reply in #general again", 5000).catch(() => {})
    keys("Escape")
    await sleep(150)
    const noted = `noted (${size})`
    send(noted)
    const notedGot = await until(() => planner.got.find((m) => textOf(m) === noted), "the quoted reply at planner", 5000).catch(() => undefined)
    check(`${size}: the quoted reply reaches #general with the card's id`, notedGot?.replyTo === onIt.id && notedGot.channel === "general", JSON.stringify(notedGot))
    const gone = await waitFor((f) => (three ? f.includes("REPLIES AND MENTIONS · 2") && !cardHeads(f, width).some((h) => h.includes("↩ planner")) : summaryOf(f, width) === "1 needs you · 2 mentions"), "the replied card to leave", 5000).catch(() => capture())
    check(`${size}: once the quoted reply is in the feed the reply's card leaves the list`, three ? gone.includes("REPLIES AND MENTIONS · 2") && !cardHeads(gone, width).some((h) => h.includes("↩ planner")) : summaryOf(gone, width) === "1 needs you · 2 mentions", gone)

    if (three) {
      await toTree()
      keys("Tab")
      keys(...times(4, "k"))
      await highlight("1 ◐ coder-2", "the highlight on the waiting agent")
      keys("Down")
      await highlight("2 @ reviewer", "down to the mention in #general")
      const before = reviewer.got.length + planner.got.length
      keys("x")
      const dismissed = await waitFor((f) => cardHeads(f, width).length === 1, "x to dismiss the card", 3000).catch(() => capture())
      const slid = await highlight("2 @ reviewer", "the highlight on the card that slid in")
      save(dir, "09-after-dismiss")
      check(
        `${size}: x dismisses the highlighted card, sends nothing, and the highlight moves to the card that slid in`,
        cardHeads(dismissed, width).length === 1 && /^2 @ reviewer\s+#design$/.test(cardHeads(dismissed, width)[0]!) && slid.startsWith("2 @ reviewer") && reviewer.got.length + planner.got.length === before,
        `${slid}\n${dismissed}`,
      )
      keys("x")
      const empty = await waitFor((f) => !f.includes("REPLIES AND MENTIONS"), "x to dismiss the last card", 3000).catch(() => capture())
      keys("x")
      await sleep(300)
      const kept = capture()
      check(`${size}: x on the waiting agent does nothing`, !empty.includes("REPLIES AND MENTIONS") && kept.includes("NEEDS YOU · 1") && inspector(kept, width).some((l) => l.startsWith("1 ◐ coder-2")), kept)
      keys("Escape")
      await sleep(150)

      const many = 16
      for (let k = 1; k <= many; k++) await reviewer.ep.multicast(`@${me} ping ${k}`, { channel: "design", mentions: [me] })
      await waitFor(has(`REPLIES AND MENTIONS · ${many}`), `${many} cards`).catch(() => {})
      await toTree()
      keysBg = treeRowBg("# general", width)
      keys("Tab")
      const seenRows: string[] = []
      for (let n = 1; n <= many + 1; n++) {
        if (n > 1) keys("Down")
        const head = n === 1 ? "1 ◐ coder-2" : `${n} @ reviewer`
        seenRows.push(await waitFor(() => (lit(width, keysBg)[0] ?? "").startsWith(head), `the highlight on ${head}`, 3000).then(() => lit(width, keysBg)[0]!).catch(() => `(missing ${head})`))
      }
      const bottom = capture()
      save(dir, "10-many-cards-scrolled")
      check(
        `${size}: the arrows reach all ${many + 1} items in order, the list scrolls to keep the highlight on screen, and no item hides behind a count`,
        seenRows.every((l, i) => l.startsWith(i === 0 ? "1 ◐ coder-2" : `${i + 1} @ reviewer`)) && !inspector(bottom, width).some((l) => l.startsWith("1 ◐ coder-2")) && !/\+\d+ more/.test(bottom),
        `${seenRows.join("\n")}\n${bottom}`,
      )
      keys("Enter")
      const oldest = await waitFor((f) => titled("#design")(f) && quoteLine(f, width).startsWith(`↳ reviewer: “@${me} ping 1”`), "enter to open and quote the oldest card", 5000).catch(() => capture())
      save(dir, "11-oldest-card-quoted")
      check(`${size}: enter on the oldest card scrolls #design back to that message and quotes it`, middle(oldest, width).includes(`┃ @${me} ping 1`) && quoteLine(oldest, width).startsWith(`↳ reviewer: “@${me} ping 1”`), oldest)
      keys("Escape")
      const dropped = await waitFor((f) => quoteLine(f, width) === "", "esc to drop the quote", 3000).catch(() => capture())
      check(`${size}: esc in the box drops the quote`, quoteLine(dropped, width) === "" && titled("#design")(dropped), dropped)
    } else {
      await toTree()
      keys("x")
      await sleep(300)
      check(`${size}: with no inspector, x in the tree dismisses nothing`, summaryOf(capture(), width) === "1 needs you · 2 mentions", capture())
    }

    await openRow("all traffic")
    await sleep(300)
    const back = capture()
    const oldestSeen = strength(width, /^17 @ reviewer/)
    const nextUnseen = strength(width, /^16 @ reviewer/)
    check(
      `${size}: an opened card stays listed after leaving its conversation${three ? ", drawn dimmer than the unseen card above it" : ""}`,
      three ? /^17 @ reviewer\s+#design$/.test(cardHeads(back, width).at(-1) ?? "") && oldestSeen < nextUnseen : summaryOf(back, width) === "1 needs you · 2 mentions",
      `seen ${oldestSeen.toFixed(2)}, unseen ${nextUnseen.toFixed(2)}\n${back}`,
    )

    await toTree()
    keys("q")
    await waitFor(has("EXIT=0"), "q to quit with status 0")
    check(`${size}: q quits with status 0`, true)

    launch(width, height, join(work, `${size}-again.err`))
    const again = await waitFor((f) => titled("#general")(f) && f.includes(`while you are here (${size})`) && (three ? f.includes("REPLIES AND MENTIONS") : summaryOf(f, width) !== ""), "the relaunched app with the space's history").catch(() => capture())
    await sleep(1000)
    let relaunched = capture()
    if (three) {
      // The oldest cards are at the bottom of the list, so the highlight goes there to scroll it.
      await toTree()
      keysBg = treeRowBg("# general", width)
      keys("Tab", ...times(20, "j"))
      await highlight("19 @ reviewer", "the highlight on the oldest card")
      relaunched = capture()
    }
    save(dir, "12-relaunched")
    const againHeads = cardHeads(relaunched, width)
    check(
      `${size}: after a relaunch the replied card stays gone, and the dismissed mentions are back`,
      titled("#general")(again) &&
        (three
          ? againHeads.length > 1 && /^18 @ reviewer\s+#general$/.test(againHeads.at(-2)!) && /^19 @ reviewer\s+#design$/.test(againHeads.at(-1)!) && !againHeads.some((h) => h.includes("↩"))
          : summaryOf(relaunched, width) === "1 needs you · 2 mentions"),
      relaunched,
    )

    if (width === 209) {
      const flood = async (round: number, channel: string) => {
        for (let k = 1; k <= FLOOD; k++) await coder.ep.multicast(`busy line ${round}.${k} (${size})`, { channel })
        await openRow("all traffic")
        await waitFor(has(`busy line ${round}.${FLOOD} (${size})`), `the ${FLOOD} posts in #${channel}`)
      }
      /** Enter on the space row `at`, counted from the top of the tree, and waits for `name` to open. */
      const openSpace = async (at: number, name: string) => {
        await toTree()
        keys(...times(40, "k"), ...times(at, "j"), "Enter")
        await waitFor((f) => titleOf(f).includes(`#general  ${name}`) && footer(f) === "? help · ctrl+p commands", `${name} to open`)
      }
      const toTop = async () => {
        await toTree()
        keys("Tab", ...times(30, "k"))
        await highlight("1 ◐ coder-2", "the highlight on the first item")
      }
      const signOff = await reviewer.ep.multicast(`@${me} sign off the release (${size})`, { channel: "general", mentions: [me] })
      const launchDate = await planner.ep.multicast(`@${me} pick a launch date (${size})`, { channel: "design", mentions: [me] })
      await toTop()
      const fresh = await waitFor((f) => f.includes("REPLIES AND MENTIONS · 20") && /^2 @ planner\s+#design$/.test(cardHeads(f, width)[0] ?? ""), "two more cards").catch(() => capture())
      check(`${size}: two new mentions make two cards at the top of the list`, fresh.includes("REPLIES AND MENTIONS · 20") && /^3 @ reviewer\s+#general$/.test(cardHeads(fresh, width)[1] ?? ""), fresh)
      keys("Escape")
      await flood(1, "ops")
      await toTop()
      const busy = capture()
      save(dir, "13-after-busy-channel")
      const busyHeads = cardHeads(busy, width)
      check(
        `${size}: after ${FLOOD} posts in another channel both cards are still listed, newest first`,
        busy.includes("REPLIES AND MENTIONS · 20") && /^2 @ planner\s+#design$/.test(busyHeads[0] ?? "") && /^3 @ reviewer\s+#general$/.test(busyHeads[1] ?? "") && busy.includes("sign off the release") && busy.includes("pick a launch date"),
        busy,
      )

      keys("Down", "Down")
      await highlight("3 @ reviewer", "down to the mention in #general")
      keys("Enter")
      const quotedOld = await waitFor((f) => titled("#general")(f) && quoteLine(f, width).startsWith(`↳ reviewer: “@${me} sign off`), "enter to open and quote the mention in #general", 5000).catch(() => capture())
      check(`${size}: enter on the card that outlived the busy channel opens #general and quotes it`, titled("#general")(quotedOld) && quoteLine(quotedOld, width).startsWith(`↳ reviewer: “@${me} sign off`), quotedOld)
      send(`signed off (${size})`)
      const signed = await until(() => reviewer.got.find((m) => textOf(m) === `signed off (${size})`), "the reply at reviewer", 5000).catch(() => undefined)
      check(`${size}: the reply reaches #general with that card's id`, signed?.replyTo === signOff.id && signed.channel === "general", JSON.stringify(signed))
      const answered = await waitFor((f) => f.includes("REPLIES AND MENTIONS · 19") && !inspector(f, width).some((l) => l.includes("sign off the release")), "the answered card to leave", 5000).catch(() => capture())
      check(`${size}: the answered card leaves the list`, answered.includes("REPLIES AND MENTIONS · 19") && !inspector(answered, width).some((l) => l.includes("sign off the release")), answered)

      await flood(2, "design")
      await toTop()
      const later = capture()
      save(dir, "14-after-second-busy-round")
      check(
        `${size}: after ${FLOOD} more posts, in #design, the answered card stays gone and the unanswered one stays listed`,
        later.includes("REPLIES AND MENTIONS · 19") && !inspector(later, width).some((l) => l.includes("sign off the release")) && /^2 @ planner\s+#design$/.test(cardHeads(later, width)[0] ?? ""),
        later,
      )

      await openSpace(1, other)
      await openSpace(0, space)
      await toTop()
      const back = await waitFor((f) => f.includes("REPLIES AND MENTIONS · 19") && /^2 @ planner\s+#design$/.test(cardHeads(f, width)[0] ?? ""), "the cards back on the space").catch(() => capture())
      save(dir, "15-back-from-another-space")
      check(
        `${size}: after a switch to another space and back, the card whose message has left #design's history is still listed and the answered one stays gone`,
        back.includes("REPLIES AND MENTIONS · 19") && /^2 @ planner\s+#design$/.test(cardHeads(back, width)[0] ?? "") && !inspector(back, width).some((l) => l.includes("sign off the release")),
        back,
      )

      keys("Down")
      await highlight("2 @ planner", "down to the mention in #design")
      keys("Enter")
      const gone = await waitFor((f) => titled("#design")(f) && quoteLine(f, width).startsWith(`↳ planner: “@${me} pick a launch date`), "enter to open and quote the mention in #design", 5000).catch(() => capture())
      save(dir, "16-quoted-message-out-of-the-feed")
      check(
        `${size}: enter on a card whose message left the loaded rows opens #design and quotes it, with the message no longer in the conversation`,
        titled("#design")(gone) && quoteLine(gone, width).startsWith(`↳ planner: “@${me} pick a launch date`) && !middle(gone, width).some((l) => !l.startsWith("↳ ") && l.includes("pick a launch date")),
        gone,
      )
      send(`tomorrow (${size})`)
      const dated = await until(() => planner.got.find((m) => textOf(m) === `tomorrow (${size})`), "the reply at planner", 5000).catch(() => undefined)
      check(`${size}: the reply to it reaches #design with that card's id`, dated?.replyTo === launchDate.id && dated.channel === "design", JSON.stringify(dated))
      const left = await waitFor((f) => f.includes("REPLIES AND MENTIONS · 18") && !inspector(f, width).some((l) => l.includes("pick a launch date")), "the second answered card to leave", 5000).catch(() => capture())
      check(`${size}: that card then leaves the list too`, left.includes("REPLIES AND MENTIONS · 18") && !inspector(left, width).some((l) => l.includes("pick a launch date")) && footer(left) === "? help · ctrl+p commands", left)

      send(`ship it on friday (${size})`)
      const friday = await until(() => planner.got.find((m) => textOf(m) === `ship it on friday (${size})`), "the human's post in #design at planner", 5000)
      await flood(3, "ops")
      await planner.ep.multicast(`friday works (${size})`, { channel: "design", replyTo: friday.id })
      await toTop()
      const late = await waitFor((f) => f.includes("REPLIES AND MENTIONS · 19"), "a reply card", 5000).catch(() => capture())
      save(dir, "17-reply-to-a-post-out-of-the-feed")
      check(
        `${size}: a reply to the human's post after ${FLOOD} posts in another channel makes a reply card at the top`,
        late.includes("REPLIES AND MENTIONS · 19") && /^2 ↩ planner\s+#design$/.test(cardHeads(late, width)[0] ?? "") && late.includes("friday works"),
        late,
      )
    }

    await toTree()
    keys("q")
    await waitFor(has("EXIT=0"), "q to quit the relaunched app with status 0")
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
