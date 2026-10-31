import { TextAttributes, type KeyEvent, type RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { COMMAND_PALETTE_COMMAND, Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { useTheme } from "../vendor/opencode/packages/tui/src/context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { DialogSelect } from "../vendor/opencode/packages/tui/src/ui/dialog-select"
import { useToast } from "../vendor/opencode/packages/tui/src/ui/toast"
import type { Catalog, Entry } from "./catalog.js"
import { layoutFor } from "./layout.js"

/** The catalog read, which starts after the first frame so the frame never waits on it. */
type Load = { phase: "loading" } | { phase: "ready"; catalog: Catalog } | { phase: "failed"; message: string }

/** One table drives the key bindings, the help dialog (rows with `keys`) and the palette (rows with
 *  `palette`). A `global` command also runs while a dialog is open. */
type Command = { id: string; bind: string; keys?: string; title: string; group: string; palette?: true; global?: true; run: (event?: KeyEvent) => void }

const fit = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p
// Workspace messages start with the file they name, which the row already shows.
const reason = (e: Extract<Entry, { kind: "unusable" }>) => (e.message.startsWith(e.source) ? e.message.slice(e.source.length).trim() : e.message)

export function Shell(props: { quit: () => void; readCatalog: () => Promise<Catalog> }) {
  const theme = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const dims = useTerminalDimensions()
  const [load, setLoad] = createSignal<Load>({ phase: "loading" })
  const [selected, setSelected] = createSignal(0)

  const entries = () => {
    const l = load()
    return l.phase === "ready" ? l.catalog.entries : []
  }
  const current = () => {
    const l = load()
    return l.phase === "ready" ? l.catalog.current : undefined
  }
  const needsYou = createMemo(() => entries().flatMap((e, i) => (e.kind === "unusable" ? [{ entry: e, index: i }] : [])))
  const selection = () => entries()[selected()]
  const layout = () => layoutFor(dims().width)
  const inspectorWidth = () => {
    const l = layout()
    return l.kind === "three" ? l.inspector : undefined
  }

  const read = async (announce: boolean) => {
    try {
      const catalog = await props.readCatalog()
      const first = load().phase !== "ready"
      setLoad({ phase: "ready", catalog })
      const currentIndex = catalog.entries.findIndex((e) => e.kind !== "unusable" && e.space === catalog.current)
      setSelected((i) => (first && currentIndex >= 0 ? currentIndex : Math.min(i, Math.max(0, catalog.entries.length - 1))))
      if (announce) toast.show({ variant: "success", message: `Reread ${catalog.entries.length} registration(s) from ${catalog.home}` })
    } catch (e) {
      const message = `The space catalog could not be read: ${(e as Error).message}`
      setLoad({ phase: "failed", message })
      toast.show({ variant: "error", message })
    }
  }
  void read(false)

  const move = (by: number) => setSelected((i) => Math.max(0, Math.min(entries().length - 1, i + by)))
  const openNeed = (n: number) => {
    const list = needsYou()
    if (list.length === 0) return toast.show({ variant: "info", message: "Nothing needs you" })
    const item = list[n]
    if (!item) return toast.show({ variant: "warning", message: `Only ${list.length} item(s) need you` })
    setSelected(item.index)
  }
  const nextNeed = () => {
    const list = needsYou()
    const after = list.findIndex((item) => item.index > selected())
    openNeed(after === -1 ? 0 : after)
  }
  const open = () => {
    const e = selection()
    if (e?.kind === "space") toast.show({ variant: "info", message: `Opening a space is not in this build yet. Nothing connected to ${e.space}.` })
  }

  const commands: Command[] = [
    { id: "cotal.down", bind: "j,down", keys: "j ↓", title: "Next row", group: "Move", run: () => move(1) },
    { id: "cotal.up", bind: "k,up", keys: "k ↑", title: "Previous row", group: "Move", run: () => move(-1) },
    { id: "cotal.open", bind: "return", keys: "enter", title: "Open the selected space", group: "Move", run: open },
    { id: "cotal.next-need", bind: "w", keys: "w", title: "Open the next item that needs you", group: "Needs you", palette: true, run: nextNeed },
    { id: "cotal.need", bind: "1,2,3,4,5,6,7,8,9", keys: "1-9", title: "Open that item", group: "Needs you", run: (e) => e && openNeed(Number(e.name) - 1) },
    { id: "cotal.reload", bind: "ctrl+r", keys: "ctrl+r", title: "Reread spaces", group: "System", palette: true, run: () => void read(true) },
    { id: COMMAND_PALETTE_COMMAND, bind: "ctrl+p", keys: "ctrl+p", title: "Commands", group: "System", global: true, run: () => dialog.replace(() => <Palette commands={commands} />) },
    { id: "cotal.help", bind: "?", keys: "?", title: "Keys", group: "System", palette: true, run: () => dialog.replace(() => <Help commands={commands} />, undefined, { size: "large" }) },
    { id: "cotal.quit", bind: "q", keys: "q ctrl+c", title: "Quit", group: "System", palette: true, run: props.quit },
    { id: "cotal.quit-anywhere", bind: "ctrl+c", title: "Quit", group: "System", global: true, run: props.quit },
  ]
  const toLayer = (c: Command) => ({ ...c, run: (_input?: string, event?: KeyEvent) => c.run(event) })
  Keymap.createLayer(() => ({ commands: commands.filter((c) => !c.global).map(toLayer) }))
  Keymap.createLayer(() => ({ mode: "global", commands: commands.filter((c) => c.global).map(toLayer) }))

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

  const rowLabel = (e: Entry, width: number) => {
    if (e.kind === "unusable") return { mark: "✗", name: fit(baseName(e.source), width - 4), tag: "", fg: theme.text.feedback.error.base }
    const tag = e.kind === "prepared" ? "prepared" : e.mode
    const fg = e.kind === "prepared" ? theme.text.muted : theme.text.base
    return { mark: e.space === current() ? "•" : " ", name: fit(e.space, width - tag.length - 5), tag, fg }
  }

  const Tree = (p: { width: number }) => {
    const rows = () => Math.max(1, dims().height - 4)
    const start = () => Math.max(0, Math.min(selected() - rows() + 1, entries().length - rows()))
    return (
      <box width={p.width} flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} backgroundColor={theme.background.raised.base}>
        <Section title="SPACES" right={load().phase === "ready" ? String(entries().filter((e) => e.kind !== "unusable").length) : ""} />
        <Switch>
          <Match when={load().phase === "loading"}>
            <text fg={theme.text.muted}>Reading spaces…</text>
          </Match>
          <Match when={load().phase === "failed"}>
            <text fg={theme.text.feedback.error.base}>Catalog unreadable</text>
          </Match>
          <Match when={entries().length === 0}>
            <text fg={theme.text.muted}>No spaces yet</text>
          </Match>
        </Switch>
        <For each={entries().slice(start(), start() + rows())}>
          {(e, i) => {
            const label = () => rowLabel(e, p.width - 2)
            const isSelected = () => start() + i() === selected()
            return (
              <box flexDirection="row" justifyContent="space-between" flexShrink={0} backgroundColor={isSelected() ? theme.background.raised.high : undefined}>
                <text wrapMode="none" fg={label().fg}>
                  <span style={{ fg: e.kind === "unusable" ? label().fg : theme.text.action.primary.base }}>{label().mark}</span>
                  {` ${label().name}`}
                </text>
                <text wrapMode="none" fg={theme.text.faint}>
                  {label().tag}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    )
  }

  const detail = (): { title: string; lines: { text: string; fg: RGBA }[] } => {
    const l = load()
    if (l.phase === "loading") return { title: "No conversation open", lines: [{ text: "Reading the spaces registered on this machine.", fg: theme.text.muted }] }
    if (l.phase === "failed") return { title: "No conversation open", lines: [{ text: l.message, fg: theme.text.feedback.error.base }] }
    const e = selection()
    if (!e)
      return {
        title: "No conversation open",
        lines: [
          { text: `No spaces are registered in ${l.catalog.home}.`, fg: theme.text.base },
          { text: "Prepare one with `cotal space create <name>`, or start one in a project with `cotal up`.", fg: theme.text.muted },
        ],
      }
    if (e.kind === "unusable")
      return {
        title: baseName(e.source),
        lines: [
          { text: "This registration cannot be used.", fg: theme.text.feedback.error.base },
          { text: e.source, fg: theme.text.muted },
          { text: reason(e), fg: theme.text.base },
        ],
      }
    if (e.kind === "prepared")
      return {
        title: e.space,
        lines: [
          { text: `"${e.space}" is prepared but not started.`, fg: theme.text.base },
          { text: `Start it with \`cotal up\` in ${e.root}.`, fg: theme.text.muted },
        ],
      }
    return {
      title: e.space,
      lines: [
        { text: `${e.mode} · ${e.server} · ${e.origin}`, fg: theme.text.muted },
        { text: e.root, fg: theme.text.muted },
        { text: "Not open. Opening a space is not in this build yet, so nothing has connected to its broker.", fg: theme.text.base },
      ],
    }
  }

  const summary = () => {
    const n = needsYou().length
    return n === 0 ? "nothing needs you" : `${n} need${n === 1 ? "s" : ""} you · w opens the next`
  }

  const Middle = () => (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} minWidth={0}>
      <text wrapMode="none" fg={theme.text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
        {detail().title}
      </text>
      <box height={1} flexShrink={0} />
      <For each={detail().lines}>
        {(line) => (
          <text fg={line.fg} flexShrink={0}>
            {line.text}
          </text>
        )}
      </For>
      <Show when={layout().kind === "two"}>
        <box flexGrow={1} />
        <text wrapMode="none" fg={needsYou().length ? theme.text.feedback.warning.base : theme.text.faint} flexShrink={0}>
          {summary()}
        </text>
      </Show>
    </box>
  )

  const Inspector = (p: { width: number }) => (
    <box width={p.width} flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} backgroundColor={theme.background.raised.base}>
      <Section title={`NEEDS YOU · ${needsYou().length}`} right={needsYou().length && p.width >= 40 ? `1-${Math.min(9, needsYou().length)} open · w next` : ""} />
      <box height={1} flexShrink={0} />
      <Show
        when={needsYou().length}
        fallback={
          <>
            <text fg={theme.text.base}>Nothing needs you.</text>
            <text fg={theme.text.muted}>Waiting agents, unread DMs and mentions show here once a space is open.</text>
          </>
        }
      >
        <For each={needsYou()}>
          {(item, i) => (
            <box flexShrink={0} marginBottom={1} backgroundColor={item.index === selected() ? theme.background.raised.high : undefined}>
              <text wrapMode="none" fg={theme.text.feedback.error.base}>
                <span style={{ fg: theme.text.base }}>{`${i() + 1} `}</span>
                {`✗ ${fit(baseName(item.entry.source), p.width - 8)}`}
              </text>
              <text fg={theme.text.muted}>{fit(reason(item.entry), (p.width - 4) * 3)}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )

  const StatusBar = () => (
    <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
      <text wrapMode="none" fg={theme.text.faint} flexShrink={1}>
        {fit("j k move · w next · ? help · ctrl+p commands · q quit", dims().width - 20)}
      </text>
      <text wrapMode="none" fg={theme.text.muted} flexShrink={0}>
        ○ not connected
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
