import { TextAttributes, type InputRenderable, type KeyEvent, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createMemo, createRoot, createSignal, For, Index, Match, on, onCleanup, Show, Switch } from "solid-js"
import type { ManagedRow } from "@cotal-ai/workspace/control"
import { COMMAND_PALETTE_COMMAND, Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { useTheme } from "../vendor/opencode/packages/tui/src/context/theme"
import { SplitBorder } from "../vendor/opencode/packages/tui/src/ui/border"
import { DialogHeader, DialogLayout, useDialog } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { DialogSelect } from "../vendor/opencode/packages/tui/src/ui/dialog-select"
import { useToast } from "../vendor/opencode/packages/tui/src/ui/toast"
import type { Catalog, Entry } from "./catalog.js"
import type { ComposerState } from "./compose.js"
import { layoutFor } from "./layout.js"
import type { Conn, FeedEntry, Managed, Mesh, Presence, Session } from "./live.js"
import { safe } from "./safe.js"
import { type Card, cardsFor, clock, conversationFeed, conversationKey, type DraftKey, draftKey, entryKey, type Mark, meshOf, type Open, openRowKey, overview, peerKey, peerOf, route, type Row, STATUS, treeItems } from "./screen.js"
import type { SpawnRequest, SpawnState } from "./spawn.js"
import { PersonaDialog, SpawnForm } from "./spawn-form.js"
import type { Talk } from "./talk.js"

type ComposerModule = typeof import("./composer.js")

/** The catalog read, which starts after the first frame so the frame never waits on it. */
type Load = { phase: "loading" } | { phase: "ready"; catalog: Catalog } | { phase: "failed"; message: string }

/** One table drives the key bindings, the help dialog (rows with `keys`) and the palette (rows with
 *  `palette`). A `global` command also runs while a dialog is open. A row with no `run` lists keys
 *  the input box binds. */
type Command = { id: string; bind?: string; keys?: string; title: string; group: string; palette?: true; global?: true; run?: (event?: KeyEvent) => void }

type Line = { text: string; fg: RGBA }

/** Where the keys go: the input box under the conversation, the tree, or the inspector. `tab` moves
 *  them in that order. The box takes them only while it is on screen, so with no space open the tree
 *  has them, and the inspector only while it is on screen. */
type Focus = "box" | "tree" | "inspector"

/** An item of the inspector: a waiting agent, or a reply or mention card with the message that
 *  opening it quotes. `key` stays with the item while others arrive above it. */
type Need = { key: string; open: Open; quote?: FeedEntry }

/** One space's replies and mentions by message id, the ids of the messages the human replied to, and
 *  the ids of the messages the human sent. */
type Queue = { cards: ReadonlyMap<string, Card>; answered: ReadonlySet<string>; sent: ReadonlySet<string> }

/** Stopping an agent: the confirm, the manager call while it runs, then its outcome for a while. */
type Stop = { phase: "idle" } | { phase: "confirm"; name: string } | { phase: "stopping"; name: string; force: boolean } | { phase: "done"; text: string; tone: "success" | "error" }
type Answer = "graceful" | "force" | "cancel"

/** A spawn the notice line follows. `from` is the conversation that was open when it began; the new
 *  agent's conversation opens only if it still is. */
type Spawning = { state: Accessor<SpawnState>; from: string }

const FEED_ROWS = 200
// The channel a space opens on, as `cotal join` defaults to it.
const DEFAULT_CHANNEL = "general"
const NOTICE_MS = 8000

const settled = (s: SpawnState) => s.phase === "joined" || s.phase === "exited" || s.phase === "refused"
const fit = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p
// Workspace messages start with the file they name, which the row already shows.
const reason = (e: Extract<Entry, { kind: "unusable" }>) => (e.message.startsWith(e.source) ? e.message.slice(e.source.length).trim() : e.message)

export function Shell(props: { quit: (farewell?: string) => void; readCatalog: () => Promise<Catalog>; openSpace: (space?: string) => Promise<Session> }) {
  const theme = useTheme()
  const dialog = useDialog()
  const keymap = Keymap.use()
  const toast = useToast()
  const dims = useTerminalDimensions()
  const [load, setLoad] = createSignal<Load>({ phase: "loading" })
  const [session, setSession] = createSignal<Session>()
  const [cursor, setCursor] = createSignal<string>()
  const [open, setOpen] = createSignal<Open>({ kind: "channel", channel: DEFAULT_CHANNEL })
  const [seen, setSeen] = createSignal<Record<string, number>>({})
  // The replies and mentions the human opened or dismissed in this app run, by message id.
  const [marks, setMarks] = createSignal<ReadonlyMap<string, Mark>>(new Map())
  const [now, setNow] = createSignal(Date.now())
  const [stop, setStop] = createSignal<Stop>({ phase: "idle" })
  const [spawns, setSpawns] = createSignal<readonly Spawning[]>([])
  // The personas spawned from this app, the latest first, which the persona list shows first.
  const [recent, setRecent] = createSignal<readonly string[]>([])
  const [composer, setComposer] = createSignal<ComposerState>({ drafts: {}, sending: {} })
  const [focus, setFocus] = createSignal<Focus>("box")
  // The space a switch opens, and the one it leaves until that one's chat session has closed.
  const [switching, setSwitching] = createSignal<{ to?: string; from?: string }>({})
  // The composer imports the chat library, a few hundred milliseconds of loading, so it loads once a
  // space is opening and never delays the first frame. Solid's lazy() is not used: with no Suspense
  // boundary it leaves the shell's effects stalled.
  const [ui, setUi] = createSignal<ComposerModule>()
  const clockTimer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clockTimer))

  const entries = () => {
    const l = load()
    return l.phase === "ready" ? l.catalog.entries : []
  }
  const conn = (): Conn => session()?.conn() ?? { phase: "connecting", space: switching().to }
  const mesh = () => meshOf(conn())
  const managed = (): Managed => session()?.managed() ?? { phase: "loading" }
  const talk = (): Talk | undefined => session()?.talk()
  const self = () => {
    const p = talk()?.phase()
    return p?.phase === "open" ? p.identity.principal : undefined
  }
  const waiting = () => mesh()?.signals.waiting ?? []
  const feed = createMemo(() => {
    const m = mesh()
    return m ? conversationFeed(m, open(), talk()?.own() ?? { received: [], sent: [], earlier: [] }, FEED_ROWS) : []
  })
  const senders = createMemo(() => new Map(feed().map((e) => [e.id, e.from.name])))
  // Each space's cards, gathered from every snapshot of it in this app run. A card stays until a reply
  // to it shows, so it outlives its message leaving the recent rows a snapshot's cards are read from.
  // The human's sent ids are kept the same way, so a reply to a post that has left those rows still
  // makes a card.
  const queues = createMemo((prev: ReadonlyMap<string, Queue>) => {
    const m = mesh()
    const t = talk()
    if (!m || !t) return prev
    const was = prev.get(m.status.space)
    // The earlier sessions' direct messages arrive once, when the space opens, so all of them make
    // cards, however much traffic is newer.
    const recent = conversationFeed(m, { kind: "channel" }, t.own(), FEED_ROWS)
    const ids = new Set(recent.map((e) => e.id))
    const found = cardsFor([...t.own().earlier.filter((e) => !ids.has(e.id)), ...recent], t.you(), t.mentionsYou, was?.sent ?? new Set())
    const answered = new Set([...(was?.answered ?? []), ...found.answered])
    const sent = new Set([...(was?.sent ?? []), ...found.sent])
    const cards = new Map(was?.cards)
    for (const c of found.cards) if (!answered.has(c.entry.id)) cards.set(c.entry.id, c)
    for (const id of found.answered) cards.delete(id)
    return new Map(prev).set(m.status.space, { cards, answered, sent })
  }, new Map())
  // The open space's cards, newest first, less the ones dismissed. The map holds them in arrival
  // order, so reversing it first keeps cards that share a timestamp newest first.
  const cards = createMemo((): Card[] => {
    const m = mesh()
    const q = m && queues().get(m.status.space)
    return q ? [...q.cards.values()].filter((c) => marks().get(c.entry.id) !== "dismissed").reverse().sort((a, b) => b.entry.ts - a.entry.ts) : []
  })
  const seenCard = (c: Card) => marks().get(c.entry.id) === "seen"
  // What the inspector lists, in its order: the keys `w` and `1`-`9` open these at every width.
  const needs = createMemo((): Need[] => [
    ...waiting().map((p): Need => ({ key: peerKey(p.card.id), open: { kind: "peer", id: p.card.id } })),
    ...cards().map((c): Need => ({ key: `msg:${c.entry.id}`, open: c.open, quote: c.entry })),
  ])
  // The inspector's highlight, by key. Once its item leaves the list, the item that slides into the
  // slot has it.
  const [needKey, setNeedKey] = createSignal<string>()
  const needAt = createMemo((slot: number) => {
    const at = needs().findIndex((n) => n.key === needKey())
    return at >= 0 ? at : Math.max(0, Math.min(slot, needs().length - 1))
  }, 0)
  // The open conversation's reply quote, which the conversation highlights.
  const draftHere = () => {
    const m = mesh()
    return m ? draftKey(m.status.space, open()) : undefined
  }
  // A memo, so the scroll effect below runs when the quote moves, not on every snapshot or keystroke.
  const quoted = createMemo(() => {
    const k = draftHere()
    return k ? composer().drafts[k]?.reply?.id : undefined
  })
  const items = createMemo(() => treeItems(entries(), conn(), seen(), self()))
  const rows = createMemo(() => items().filter((i): i is Row => i.kind !== "header"))
  // With no row chosen in the tree, the cursor rests on the open conversation's row.
  const cursorIndex = () => {
    const at = rows().findIndex((r) => r.key === (cursor() ?? openRowKey(open())))
    return at >= 0 ? at : Math.max(0, rows().findIndex((r) => r.kind === "entry" && r.open))
  }
  const openPeer = () => {
    const o = open()
    return o.kind === "peer" ? o.id : undefined
  }
  const selection = () => rows()[cursorIndex()]
  const layout = () => layoutFor(dims().width)
  const inspectorWidth = () => {
    const l = layout()
    return l.kind === "three" ? l.inspector : undefined
  }

  createEffect(() => {
    const m = mesh()
    setNow(Date.now())
    const o = open()
    if (!m || o.kind !== "channel" || o.channel === undefined) return
    const arrivals = m.channels.find((c) => c.channel === o.channel)?.arrivals ?? 0
    if (seen()[o.channel] !== arrivals) setSeen((s) => ({ ...s, [o.channel!]: arrivals }))
  })
  const mark = (ids: readonly string[], m: Mark) => setMarks((prev) => new Map([...prev, ...ids.map((id) => [id, m] as const)]))
  // A reply or mention that lands in the open conversation is seen as it arrives. One the
  // conversation already held when it opened, such as the space's history, is not.
  let shown: { key?: DraftKey; since: number } = { since: 0 }
  createEffect(() => {
    const key = draftHere()
    if (key !== shown.key) shown = { key, since: Date.now() }
    const here = conversationKey(open())
    const landed = cards().filter((c) => !seenCard(c) && c.entry.ts >= shown.since && conversationKey(c.open) === here)
    if (landed.length) mark(landed.map((c) => c.entry.id), "seen")
  })

  // The box has the keys while it is on screen or on its way, as a space opens or the composer
  // loads. A catalog entry's page and a space that failed or closed have no box, so the tree has them.
  const composing = () => focus() === "box" && open().kind !== "entry" && conn().phase !== "failed" && conn().phase !== "closed"
  const keysAt = (): Focus => (composing() ? "box" : focus() === "inspector" && inspectorWidth() ? "inspector" : "tree")
  const toBox = () => {
    setCursor(undefined)
    setFocus("box")
  }
  const nextColumn = () => (keysAt() === "tree" && inspectorWidth() ? setFocus("inspector") : toBox())
  /** Quotes `e` in the open conversation's draft, or shows why the reply rule refuses it. */
  const quoteRow = (e: FeedEntry) => {
    const u = ui()
    const k = draftHere()
    const t = talk()
    if (!u || !k || !t) return
    setComposer((s) => u.quoteRow(s, k, e, t.you(), open()))
  }
  // A quote moved off screen scrolls into view; with none the conversation follows its newest row again.
  let scroller: ScrollBoxRenderable | undefined
  createEffect(
    on(
      quoted,
      (id) => {
        if (!scroller || scroller.isDestroyed) return
        if (id) scroller.scrollChildIntoView(`msg-${id}`, { align: "nearest", inset: 1 })
        else scroller.scrollTo(Infinity)
      },
      { defer: true },
    ),
  )

  // Each switch takes a number. One that a later switch or the app closing overtook while it waited
  // closes the session it opened instead of showing it.
  let switches = 0
  const switchTo = async (space?: string) => {
    const mine = ++switches
    const old = session()
    const was = conn().space
    setSwitching({ to: space, from: old && was })
    setSession(undefined)
    setOpen({ kind: "channel", channel: DEFAULT_CHANNEL })
    setSeen({})
    setStop({ phase: "idle" })
    setSpawns([])
    const chat = await old?.close()
    if (mine === switches) setSwitching({ to: space })
    if (chat && !chat.clean) toast.show({ variant: "warning", message: `your session on ${was} did not close cleanly: ${chat.summary}` })
    const next = await props.openSpace(space)
    if (!ui()) void import("./composer.js").then((m) => setUi(() => m))
    if (mine !== switches) return void next.close()
    setSession(next)
  }
  void switchTo()
  onCleanup(() => {
    switches++
    void session()?.close()
  })

  const read = async (announce: boolean) => {
    try {
      const catalog = await props.readCatalog()
      setLoad({ phase: "ready", catalog })
      if (announce) toast.show({ variant: "success", message: `Reread ${catalog.entries.length} registration(s) from ${catalog.home}` })
    } catch (e) {
      const message = `The space catalog could not be read: ${(e as Error).message}`
      setLoad({ phase: "failed", message })
      toast.show({ variant: "error", message })
    }
  }
  void read(false)

  const move = (by: number) => {
    const list = rows()
    if (list.length) setCursor(list[Math.max(0, Math.min(list.length - 1, cursorIndex() + by))]!.key)
  }
  const openRow = () => {
    const r = selection()
    if (!r) return
    if (r.kind === "channel") setOpen({ kind: "channel", channel: r.channel })
    else if (r.kind === "peer") setOpen({ kind: "peer", id: r.presence.card.id })
    else if (r.entry.kind !== "space") setOpen({ kind: "entry", key: r.key })
    else if (r.open) setOpen({ kind: "channel", channel: DEFAULT_CHANNEL })
    else void switchTo(r.entry.space)
    toBox()
  }
  /** Opens the inspector's item `n` and moves the highlight to it. A card is seen from then on and
   *  quotes its message, so the next enter in the box replies to it. Says whether there was an item
   *  to open. */
  const openNeed = (n: number) => {
    const list = needs()
    if (list.length === 0) return void toast.show({ variant: "info", message: "Nothing needs you" })
    const item = list[n]
    if (!item) return void toast.show({ variant: "warning", message: `Only ${list.length} item(s) need you` })
    setNeedKey(item.key)
    setOpen(item.open)
    setCursor(item.open.kind === "peer" ? peerKey(item.open.id) : undefined)
    if (item.quote) {
      mark([item.quote.id], "seen")
      quoteRow(item.quote)
    }
    return true
  }
  // `w` passes the highlighted item when its conversation is the open one, and otherwise opens it,
  // which after a reply or a dismissal is the item that slid into its slot.
  const nextNeed = () => {
    const list = needs()
    const at = needAt()
    const next = list[at] && conversationKey(list[at].open) === conversationKey(open()) ? at + 1 : at
    openNeed(next < list.length ? next : 0)
  }
  // Enter and a click open the item and hand the keys to the box, for the reply.
  const answerNeed = (n: number) => openNeed(n) && toBox()
  const moveNeed = (by: number) => {
    const list = needs()
    if (list.length) setNeedKey(list[Math.max(0, Math.min(list.length - 1, needAt() + by))]!.key)
  }
  // `x` in the inspector dismisses the highlighted card without a reply. A waiting agent stays.
  const dismissNeed = () => {
    const item = needs()[needAt()]
    if (keysAt() === "inspector" && item?.quote) mark([item.quote.id], "dismissed")
  }
  // What the arrows and enter do in the column that has the keys.
  const column = () => (keysAt() === "inspector" ? { move: moveNeed, open: () => answerNeed(needAt()) } : { move, open: openRow })

  // The shared-name warning, once per session that finds its name taken, and the warning for a session
  // the app could not remember.
  for (const key of ["shared", "unremembered"] as const)
    createEffect(
      on(
        () => {
          const p = talk()?.phase()
          return p?.phase === "open" ? p[key] : undefined
        },
        (line) => line && toast.show({ variant: "warning", message: line, duration: 10_000 }),
      ),
    )
  // Why earlier direct messages are missing, once per space. An agent's conversation keeps saying it.
  createEffect(on(() => talk()?.unread(), (why) => why && toast.show({ variant: "warning", message: why, duration: 10_000 })))

  const unsent = () => Object.values(composer().drafts).filter((d) => d.text.trim()).length
  // Quitting closes the chat session first, as `cotal chat` does, and prints how it closed.
  const quit = async () => {
    dialog.clear()
    switches++
    const s = session()
    const space = conn().space
    const chat = await s?.close()
    props.quit(chat && space ? `${space}: ${chat.summary}` : undefined)
  }
  const requestQuit = () => {
    const n = unsent()
    if (n === 0) return void quit()
    dialog.replace(() => <ConfirmQuit drafts={n} answer={(yes) => (yes ? void quit() : dialog.clear())} />)
  }
  const endSession = async () => {
    const closed = await talk()?.end()
    toast.show(closed ? { variant: closed.clean ? "success" : "warning", message: `chat session ended: ${closed.summary}` } : { variant: "info", message: "No chat session is open" })
  }
  const rename = () => {
    const t = talk()
    if (!t) return toast.show({ variant: "info", message: "Open a space to change your name in it" })
    dialog.replace(() => <NameDialog talk={t} done={() => dialog.clear()} />)
  }

  // The stop is pinned to the run the overview shows, so it is offered only for a seat a manager
  // reports. The manager finds the seat by name, so no other managed seat may hold it.
  const askStop = () => {
    const r = selection()
    if (r?.kind !== "peer" || r.presence.card.kind !== "agent") return toast.show({ variant: "info", message: "Select an agent to stop it" })
    const m = managed()
    const row = m.phase === "rows" ? m.byId.get(r.presence.card.id) : undefined
    if (!row || m.phase !== "rows") return toast.show({ variant: "info", message: `No manager on this space reports running ${r.presence.card.name}` })
    const name = row.name
    const held = [...m.byId.values()].filter((o) => o.name === name).length
    if (held > 1) return toast.show({ variant: "warning", message: `${held} managed agents are named ${name}, and the app stops an agent by name, so it cannot pick one` })
    const s = stop()
    if (s.phase === "stopping") return toast.show({ variant: "warning", message: `Still stopping ${s.name}` })
    setStop({ phase: "confirm", name })
    dialog.replace(
      () => <ConfirmStop name={name} answer={(a) => answerStop(row, a)} />,
      () => setStop((cur) => (cur.phase === "confirm" ? { phase: "idle" } : cur)),
    )
  }
  const answerStop = async (row: ManagedRow, a: Answer) => {
    dialog.clear()
    const s = session()
    if (a === "cancel" || !s) return
    const force = a === "force"
    const name = row.name
    setStop({ phase: "stopping", name, force })
    const r = await s.stop(row, !force)
    if (session() !== s) return
    const done: Stop = r.ok ? { phase: "done", text: `${force ? "force-killed" : "stopped"} ${name}`, tone: "success" } : { phase: "done", text: `stop: ${r.error}`, tone: "error" }
    setStop(done)
    setTimeout(() => setStop((cur) => (cur === done ? { phase: "idle" } : cur)), NOTICE_MS)
  }

  // A spawn that failed stays on the notice line until the next one starts; one that joined leaves
  // after a while.
  const askSpawn = async () => {
    const s = session()
    if (!s || !talk()) return toast.show({ variant: "info", message: "No space is open" })
    let setup: Awaited<ReturnType<Session["spawnSetup"]>>
    try {
      setup = await s.spawnSetup()
    } catch (e) {
      return toast.show({ variant: "error", message: `Spawning is not available: ${safe((e as Error).message)}` })
    }
    if (session() !== s) return
    const large = { size: "large" as const }
    const list = (at?: string) =>
      dialog.replace(
        () => (
          <PersonaDialog
            setup={setup}
            recent={recent()}
            at={at}
            pick={(persona) =>
              dialog.replace(
                () => (
                  <SpawnForm
                    setup={setup}
                    persona={persona}
                    nameError={s.nameError}
                    back={() => list(persona.name)}
                    launch={(req) => {
                      dialog.clear()
                      setRecent((all) => [req.persona, ...all.filter((n) => n !== req.persona)])
                      runSpawn(s, req)
                    }}
                  />
                ),
                undefined,
                large,
              )
            }
          />
        ),
        undefined,
        large,
      )
    list()
  }
  const runSpawn = (s: Session, req: SpawnRequest) => {
    const spawn: Spawning = { state: s.spawn(req), from: conversationKey(open()) }
    setSpawns((all) => [...all.filter((x) => !settled(x.state())), spawn])
    createRoot((dispose) =>
      createEffect(() => {
        const st = spawn.state()
        if (!settled(st)) return
        dispose()
        if (st.phase !== "joined") return
        setTimeout(() => setSpawns((all) => all.filter((x) => x !== spawn)), NOTICE_MS)
        if (session() !== s || conversationKey(open()) !== spawn.from) return
        setOpen({ kind: "peer", id: st.id })
        setCursor(peerKey(st.id))
      }),
    )
  }

  const sendToRole = () => {
    const m = ui()
    if (!m || !talk()) return toast.show({ variant: "info", message: "No space is open" })
    dialog.replace(() => (
      <m.RoleDialog
        done={(role) => {
          dialog.clear()
          setOpen({ kind: "role", role })
          toBox()
        }}
      />
    ))
  }

  // Letter keys belong to the tree and the inspector. In the box they are text; `tab` there is bound
  // by the composer.
  const commands: Command[] = [
    { id: "cotal.next-column", bind: "tab", keys: "tab", title: "Next column: the box, the tree, the inspector", group: "Move", run: nextColumn },
    { id: "cotal.box", bind: "escape", keys: "esc", title: "Back to the input box", group: "Move", run: toBox },
    { id: "cotal.down", bind: "j,down", keys: "j ↓", title: "Next row", group: "Move", run: () => column().move(1) },
    { id: "cotal.up", bind: "k,up", keys: "k ↑", title: "Previous row", group: "Move", run: () => column().move(-1) },
    { id: "cotal.open", bind: "return", keys: "enter", title: "Open the selected row, quoting a card", group: "Move", run: () => column().open() },
    { id: "cotal.next-need", bind: "w", keys: "w", title: "Open the next waiting agent, reply or mention", group: "Needs you", palette: true, run: nextNeed },
    { id: "cotal.need", bind: "1,2,3,4,5,6,7,8,9", keys: "1-9", title: "Open that item of the inspector", group: "Needs you", run: (e) => e && openNeed(Number(e.name) - 1) },
    { id: "cotal.dismiss", bind: "x", keys: "x", title: "Dismiss the highlighted reply or mention", group: "Needs you", run: dismissNeed },
    { id: "cotal.reload", bind: "ctrl+r", keys: "ctrl+r", title: "Reread spaces", group: "System", palette: true, run: () => void read(true) },
    { id: COMMAND_PALETTE_COMMAND, bind: "ctrl+p", keys: "ctrl+p", title: "Commands", group: "System", global: true, run: () => dialog.replace(() => <Palette commands={commands} />) },
    { id: "cotal.help", bind: "?", keys: "?", title: "Keys", group: "System", palette: true, run: () => dialog.replace(() => <Help commands={commands} />, undefined, { size: "large" }) },
    { id: "cotal.quit", bind: "q", keys: "q ctrl+c", title: "Quit", group: "System", palette: true, run: requestQuit },
    { id: "cotal.quit-anywhere", bind: "ctrl+c", title: "Quit", group: "System", global: true, run: requestQuit },
    { id: "cotal.stop", bind: "shift+d", keys: "D", title: "Stop the selected agent", group: "Agents", palette: true, run: askStop },
    { id: "cotal.spawn", bind: "shift+s", keys: "S", title: "Spawn agent", group: "Agents", palette: true, run: () => void askSpawn() },
    { id: "cotal.reply.quote", keys: "↑ ↓ click", title: "Quote a message to reply to; ↑ ↓ on an empty box", group: "Reply" },
    { id: "cotal.reply.drop", keys: "esc", title: "Drop the quote and keep the text", group: "Reply" },
    // Last, so the palette at 80x24 still opens on the commands above.
    { id: "cotal.role", title: "Send to a role", group: "Talk", palette: true, run: sendToRole },
    { id: "cotal.name", title: "Change your name", group: "Talk", palette: true, run: rename },
    { id: "cotal.end-session", title: "End your chat session", group: "Talk", palette: true, run: () => void endSession() },
  ]
  const toLayer = (c: Command) => ({ ...c, run: (_input?: string, event?: KeyEvent) => c.run?.(event) })
  Keymap.createLayer(() => ({ commands: commands.filter((c) => !c.global && c.bind).map(toLayer) }))
  Keymap.createLayer(() => ({ mode: "global", commands: commands.filter((c) => c.global).map(toLayer) }))

  const statusFg = (p: Presence) =>
    ({ working: theme.text.feedback.success.base, waiting: theme.text.feedback.warning.base, idle: theme.text.muted, offline: theme.text.faint })[p.status]

  // A name keeps the color it got first. A new name starts at its hash and takes the next color no
  // name holds yet, so a few agents never share one. You are gold.
  const tints = new Map<string, number>()
  const tint = (name: string) => {
    const n = theme.categorical.length
    let i = tints.get(name)
    if (i === undefined) {
      const start = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % n
      const held = new Set(tints.values())
      i = Array.from({ length: n }, (_, k) => (start + k) % n).find((k) => !held.has(k)) ?? start
      tints.set(name, i)
    }
    return theme.categorical[i % n][200]
  }
  const gold = () => theme.hue.accent[200]
  const nameFg = (from: { id: string; name: string }) => (from.id === self() ? gold() : tint(from.name))

  const Section = (p: { title: string; right?: string }) => (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={theme.text.muted} attributes={TextAttributes.BOLD} wrapMode="none">
        {p.title}
      </text>
      <Show when={p.right}>
        <text fg={theme.text.faint} wrapMode="none">
          {p.right}
        </text>
      </Show>
    </box>
  )

  /** One overview row. A long value wraps under itself, so the labels stay a clean column. */
  const Field = (p: { label: string; value: string; fg: RGBA }) => (
    <box flexDirection="row" flexShrink={0}>
      <text width={9} flexShrink={0} wrapMode="none" fg={theme.text.faint}>
        {p.label}
      </text>
      <text flexGrow={1} flexShrink={1} fg={p.fg}>
        {p.value}
      </text>
    </box>
  )

  const rowLabel = (r: Row, width: number): { mark: string; markFg: RGBA; name: string; tag: string; fg: RGBA } => {
    if (r.kind === "channel") {
      const tag = r.unread ? `+${r.unread}` : ""
      return { mark: r.channel === undefined ? "∗" : "#", markFg: theme.text.faint, name: fit(r.channel ?? "all traffic", width - tag.length - 5), tag, fg: theme.text.base }
    }
    if (r.kind === "peer") {
      const p = r.presence
      const mark = p.card.kind === "agent" ? STATUS[p.status].mark : "⚙"
      const tag = p.card.role ?? ""
      const fg = p.status === "offline" ? theme.text.faint : p.card.kind === "agent" ? nameFg(p.card) : theme.text.base
      return { mark, markFg: statusFg(p), name: fit(p.card.name, width - tag.length - 5), tag: fit(tag, Math.max(0, width - 12)), fg }
    }
    const e = r.entry
    if (e.kind === "unusable") return { mark: "✗", markFg: theme.text.feedback.error.base, name: fit(baseName(e.source), width - 4), tag: "", fg: theme.text.feedback.error.base }
    const tag = e.kind === "prepared" ? "prepared" : r.open ? "open" : e.mode
    return { mark: r.open ? "▸" : " ", markFg: gold(), name: fit(e.space, width - tag.length - 5), tag, fg: e.kind === "prepared" ? theme.text.muted : theme.text.base }
  }

  /** The human's name: dim while watching unseen, plain once a session puts them on the roster. */
  const me = () => {
    const p = talk()?.phase()
    if (p?.phase === "open") return { name: p.identity.label, seen: true }
    const n = talk()?.name()
    return n?.state === "ok" ? { name: n.name.name, seen: false } : undefined
  }

  const Tree = (p: { width: number }) => {
    const height = () => Math.max(1, dims().height - 6)
    const start = () => {
      const at = items().findIndex((i) => i.kind !== "header" && i.key === selection()?.key)
      return Math.max(0, Math.min(at - height() + 1, items().length - height()))
    }
    return (
      <box width={p.width} flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} backgroundColor={theme.background.raised.base}>
        <Switch>
          <Match when={load().phase === "loading"}>
            <text fg={theme.text.muted}>Reading spaces…</text>
          </Match>
          <Match when={load().phase === "failed"}>
            <text fg={theme.text.feedback.error.base}>Catalog unreadable</text>
          </Match>
        </Switch>
        <For each={items().slice(start(), start() + height())}>
          {(item) => {
            if (item.kind === "header")
              return (
                <box flexShrink={0} paddingTop={item.title === "SPACES" ? 0 : 1}>
                  <Section title={item.title} right={item.right} />
                </box>
              )
            const label = () => rowLabel(item, p.width - 2)
            return (
              <box flexDirection="row" justifyContent="space-between" flexShrink={0} backgroundColor={item.key !== selection()?.key ? undefined : keysAt() === "tree" ? theme.background.raised.max : theme.background.raised.high}>
                <text wrapMode="none" fg={label().fg}>
                  <span style={{ fg: label().markFg }}>{label().mark}</span>
                  {` ${label().name}`}
                </text>
                <text wrapMode="none" fg={item.kind === "channel" && item.unread ? gold() : theme.text.faint}>
                  {label().tag}
                </text>
              </box>
            )
          }}
        </For>
        <box flexGrow={1} />
        <Show when={me()}>
          {(m) => (
            <box flexShrink={0} paddingBottom={1}>
              <text wrapMode="none" fg={m().seen ? gold() : theme.text.faint}>
                {fit(m().name, p.width - 2)}
              </text>
            </box>
          )}
        </Show>
      </box>
    )
  }

  const entryLines = (e: Entry): Line[] => {
    if (e.kind === "unusable")
      return [
        { text: "This registration cannot be used.", fg: theme.text.feedback.error.base },
        { text: e.source, fg: theme.text.muted },
        { text: reason(e), fg: theme.text.base },
      ]
    if (e.kind === "prepared")
      return [
        { text: `"${e.space}" is prepared but not started.`, fg: theme.text.base },
        { text: `Start it with \`cotal up\` in ${e.root}.`, fg: theme.text.muted },
      ]
    return [{ text: `${e.mode} · ${e.server} · ${e.origin}`, fg: theme.text.muted }]
  }

  /** The middle column when it has no feed to show: an unopenable catalog row, or the connection
   *  saying why no space is open. */
  const notice = (): { title: string; lines: Line[] } | undefined => {
    const o = open()
    if (o.kind === "entry") {
      const e = entries().find((x) => entryKey(x) === o.key)
      return e && { title: e.kind === "unusable" ? baseName(e.source) : e.space, lines: entryLines(e) }
    }
    const c = conn()
    if (c.phase === "connecting") {
      const from = switching().from
      return { title: c.space ?? "Opening a space", lines: [{ text: from ? `Leaving ${from}…` : c.space ? `Connecting to ${c.space}…` : "Finding the space for this folder…", fg: theme.text.muted }] }
    }
    if (c.phase === "closed") return { title: c.space ?? "No space open", lines: [{ text: "Closed.", fg: theme.text.muted }] }
    if (c.phase === "failed") {
      const none = entries().length === 0 && load().phase === "ready" ? [{ text: "Prepare one with `cotal space create <name>`, or start one in a project with `cotal up`.", fg: theme.text.muted }] : []
      return {
        title: c.space ?? "No space open",
        lines: [{ text: c.message, fg: theme.text.feedback.error.base }, ...(c.remedy ? [{ text: c.remedy, fg: theme.text.base }] : []), ...none],
      }
    }
    return undefined
  }

  // The quoted row sits on a gold wash and keeps its colored bar. On the wash an agent's color, the muted
  // gray and the usual gold all fall under 4.5:1 in one theme, so its name turns base, its route a
  // stronger gray, and its gold the accent's strongest step.
  const FeedRow = (p: { entry: FeedEntry; withChannel: boolean }) => {
    const lit = () => quoted() === p.entry.id
    const to = () => route(p.entry, p.withChannel)
    const answers = () => (p.entry.replyTo === undefined ? "" : `  ↩ ${senders().get(p.entry.replyTo) ?? ""}`.trimEnd())
    const mark = () => (lit() ? theme.hue.accent[100] : gold())
    return (
      <box
        id={`msg-${p.entry.id}`}
        flexShrink={0}
        marginBottom={1}
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={p.entry.events ? theme.text.faint : nameFg(p.entry.from)}
        paddingLeft={1}
        paddingRight={lit() ? 1 : 0}
        backgroundColor={lit() ? theme.hue.accent[800] : undefined}
        onMouseDown={
          p.entry.events
            ? undefined
            : () => {
                quoteRow(p.entry)
                toBox()
              }
        }
      >
        <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <text wrapMode="none" fg={lit() ? theme.text.base : nameFg(p.entry.from)} attributes={TextAttributes.BOLD}>
            {p.entry.from.name}
            <span style={{ fg: lit() ? theme.hue.neutral[300] : theme.text.faint }}>{to() ? ` ${to()}` : ""}</span>
            <span style={{ fg: lit() ? theme.hue.neutral[300] : theme.text.muted }}>{answers()}</span>
            <span style={{ fg: mark() }}>{talk()?.mentionsYou(p.entry) ? "  @you" : ""}</span>
          </text>
          <text wrapMode="none" fg={lit() ? mark() : theme.text.faint}>
            {clock(p.entry.ts)}
          </text>
        </box>
        <text fg={p.entry.events ? theme.text.muted : theme.text.base}>{p.entry.text}</text>
      </box>
    )
  }

  const Conversation = (p: { mesh: Mesh }) => {
    const peer = () => {
      const id = openPeer()
      return id === undefined ? undefined : peerOf(p.mesh, id)
    }
    const channel = () => {
      const o = open()
      return o.kind === "channel" ? o : undefined
    }
    const title = () => {
      const c = channel()
      if (c) return c.channel === undefined ? "all traffic" : `#${c.channel}`
      const o = open()
      if (o.kind === "role") return `role:${o.role}`
      return peer()?.card.name ?? "gone from the roster"
    }
    return (
      <>
        <box flexDirection="row" flexShrink={0}>
          <text wrapMode="none" fg={theme.text.base} attributes={TextAttributes.BOLD}>
            {title()}
            <span style={{ fg: theme.text.faint }}>{`  ${p.mesh.status.space}`}</span>
          </text>
        </box>
        <box height={1} flexShrink={0} />
        <Show when={open().kind === "peer" && talk()?.unread()}>
          {(why) => (
            <text fg={theme.text.feedback.warning.base} flexShrink={0} marginBottom={1}>
              {why()}
            </text>
          )}
        </Show>
        <Show when={peer()}>
          {(pr) => (
            <box flexShrink={0} marginBottom={1}>
              <Show when={pr().status === "waiting"}>
                <text fg={theme.text.feedback.warning.base}>{`◐ ${pr().card.name} is waiting`}</text>
                <text fg={theme.text.base}>{pr().activity ? `“${pr().activity}”` : "It reported no question."}</text>
              </Show>
              <Show when={layout().kind === "two" && !composing()}>
                <For each={overview(pr(), now(), managed())}>{(f) => <Field label={f.label} value={f.value} fg={theme.text.muted} />}</For>
              </Show>
            </box>
          )}
        </Show>
        <box flexGrow={1} minHeight={0} overflow="hidden">
          <Show when={feed().length} fallback={<text fg={theme.text.muted}>No messages yet.</text>}>
            <scrollbox ref={(r: ScrollBoxRenderable) => (scroller = r)} flexGrow={1} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
              <For each={feed()}>{(e) => <FeedRow entry={e} withChannel={channel()?.channel === undefined} />}</For>
            </scrollbox>
          </Show>
        </box>
      </>
    )
  }

  /** The input box: on screen while a space's conversation is, and once the composer has loaded. */
  const box = () => {
    const m = mesh()
    const t = talk()
    const u = ui()
    return !notice() && m && t && u ? { mesh: m, talk: t, Composer: u.Composer } : undefined
  }
  // Until the box is on screen, a letter typed for it runs no tree command; tab hands the keys to the tree.
  createEffect(() => {
    if (composing() && !box() && dialog.stack.length === 0) onCleanup(keymap.mode.push("hold"))
  })
  Keymap.createLayer(() => ({ mode: "hold", commands: [{ id: "cotal.hold.tree", bind: "tab", title: "Move to the tree", group: "Move", run: () => void setFocus("tree") }] }))

  /** The inspector as one line, for a screen too narrow for it, such as `1 needs you · 2 mentions`. */
  const summary = () => {
    const n = waiting().length
    const replies = cards().filter((c) => c.kind === "reply").length
    const mentions = cards().length - replies
    const parts = [n ? `${n} need${n === 1 ? "s" : ""} you` : "", replies ? `${replies} repl${replies === 1 ? "y" : "ies"}` : "", mentions ? `${mentions} mention${mentions === 1 ? "" : "s"}` : ""]
    return parts.filter(Boolean).join(" · ")
  }

  const Middle = () => (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} minWidth={0} minHeight={0}>
      <Show
        when={notice()}
        fallback={<Show when={mesh()}>{(m) => <Conversation mesh={m()} />}</Show>}
      >
        {(n) => (
          <>
            <text wrapMode="none" fg={theme.text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
              {n().title}
            </text>
            <box height={1} flexShrink={0} />
            <For each={n().lines}>
              {(line) => (
                <text fg={line.fg} flexShrink={0}>
                  {line.text}
                </text>
              )}
            </For>
            <box flexGrow={1} />
          </>
        )}
      </Show>
      <Show when={layout().kind === "two" && summary()}>
        {(line) => (
          <text wrapMode="none" fg={theme.text.feedback.warning.base} flexShrink={0}>
            {line()}
          </text>
        )}
      </Show>
      <Show when={box()}>
        {(b) => {
          const Composer = b().Composer
          return (
            <Composer
              talk={b().talk}
              space={b().mesh.status.space}
              open={open()}
              mesh={b().mesh}
              feed={feed()}
              state={composer()}
              setState={setComposer}
              // A dialog hands focus back to whatever held it when it opened, which is not the box
              // when a palette command opens a second dialog, so the box takes it back itself.
              focused={focus() === "box" && dialog.stack.length === 0}
              toTree={() => setFocus("tree")}
              maxRows={dims().height >= 40 ? 6 : 3}
            />
          )
        }}
      </Show>
    </box>
  )

  // The item with the keys is lit as the tree's row is when the tree has them; otherwise an open
  // waiting agent is.
  const needBg = (n: number, opened: boolean) => (keysAt() === "inspector" && needAt() === n ? theme.background.raised.max : opened ? theme.background.raised.high : undefined)

  /** A reply or mention: who, where, and the start of what they wrote, all in the faint color once it
   *  is seen. A click opens it, as enter does. */
  const CardRow = (p: { card: Card; n: number; width: number }) => {
    const e = () => p.card.entry
    const where = () => {
      const m = e()
      return m.delivery === "multicast" ? (m.channel ? `#${m.channel}` : "") : m.delivery === "anycast" ? `@${m.toService ?? "?"}` : "→ you"
    }
    const dim = () => (seenCard(p.card) ? theme.text.faint : undefined)
    return (
      <box id={`need-${p.n}`} flexShrink={0} marginBottom={1} backgroundColor={needBg(p.n, false)} onMouseDown={() => answerNeed(p.n)}>
        <text wrapMode="none" fg={dim() ?? gold()}>
          <span style={{ fg: dim() ?? theme.text.base }}>{`${p.n + 1} `}</span>
          {p.card.kind === "reply" ? "↩ " : "@ "}
          <span style={{ fg: dim() ?? nameFg(e().from) }}>{fit(e().from.name, p.width - 8 - where().length)}</span>
          <span style={{ fg: theme.text.faint }}>{`  ${where()}`}</span>
        </text>
        <text fg={dim() ?? theme.text.muted}>{fit(e().text.split("\n")[0]!, (p.width - 4) * 2)}</text>
      </box>
    )
  }

  // The highlight stays on screen as it moves and as items arrive above it.
  let needScroller: ScrollBoxRenderable | undefined
  createEffect(
    on([needAt, keysAt], ([n]) => {
      if (needScroller && !needScroller.isDestroyed) needScroller.scrollChildIntoView(`need-${n}`, { align: "nearest", inset: 2 })
    }),
  )

  // The rows are kept by slot. Every snapshot makes new waiting entries and cards, and a row remade
  // between two frames drops a click on it.
  const Inspector = (p: { width: number }) => {
    const selected = () => {
      const r = selection()
      return r?.kind === "peer" ? r.presence : undefined
    }
    return (
      <box width={p.width} flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} backgroundColor={theme.background.raised.base}>
        <scrollbox ref={(r: ScrollBoxRenderable) => (needScroller = r)} flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
          <Show when={waiting().length || !cards().length}>
            <Section title={`NEEDS YOU · ${waiting().length}`} />
            <box height={1} flexShrink={0} />
          </Show>
          <Show
            when={waiting().length}
            fallback={<Show when={!cards().length}><text fg={theme.text.muted}>Nothing needs you.</text></Show>}
          >
            <Index each={waiting()}>
              {(a, i) => (
                <box id={`need-${i}`} flexShrink={0} marginBottom={1} backgroundColor={needBg(i, openPeer() === a().card.id)} onMouseDown={() => answerNeed(i)}>
                  <text wrapMode="none" fg={theme.text.feedback.warning.base}>
                    <span style={{ fg: theme.text.base }}>{`${i + 1} `}</span>
                    {"◐ "}
                    <span style={{ fg: nameFg(a().card) }}>{fit(a().card.name, p.width - 8 - (a().card.role?.length ?? 0))}</span>
                    <span style={{ fg: theme.text.faint }}>{a().card.role ? `  ${a().card.role}` : ""}</span>
                  </text>
                  <text fg={theme.text.muted}>{fit(a().activity ?? "reported no question", (p.width - 4) * 3)}</text>
                </box>
              )}
            </Index>
          </Show>
          <Show when={cards().length}>
            <Section title={`REPLIES AND MENTIONS · ${cards().length}`} />
            <box height={1} flexShrink={0} />
            <Index each={cards()}>{(c, i) => <CardRow card={c()} n={waiting().length + i} width={p.width} />}</Index>
          </Show>
          <Show when={selected()}>
            {(a) => (
              <box flexShrink={0} marginTop={1}>
                <Section title={a().card.kind === "agent" ? "AGENT" : "ENDPOINT"} right={fit(a().card.name, p.width - 16)} />
                <box height={1} flexShrink={0} />
                <For each={overview(a(), now(), managed())}>{(f) => <Field label={f.label} value={f.value} fg={theme.text.base} />}</For>
              </box>
            )}
          </Show>
        </scrollbox>
      </box>
    )
  }

  // The footer speaks only when the connection is in trouble; the middle column says why.
  const indicator = (): Line | undefined => {
    const c = conn()
    if (c.phase === "reconnecting") return { text: "◐ reconnecting", fg: theme.text.feedback.warning.base }
    if (c.phase === "failed") return { text: "✗ not connected", fg: theme.text.feedback.error.base }
    return undefined
  }

  const toneFg = (tone: "success" | "warning" | "error") => theme.text.feedback[tone].base
  const stopLine = (): Line | undefined => {
    const s = stop()
    if (s.phase === "stopping") return { text: `${s.force ? "force-killing" : "stopping"} ${s.name}…`, fg: theme.text.muted }
    if (s.phase === "done") return { text: s.text, fg: toneFg(s.tone) }
    return undefined
  }
  const ago = (since: number) => {
    const s = Math.max(0, Math.round((now() - since) / 1000))
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
  }
  const spawnLine = (st: SpawnState): Line => {
    switch (st.phase) {
      case "launching":
        return { text: `spawning ${st.label}… · ${ago(st.since)}`, fg: theme.text.muted }
      case "waiting":
        if (st.late) return { text: `${st.name} is running but has not joined yet; following it · ${ago(st.since)}`, fg: toneFg("warning") }
        if (st.waitingFor) return { text: `${st.name} waits for you at ${st.waitingFor}; \`cotal attach ${st.name}\` opens it`, fg: toneFg("warning") }
        return { text: `the manager started ${st.name}; waiting for it on the roster…${st.notice ? ` · ${st.notice}` : ""}`, fg: theme.text.muted }
      case "joined":
        return st.notice ? { text: `${st.name} joined · ${st.notice}`, fg: toneFg("warning") } : { text: `${st.name} joined`, fg: toneFg("success") }
      case "exited":
        return { text: st.reason, fg: toneFg("error") }
      case "refused":
        return { text: `spawn: ${st.error}`, fg: toneFg("error") }
    }
  }
  const noticeLines = () => [stopLine(), ...spawns().map((x) => spawnLine(x.state()))].filter((l): l is Line => l !== undefined)

  const StatusBar = () => (
    <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
      <text wrapMode="none" fg={indicator()?.fg ?? theme.text.faint} flexShrink={1}>
        {indicator()?.text ?? ""}
      </text>
      <text wrapMode="none" fg={theme.text.faint} flexShrink={0}>
        ? help · ctrl+p commands
      </text>
    </box>
  )

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background.base}>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Tree width={layout().tree} />
        <Middle />
        <Show when={inspectorWidth()}>{(width) => <Inspector width={width()} />}</Show>
      </box>
      <For each={noticeLines()}>
        {(line) => (
          <box flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.base}>
            <text fg={line.fg}>{fit(line.text, dims().width - 2)}</text>
          </box>
        )}
      </For>
      <StatusBar />
    </box>
  )
}

