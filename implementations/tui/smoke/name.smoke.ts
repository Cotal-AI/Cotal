import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mintLifecycleUid } from "@cotal-ai/core"
import { readPreferences, writePreference, type MeshTarget } from "@cotal-ai/workspace"
import { rememberChatSession } from "@cotal-ai/workspace/chat"
import type { ControlClient } from "@cotal-ai/workspace/control"
import type { FeedEntry } from "@cotal-ai/workspace/view"
import { conversationRecipient, tuiName } from "../src/screen.js"
import { openTalk } from "../src/talk.js"

for (const name of [" ", "", "\n", " \n\t"]) {
  assert.equal(tuiName(name, "local.blank"), "local.blank", JSON.stringify(name))
  assert.equal(tuiName(name, "local.blank").includes("\n"), false)
}
assert.equal(tuiName("ada", "local.ada"), "ada")
assert.equal(tuiName(undefined, "local.blank"), "local.blank")

const mesh = {
  agents: [{ card: { id: "local.blank", name: " \n", kind: "agent" }, status: "idle", ts: 1 }],
  endpoints: [],
} as never
const recipient = conversationRecipient({ kind: "peer", id: "local.blank" }, mesh)
assert.equal(recipient?.kind, "peer")
if (recipient?.kind === "peer") assert.equal(recipient.name, "local.blank")
const named = conversationRecipient({ kind: "peer", id: "local.ada" }, {
  agents: [{ card: { id: "local.ada", name: "ada", kind: "agent" }, status: "idle", ts: 1 }],
  endpoints: [],
} as never)
if (named?.kind === "peer") assert.equal(named.name, "ada")

const home = mkdtempSync(join(tmpdir(), "tui-mention-labels-"))
process.env.COTAL_HOME = home
try {
  const target: MeshTarget = { root: home, personaRoot: join(home, "agents"), source: "flag-server", tlsRequired: false,
    space: "tui-mention-labels", server: "nats://127.0.0.1:1", mode: "open" }
  writePreference({}, "name", "reviewer", readPreferences().revision)
  const principal = "local.Reviewer"
  rememberChatSession(target, { mode: "open", space: target.space, principal, lifecycleUid: mintLifecycleUid(), label: "reviewer", allowPublish: [], allowSubscribe: [] })
  const talk = openTalk({ target, control: {} as ControlClient, afterPaint: async () => {}, nameOf: (id) => id,
    observer: { dmHistoryOf: async () => ({ state: "read", items: [] }) } })
  for (let attempt = 0; attempt < 100 && talk.name().state === "resolving"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(talk.name().state, "ok")
  const entry: FeedEntry = { id: "p", ts: 1, from: { id: "local.publisher", name: "publisher" }, delivery: "multicast", channel: "general", text: "hello" }
  assert.equal(talk.mentionsYou({ ...entry, mentionIds: [principal] }), true, "a matching principal highlights without a name")
  assert.equal(talk.mentionsYou({ ...entry, mentions: ["reviewer"], mentionIds: ["local.reviewer"] }), false, "a different principal never falls back to a matching name")
  assert.equal(talk.mentionsYou({ ...entry, mentions: ["reviewer"], mentionIds: [] }), false, "an empty list highlights nobody")
  assert.equal(talk.mentionsYou({ ...entry, mentions: ["REVIEWER"] }), true, "an old post still highlights by name")
  const elsewhere = openTalk({ target: { ...target, space: "tui-mention-elsewhere" }, control: {} as ControlClient,
    afterPaint: async () => {}, nameOf: (id) => id, observer: { dmHistoryOf: async () => ({ state: "read", items: [] }) } })
  assert.equal(elsewhere.mentionsYou({ ...entry, mentionIds: [principal] }), false, "a session on another space does not highlight")
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log("tui name smoke: all assertions passed")
