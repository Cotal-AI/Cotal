import type { InputRenderable, RGBA, TextareaRenderable } from "@opentui/core"
import { parseRecipient, type Recipient } from "@cotal-ai/workspace/chat"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { useTheme } from "../vendor/opencode/packages/tui/src/context/theme"
import { DialogHeader, DialogLayout } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { draftKey, edited, replyFrom, settled, submit, unsent, type ComposerState, type Effect, type Tone } from "./compose.js"
import type { Mesh } from "./live.js"
import { clock, conversationRecipient, peerOf, type Open } from "./screen.js"
import type { Talk } from "./talk.js"

type Line = { text: string; fg: RGBA }

/** Where a recipient goes, as the box's line names it. */
const where = (r: Recipient) => (r.kind === "channel" ? `#${r.channel}` : r.kind === "peer" ? `@${r.name}` : r.kind === "dm" ? `@${r.to}` : `role:${r.role}`)

/**
 * The input box under the conversation: the quoted message of a reply, the text, and one line naming
 * where the message goes. The session's state and the latest outcome follow that line when there is
 * one. While `focused`, the box pushes the `compose` mode and then focuses the textarea, so letters
 * reach the text and the tree's keys stay off; `tab` hands the keys to the tree.
 */
export function Composer(props: {
  talk: Talk
  space: string
  open: Open
  mesh: Mesh
  state: ComposerState
  setState: (f: (s: ComposerState) => ComposerState) => void
  focused: boolean
  toTree: () => void
  maxRows: number
}) {
  const theme = useTheme()
  const keymap = Keymap.use()
  let ta: TextareaRenderable | undefined

  const key = () => draftKey(props.space, props.open)
  const draft = () => props.state.drafts[key()]
  const recipient = () => draft()?.reply?.to ?? conversationRecipient(props.open, props.mesh)
  const self = () => {
    const p = props.talk.phase()
    return p.phase === "open" ? p.identity.principal : undefined
  }
  const nextName = () => {
    const n = props.talk.name()
    return n.state === "ok" ? n.name.name : undefined
  }
  const tone = (t: Tone) => ({ ok: theme.text.feedback.success.base, waiting: theme.text.feedback.warning.base, failed: theme.text.feedback.error.base, hint: theme.text.muted })[t]

  const ends = () => {
    const p = props.talk.phase()
    return p.phase === "open" && p.identity.expiresAt !== undefined ? ` · ends ${clock(p.identity.expiresAt).slice(0, 5)}` : ""
  }

  const target = () => {
    const r = recipient()
    if (!r) return "no recipient in all traffic"
    const q = draft()?.reply
    if (q) return `replying to ${q.from}${r.kind === "channel" ? ` in #${r.channel}` : ""}${ends()}`
    const peer = props.open.kind === "peer" ? peerOf(props.mesh, props.open.id) : undefined
    if (peer?.status === "waiting") return `answering ${peer.card.name}${ends()}`
    return `${where(r)}${ends()}`
  }

  // A notice belongs to the draft it was given for; the session's own state shows when it is not open.
  const below = (): Line[] => {
    const n = props.state.notice
    const notice = n && n.key === key() ? n.lines.map((text) => ({ text, fg: tone(n.tone) })) : []
    const p = props.talk.phase()
    if (p.phase === "opening") return [{ text: `joining ${props.space} as ${p.name}…`, fg: theme.text.muted }, ...notice]
    if (p.phase === "refused") return [...notice, { text: p.message, fg: theme.text.feedback.error.base }, ...(p.remedy ? [{ text: p.remedy, fg: theme.text.base }] : [])]
    if (p.phase === "ended")
      return [...notice, { text: `session ended ${clock(p.at).slice(0, 5)}: ${p.why} · enter opens a new one${nextName() ? ` as ${nextName()}` : ""}`, fg: theme.text.feedback.warning.base }]
    const name = props.talk.name()
    if (p.phase === "watching" && name.state === "refused")
      return [...notice, { text: `no name to join with: ${name.message}`, fg: theme.text.feedback.error.base }, ...(name.remedy ? [{ text: name.remedy, fg: theme.text.base }] : [])]
    return notice
  }

  // The textarea shows the open conversation's draft, so a switch swaps the text.
  const show = (k = key()) => {
    if (!ta || ta.isDestroyed || k !== key()) return
    const want = props.state.drafts[k]?.text ?? ""
    if (ta.plainText !== want) {
      ta.setText(want)
      ta.gotoBufferEnd()
    }
  }
  createEffect(on(key, () => show(), { defer: true }))

  createEffect(() => {
    if (!props.focused) return
    const pop = keymap.mode.push("compose")
    ta?.focus()
    onCleanup(() => {
      pop()
      if (ta && !ta.isDestroyed) ta.blur()
    })
  })

  const run = async (effect: Effect, k: ReturnType<typeof key>) => {
    switch (effect.kind) {
      case "open":
        return props.talk.open(effect.postTo)
      case "publish": {
        if (effect.open) {
          await props.talk.open(effect.open.postTo)
          if (props.talk.phase().phase !== "open") return props.setState(unsent)
        }
        const result = await props.talk.publish(effect.to, effect.text)
        props.setState((s) => settled(s, result))
        return show(k)
      }
      case "slash": {
        const out = await props.talk.slash(effect.command)
        return props.setState((s) => ({ ...s, notice: { key: k, ...out } }))
      }
      case "reply-latest":
        return props.setState((s) => replyFrom(s, k, props.talk.latest(), self() ?? ""))
      case "end": {
        const closed = await props.talk.end()
        return props.setState((s) => ({ ...s, notice: { key: k, tone: closed?.clean === false ? "waiting" : "ok", lines: [closed ? closed.summary : "no session was open"] } }))
      }
      case "none":
        return
    }
  }

  const onSubmit = () => {
    if (!ta || ta.isDestroyed) return
    const k = key()
    props.setState((s) => edited(s, k, ta!.plainText))
    const step = submit(props.state, k, { space: props.space, phase: props.talk.phase(), name: nextName(), recipient: recipient() })
    props.setState(() => step.state)
    show(k)
    void run(step.effect, k)
  }

  Keymap.createLayer(() => ({
    mode: "compose",
    commands: [{ id: "cotal.compose.tree", bind: "tab", title: "Move to the tree", group: "Move", run: () => props.toTree() }],
  }))

  const bg = theme.background.raised.base
  return (
    <box flexShrink={0} flexDirection="column" backgroundColor={bg} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} marginBottom={1}>
      <Show when={draft()?.reply}>
        {(q) => (
          <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
            {`↳ ${q().from}: “${q().line}”`}
          </text>
        )}
      </Show>
      <textarea
        ref={(r: TextareaRenderable) => {
          ta = r
          show()
        }}
        minHeight={1}
        maxHeight={props.maxRows}
        backgroundColor={bg}
        focusedBackgroundColor={bg}
        textColor={theme.text.base}
        focusedTextColor={theme.text.base}
        onSubmit={onSubmit}
        onContentChange={() => ta && props.setState((s) => edited(s, key(), ta!.plainText))}
      />
      <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
        {target()}
      </text>
      <For each={below()}>
        {(l) => (
          <text fg={l.fg} flexShrink={0}>
            {l.text}
          </text>
        )}
      </For>
    </box>
  )
}

/** Send to a role: names the role whose conversation opens, so the box sends it a task. */
export function RoleDialog(props: { done: (role: string) => void }) {
  const theme = useTheme().surface("dialog")
  const [error, setError] = createSignal<string>()
  let input: InputRenderable | undefined
  const save = () => {
    const r = parseRecipient(`role:${input?.value.trim() ?? ""}`, "type a role")
    if (!r.ok) return setError(r.error)
    if (r.recipient.kind === "role") props.done(r.recipient.role)
  }
  return (
    <DialogLayout header={<DialogHeader title="Send to a role" />}>
      <input
        ref={(r: InputRenderable) => {
          input = r
          setTimeout(() => r.focus(), 1)
        }}
        placeholder="role"
        onSubmit={save}
      />
      <Show when={error()}>{(e) => <text fg={theme.text.feedback.error.base}>{e()}</text>}</Show>
    </DialogLayout>
  )
}
