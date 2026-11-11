import { RGBA, TextAttributes, type InputRenderable, type TextareaRenderable } from "@opentui/core"
import { personaCatalogDescription } from "@cotal-ai/core"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { useTheme } from "../vendor/opencode/packages/tui/src/context/theme"
import { DIALOG_INSET, DIALOG_LIST_INSET, DialogBleed, DialogHeader, DialogLayout } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { DialogSelect, DialogSelectChoice } from "../vendor/opencode/packages/tui/src/ui/dialog-select"
import { Locale } from "../vendor/opencode/packages/tui/src/util/locale"
import { cycleApp, cycleEffort, cycleModel, resolve, ROWS, type Draft, type Persona, type Row, type SpawnRequest, type SpawnSetup } from "./spawn.js"

const LABEL: Record<Row, string> = { prompt: "Prompt", app: "Application", model: "Model", effort: "Effort", name: "Name" }

/** The personas `S` spawns from: the ones spawned from this app first, the saved default marked and
 *  highlighted, each with its description and the application it runs in. `at` is the persona to
 *  highlight instead, when the form for it was closed. */
export function PersonaDialog(props: { setup: SpawnSetup; recent: readonly string[]; at?: string; pick: (persona: Persona) => void }) {
  const theme = useTheme().surface("dialog")
  const { setup } = props
  const recent = props.recent.filter((n) => setup.personas.some((p) => p.name === n))
  const ordered = [...recent.map((n) => setup.personas.find((p) => p.name === n)!), ...setup.personas.filter((p) => !recent.includes(p.name))]
  return (
    <DialogSelect
      title="Spawn agent"
      flat
      current={setup.defaultPersona}
      focusTarget={props.at}
      options={ordered.map((p, i) => {
        const app = p.def ? (p.def.agent ?? setup.defaultApplication) : undefined
        return {
          title: p.name,
          value: p.name,
          description: p.def ? (personaCatalogDescription(p.def) ?? "") : `cannot be read: ${p.error}`,
          footer: app,
          searchFooter: app,
          searchText: `${p.def?.role ?? ""} ${app ?? ""}`,
          ...(recent.length ? { category: i < recent.length ? "Recent" : "Personas" } : {}),
        }
      })}
      onSelect={(o) => {
        const p = setup.personas.find((x) => x.name === o.value)
        if (p?.def) props.pick({ name: p.name, def: p.def })
      }}
      emptyView={<text fg={theme.text.muted}>{`No personas in ${setup.dir}. Make one with \`cotal persona create <name>\`.`}</text>}
    />
  )
}

/**
 * The settings of one spawn, opened on the persona picked. `↑` `↓` move between the rows and skip a
 * disabled Effort, `←` `→` change the application, the model or the effort, and the prompt and the
 * name are typed in their rows. Enter spawns from any row unless a value is refused, which
 * highlights that row. Esc goes back to the personas.
 */
