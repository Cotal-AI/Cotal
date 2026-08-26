/**
 * Mesh-manifest launch smoke — proves the `supervise --launch` path: `startAgent({ resolved })`
 * mints creds from the RESOLVED policy (no persona file read for authority), the launch-spec loader
 * rejects untrusted/unsafe input, and `materializePersona` writes a transient, non-authoritative
 * persona (no ACL frontmatter, with a generated header). Boots a throwaway auth broker (the spawn
 * path opens a real ephemeral provisioner connection — withProvisioner — so a live trusted broker
 * with the space streams is part of startAgent's contract now), a fake runtime, decode the minted
 * creds JWT.
 * Run with: pnpm smoke:manifest-launch
 *
 * ── READ THIS BEFORE ADDING A CHECK HERE ─────────────────────────────────────────────────────
 * This suite reaches the handler through a PRIVATE CAST — `(mgr as unknown as {opLaunch(...)})
 * .opLaunch(...)` below — so NO CONTRACT IS EVER APPLIED to what it passes. That is not a
 * stylistic note; it produced a real escape. PR #317 added remote manifest deploy (an inline
 * launch spec pushed over the control plane) and a check here asserting `opLaunch boots from an
 * INLINE spec`. It passed. The feature was dead: `LAUNCH_INPUT_SCHEMA` is
 * `additionalProperties:false` over exactly `{runId, name}`, so the ep door refuses the call
 * before `opLaunch` ever runs. Main shipped a PASSING TEST FOR EXACTLY THE FEATURE THAT WAS
 * BROKEN, and it could not catch the break because it tested one layer BELOW the contract that
 * refuses the call. That is not a missing suite; it is a test whose green is meaningless for the
 * property its name claims.
 *
 * Generalise it: any test that reaches past a boundary via a cast proves nothing about traffic
 * that must CROSS that boundary. A door-enforced property needs a door-level suite —
 * `manager-service-ops` / `manager-service-invoke`, which drive `A.call(...)` through the real ep
 * door and are in `smoke:ci`.
 *
 * And the correlation, which is the generalisable half: every suite in this repo that invokes a
 * handler through a cast (this one, `lifecycle-e2e`, `start-model-preflight`) is ALSO outside
 * `smoke:ci`. The ungated set and the below-the-door set are the same set, so #317 was three
 * independent misses — the feature had a test, the test sat below the contract, and it was
 * ungated — each of which alone would have been survivable. When you gate a previously ungated
 * suite, check FIRST whether it reaches its subject through the real door: an ungated suite has
 * never had to be honest about that.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import { loadLaunchSpec, materializePersona, launchAgentToStartOpts, launchSpecForRun } from "../src/launch.js";
import { createSpaceAuth, mintCreds, newIdentity, principalKey, setupSpaceStreams, registry, DEV_OWNER, type Connector, type LaunchSpec, type AgentHandle, type MeshLaunchAgent, type MeshLaunchSpec } from "@cotal-ai/core";
import { bootBroker } from "./_boot-broker.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

/** `ControlReply.data` is `unknown` on the wire, so the identity a reply reports is read through
 *  one narrow view rather than four spot casts. */
const replyName = (r: { data?: unknown }): string | undefined =>
  (r.data as { name?: string } | undefined)?.name;
function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
}

function credAcl(path: string): { sub: string[]; pub: string[] } {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  const nats = claims.nats ?? {};
  const chat = (arr: string[] | undefined, keepJs: boolean) =>
    (arr ?? []).filter((s) => s.includes(".chat.") && (keepJs || !s.startsWith("$JS")));
  return { sub: chat(nats.sub?.allow, true), pub: chat(nats.pub?.allow, false) };
}

const root = mkdtempSync(join(tmpdir(), "cotal-launch-"));
const runId = "deadbeef01";

// --- materializePersona: transient, non-authoritative -------------------------------------------
const resolved: MeshLaunchAgent = {
  name: "scout",
  agent: "smoke-launch",
  role: "researcher",
  model: "opus",
  variant: "high",
  launchOptions: { temperature: "0.2" },
  description: "Quick web researcher.",
  body: "Research the web; report in 3 bullets.",
  prompt: "Kick off: post your research plan in #general.",
  capabilities: ["spawn"],
  subscribe: ["general", "ops"],
  allowSubscribe: ["general", "ops", "review"],
  allowPublish: ["general"],
  personaPath: undefined,
  hash: "abc123",
};
const personaPath = materializePersona(root, runId, resolved);
{
  const md = readFileSync(personaPath, "utf8");
  check("transient persona lives under .cotal/run/<runId>/agents", personaPath.includes(join(".cotal", "run", runId, "agents")));
  check("not under .cotal/agents", !personaPath.includes(join(".cotal", "agents", "scout")));
  check("carries identity/role/model/variant", /name: scout/.test(md) && /role: researcher/.test(md) && /model: opus/.test(md) && /variant: high/.test(md));
  check("carries the persona body", md.includes("Research the web"));
  check("has a generated-artifact header", /Generated runtime artifact/.test(md));
  check("NO authoritative ACL frontmatter", !/^(subscribe|allowSubscribe|allowPublish|capabilities):/m.test(md), md);
}

