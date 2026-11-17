import { EmbeddedTerminalRenderable, type BoxRenderable, type KeyEvent, type PasteEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, onCleanup, onMount } from "solid-js"
import type { Attached } from "./live.js"

// Claude Code and Codex interrupt a turn on Esc, so a lone Esc must still reach them, a moment late.
const ESC_HOLD_MS = 300

/** What the session's end reason means to the person watching. The manager ends a session with
 *  `process-exit` when the agent exits on its own, and with `target-despawn` when it stops, reaps or
 *  retires the seat. */
const ENDED: Record<string, string> = {
  "process-exit": "the agent exited",
  "target-despawn": "the agent is gone",
  "manager-restart": "the manager restarted",
  expired: "the session expired",
  closed: "the manager closed it",
  "peer-closed": "the manager closed it",
  "connection-closed": "the connection was lost",
}
export const endedText = (reason: string) => ENDED[reason] ?? `the session broke (${reason})`

/** An agent's terminal that keeps Esc Esc for the app. A lone Esc is held for `ESC_HOLD_MS` and then
 *  sent; a second one inside that window leaves, and neither reaches the agent. Two Escs that arrive
 *  in one read parse as alt+Esc, so that leaves too. Any other key or a paste during the hold sends
 *  the held Esc first, so the agent sees them in the order they were typed. Once the session has
 *  ended there is nothing to send to, and one Esc leaves. */
class PaneTerminal extends EmbeddedTerminalRenderable {
  leave = () => {}
  ended = false
  private held: { key: KeyEvent; timer: ReturnType<typeof setTimeout> } | undefined

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name !== "escape" || key.ctrl || key.shift) {
      if (key.eventType !== "release") this.sendHeld()
      return super.handleKeyPress(key)
    }
    if (key.eventType === "release") return true
    if (this.ended || this.held || key.meta) {
      clearTimeout(this.held?.timer)
      this.held = undefined
      this.leave()
    } else this.held = { key, timer: setTimeout(() => this.sendHeld(), ESC_HOLD_MS) }
    return true
  }

  override handlePaste(event: PasteEvent) {
    this.sendHeld()
    super.handlePaste(event)
  }

  private sendHeld() {
    if (!this.held) return
    const { key, timer } = this.held
    clearTimeout(timer)
    this.held = undefined
    super.handleKeyPress(key)
  }

  protected override destroySelf() {
    clearTimeout(this.held?.timer)
    super.destroySelf()
  }
}

/** The attached agent's live terminal, filling its box. Its size is the seat's PTY size, so laying it
 *  out resizes the agent for everyone watching it. It holds the keys while it is on screen. */
export function TerminalPane(props: { attached: Attached; onSize: (cols: number, rows: number) => void; leave: () => void }) {
  const term = new PaneTerminal(useRenderer(), {
    width: "100%",
    height: "100%",
    maxScrollback: 5000,
    onData: (bytes) => props.attached.send(bytes),
    onTerminalResize: (cols, rows) => {
      props.attached.resize(cols, rows)
      props.onSize(cols, rows)
    },
  })
  term.leave = () => props.leave()
  props.attached.onOutput((bytes) => term.write(bytes))
  createEffect(() => (term.ended = props.attached.ended() !== undefined))
  onMount(() => term.focus())
  onCleanup(() => term.destroy())
  return <box ref={(host: BoxRenderable) => host.add(term)} flexGrow={1} minHeight={0} minWidth={0} />
}