export function SpawnForm(props: { setup: SpawnSetup; persona: Persona; nameError: (name: string) => string | undefined; launch: (r: SpawnRequest) => void; back: () => void }) {
  const theme = useTheme().surface("dialog")
  const [draft, setDraft] = createSignal<Draft>({ persona: props.persona, prompt: "", name: props.persona.name })
  const [at, setAt] = createSignal<Row>("prompt")
  const r = createMemo(() => resolve(props.setup, draft(), props.nameError))
  const refused = (row: Row) => {
    const now = r()
    return "refused" in now && now.refused.row === row ? now.refused.reason : undefined
  }
  const disabled = (row: Row) => row === "effort" && "disabled" in r().effort

  // Each editor stays mounted while the form is open, so its text, cursor and undo survive leaving the row.
  const editors: Partial<Record<Row, TextareaRenderable>> = {}
  createEffect(() => {
    const row = at()
    setTimeout(() => {
      for (const [key, editor] of Object.entries(editors)) if (!editor.isDestroyed) key === row ? editor.focus() : editor.blur()
    }, 1)
  })

  const move = (by: 1 | -1) =>
    void setAt((row) => {
      let next = row
      do next = ROWS[(ROWS.indexOf(next) + by + ROWS.length) % ROWS.length]!
      while (disabled(next))
      return next
    })
  // In a prompt of several lines, the arrows move its cursor until it reaches the first or last line.
  const vertical = (by: 1 | -1) => {
    const prompt = editors.prompt
    if (at() === "prompt" && prompt && !prompt.isDestroyed) {
      const line = prompt.visualCursor.visualRow
      if (by < 0 ? line > 0 : line < prompt.virtualLineCount - 1) return void (by < 0 ? prompt.moveCursorUp() : prompt.moveCursorDown())
    }
    move(by)
  }
  const change = (by: 1 | -1) => void setDraft((d) => (at() === "app" ? cycleApp(props.setup, d, r(), by) : at() === "model" ? cycleModel(d, r(), by) : cycleEffort(d, r(), by)))
  const launch = () => {
    const now = r()
    if ("refused" in now) return void setAt(now.refused.row)
    props.launch(now.request)
  }
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { id: "cotal.spawn.up", bind: "up", title: "Previous setting", group: "Spawn", run: () => vertical(-1) },
      { id: "cotal.spawn.down", bind: "down", title: "Next setting", group: "Spawn", run: () => vertical(1) },
      { id: "cotal.spawn.back", bind: "escape", title: "Back to the personas", group: "Spawn", run: props.back },
    ],
  }))
  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: at() === "app" || at() === "model" || at() === "effort",
    commands: [
      { id: "cotal.spawn.previous", bind: "left", title: "Previous value", group: "Spawn", run: () => change(-1) },
      { id: "cotal.spawn.next", bind: "right", title: "Next value", group: "Spawn", run: () => change(1) },
      { id: "cotal.spawn.launch", bind: "return", title: "Spawn", group: "Spawn", run: launch },
    ],
  }))

  const shown: Record<Row, () => string> = {
    prompt: () => (draft().prompt.trim() ? Locale.truncate(draft().prompt.trim().replace(/\s+/g, " "), 40) : "none"),
    app: () => r().app.id,
    model: () => r().model || "default",
    effort: () => {
      const e = r().effort
      return "disabled" in e ? e.disabled : e.value || "default"
    },
    name: () => r().name,
  }
  const about = personaCatalogDescription(props.persona.def)
  const typed = (row: Row) => row === "prompt" || row === "name"

  const Value = (p: { row: Row; active: boolean }) => {
    const fg = () => (p.active ? theme.text.action.primary.focused : r().changed[p.row] ? theme.hue.accent[200] : theme.text.muted)
    return (
      <>
        <Show when={!(p.active && typed(p.row))}>
          <box flexShrink={0} flexDirection="row" gap={3} marginRight={p.active ? -2 : undefined}>
            <Show when={p.row === "app" && "events" in r().app}>
              <text fg={p.active ? fg() : theme.text.muted}>no activity feed</text>
            </Show>
            <text fg={fg()}>{p.active ? <DialogSelectChoice value={shown[p.row]()} active /> : shown[p.row]()}</text>
          </box>
        </Show>
        <Show when={p.row === "prompt"}>
          <textarea
            ref={(e: TextareaRenderable) => (editors.prompt = e)}
            visible={p.active}
            flexGrow={1}
            minHeight={1}
            maxHeight={4}
            placeholder="what it should do first (optional)"
            placeholderColor={theme.text.muted}
            textColor={theme.text.base}
            focusedTextColor={theme.text.base}
            cursorColor={theme.text.base}
            backgroundColor={RGBA.fromInts(0, 0, 0, 0)}
            focusedBackgroundColor={RGBA.fromInts(0, 0, 0, 0)}
            onContentChange={() => editors.prompt && setDraft((d) => ({ ...d, prompt: editors.prompt!.plainText }))}
            onSubmit={launch}
          />
        </Show>
        <Show when={p.row === "name"}>
          <input
            ref={(e: InputRenderable) => (editors.name = e)}
            visible={p.active}
            flexGrow={1}
            value={props.persona.name}
            placeholder={props.persona.name}
            placeholderColor={theme.text.muted}
            textColor={theme.text.base}
            focusedTextColor={theme.text.base}
            cursorColor={theme.text.base}
            backgroundColor={RGBA.fromInts(0, 0, 0, 0)}
            focusedBackgroundColor={RGBA.fromInts(0, 0, 0, 0)}
            onInput={(v: string) => setDraft((d) => ({ ...d, name: v }))}
            onSubmit={launch}
          />
        </Show>
      </>
    )
  }

  return (
    <DialogLayout
      header={
        <box paddingLeft={DIALOG_LIST_INSET - DIALOG_INSET} paddingRight={DIALOG_LIST_INSET - DIALOG_INSET}>
          <DialogHeader title={`Spawn ${props.persona.name}`} onClose={props.back} />
          <Show when={about}>
            <text fg={theme.text.muted} wrapMode="word">
              {about}
            </text>
          </Show>
        </box>
      }
    >
      <DialogBleed>
        <box paddingLeft={1} paddingRight={1}>
          <For each={ROWS}>
            {(row) => {
              const active = () => at() === row
              const typing = () => active() && typed(row)
              return (
                <box flexDirection="column" onMouseDown={() => !disabled(row) && setAt(row)}>
                  <box
                    flexDirection="row"
                    paddingLeft={DIALOG_LIST_INSET - 1}
                    paddingRight={DIALOG_LIST_INSET - 1}
                    gap={2}
                    backgroundColor={active() && !typing() ? theme.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
                  >
                    <text
                      flexGrow={typing() ? 0 : 1}
                      flexShrink={0}
                      fg={typing() ? theme.background.action.primary.focused : active() ? theme.text.action.primary.focused : disabled(row) ? theme.text.muted : theme.text.base}
                      attributes={active() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {LABEL[row]}
                    </text>
                    <Value row={row} active={active()} />
                  </box>
                  <Show when={refused(row)}>
                    {(reason) => (
                      <box paddingLeft={DIALOG_LIST_INSET - 1} paddingRight={DIALOG_LIST_INSET - 1}>
                        <text fg={theme.text.feedback.error.base} wrapMode="word">
                          {reason()}
                        </text>
                      </box>
                    )}
                  </Show>
                </box>
              )
            }}
          </For>
        </box>
      </DialogBleed>
    </DialogLayout>
  )
}