// --- startAgent({ resolved }): creds minted from the resolved policy, no file authority ----------
const auth = await createSpaceAuth("demo");
const broker = await bootBroker(auth);
await setupSpaceStreams({ servers: broker.servers, space: "demo", creds: await mintCreds(auth, newIdentity(), "provisioner") });
const mgr = new Manager({ space: "demo", servers: broker.servers, runtime: "pty", workspaceRoot: root });
(mgr as unknown as { auth: unknown }).auth = auth;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  provisionDmInbox: async () => {},
  provisionDlvInbox: async () => {},
  commitAcl: async () => {},
  reissueAcl: async () => {},
  provisionTaskQueue: async () => {},
  // #159 B1 readiness race: on/off (event is only a wake) + getRoster reporting every managed agent joined.
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
};
let seenVariant: string | undefined;
let seenLaunchOptions: Record<string, unknown> | undefined;
let seenPrompt: string | undefined;
const recCon: Connector = {
  kind: "connector",
  name: "smoke-launch",
  requires: ["node"],
  supportsModelVariant: true,
  buildLaunch: (opts) => {
    seenVariant = opts.variant;
    seenLaunchOptions = opts.launchOptions;
    seenPrompt = opts.prompt;
    return { command: "true", args: [], env: {} };
  },
};
registry.register(recCon);

{
  // Note: there is NO .cotal/agents/scout.md — only the transient file. A non-resolved spawn would
  // fail "no persona scout"; the resolved path must succeed from the launch object alone.
  const startOpts = launchAgentToStartOpts(resolved, personaPath);
  check("launchAgentToStartOpts carries variant", startOpts.variant === "high", startOpts.variant);
  const OWNER = "u_" + "a".repeat(26);
  check("launchAgentToStartOpts forwards the apply-time owner", launchAgentToStartOpts(resolved, personaPath, OWNER).owner === OWNER);
  const reply = await mgr.startAgent(startOpts);
  check("resolved spawn succeeds with no persona file in .cotal/agents", reply.ok === true, JSON.stringify(reply));
  check("identity is the resolved name", reply.ok && replyName(reply) === "scout", reply.ok && replyName(reply));
  check("variant is forwarded to the connector", seenVariant === "high", seenVariant);
  check("launchOptions forwarded to the connector (via resolved)", JSON.stringify(seenLaunchOptions) === JSON.stringify({ temperature: "0.2" }), seenLaunchOptions);
  check("manifest kickoff prompt forwarded to the connector (via resolved)", seenPrompt === "Kick off: post your research plan in #general.", seenPrompt);
  // One source: an imperative --prompt alongside a resolved launch is a caller contract error.
  const rej = await mgr.startAgent({ ...launchAgentToStartOpts(resolved, personaPath), prompt: "imperative override" });
  check("imperative prompt alongside resolved is rejected", rej.ok === false && /prompt/.test(rej.error ?? ""), JSON.stringify(rej));

  // Lifecycle-keyed cred file (`<name>.<uid>.creds`) — the reply's uid names this incarnation's file.
  const scoutUid = reply.ok ? String((reply.data as { lifecycleUid?: string }).lifecycleUid ?? "") : "";
  const acl = credAcl(join(root, ".cotal", "auth", "creds", `scout.${scoutUid}.creds`));
  check("read ACL = resolved allowSubscribe (general+ops+review)", ["general", "ops", "review"].every((ch) => acl.sub.some((s) => s.endsWith("." + ch))), acl.sub);
  check("post ACL = resolved allowPublish (general only)", acl.pub.some((s) => s.endsWith(".general")) && !acl.pub.some((s) => s.endsWith(".ops")), acl.pub);
}

