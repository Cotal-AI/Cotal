import { TextAttributes, type KeyEvent, type RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { COMMAND_PALETTE_COMMAND, Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { useTheme } from "../vendor/opencode/packages/tui/src/context/theme"
import { SplitBorder } from "../vendor/opencode/packages/tui/src/ui/border"
import { DialogHeader, DialogLayout, useDialog } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { DialogSelect } from "../vendor/opencode/packages/tui/src/ui/dialog-select"
import { useToast } from "../vendor/opencode/packages/tui/src/ui/toast"
import type { Catalog, Entry } from "./catalog.js"
import { layoutFor } from "./layout.js"
import type { Conn, FeedEntry, Mesh, Presence, Session } from "./live.js"
import { clock, entryKey, feedFor, meshOf, type Open, overview, peerKey, peerOf, route, type Row, STATUS, treeItems } from "./screen.js"

/** The catalog read, which starts after the first frame so the frame never waits on it. */
type Load = { phase: "loading" } | { phase: "ready"; catalog: Catalog } | { phase: "failed"; message: string }

/** One table drives the key bindings, the help dialog (rows with `keys`) and the palette (rows with
 *  `palette`). A `global` command also runs while a dialog is open. */
type Command = { id: string; bind: string; keys?: string; title: string; group: string; palette?: true; global?: true; run: (event?: KeyEvent) => void }

type Line = { text: string; fg: RGBA }

const FEED_ROWS = 200

const fit = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p
// Workspace messages start with the file they name, which the row already shows.
const reason = (e: Extract<Entry, { kind: "unusable" }>) => (e.message.startsWith(e.source) ? e.message.slice(e.source.length).trim() : e.message)

export function Shell(props: { quit: () => void; readCatalog: () => Promise<Catalog>; openSpace: (space?: string) => Promise<Session> }) {
  const theme = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const dims = useTerminalDimensions()
  const [load, setLoad] = createSignal<Load>({ phase: "loading" })
  const [session, setSession] = createSignal<Session>()
  const [cursor, setCursor] = createSignal<string>()
  const [open, setOpen] = createSignal<Open>({ kind: "channel" })
  const [seen, setSeen] = createSignal<Record<string, number>>({})
  const [now, setNow] = createSignal(Date.now())

  const entries = () => {
    const l = load()
    return l.phase === "ready" ? l.catalog.entries : []
  }
  const conn = (): Conn => session()?.conn() ?? { phase: "connecting" }
  const mesh = () => meshOf(conn())
  const waiting = () => mesh()?.signals.waiting ?? []
  const items = createMemo(() => treeItems(entries(), conn(), seen()))
  const rows = createMemo(() => items().filter((i): i is Row => i.kind !== "header"))
  const cursorIndex = () => {
    const at = rows().findIndex((r) => r.key === cursor())
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

  const switchTo = async (space?: string) => {
    const old = session()
    setSession(undefined)
    setOpen({ kind: "channel" })
    setSeen({})
    await old?.close()
    setSession(await props.openSpace(space))
  }
  void switchTo()
  onCleanup(() => void session()?.close())

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
    if (r.kind === "channel") return setOpen({ kind: "channel", channel: r.channel })
    if (r.kind === "peer") return setOpen({ kind: "peer", id: r.presence.card.id })
    if (r.entry.kind !== "space") return setOpen({ kind: "entry", key: r.key })
    if (r.open) return setOpen({ kind: "channel" })
    void switchTo(r.entry.space)
  }
  const openWaiting = (n: number) => {
    const list = waiting()
    if (list.length === 0) return toast.show({ variant: "info", message: "Nothing needs you" })
    const p = list[n]
    if (!p) return toast.show({ variant: "warning", message: `Only ${list.length} agent(s) need you` })
    setOpen({ kind: "peer", id: p.card.id })
    setCursor(peerKey(p.card.id))
  }
  const nextWaiting = () => {
    const at = waiting().findIndex((p) => p.card.id === openPeer())
    openWaiting(at + 1 < waiting().length ? at + 1 : 0)
  }

  const commands: Command[] = [
    { id: "cotal.down", bind: "j,down", keys: "j ↓", title: "Next row", group: "Move", run: () => move(1) },
    { id: "cotal.up", bind: "k,up", keys: "k ↑", title: "Previous row", group: "Move", run: () => move(-1) },
    { id: "cotal.open", bind: "return", keys: "enter", title: "Open the selected row", group: "Move", run: openRow },
    { id: "cotal.next-need", bind: "w", keys: "w", title: "Open the next waiting agent", group: "Needs you", palette: true, run: nextWaiting },
    { id: "cotal.need", bind: "1,2,3,4,5,6,7,8,9", keys: "1-9", title: "Open that waiting agent", group: "Needs you", run: (e) => e && openWaiting(Number(e.name) - 1) },
    { id: "cotal.reload", bind: "ctrl+r", keys: "ctrl+r", title: "Reread spaces", group: "System", palette: true, run: () => void read(true) },
    { id: COMMAND_PALETTE_COMMAND, bind: "ctrl+p", keys: "ctrl+p", title: "Commands", group: "System", global: true, run: () => dialog.replace(() => <Palette commands={commands} />) },
    { id: "cotal.help", bind: "?", keys: "?", title: "Keys", group: "System", palette: true, run: () => dialog.replace(() => <Help commands={commands} />, undefined, { size: "large" }) },
    { id: "cotal.quit", bind: "q", keys: "q ctrl+c", title: "Quit", group: "System", palette: true, run: props.quit },
    { id: "cotal.quit-anywhere", bind: "ctrl+c", title: "Quit", group: "System", global: true, run: props.quit },
  ]
  const toLayer = (c: Command) => ({ ...c, run: (_input?: string, event?: KeyEvent) => c.run(event) })
  Keymap.createLayer(() => ({ commands: commands.filter((c) => !c.global).map(toLayer) }))
  Keymap.createLayer(() => ({ mode: "global", commands: commands.filter((c) => c.global).map(toLayer) }))

  const statusFg = (p: Presence) =>
    ({ working: theme.text.feedback.success.base, waiting: theme.text.feedback.warning.base, idle: theme.text.muted, offline: theme.text.faint })[p.status]

  const Section = (p: { title: string; right?: string }) => (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={theme.text.muted} attributes={TextAttributes.BOLD} wrapMode="none">
        {p.title}
      </text>
      <text fg={theme.text.faint} wrapMode="none">
        {p.right ?? ""}
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
      return { mark, markFg: statusFg(p), name: fit(p.card.name, width - tag.length - 5), tag: fit(tag, Math.max(0, width - 12)), fg: p.status === "offline" ? theme.text.faint : theme.text.base }
    }
    const e = r.entry
    if (e.kind === "unusable") return { mark: "✗", markFg: theme.text.feedback.error.base, name: fit(baseName(e.source), width - 4), tag: "", fg: theme.text.feedback.error.base }
    const tag = e.kind === "prepared" ? "prepared" : r.open ? "open" : e.mode
    return { mark: r.open ? "▸" : " ", markFg: theme.text.action.primary.base, name: fit(e.space, width - tag.length - 5), tag, fg: e.kind === "prepared" ? theme.text.muted : theme.text.base }
  }

  const Tree = (p: { width: number }) => {
    const height = () => Math.max(1, dims().height - 4)
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
              <box flexDirection="row" justifyContent="space-between" flexShrink={0} backgroundColor={item.key === selection()?.key ? theme.background.raised.high : undefined}>
                <text wrapMode="none" fg={label().fg}>
                  <span style={{ fg: label().markFg }}>{label().mark}</span>
                  {` ${label().name}`}
                </text>
                <text wrapMode="none" fg={item.kind === "channel" && item.unread ? theme.text.action.primary.base : theme.text.faint}>
                  {label().tag}
                </text>
              </box>
            )
          }}
        </For>
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
    if (c.phase === "connecting")
      return { title: c.space ?? "Opening a space", lines: [{ text: c.space ? `Connecting to ${c.space}…` : "Finding the space for this folder…", fg: theme.text.muted }] }
    if (c.phase === "closed") return { title: c.space ?? "No space open", lines: [{ text: "Closed.", fg: theme.text.muted }] }
    if (c.phase === "failed") {
      const pick = entries().some((e) => e.kind === "space") ? [{ text: "Pick a space on the left and press enter to open it.", fg: theme.text.muted }] : []
      const none = entries().length === 0 && load().phase === "ready" ? [{ text: "Prepare one with `cotal space create <name>`, or start one in a project with `cotal up`.", fg: theme.text.muted }] : []
      return {
        title: c.space ?? "No space open",
        lines: [{ text: c.message, fg: theme.text.feedback.error.base }, ...(c.remedy ? [{ text: c.remedy, fg: theme.text.base }] : []), ...pick, ...none],
      }
    }
    return undefined
  }

  const FeedRow = (p: { entry: FeedEntry; withChannel: boolean }) => (
    <box flexShrink={0} marginBottom={1} border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={p.entry.events ? theme.text.faint : theme.text.muted} paddingLeft={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text wrapMode="none" fg={theme.text.base} attributes={TextAttributes.BOLD}>
          {p.entry.from.name}
          <span style={{ fg: theme.text.faint }}>{` ${route(p.entry, p.withChannel)}`}</span>
        </text>
        <text wrapMode="none" fg={theme.text.faint}>
          {clock(p.entry.ts)}
        </text>
      </box>
      <text fg={p.entry.events ? theme.text.muted : theme.text.base}>{p.entry.text}</text>
    </box>
  )

  const Conversation = (p: { mesh: Mesh }) => {
    const peer = () => {
      const id = openPeer()
      return id === undefined ? undefined : peerOf(p.mesh, id)
    }
    const channel = () => {
      const o = open()
      return o.kind === "channel" ? o : undefined
    }
    const feed = () => feedFor(p.mesh, open()).slice(-FEED_ROWS)
    const title = () => {
      const c = channel()
      if (c) return c.channel === undefined ? "all traffic" : `#${c.channel}`
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
        <Show when={peer()}>
          {(pr) => (
            <box flexShrink={0} marginBottom={1}>
              <Show when={pr().status === "waiting"}>
                <text fg={theme.text.feedback.warning.base}>{`◐ ${pr().card.name} is waiting`}</text>
                <text fg={theme.text.base}>{pr().activity ? `“${pr().activity}”` : "It reported no question."}</text>
              </Show>
              <Show when={layout().kind === "two"}>
                <For each={overview(pr(), now())}>{(f) => <text fg={theme.text.muted}>{`${f.label.padEnd(9)}${f.value}`}</text>}</For>
              </Show>
            </box>
          )}
        </Show>
        <box flexGrow={1} minHeight={0} overflow="hidden">
          <Show when={feed().length} fallback={<text fg={theme.text.muted}>No messages yet.</text>}>
            <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
              <For each={feed()}>{(e) => <FeedRow entry={e} withChannel={channel()?.channel === undefined} />}</For>
            </scrollbox>
          </Show>
        </box>
      </>
    )
  }

  const summary = () => {
    const n = waiting().length
    return n === 0 ? "nothing needs you" : `${n} need${n === 1 ? "s" : ""} you · w opens the next`
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
      <Show when={layout().kind === "two"}>
        <text wrapMode="none" fg={waiting().length ? theme.text.feedback.warning.base : theme.text.faint} flexShrink={0}>
          {summary()}
        </text>
      </Show>
    </box>
  )

  const Inspector = (p: { width: number }) => {
    const selected = () => {
      const r = selection()
      return r?.kind === "peer" ? r.presence : undefined
    }
    return (
      <box width={p.width} flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} backgroundColor={theme.background.raised.base}>
        <Section title={`NEEDS YOU · ${waiting().length}`} right={waiting().length && p.width >= 40 ? `1-${Math.min(9, waiting().length)} open · w next` : ""} />
        <box height={1} flexShrink={0} />
        <Show
          when={waiting().length}
          fallback={
            <>
              <text fg={theme.text.base}>Nothing needs you.</text>
              <text fg={theme.text.muted}>{mesh() ? "Agents that wait for an answer show here." : "Waiting agents show here once a space is open."}</text>
            </>
          }
        >
          <For each={waiting()}>
            {(a, i) => (
              <box flexShrink={0} marginBottom={1} backgroundColor={openPeer() === a.card.id ? theme.background.raised.high : undefined}>
                <text wrapMode="none" fg={theme.text.feedback.warning.base}>
                  <span style={{ fg: theme.text.base }}>{`${i() + 1} `}</span>
                  {`◐ ${fit(a.card.name, p.width - 8 - (a.card.role?.length ?? 0))}`}
                  <span style={{ fg: theme.text.faint }}>{a.card.role ? `  ${a.card.role}` : ""}</span>
                </text>
                <text fg={theme.text.muted}>{fit(a.activity ?? "reported no question", (p.width - 4) * 3)}</text>
              </box>
            )}
          </For>
        </Show>
        <Show when={selected()}>
          {(a) => (
            <box flexShrink={0} marginTop={1}>
              <Section title={a().card.kind === "agent" ? "AGENT" : "ENDPOINT"} right={fit(a().card.name, p.width - 16)} />
              <box height={1} flexShrink={0} />
              <For each={overview(a(), now())}>
                {(f) => (
                  <box flexDirection="row" flexShrink={0}>
                    <text width={9} flexShrink={0} wrapMode="none" fg={theme.text.faint}>
                      {f.label}
                    </text>
                    <text flexGrow={1} flexShrink={1} fg={theme.text.base}>
                      {f.value}
                    </text>
                  </box>
                )}
              </For>
            </box>
          )}
        </Show>
      </box>
    )
  }

  const indicator = (): { text: string; fg: RGBA } => {
    const c = conn()
    if (c.phase === "live") return { text: `● live · ${c.space}`, fg: theme.text.feedback.success.base }
    if (c.phase === "reconnecting") return { text: `◐ reconnecting · ${c.space}`, fg: theme.text.feedback.warning.base }
    if (c.phase === "connecting") return { text: c.space ? `◌ connecting · ${c.space}` : "◌ connecting", fg: theme.text.muted }
    if (c.phase === "closed") return { text: "○ closed", fg: theme.text.muted }
    return { text: "✗ not connected", fg: theme.text.feedback.error.base }
  }

  const StatusBar = () => (
    <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
      <text wrapMode="none" fg={theme.text.faint} flexShrink={1}>
        {fit("j k move · enter open · w next · ? help · ctrl+p commands · q quit", dims().width - indicator().text.length - 4)}
      </text>
      <text wrapMode="none" fg={indicator().fg} flexShrink={0}>
        {indicator().text}
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
      <StatusBar />
    </box>
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
            c.run()
          },
        }))}
    />
  )
}
