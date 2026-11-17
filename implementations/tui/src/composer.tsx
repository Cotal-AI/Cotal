import type { InputRenderable, RGBA, TextareaRenderable } from "@opentui/core"
import { parseRecipient, type PublishResult, type Recipient } from "@cotal-ai/workspace/chat"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { useTheme } from "../vendor/opencode/packages/tui/src/context/theme"
import { DialogHeader, DialogLayout } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { edited, quotable, replyFrom, settled, submit, unquote, unsent, walk, type ComposerState, type Effect, type Tone } from "./compose.js"
import type { FeedEntry, Mesh } from "./live.js"
import { clock, conversationRecipient, draftKey, peerOf, tuiName, type Open } from "./screen.js"
import type { Talk } from "./talk.js"

export { quoteRow } from "./compose.js"

type Line = { text: string; fg: RGBA }

/** Where a recipient goes, as the box's line names it. */
const where = (r: Recipient) => (r.kind === "channel" ? `#${r.channel}` : r.kind === "peer" ? `@${r.name}` : r.kind === "dm" ? `@${r.to}` : `role:${r.role}`)

/**
 * The input box under the conversation: the quoted message of a reply, the text, and one line naming
 * where the message goes. The session's state and the latest outcome follow that line when there is
 * one. While `focused`, the box pushes the `compose` mode and then focuses the textarea, so letters
 * reach the text and the tree's keys stay off; `tab` hands the keys to the tree. On an empty box `↑`
 * and `↓` move the quote through the conversation's rows in `feed`, and `esc` drops it.
 */
export function Composer(props: {
  talk: Talk
  space: string
  open: Open
  mesh: Mesh
  feed: readonly FeedEntry[]
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
  const nextName = () => {
    const n = props.talk.name()
    return n.state === "ok" ? n.name.name : undefined
  }
  const tone = (t: Tone) => ({ ok: theme.text.feedback.success.base, waiting: theme.text.feedback.warning.base, failed: theme.text.feedback.error.base, hint: theme.text.muted })[t]

  const ends = () => {
    const p = props.talk.phase()
    return p.phase === "open" && p.identity.expiresAt !== undefined ? ` · ends ${clock(p.identity.expiresAt).slice(0, 5)}` : ""
  }

  // The quote above the box names whom a reply answers, so this line names only where it goes.
  const target = () => {
    const r = recipient()
    if (!r) return "no recipient in all traffic"
    const peer = props.open.kind === "peer" ? peerOf(props.mesh, props.open.id) : undefined
    if (peer?.status === "waiting" && r.kind === "peer" && r.principal === peer.card.id) return `answering ${tuiName(peer.card.name, peer.card.id)}${ends()}`
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
        // Read before the wait, since a space switch or a catalog entry can unmount the box while
        // the send is out, and the send settles either way.
        const talk = props.talk
        const space = props.space
        let result: PublishResult | undefined
        try {
          result = await talk.publish(effect.to, effect.text, effect.open)
        } finally {
          props.setState((s) => (result ? settled(s, space, result) : unsent(s, space)))
        }
        return show(k)
      }
      case "slash": {
        const out = await props.talk.slash(effect.command)
        return props.setState((s) => ({ ...s, notice: { key: k, ...out } }))
      }
      case "reply-latest":
        return props.setState((s) => replyFrom(s, k, props.talk.latest(), props.talk.you()))
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
  // With text in the box, the arrows move its cursor.
  const step = (by: -1 | 1) => {
    const you = props.talk.you()
    props.setState((s) => walk(s, key(), quotable(props.feed, you, props.open), you, props.open, by))
  }
  Keymap.createLayer(() => ({
    mode: "compose",
    enabled: (draft()?.text ?? "") === "",
    commands: [
      { id: "cotal.compose.older", bind: "up", title: "Quote an older message", group: "Reply", run: () => step(-1) },
      { id: "cotal.compose.newer", bind: "down", title: "Quote a newer message", group: "Reply", run: () => step(1) },
    ],
  }))
  Keymap.createLayer(() => ({
    mode: "compose",
    enabled: draft()?.reply !== undefined,
    commands: [{ id: "cotal.compose.unquote", bind: "escape", title: "Drop the quote", group: "Reply", run: () => props.setState((s) => unquote(s, key())) }],
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