// --- loadLaunchSpec: untrusted-input validation -------------------------------------------------
const specOf = (over: Partial<MeshLaunchSpec> = {}): unknown => ({
  apiVersion: "cotal-launch/v1",
  space: "demo",
  runId: "run01",
  agents: [{ name: "a", agent: "claude", subscribe: ["general"], allowSubscribe: ["general"], allowPublish: [], hash: "h" }],
  ...over,
});
function writeSpec(name: string, body: unknown): string {
  const p = join(root, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}
{
  const spec = loadLaunchSpec(writeSpec("ok.json", specOf()));
  check("valid launch spec loads", spec.agents.length === 1 && spec.runId === "run01");
  throws("bad apiVersion rejected", () => loadLaunchSpec(writeSpec("v.json", specOf({ apiVersion: "nope" as never }))));
  throws("path-traversal runId rejected", () => loadLaunchSpec(writeSpec("r.json", specOf({ runId: "../evil" }))));
  throws("unknown top-level key rejected (strict)", () => loadLaunchSpec(writeSpec("k.json", { ...(specOf() as object), bogus: 1 })));
  throws("unsafe agent name rejected", () =>
    loadLaunchSpec(writeSpec("n.json", specOf({ agents: [{ name: "../x", agent: "claude", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "h" }] }))));
  // Tightened untrusted-input contract: connector / role / capability / hash must be safe tokens.
  const agent1 = (over: Record<string, unknown>) => specOf({ agents: [{ name: "a", agent: "claude", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "h", ...over }] });
  throws("injection-y connector token rejected", () => loadLaunchSpec(writeSpec("a1.json", agent1({ agent: "claude;rm -rf" }))));
  throws("unsafe role token rejected", () => loadLaunchSpec(writeSpec("a2.json", agent1({ role: "a/b" }))));
  throws("unsafe capability token rejected", () => loadLaunchSpec(writeSpec("a3.json", agent1({ capabilities: ["spawn x"] }))));
  throws("non-alphanumeric hash rejected", () => loadLaunchSpec(writeSpec("a4.json", agent1({ hash: "../../etc" }))));
  throws("empty variant rejected", () => loadLaunchSpec(writeSpec("a5.json", agent1({ variant: "" }))));
  throws("empty prompt rejected", () => loadLaunchSpec(writeSpec("a6.json", agent1({ prompt: "" }))));
  check("kickoff prompt loads through the strict schema", loadLaunchSpec(writeSpec("a7.json", agent1({ prompt: "go" }))).agents[0].prompt === "go");
  // Policy re-validation at the manager boundary — --launch must not be a looser manifest format.
  throws("wildcard scope in launch policy rejected", () => loadLaunchSpec(writeSpec("p1.json", agent1({ subscribe: ["team.>"], allowSubscribe: ["team.>"] }))));
  throws("subscribe ⊄ allowSubscribe rejected", () => loadLaunchSpec(writeSpec("p2.json", agent1({ subscribe: ["general"], allowSubscribe: [] }))));
  throws("unknown capability rejected (not just unsafe token)", () => loadLaunchSpec(writeSpec("p3.json", agent1({ capabilities: ["teleport"] }))));
  // Belt-and-suspenders (review-fact): allowPublish-only wildcard is rejected too (same validateLaunchPolicy loop).
  throws("wildcard allowPublish rejected", () => loadLaunchSpec(writeSpec("p4.json", agent1({ allowPublish: ["team.>"] }))));
  // Envelope-rule vocabulary: a delegable `role:<r>` capability is a KNOWN manifest capability
  // (strict shape), while `admin` stays deliberately manifest-inadmissible — a hand-editable file
  // must not mint an authority-root agent.
  const roleCap = loadLaunchSpec(writeSpec("c1.json", agent1({ capabilities: ["spawn", "role:worker"] })));
  check("role:<r> capability accepted", roleCap.agents[0].capabilities?.includes("role:worker") === true, roleCap.agents[0].capabilities);
  throws("unsafe role capability rejected", () => loadLaunchSpec(writeSpec("c2.json", agent1({ capabilities: ["role:a b"] }))));
  throws("nested role capability rejected", () => loadLaunchSpec(writeSpec("c3.json", agent1({ capabilities: ["role:a:b"] }))));
  throws("unknown namespaced capability rejected", () => loadLaunchSpec(writeSpec("c4.json", agent1({ capabilities: ["teleport:x"] }))));
  throws("admin capability rejected at the manifest boundary", () => loadLaunchSpec(writeSpec("c5.json", agent1({ capabilities: ["admin"] }))));
  // USER-AUTH: the apply-time owner (`up -f --user-auth`) survives the strict schema — and only as
  // a real derived token (an arbitrary string can't become ownership attribution).
  const OWNER = "u_" + "b".repeat(26);
  const owned = loadLaunchSpec(writeSpec("o1.json", { ...(specOf() as object), owner: OWNER }));
  check("apply-time owner loads through the strict schema", owned.owner === OWNER, owned.owner);
  throws("malformed owner rejected (not a derived token)", () => loadLaunchSpec(writeSpec("o2.json", { ...(specOf() as object), owner: "u_HACK" })));
}

// --- launchSpecForRun + the `launch` control op: spawn -f onto a RUNNING manager ----------------
{
  const runId2 = "feedface02";
  const spec2: MeshLaunchSpec = {
    apiVersion: "cotal-launch/v1",
    space: "demo",
    runId: runId2,
    owner: "u_" + "c".repeat(26),
    agents: [{
      name: "scout", agent: "smoke-launch", role: "researcher", model: "opus", variant: "high", description: "Quick researcher.",
      body: "Research; 3 bullets.", capabilities: ["spawn"], subscribe: ["general"], allowSubscribe: ["general", "ops"],
      allowPublish: ["general"], personaPath: undefined, hash: "abc123",
    }, {
      // A NON-COLLIDING declared name. `scout` is already live from the startAgent test above, so
      // under M6 it refuses (asserted below) — and the ledger-keying invariants that used to ride
      // on the collision-numbered `scout-2` have to keep running somewhere, so they ride this.
      name: "ranger", agent: "smoke-launch", role: "researcher", model: "opus", variant: "high", description: "Quick researcher.",
      body: "Research; 3 bullets.", capabilities: ["spawn"], subscribe: ["general"], allowSubscribe: ["general", "ops"],
      allowPublish: ["general"], personaPath: undefined, hash: "abc123",
    }],
  };
  mkdirSync(join(root, ".cotal", "run"), { recursive: true });
  writeFileSync(join(root, ".cotal", "run", `${runId2}.json`), JSON.stringify(spec2));

  // The op takes a runId, NOT a path — the manager derives + validates the spec location itself.
  check("launchSpecForRun derives + loads the spec by runId", launchSpecForRun(root, runId2).agents[0].name === "scout");
  check("launchSpecForRun preserves the apply-time owner", launchSpecForRun(root, runId2).owner === spec2.owner, launchSpecForRun(root, runId2).owner);
  throws("launchSpecForRun rejects an unsafe runId token", () => launchSpecForRun(root, "../evil"));
  throws("launchSpecForRun rejects a missing run", () => launchSpecForRun(root, "nosuchrun"));

  type LaunchReply = { ok: boolean; data?: Record<string, unknown>; error?: string };
  // Admin-tier launch (the static operator deploy path); the user-mode owner-equality policy is
  // pinned separately in smoke:own-agent-control (pure authorizeLaunch).
  const op = (a: Record<string, unknown>) =>
    (mgr as unknown as { opLaunch(a: Record<string, unknown>, c: string, admin: boolean): Promise<LaunchReply> }).opLaunch(a, "smoke-caller", true);
  // ── M6: A MANIFEST-DECLARED NAME IS A DECLARATION, NOT A REQUEST ──────────────────────────────
  // `scout` is already live from the startAgent test above. This suite used to assert it
  // COLLISION-NUMBERED to `scout-2`; that is pre-M6 behaviour and the expectation was stale, not
  // the code. Collision-numbering a manifest-declared name makes `up -f` non-idempotent and sprawls
  // agents, so a declared collision now REFUSES at accept. Breaking change against shipped main,
  // declared as such. Asserted as the CONTRAST rather than as a bare refusal — the message must name
  // the manifest-declared arm specifically, so this cannot pass on any old refusal.
  const collide = await op({ runId: runId2, name: "scout" });
  check("M6 a manifest-declared name colliding with a live incarnation REFUSES (never a silent -2)",
    collide.ok === false && /hard-pinned \(manifest-declared\)/.test(String(collide.error ?? "")), collide);
  check("M6 the refusal names the colliding name so an operator can act on it",
    /"scout"|'scout'|\bscout\b/.test(String(collide.error ?? "")), collide.error);

  // The ledger-keying invariants below are NOT about M6 and must keep running, so they ride a
  // NON-COLLIDING declared name. Flipping the assertion above to "expect a refusal" and stopping
  // there would have silently deleted all of them.
  const reply = await op({ runId: runId2, name: "ranger" });
  check("opLaunch boots the resolved agent", reply.ok === true, reply.error);
  check("reply.name is the declared name, taken exactly (no numbering when nothing collides)", reply.ok && replyName(reply) === "ranger", reply.ok && replyName(reply));
  check("reply carries the manifest requested name", reply.ok && reply.data?.requested === "ranger");
  check("reply carries runId + resolved hash for the ledger", reply.ok && reply.data?.runId === runId2 && reply.data?.hash === "abc123");
  check("reply carries the spawned nkey id", reply.ok && typeof reply.data?.id === "string" && (reply.data.id as string).length > 0);
  // Lifecycle-keyed under the SPAWNED name: `ranger.<uid>.creds`.
  const scout2Uid = reply.ok ? String((reply.data as { lifecycleUid?: string }).lifecycleUid ?? "") : "";
  const scout2Creds = join(root, ".cotal", "auth", "creds", `ranger.${scout2Uid}.creds`);
  check("creds are filed under the SPAWNED name (ledger-keying invariant)", existsSync(scout2Creds));
  // The cred file's OWN nkey subject equals the reply id — the invariant `down -f` relies on to
  // verify a cred belongs to the recorded agent before deleting it (name+id ownership).
  {
    const credText = readFileSync(scout2Creds, "utf8");
    const jwt = credText.split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
    const sub = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).sub;
    check("minted cred's JWT subject == the reply id (down -f cred-ownership check)", reply.ok && sub === reply.data?.id, { sub, id: reply.ok && reply.data?.id });
  }
  const bad = await op({ runId: runId2, name: "ghost" });
  check("opLaunch rejects an unknown agent name", bad.ok === false);

  // --- INLINE spec: the remote-deploy path (spec pushed over the control plane, no shared disk) --
  const runId3 = "cafebabe03";
  const spec3: MeshLaunchSpec = {
    apiVersion: "cotal-launch/v1",
    space: "demo",
    runId: runId3,
    agents: [{
      name: "pusher", agent: "smoke-launch", role: "researcher", model: "opus", body: "Inline persona.",
      subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], personaPath: undefined, hash: "def456",
    }],
  };
  const inline = await op({ runId: runId3, name: "pusher", spec: spec3 });
  check("opLaunch boots from an INLINE spec (no pre-shared run file)", inline.ok === true, inline.error);
  check("inline spec persisted under the MANAGER's own run tree", existsSync(join(root, ".cotal", "run", `${runId3}.json`)));
  check("persisted spec round-trips through launchSpecForRun", launchSpecForRun(root, runId3).agents[0].name === "pusher");
  const mism = await op({ runId: "aaaaaaaa04", name: "pusher", spec: spec3 });
  check("inline spec runId mismatch rejected", mism.ok === false && /does not match/.test(mism.error ?? ""), mism.error);
  const evil = await op({ runId: runId3, name: "pusher", spec: { ...spec3, agents: [{ ...spec3.agents[0], name: "../evil" }] } });
  check("invalid inline spec rejected (unsafe agent name)", evil.ok === false);
  // M6, and note what the OLD assertion was called: "is idempotent (collision-numbered spawn)". Its
  // NAME wanted idempotence and its BODY asserted `pusher-2` — spawning a SECOND agent, which is the
  // non-idempotent outcome. Re-pushing a manifest is the `up -f` case M6 exists for: it must not
  // sprawl. So a re-push now REFUSES and no duplicate is created, which is what the assertion's own
  // name was reaching for while testing the opposite.
  const again = await op({ runId: runId3, name: "pusher", spec: spec3 });
  check("M6 a re-push of the same inline spec REFUSES rather than sprawling a duplicate (`up -f` stays idempotent)",
    again.ok === false && /hard-pinned \(manifest-declared\)/.test(String(again.error ?? "")), JSON.stringify(again));
}