function ConfirmStop(props: { name: string; answer: (a: Answer) => void }) {
  const theme = useTheme().surface("dialog")
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { id: "cotal.stop.graceful", bind: "y", title: "Stop", group: "Dialog", run: () => props.answer("graceful") },
      { id: "cotal.stop.force", bind: "f", title: "Force-kill", group: "Dialog", run: () => props.answer("force") },
      // Enter cancels: the safe answer is the one a stray Enter gives.
      { id: "cotal.stop.cancel", bind: "n,return", title: "Cancel", group: "Dialog", run: () => props.answer("cancel") },
    ],
  }))
  return (
    <DialogLayout header={<DialogHeader title={`Stop agent ${props.name} via the manager?`} />}>
      <text>
        <span style={{ fg: theme.text.action.primary.base }}>y</span>
        <span style={{ fg: theme.text.base }}> stop · </span>
        <span style={{ fg: theme.text.action.primary.base }}>f</span>
        <span style={{ fg: theme.text.base }}> force-kill · </span>
        <span style={{ fg: theme.text.action.primary.base }}>n esc enter</span>
        <span style={{ fg: theme.text.base }}> cancel</span>
      </text>
    </DialogLayout>
  )
}

function Help(props: { commands: Command[] }) {
  const theme = useTheme().surface("dialog")
  const groups = () => [...new Set(props.commands.filter((c) => c.keys).map((c) => c.group))]
  return (
    <DialogLayout header={<DialogHeader title="Keys" />}>
      <For each={groups()}>
        {(group) => (
          <box flexShrink={0} marginBottom={1}>
            <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>
              {group}
            </text>
            <For each={props.commands.filter((c) => c.group === group && c.keys)}>
              {(c) => (
                <text>
                  <span style={{ fg: theme.text.action.primary.base }}>{c.keys!.padEnd(12)}</span>
                  <span style={{ fg: theme.text.base }}>{c.title}</span>
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </DialogLayout>
  )
}

function Palette(props: { commands: Command[] }) {
  return (
    <DialogSelect
      title="Commands"
      flat
      filterThreshold={0.7}
      options={props.commands
        .filter((c) => c.palette)
        .map((c) => ({
          title: c.title,
          category: c.group,
          footer: c.keys,
          value: c.id,
          onSelect: (d) => {
            d.clear()
            c.run?.()
          },
        }))}
    />
  )
}

/** Quit with unsent drafts. `y` quits; `n`, esc and enter stay, so a stray Enter is safe. */
function ConfirmQuit(props: { drafts: number; answer: (quit: boolean) => void }) {
  const theme = useTheme().surface("dialog")
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { id: "cotal.quit.yes", bind: "y", title: "Quit", group: "Dialog", run: () => props.answer(true) },
      { id: "cotal.quit.no", bind: "n,return", title: "Stay", group: "Dialog", run: () => props.answer(false) },
    ],
  }))
  return (
    <DialogLayout header={<DialogHeader title={`Quit with ${props.drafts} unsent draft${props.drafts === 1 ? "" : "s"}?`} />}>
      <text>
        <span style={{ fg: theme.text.action.primary.base }}>y</span>
        <span style={{ fg: theme.text.base }}> quit · </span>
        <span style={{ fg: theme.text.action.primary.base }}>n esc enter</span>
        <span style={{ fg: theme.text.base }}> stay</span>
      </text>
    </DialogLayout>
  )
}

