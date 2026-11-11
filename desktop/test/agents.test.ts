import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
import { agentInventory, renderAgents, runningFor, shortFolder } from "../src/agents.js";
import { parseHostedAgents } from "../../bin/daemon/agents.js";
const agent: { name: string; application: string; cwd: string; startedAt: string; state: string; model?: string } = { name: "writer", application: "codex", cwd: "/projects/cotal", startedAt: "2026-11-11T20:00:00.000Z", state: "running" };
const read = (space: string, agents = [agent]) => ({ space, state: "read", agents });
test("none and unavailable are distinct", () => {
  assert.deepEqual(agentInventory({ agents: [] }), { agents: [], unreadable: [], available: true });
  assert.equal(agentInventory({}).available, false);
});
test("refresh keeps row nodes and unknown reads never claim a zero count", () => {
  const dom = new JSDOM('<section class="connection-card"><section id="running-agents"><h2 id="agents-heading"></h2><p id="agents-empty"></p><p id="agents-unavailable"></p><ul id="agent-list"></ul></section></section>');
  const prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const root = dom.window.document.getElementById("running-agents")!;
    const status = { agents: [read("team", [{ ...agent, model: "private-model-pin" }])] };
    renderAgents(status, root);
    const row = root.querySelector("li")!;
    renderAgents(status, root);
    assert.equal(root.querySelector("li"), row);
    assert.ok(row.getAttribute("aria-label")?.includes("private-model-pin"));
    assert.ok(!row.textContent?.includes("private-model-pin"));
    assert.equal(root.querySelector(".agent-folder")?.getAttribute("aria-label"), agent.cwd);
    renderAgents({ agents: [{ space: "team", state: "unreadable" }, ...status.agents] }, root);
    assert.match(root.querySelector(".agent-count")!.textContent!, /could not read/);
  } finally { globalThis.document = prior; dom.window.close(); }
});
test("one records public application and pinned model", () => {
  const result = agentInventory({ agents: [read("team", [{ ...agent, model: "model-pin" }])] });
  assert.equal(result.agents[0]?.application, "Codex");
  assert.equal(result.agents[0]?.model, "model-pin");
});
test("many and several spaces keep deterministic ordering", () => {
  const result = agentInventory({ agents: [read("z"), read("a", Array.from({ length: 12 }, (_, i) => ({ ...agent, name: `agent-${i}` })))] });
  assert.equal(result.agents.length, 13);
  assert.equal(result.agents[0]?.space, "a");
});
test("could not read remains explicit beside successful spaces", () => {
  const result = agentInventory({ agents: [read("team"), { space: "offline", state: "unreadable" }] });
  assert.deepEqual(result.unreadable, ["offline"]);
  assert.equal(result.agents.length, 1);
});
test("long names and paths retain full originals", () => {
  const path = `/projects/${"long-folder/".repeat(20)}work`;
  const name = "long-name".repeat(14);
  const result = agentInventory({ agents: [read("team", [{ ...agent, name, cwd: path }])] });
  assert.equal(result.agents[0]?.name, name);
  assert.equal(result.agents[0]?.cwd, path);
  assert.ok(shortFolder(path).length <= 42);
  assert.ok(shortFolder(path).endsWith("work"));
});
test("elapsed time does not invent negative runtime", () => {
  const start = Date.parse(agent.startedAt);
  assert.equal(runningFor(agent.startedAt, start - 1), "Just started");
  assert.equal(runningFor(agent.startedAt, start + 65 * 60_000), "1h 5m");
});
test("parent projection strips unknown fields and rejects malformed or oversized rows", () => {
  assert.deepEqual(parseHostedAgents([{ ...agent, token: "secret", prompt: "private" }]), [agent]);
  assert.throws(() => parseHostedAgents(Array(51).fill(agent)));
  assert.throws(() => parseHostedAgents([{ ...agent, name: "bad\nname" }]));
  assert.throws(() => parseHostedAgents([{ ...agent, startedAt: "invalid" }]));
});
