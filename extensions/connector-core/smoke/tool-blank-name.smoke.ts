import assert from "node:assert/strict";
import { decideTake } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";

let checks = 0;
const ok = (cond: boolean, message: string, extra?: string): void => {
  assert.ok(cond, extra === undefined ? message : `${message}\n${extra}`);
  checks++;
  console.log(`  ✓ ${message}`);
};

const stored = { role: "reviewer", sender: "local.caller", id: "req" };
const take = (name: string, id = "local.blank", count = 1) => decideTake(undefined, stored, {
  epoch: "1", seq: 4, holder: { id, name }, count, now: 1,
});

const space = take(" ").next?.outbox[0]?.text ?? "";
ok(space === "local.blank took your @reviewer request (seq 4).", "a whitespace holder name is the id", space);
const empty = take("").next?.outbox[0]?.text ?? "";
ok(empty === "local.blank took your @reviewer request (seq 4).", "an empty holder name is the id", empty);
const newline = take("\n").next?.outbox[0]?.text ?? "";
ok(newline === "local.blank took your @reviewer request (seq 4)." && !newline.includes("\n"), "a newline holder name stays on one line as the id", newline);
const kept = take(" ada").next?.outbox[0]?.text ?? "";
ok(kept === " ada (local.blank) took your @reviewer request (seq 4).", "a holder name with a leading space stays", kept);
const named = take("ada", "local.ada").next?.outbox[0]?.text ?? "";
ok(named === "ada (local.ada) took your @reviewer request (seq 4).", "a holder name stays", named);

const first = take(" ");
const moved = decideTake(first.next, stored, {
  epoch: "1", seq: 4, holder: { id: "local.ada", name: "ada" }, count: 2, now: 2,
});
const again = moved.next?.outbox.at(-1)?.text ?? "";
ok(again.includes("local.blank did not confirm your @reviewer request (seq 4)") && again.includes("ada (local.ada) took it") && again.includes("local.blank may already have started it"), "a redelivery notice uses the id for a blank previous holder", again);
const refused = decideTake(first.next, stored, {
  epoch: "1", seq: 4, holder: { id: "local.other", name: "other" }, count: 1, now: 3,
});
ok(refused.reply.ok === false && refused.reply.error === "request seq 4 was taken by local.blank on delivery 1", "a refused take names a blank holder by id", refused.reply.error);

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};
const authed: AgentConfig = { ...cfg, creds: async () => "unused" };
const anycast = cotalToolSpecs(cfg).find((spec) => spec.name === "cotal_anycast")!;
const dm = cotalToolSpecs(cfg).find((spec) => spec.name === "cotal_dm")!;

async function status(name: string): Promise<string> {
  const agent = new MeshAgent(cfg);
  (agent as unknown as { anycastStatus: unknown }).anycastStatus = async () => ({
    state: "taken", seq: 4, role: "reviewer", at: Date.parse("2026-11-13T00:00:00.000Z"),
    taker: { id: "local.blank", name },
  });
  return (await anycast.run(agent, authed, { seq: 4 })).text;
}
const statusBlank = await status(" ");
ok(statusBlank.includes("taken by local.blank at ") && statusBlank.includes("Ask local.blank with cotal_dm"), "a blank taker is the id in the status and the follow-up", statusBlank);
const statusKept = await status(" ada");
ok(statusKept.includes("taken by  ada (local.blank) at ") && statusKept.includes("Ask  ada with cotal_dm"), "a taker name with a leading space stays", statusKept);
async function previous(name: string): Promise<string> {
  const agent = new MeshAgent(cfg);
  (agent as unknown as { anycastStatus: unknown }).anycastStatus = async () => ({
    state: "taken", seq: 4, role: "reviewer", at: Date.parse("2026-11-13T00:00:00.000Z"),
    taker: { id: "local.ada", name: "ada" },
    previous: { id: "local.blank", name },
  });
  return (await anycast.run(agent, authed, { seq: 4 })).text;
}
const previousBlank = await previous(" ");
ok(previousBlank.includes("local.blank took it") && previousBlank.includes("so local.blank may also have started it"), "a blank previous holder is the id in both clauses", previousBlank);
const previousKept = await previous(" ada");
ok(previousKept.includes("so  ada may also have started it") && !previousKept.includes("so local.blank"), "a previous holder name with a leading space stays", previousKept);

async function sent(name: string, recipientStatusAtSend: "offline" | "unrostered"): Promise<string> {
  const agent = new MeshAgent(cfg);
  (agent as unknown as { dm: unknown }).dm = async () => ({
    recipient: { id: "local.blank", name }, ack: { seq: 1, duplicate: false }, recipientStatusAtSend,
  });
  return (await dm.run(agent, cfg, { to: "local.blank", text: "hi" })).text;
}
const offline = await sent(" ", "offline");
ok(offline.startsWith("Sent to local.blank.") && offline.includes("local.blank is offline") && offline.includes("when local.blank reconnects") && offline.includes("spawned as local.blank"), "a blank DM recipient is the id", offline);
const split = await sent("\n", "offline");
ok(split.startsWith("Sent to local.blank.") && !split.includes("\n"), "a newline DM recipient stays on one line as the id", split);
const dmKept = await sent(" ada", "offline");
ok(dmKept.startsWith("Sent to  ada.") && dmKept.includes("when  ada reconnects") && !dmKept.includes("local.blank"), "a DM recipient with a leading space stays", dmKept);
const missing = await sent(" ", "unrostered");
ok(missing.includes("local.blank has no roster row"), "a blank unrostered recipient is the id", missing);

console.log(`tool blank name: ${checks} checks passed`);