// --- symlinked parent dir refused (writes can't escape the run tree) ----------------------------
{
  const root2 = mkdtempSync(join(tmpdir(), "cotal-launch-sym-"));
  const external = mkdtempSync(join(tmpdir(), "cotal-launch-ext-"));
  mkdirSync(join(root2, ".cotal"));
  symlinkSync(external, join(root2, ".cotal", "run")); // .cotal/run → outside the workspace
  throws("materialize refuses a symlinked .cotal/run parent", () => materializePersona(root2, "run01", { ...resolved, name: "x" }));
  throws("launchSpecForRun refuses a symlinked .cotal/run parent", () => launchSpecForRun(root2, "run01"));

  // Belt-and-suspenders (review-fact): a symlinked <runId> dir is refused too (same per-component lstat).
  const root3 = mkdtempSync(join(tmpdir(), "cotal-launch-sym2-"));
  mkdirSync(join(root3, ".cotal", "run", "agents"), { recursive: true });
  symlinkSync(mkdtempSync(join(tmpdir(), "cotal-launch-ext2-")), join(root3, ".cotal", "run", "rid"));
  throws("materialize refuses a symlinked .cotal/run/<runId> dir", () => materializePersona(root3, "rid", { ...resolved, name: "y" }));
}

await broker.stop();
console.log(`\nMANIFEST-LAUNCH SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
