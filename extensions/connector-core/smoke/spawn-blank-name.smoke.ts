import assert from "node:assert/strict";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};
const tool = cotalToolSpecs(cfg).find((spec) => spec.name === "cotal_spawn")!;
let checks = 0;
const ok = (cond: boolean, message: string, extra?: string): void => {
  assert.ok(cond, extra === undefined ? message : `${message}\n${extra}`);
  checks++;
  console.log(`  ✓ ${message}`);
};

async function started(data: Record<string, unknown>, args: Record<string, unknown> = {}): Promise<string> {
  const agent = new MeshAgent(cfg);
  (agent as unknown as { spawn: unknown }).spawn = async () => ({ ok: true, data });
  const result = await tool.run(agent, cfg, { name: "reviewer", join: ["review"], ...args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.text;
}

const space = await started({ name: " ", id: "local.blank", mode: "pty" });
ok(space.startsWith('Started local.blank ("reviewer" was taken) on #review (pty).'), "a whitespace spawn name is the id", space);
const empty = await started({ name: "", id: "local.blank", mode: "pty" });
ok(empty.startsWith("Started local.blank "), "an empty spawn name is the id", empty);
const newline = await started({ name: "\n", id: "local.blank", mode: "pty" });
ok(newline.startsWith("Started local.blank ") && !newline.slice(0, 40).includes("\n"), "a newline spawn name stays on the lead as the id", newline);
const kept = await started({ name: " ada", id: "local.blank", mode: "pty" });
ok(kept.startsWith('Started  ada ("reviewer" was taken)') && !kept.includes("local.blank"), "a spawn name with a leading space stays", kept);
const named = await started({ name: "ada", id: "local.blank", mode: "pty" });
ok(named.startsWith('Started ada ("reviewer" was taken)') && !named.includes("local.blank"), "a returned spawn name stays", named);
const same = await started({ name: "reviewer", id: "local.blank", mode: "pty" });
ok(same.startsWith("Started reviewer on #review") && !same.includes("was taken"), "the requested name stays when the manager returns it", same);
const role = await started({ name: " ", id: "local.blank", mode: "pty" }, { role: "worker" });
ok(role.startsWith("Started local.blank/worker "), "a blank spawn name with a role is the id and role", role);
const unnamed = await started({ name: " ", mode: "pty" });
ok(unnamed.startsWith("Started (unnamed) "), "a blank spawn name with no id is unnamed", unnamed);

const agent = new MeshAgent(cfg);
(agent as unknown as { spawn: unknown }).spawn = async () => ({
  ok: false, code: "uncertain", data: { name: " ", id: "local.blank", actor: "local.blank" },
});
const pending = await tool.run(agent, cfg, { name: "reviewer" });
ok(pending.text.includes("spawning local.blank instead") && pending.text.includes("Watch cotal_roster for local.blank"), "a pending blank name is the id in the lead and the roster watch", pending.text);

console.log(`spawn blank name: ${checks} checks passed`);
