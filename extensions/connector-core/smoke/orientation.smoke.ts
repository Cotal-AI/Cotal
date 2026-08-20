/**
 * Smoke for cotal_orientation — pure (no broker). Covers the plan's §6 checks that don't need a
 * live mesh: identity + access mapping, auth-vs-open, the gated tool list, the core/more grouping,
 * and the live-context snapshot, plus the identity-plane gate (#740). Run: `pnpm smoke:orientation`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFromEnv,
  cotalToolSpecs,
  buildOrientation,
  renderOrientation,
  ORIENTATION_BOOTSTRAP,
  DOCS_VERSION,
  type AgentConfig,
  type MeshAgent,
} from "../src/index.js";
// RELATIVE, not the package specifier. `@cotal-ai/connector-core` resolves to `dist/`, so this
// suite used to assert against the last build rather than the tree: it passes on a stale `dist`,
// and `mutation-proof` cannot grade it at all, because a mutation applied to `src/` is invisible
// to it. Every other mutation-proved smoke in this package loads its target the same way.

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

// 6 — the identity-plane gate (#740). `canSpawn` used to read "no static creds" as open mode, so a
// USER-AUTH agent — which carries no static creds by construction (creds+userAuth are mutually
// exclusive at launch, at parse, and at connect) — was advertised the manager-op tools whatever its
// capabilities. Three cells, and the third is the one that matters most: gating open mode as well
// would be a real regression, so it is asserted unchanged in the same breath.
//
// The user-auth configs come from the REAL `configFromEnv`, off the four env vars a spawner writes,
// rather than a hand-built object — so these cells prove the live launch path reaches the gate, not
// only that the gate exists.
{
  const dir = mkdtempSync(join(tmpdir(), "cotal-orientation-smoke-"));
  const sentinelPath = join(dir, "sentinel.creds");
  writeFileSync(sentinelPath, "-----BEGIN NATS USER JWT-----\nSENTINEL\n------END NATS USER JWT------\n");

  const userAuthCfg = (capabilities?: string) =>
    configFromEnv({
      COTAL_NAME: "alice",
      COTAL_SPACE: "demo",
      COTAL_OWNER: "acme",
      COTAL_ACTOR: "alice",
      COTAL_SENTINEL_CREDS: sentinelPath,
      COTAL_BEARER_CMD: JSON.stringify(["/bin/echo", "bearer"]),
      COTAL_LIFECYCLE_UID: "abcdef0123456789",
      ...(capabilities === undefined ? {} : { COTAL_CAPABILITIES: capabilities }),
    });

  const names = (c: AgentConfig) => cotalToolSpecs(c).map((s) => s.name);
  const cardTools = (c: AgentConfig) => {
    const visible = cotalToolSpecs(c).map((s) => ({ name: s.name, title: s.title }));
    const o = buildOrientation(agentStub(), c, visible, 1);
    return [...o.tools.core, ...o.tools.more].map((t) => t.name);
  };

  // 6a — user-auth WITHOUT the capability: an authed plane, so the tools are gated off.
  const noCap = userAuthCfg();
  assert.equal(noCap.creds, undefined, "740:user-auth carries no static creds by construction");
  assert.ok(noCap.userAuth, "740:user-auth config actually parsed a userAuth plane");
  assert.ok(!names(noCap).includes("cotal_spawn"), "740:user-auth without the spawn capability must not be advertised cotal_spawn");
  assert.ok(!names(noCap).includes("cotal_persona"), "740:user-auth without the spawn capability must not be advertised cotal_persona");
  assert.ok(!cardTools(noCap).includes("cotal_spawn"), "740:the orientation card must not claim cotal_spawn for a user-auth agent without the capability");
  assert.ok(!cardTools(noCap).includes("cotal_persona"), "740:the orientation card must not claim cotal_persona for a user-auth agent without the capability");
  // The card's own access line is the same expression: a user-auth mesh IS broker-enforced.
  assert.equal(
    buildOrientation(agentStub(), noCap, [], 1).access.authMode,
    true,
    "740:a user-auth mesh is auth mode, not open mode, on the orientation card",
  );

  // 6b — user-auth WITH the capability: still advertised, so the fix is a gate and not a blanket hide.
  const withCap = userAuthCfg("spawn");
  assert.ok(names(withCap).includes("cotal_spawn"), "740:user-auth with the spawn capability must still be advertised cotal_spawn");
  assert.ok(names(withCap).includes("cotal_persona"), "740:user-auth with the spawn capability must still be advertised cotal_persona");

  // 6c — REGRESSION GUARD. Open mode mints no creds and has no user-auth plane; the wire grants
  // nobody anything there, so everything stays visible. This cell passes BEFORE and AFTER the gate
  // change, on purpose: it is the guard against the natural way to get this wrong, which is to gate
  // open mode too. `token`/`user`/`pass` (soft-shared NATS auth off a join link) belong on this side
  // — core groups them with open mode, they carry no owner+actor grant and no per-agent publish ACL,
  // so the wire does not gate spawn for them either.
  const open = configFromEnv({ COTAL_NAME: "alice", COTAL_SPACE: "demo" });
  assert.equal(open.creds, undefined);
  assert.equal(open.userAuth, undefined);
  assert.ok(names(open).includes("cotal_spawn"), "740:open mode must still be advertised cotal_spawn with no capability");
  assert.ok(names(open).includes("cotal_persona"), "740:open mode must still be advertised cotal_persona with no capability");
  assert.equal(buildOrientation(agentStub(), open, [], 1).access.authMode, false, "740:open mode is still open mode on the card");

  const tokenMode = configFromEnv({ COTAL_NAME: "alice", COTAL_SPACE: "demo", COTAL_TOKEN: "shared" });
  assert.ok(names(tokenMode).includes("cotal_spawn"), "740:token mode is not an identity plane and must still be advertised cotal_spawn");
}

console.log("✓ orientation smoke passed");
