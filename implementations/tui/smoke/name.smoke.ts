import assert from "node:assert/strict"
import { conversationRecipient, tuiName } from "../src/screen.js"

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

console.log("tui name smoke: all assertions passed")
