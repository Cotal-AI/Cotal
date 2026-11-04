import type { RGBA, TextareaRenderable } from "@opentui/core"
import { parseRecipient, type Recipient } from "@cotal-ai/workspace/chat"
import { createEffect, For, on, Show } from "solid-js"
import { Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { useTheme } from "../vendor/opencode/packages/tui/src/context/theme"
import { useDialog } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../vendor/opencode/packages/tui/src/ui/dialog-select"
import { draftKey, edited, moveDraft, replyFrom, settled, submit, type ComposerState, type Effect, type Tone } from "./compose.js"
import type { Mesh } from "./live.js"
import { clock, conversationRecipient, peerOf, type Open } from "./screen.js"
import type { Talk } from "./talk.js"

type Line = { text: string; fg: RGBA }

/** Where a recipient goes, as the composer's lines name it. */
const where = (r: Recipient) => (r.kind === "channel" ? `#${r.channel}` : r.kind === "peer" ? r.name : r.kind === "dm" ? r.to : `role:${r.role}`)

const openOf = (r: Recipient): Open | undefined => (r.kind === "channel" ? { kind: "channel", channel: r.channel } : r.kind === "role" ? { kind: "role", role: r.role } : undefined)

/**
 * The block under the conversation. Collapsed it is one line: what `c` writes to and the name the
 * human appears as, or why no session is open. Writing, it is the target line, the quoted message
 * of a reply, the textarea and the latest outcome. The app pushes the `compose` mode before it
 * renders the textarea, so letters reach the text and not the tree's keys; this mode's layer binds
 * `tab` to the recipient picker and `escape` to going back with the draft kept.
 */
export function Composer(props: {
  talk: Talk
  space: string
  open: Open
  mesh: Mesh
  state: ComposerState
  setState: (f: (s: ComposerState) => ComposerState) => void
  setOpen: (o: Open) => void
  composing: boolean
  stop: () => void
  maxRows: number
}) {
  const theme = useTheme()
  const dialog = useDialog()
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

  // A notice belongs to the draft it was given for; the session's own state shows when it is not open.
  const below = (): Line[] => {
    const n = props.state.notice
    const notice = n && n.key === key() ? n.lines.map((text) => ({ text, fg: tone(n.tone) })) : []
    const p = props.talk.phase()
    if (p.phase === "opening") return [{ text: `joining ${props.space} as ${p.name}…`, fg: theme.text.muted }, ...notice]
    if (p.phase === "refused") return [...notice, { text: p.message, fg: theme.text.feedback.error.base }, ...(p.remedy ? [{ text: p.remedy, fg: theme.text.base }] : [])]
    if (p.phase === "ended")
      return [...notice, { text: `session ended ${clock(p.at).slice(0, 5)}: ${p.why} · enter opens a new one${nextName() ? ` as ${nextName()}` : ""}`, fg: theme.text.feedback.warning.base }]
    return notice
  }

  const ends = () => {
    const p = props.talk.phase()
    return p.phase === "open" && p.identity.expiresAt !== undefined ? ` · ends ${clock(p.identity.expiresAt).slice(0, 5)}` : ""
  }

  const target = () => {
    const r = recipient()
    const p = props.talk.phase()
    const as = p.phase === "open" ? ` · as ${p.identity.label}${ends()}` : ""
    if (!r) return `no recipient · tab chooses one${as}`
    const q = draft()?.reply
    if (q) return `reply to ${q.from}${r.kind === "channel" ? ` in #${r.channel}` : ""}${as}`
    const peer = props.open.kind === "peer" ? peerOf(props.mesh, props.open.id) : undefined
    if (peer?.status === "waiting") return `to ${where(r)} · answering “${peer.activity ?? "a question it did not report"}”`
    return `to ${where(r)}${as}`
  }

  const collapsed = (): Line[] => {
    const p = props.talk.phase()
    if (p.phase === "opening" || p.phase === "refused" || p.phase === "ended") return below()
    const r = recipient()
    const to = r ? ` to ${where(r)}` : ""
    if (p.phase === "open") return [{ text: `c write${to} · you appear as ${p.identity.label}${ends()}`, fg: theme.text.muted }]
    const n = props.talk.name()
    if (n.state === "refused") return [{ text: `no name to join with: ${n.message}`, fg: theme.text.feedback.error.base }, ...(n.remedy ? [{ text: n.remedy, fg: theme.text.base }] : [])]
    return [{ text: `c write${to}${n.state === "ok" ? ` · you appear as ${n.name.name}` : ""}`, fg: theme.text.muted }]
  }

  // The textarea shows the open conversation's draft, so a switch while writing swaps the text.
  const show = (k = key()) => {
    if (!ta || ta.isDestroyed || k !== key()) return
    const want = props.state.drafts[k]?.text ?? ""
    if (ta.plainText !== want) {
      ta.setText(want)
      ta.gotoBufferEnd()
    }
  }
  createEffect(on(key, () => show(), { defer: true }))

  const run = async (effect: Effect, k: ReturnType<typeof key>) => {
    switch (effect.kind) {
      case "open":
        return props.talk.open(effect.postTo)
      case "publish": {
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
      case "pick":
        return pick()
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

  const choose = async (to: Open, label: string) => {
    dialog.clear()
    const from = key()
    const next = draftKey(props.space, to)
    props.setState((s) => moveDraft(s, from, next, label))
    if (props.state.drafts[from]?.text) return
    props.setOpen(to)
    const r = conversationRecipient(to, props.mesh)
    const warning = r && (await props.talk.disclose(r))
    if (warning) props.setState((s) => ({ ...s, notice: { key: next, tone: "waiting", lines: [warning] } }))
  }

  const pick = () => {
    const option = (title: string, value: Open, category: string, description?: string): DialogSelectOption<Open> => ({
      title,
      value,
      category,
      ...(description ? { description } : {}),
      onSelect: () => void choose(value, title),
    })
    const listed = [
      ...props.mesh.channels.map((c) => option(`#${c.channel}`, { kind: "channel", channel: c.channel }, "Channels")),
      ...[...props.mesh.agents, ...props.mesh.endpoints]
        .filter((p) => p.status !== "offline" && p.card.id !== self())
        .map((p) => option(p.card.name, { kind: "peer", id: p.card.id }, p.card.kind === "agent" ? "Agents" : "Endpoints", p.card.role)),
    ]
    const search = (query: string) => {
      const q = query.trim().toLowerCase()
      const typed = q ? parseRecipient(query) : undefined
      const open = typed?.ok ? openOf(typed.recipient) : undefined
      const extra = open && typed?.ok && !listed.some((o) => o.title === where(typed.recipient)) ? [option(where(typed.recipient), open, "Typed")] : []
      return [...extra, ...listed.filter((o) => o.title.toLowerCase().includes(q))]
    }
    dialog.replace(() => <DialogSelect title="Write to" placeholder="#channel, a name or role:<role>" options={listed} search={search} />)
  }

  Keymap.createLayer(() => ({
    mode: "compose",
    commands: [
      { id: "cotal.compose.pick", bind: "tab", title: "Choose where this draft goes", group: "Talk", run: pick },
      { id: "cotal.compose.back", bind: "escape", title: "Back, keeping the draft", group: "Talk", run: () => props.stop() },
    ],
  }))

  const Lines = (p: { lines: Line[] }) => (
    <For each={p.lines}>
      {(l) => (
        <text fg={l.fg} flexShrink={0}>
          {l.text}
        </text>
      )}
    </For>
  )

  return (
    <Show
      when={props.composing}
      fallback={
        <box flexShrink={0} flexDirection="column">
          <Lines lines={collapsed()} />
        </box>
      }
    >
      <box flexShrink={0} flexDirection="column" border={["top"]} borderColor={theme.text.action.primary.base}>
        <text fg={theme.text.action.primary.base} wrapMode="none" flexShrink={0}>
          {target()}
        </text>
        <Show when={draft()?.reply}>{(q) => <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>{`↳ ${q().from}: “${q().line}”`}</text>}</Show>
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.text.action.primary.base} flexShrink={0}>
            {"› "}
          </text>
          <textarea
            ref={(r: TextareaRenderable) => {
              ta = r
              show()
              r.focus()
            }}
            flexGrow={1}
            minHeight={1}
            maxHeight={props.maxRows}
            placeholder={recipient() ? `Write to ${where(recipient()!)}` : "Choose a recipient with tab"}
            onSubmit={onSubmit}
            onContentChange={() => ta && props.setState((s) => edited(s, key(), ta!.plainText))}
          />
        </box>
        <Lines lines={below()} />
      </box>
    </Show>
  )
}
