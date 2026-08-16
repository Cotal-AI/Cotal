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

// 4b — roles present: the card answers "is there one of these here, and how do I address it".
{
  const many = [
    presence("ALICEID0000000000000000000000000000000000000", "alice", "reviewer"), // self
    presence("B0000000000000000000000000000000000000000000", "board", "board"),
    presence("C0000000000000000000000000000000000000000000", "carol", "worker"),
    presence("D0000000000000000000000000000000000000000000", "dave", "worker"),
    presence("E0000000000000000000000000000000000000000000", "erin"), // no role
    // Past the eight the summary shows, so the roles field is proved to count the whole roster
    // rather than the visible slice — which is the case that matters, since a space small enough
    // to read off the summary never needed this field.
    ...Array.from({ length: 9 }, (_, i) =>
      presence(`F${String(i).padStart(43, "0")}`, `filler-${i}`, "filler"),
    ),
  ];
  const o = buildOrientation(agentStub({ roster: many }), cfg({ creds: "CREDS" }), [], 1);

  assert.deepEqual(
    o.peers.roles,
    [{ role: "board", count: 1 }, { role: "filler", count: 9 }, { role: "worker", count: 2 }],
    "roles are counted over the whole roster, self excluded, sorted by name",
  );
  assert.equal(o.peers.present, 13, "a peer with no role still counts as present");
  assert.ok(
    !o.peers.roles.some((r) => r.role === "reviewer"),
    "own role is not listed as present: the card is what is around you",
  );

  // The summary has truncated by now; the roles field must not have.
  assert.ok(o.peers.summary.includes("more"), "precondition: this roster is past the summary cutoff");
  const text = renderOrientation(o);
  assert.match(text, /roles present: board \(1\), filler \(9\), worker \(2\)/);
  assert.match(text, /found by its ROLE/, "the card carries the addressing rule, not just the counts");
  assert.match(text, /cotal_roster/, "and names the tool that turns a role into an address");
  // The three clauses that are instructions rather than motivation. A probe that rewrote the
  // middle one survived a version of this block that pinned only the slogan above, and the middle
  // one is the part that decides whether an agent addresses the peer or broadcasts at its role.
  assert.match(text, /take that peer's name from cotal_roster, and message it directly/,
    "the card says how to turn the role into an address, not only that a role is the thing to use");

  // No roles at all ⇒ no line and no rule. A sentence about how to address a role, printed to an
  // agent in a space with none, is advice that cannot be acted on.
  const alone = buildOrientation(agentStub({ roster: [] }), cfg({ creds: "CREDS" }), [], 1);
  assert.deepEqual(alone.peers.roles, []);
  assert.ok(!renderOrientation(alone).includes("roles present"));
  assert.ok(!renderOrientation(alone).includes("found by its ROLE"));
}

// 4c — an OFFLINE holder is not an addressable one.
//
// Found by a control rather than by review: an offline peer lingers in the roster by design, so
// the first version of 4b counted it and the card advertised a service that could not answer.
// The reader of this field acts on it by sending a message, so a stale holder does not read as a
// wrong count — it reads as a peer that never replies, which is indistinguishable from one that
// is broken. These pin the exclusion at both sizes: one holder of several, and the last one.
{
  const withDead = [
    presence("B0000000000000000000000000000000000000000000", "board", "board", "offline"),
    presence("B1000000000000000000000000000000000000000000", "board-2", "board", "idle"),
    presence("C0000000000000000000000000000000000000000000", "carol", "worker", "offline"),
  ];
  const o = buildOrientation(agentStub({ roster: withDead }), cfg({ creds: "CREDS" }), [], 0);
  assert.deepEqual(
    o.peers.roles,
    [{ role: "board", count: 1 }],
    "an offline holder is not counted, and a role whose only holder is offline is not listed at all",
  );
  assert.equal(o.peers.present, 3, "`present` still counts the roster: it answers who is here, not whom I can ask");
  // Scoped to the roles line on purpose. The summary above it still names carol/worker (offline),
  // and should: that line reports who is on the roster, which is a different question from whom
  // this agent can address. Asserting over the whole card would have conflated the two.
  const rolesLine = renderOrientation(o).split("\n").find((l) => l.includes("roles present")) ?? "";
  assert.match(rolesLine, /board \(1\)/);
  assert.ok(!rolesLine.includes("worker"), "a role with no live holder does not reach the addressing line");

  // The last live holder going offline must take the whole line with it, rule included — otherwise
  // the card tells an agent how to address a role that nothing holds.
  const allDead = buildOrientation(
    agentStub({ roster: [presence("B0000000000000000000000000000000000000000000", "board", "board", "offline")] }),
    cfg({ creds: "CREDS" }), [], 0,
  );
  assert.deepEqual(allDead.peers.roles, []);
  assert.ok(!renderOrientation(allDead).includes("roles present"));
  assert.ok(!renderOrientation(allDead).includes("found by its ROLE"));
}

// 5 — the shared connector bootstrap is exported and points agents at the tool.
{
  assert.ok(ORIENTATION_BOOTSTRAP.length > 0, "bootstrap is non-empty");
  assert.match(ORIENTATION_BOOTSTRAP, /cotal_orientation/);
}

console.log("✓ orientation smoke passed");
