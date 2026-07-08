/**
 * Smoke for cotal_orientation — pure (no broker). Covers the plan's §6 checks that don't need a
 * live mesh: identity + access mapping, auth-vs-open, the gated tool list, the core/more grouping,
 * and the live-context snapshot. Run: `pnpm smoke:orientation`.
 */
import assert from "node:assert/strict";
import {
  cotalToolSpecs,
  buildOrientation,
  renderOrientation,
  ORIENTATION_BOOTSTRAP,
  DOCS_VERSION,
  type AgentConfig,
  type MeshAgent,
} from "@cotal-ai/connector-core";

function cfg(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    space: "demo",
    name: "alice",
    role: "reviewer",
    servers: "nats://127.0.0.1:4222",
    subscribe: ["general"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
    kind: "agent",
    tls: false,
    ...over,
  } as AgentConfig;
}

// A minimal MeshAgent stub — buildOrientation only reads id/status/attention/roster/inboxCount.
function agentStub(over: { roster?: any[]; unread?: number } = {}): MeshAgent {
  return {
    id: "ALICEID0000000000000000000000000000000000000",
    status: "working",
    attention: "open",
    connected: true,
    roster: () => over.roster ?? [],
    inboxCount: () => over.unread ?? 0,
  } as unknown as MeshAgent;
}

const presence = (id: string, name: string, role?: string, status = "idle") => ({
  card: { id, name, role },
  status,
});

// 1 — gated tool list: orientation is first; spawn/persona hidden without the capability, shown with it.
{
  const open = cotalToolSpecs(cfg({ creds: undefined }));
  assert.equal(open[0].name, "cotal_orientation", "orientation should be the first tool");

  const noSpawn = cotalToolSpecs(cfg({ creds: "CREDS", capabilities: [] })).map((s) => s.name);
  assert.ok(!noSpawn.includes("cotal_spawn"), "no spawn cap ⇒ cotal_spawn hidden");
  assert.ok(!noSpawn.includes("cotal_persona"), "no spawn cap ⇒ cotal_persona hidden");

  const withSpawn = cotalToolSpecs(cfg({ creds: "CREDS", capabilities: ["spawn"] })).map((s) => s.name);
  assert.ok(withSpawn.includes("cotal_spawn") && withSpawn.includes("cotal_persona"), "spawn cap ⇒ both shown");
}

// 2 — identity + access mapping, and auth vs open.
{
  const authCfg = cfg({ creds: "CREDS", subscribe: ["general"], allowSubscribe: ["general", "incident"], allowPublish: [] });
  const visible = cotalToolSpecs(authCfg).map((s) => ({ name: s.name, title: s.title }));
  const o = buildOrientation(agentStub(), authCfg, visible, 1_700_000_000_000);

  assert.deepEqual(o.identity, { name: "alice", role: "reviewer", space: "demo", id: "ALICEID0000000000000000000000000000000000000", cotalVersion: DOCS_VERSION });
  assert.equal(o.access.authMode, true);
  assert.deepEqual(o.access.read, ["general"]);
  assert.deepEqual(o.access.readAcl, ["general", "incident"]); // read ACL wider than active read
  assert.deepEqual(o.access.post, []); // default-deny ⇒ read-only
  assert.equal(o.generatedAt, 1_700_000_000_000);

  const openO = buildOrientation(agentStub(), cfg({ creds: undefined }), [], 1);
  assert.equal(openO.access.authMode, false);

  // read-only renders explicitly; readAcl line appears only when it differs from read.
  const text = renderOrientation(o);
  assert.match(text, /read-only/);
  assert.match(text, /may join \(read ACL\)/);
}

// 3 — core/more grouping covers exactly the gated set (minus orientation itself), no dupes.
{
  const c = cfg({ creds: "CREDS", capabilities: ["spawn"] });
  const gated = cotalToolSpecs(c).map((s) => s.name).filter((n) => n !== "cotal_orientation");
  const visible = cotalToolSpecs(c).map((s) => ({ name: s.name, title: s.title }));
  const o = buildOrientation(agentStub(), c, visible, 1);

  const grouped = [...o.tools.core, ...o.tools.more].map((t) => t.name);
  assert.ok(!grouped.includes("cotal_orientation"), "the card omits the orientation tool itself");
  assert.equal(new Set(grouped).size, grouped.length, "no duplicate tools across core/more");
  assert.deepEqual([...grouped].sort(), [...gated].sort(), "core ∪ more == gated tool set");
  assert.ok(o.tools.core.every((t) => ["cotal_inbox", "cotal_send", "cotal_dm", "cotal_anycast", "cotal_roster", "cotal_status"].includes(t.name)));
}

// 4 — live context: peers exclude self, unread = inboxCount.
{
  const roster = [
    presence("ALICEID0000000000000000000000000000000000000", "alice", "reviewer"), // self
    presence("BOBID00000000000000000000000000000000000000", "bob", "worker", "working"),
    presence("CARID00000000000000000000000000000000000000", "carol"),
  ];
  const o = buildOrientation(agentStub({ roster, unread: 3 }), cfg({ creds: "CREDS" }), [], 1);
  assert.equal(o.peers.present, 2, "self excluded from peer count");
  assert.match(o.peers.summary, /bob\/worker \(working\)/);
  assert.ok(!o.peers.summary.includes("alice"), "self not in the peer summary");
  assert.equal(o.unread.total, 3);
}

// 5 — the shared connector bootstrap is exported and points agents at the tool.
{
  assert.ok(ORIENTATION_BOOTSTRAP.length > 0, "bootstrap is non-empty");
  assert.match(ORIENTATION_BOOTSTRAP, /cotal_orientation/);
}

console.log("✓ orientation smoke passed");