/** Change your name: saves the `name` preference every chat session on this machine uses. An empty
 *  name unsets it. An open session keeps its name until it ends. */
function NameDialog(props: { talk: Talk; done: () => void }) {
  const theme = useTheme().surface("dialog")
  const [error, setError] = createSignal<string>()
  const current = () => {
    const n = props.talk.name()
    return n.state === "ok" ? n.name : undefined
  }
  let input: InputRenderable | undefined
  const save = async () => {
    const value = input?.value.trim() ?? ""
    const refused = await props.talk.rename(value === "" ? undefined : value)
    if (refused) return setError(refused)
    props.done()
  }
  return (
    <DialogLayout header={<DialogHeader title="Change your name" />}>
      <text fg={theme.text.muted}>{current() ? `Your name is ${current()!.name}, from ${current()!.from}.` : "Your name is not resolved yet."}</text>
      <text fg={theme.text.muted}>{props.talk.phase().phase === "open" ? "The open session keeps its name until it ends." : "Every chat session on this machine uses it."}</text>
      <box height={1} />
      <input
        ref={(r: InputRenderable) => {
          input = r
          setTimeout(() => r.focus(), 1)
        }}
        placeholder="a name, or empty for your sign-in name or OS login"
        onSubmit={() => void save()}
      />
      <Show when={error()}>{(e) => <text fg={theme.text.feedback.error.base}>{e()}</text>}</Show>
    </DialogLayout>
  )
}
