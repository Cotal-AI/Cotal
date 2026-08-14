/**
 * Agent-driven mesh connection control: `cotal_disconnect` / `cotal_connect`, driven through the
 * REAL entry point — `cotalToolSpecs(...).run(...)`, which is exactly what `registerCotalTools`
 * dispatches an MCP call to. Nothing here calls the endpoint directly except to build the fixture.
 *
 * The assertions that matter are made at the BROKER, through an INDEPENDENT OBSERVER peer: a
 * self-view roster is a report by the thing under test about itself. What a supervisor sees is the
 * property this feature exists to provide, so that is what gets asserted.
 *
 * REFUTATION CONDITIONS, stated before any result is cited:
 *  - The observable-departure claim is REFUTED if observer-B does not see the subject go offline
 *    after a self-disconnect, or sees it go offline WITHOUT the disconnect having been called.
 *  - The stickiness claim is REFUTED if the subject is back on the mesh after the self-heal's
 *    retry window elapses (C1 proves the connection was live, so the arms can differ).
 *  - Each named refusal is REFUTED if it returns a different reason, or returns success.
 *  - The grant gate is REFUTED if the verbs are visible without `capabilities: [connection]`,
 *    or ABSENT with it (G2 is the inverse control: if the verbs were missing for both arms the
 *    gate assertion would pass for the wrong reason).
 *
 * Run: node_modules/.bin/tsx extensions/connector-core/smoke/connection-control.smoke.ts
 * Needs `nats-server` on PATH. Local-only, loopback-only.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

// ---- FIRST ACTION: never the live broker, and never anything inherited -------------------------
// A manager-hosted seat exports COTAL_SERVERS=nats://broker.cotal.ai:4222 into every child it
// spawns, so a suite that defaults its target to the environment is pointed at PRODUCTION. Delete
// the inherited connection vars, then assert on the URL this suite ACTUALLY DIALS — asserting on an
// env var would be over-broad (it refuses on a variable it never reads) and under-powered (it would
// not catch a hardcoded live host).
for (const k of Object.keys(process.env)) if (/^COTAL_(SERVERS|CREDS|SPACE|NAME|ID|CONTROL_|LIFECYCLE)/.test(k)) delete process.env[k];

const pickFreePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

// ---- SECOND ACTION: refuse to grade a stale build ---------------------------------------------
// This suite imports the connector through RELATIVE source (`../src/agent.js` — tsx compiles it),
// but core through the PACKAGE SPECIFIER `@cotal-ai/core`, which resolves to `packages/core/dist`.
// `dist/` is gitignored, so it is invisible to `git status`, invisible to the porcelain sweep, and
// a SHARED SIDE EFFECT ACROSS WORKTREES: another lane's build changes what this suite executes.
//
// A suite cannot distinguish "the source is right" from "the source was never run" — it reports the
// same green for both. That makes a green without build provenance UNGRADED rather than passing,
// and it is exactly how a mutation proof turns into a no-op: the mutant edits `src`, the suite
// executes last week's `dist`, and the cell stays green for a reason that has nothing to do with
// the code. So the check is a REFUSAL rather than a note in a runbook: a discipline is something a
// tired operator skips, and this one had to be remembered before every single run.
//
// NOT fixed by pointing the import at `src/`: the published entry point resolves through `dist/`,
// so that would trade a provenance gap for a coverage gap — green about code no user runs.
const distStamp = statSync(join(import.meta.dirname, "../../../packages/core/dist/endpoint.js")).mtimeMs;
const coreSrc = join(import.meta.dirname, "../../../packages/core/src");
const newerThanDist = readdirSync(coreSrc, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".ts"))
  .map((d) => join(d.parentPath ?? coreSrc, d.name))
  .filter((f) => statSync(f).mtimeMs > distStamp);
if (newerThanDist.length)
  throw new Error(
    `REFUSING TO RUN: packages/core/dist is older than ${newerThanDist.length} source file(s) — ` +
    `this suite would grade a build that does not contain them, and would report green for it. ` +
    `Run \`./node_modules/.bin/tsc -p packages/core\` first.\n  stale vs: ` +
    newerThanDist.slice(0, 5).map((f) => f.replace(`${coreSrc}/`, "")).join(", ") +
    (newerThanDist.length > 5 ? `, +${newerThanDist.length - 5} more` : ""),
  );
console.log(`[provenance] core dist built at ${new Date(distStamp).toISOString()} — newer than every packages/core/src/*.ts`);

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const LIVE = "broker.cotal.ai";
if (SERVER.includes(LIVE)) throw new Error(`REFUSING: ${SERVER} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVER)) throw new Error(`REFUSING: ${SERVER} is not loopback`);
console.log(`[safety] dialling ${SERVER} — asserted not ${LIVE}, loopback only; inherited COTAL_* deleted`);

let pass = 0;
let fail = 0;
let voided = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

// ---- arm contamination: a green cell on a dead fixture is worse than a red one ------------------
// Measured, not anticipated: the authed arm's first run had its subject fail to connect, and E4
// ("the observer sees it offline") and E5 ("the cause is carried") both went GREEN — because an
// agent that never connected is trivially offline, and its activity string was whatever the
// disconnect had written. Two cells asserting a real property passed for a reason that had nothing
// to do with the property. So the entry precondition is asserted separately, and every cell
// downstream of a failed precondition is VOID — not passed, and not failed either, since a cell
// that never ran is not evidence against the code.
const contaminated = new Set<string>();
const precondition = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ PRE-${arm}: ${name}`); }
  else { fail++; contaminated.add(arm); console.log(`  ✗ FAIL PRE-${arm}: ${name}`, extra ?? ""); }
};
const armCheck = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (contaminated.has(arm)) { voided++; console.log(`  ⊘ VOID (${arm} fixture contaminated upstream): ${name}`); return; }
  check(name, cond, extra);
};

const store = mkdtempSync(join(tmpdir(), "meshctl-conn-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;

const mk = (name: string, role: string) => ({
  space: "meshctl-conn", name, role, kind: "agent" as const, servers: SERVER,
  subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
});

/** What an INDEPENDENT observer sees for `name` — never the subject's own view of itself. */
const seenBy = (B: any, name: string): { status?: string; activity?: string } | undefined => {
  const row = B.roster().find((p: any) => (p.name ?? p.card?.name) === name);
  return row ? { status: row.status, activity: row.activity } : undefined;
};

async function main() {
  const { isReachable } = await import("@cotal-ai/core");
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) break; await sleep(150); }

  const { MeshAgent } = await import("../src/agent.js");
  const { cotalToolSpecs } = await import("../src/tool-specs.js");

  const cfgA = mk("subject-a", "worker");
  const cfgB = mk("observer-b", "supervisor");
  const A = new MeshAgent(cfgA as any);
  const B = new MeshAgent(cfgB as any);
  // A short retry so the "the self-heal did not undo it" arm is a real wait, not a hopeful one.
  A.start(300); B.start(300);
  for (let i = 0; i < 90 && !(A.connected && B.connected); i++) await sleep(150);
  if (!(A.connected && B.connected)) throw new Error("fixture failed: agents did not both connect");
  await sleep(1200); // presence propagation

  // The REAL entry point: the same array `registerCotalTools` renders onto MCP.
  const specs = cotalToolSpecs(cfgA as any, "smoke");
  const run = async (tool: string, agent: any, cfg: any, args?: any) => {
    const spec = specs.find((s: any) => s.name === tool);
    if (!spec) throw new Error(`fixture failed: ${tool} is not on the tool surface`);
    return spec.run(agent, cfg, args);
  };

  console.log("\n=== the grant gate (tool-surface visibility) ===");
  // `creds` set = auth mode, where the capability is the gate. Both arms differ ONLY in capabilities.
  const gated = { ...mk("gated", "worker"), creds: "/nonexistent/agent.creds", capabilities: [] as string[] };
  const granted = { ...gated, capabilities: ["connection"] };
  const names = (c: any) => cotalToolSpecs(c as any, "smoke").map((s: any) => s.name);
  const ungrantedNames = names(gated);
  const grantedNames = names(granted);
  check("G1 without `capabilities: [connection]` the verbs are ABSENT from the surface",
    !ungrantedNames.includes("cotal_disconnect") && !ungrantedNames.includes("cotal_connect"), ungrantedNames);
  check("G2 CONTROL: with the grant they ARE present (so G1's arms could differ)",
    grantedNames.includes("cotal_disconnect") && grantedNames.includes("cotal_connect"), grantedNames);
  // USER MODE: `creds` is undefined by construction, so a `!config.creds` gate takes the permissive
  // arm and an ungranted session would see the verbs. Spawn survives that because the broker denies
  // it at the wire; a disconnect closes this client's own socket, which no broker can police, so
  // this gate is the only gate and must not have a permissive arm here.
  const userUngranted = { ...mk("user-ungranted", "worker"), userAuth: { owner: "o", actor: "a", sentinelCreds: "x", bearerCmd: ["true"] }, capabilities: [] as string[] };
  const userGranted = { ...userUngranted, capabilities: ["connection"] };
  check("G3 an UNGRANTED USER-MODE session does not see the verbs either",
    !names(userUngranted).includes("cotal_disconnect"), names(userUngranted));
  check("G4 CONTROL: a granted user-mode session does (so G3's arms could differ)",
    names(userGranted).includes("cotal_disconnect"), names(userGranted));
  // OPEN MODE — the third arm, and the one the design note used to describe wrongly.
  // With neither `creds` nor `userAuth` there is no credential, no broker ACL and no grant system at
  // all, so the gate admits the verbs WITHOUT `capabilities: [connection]`. That is deliberate:
  // there is no grant to withhold, and the verbs re-present nothing and re-point nothing — an
  // open-mode session disconnecting itself closes a socket that was never fenced in the first place.
  // It is measured here rather than left as a reading, because DESIGN §5 asserted the opposite
  // ("an agent without capabilities: [connection] sees none of these verbs") as an unqualified rule,
  // and an unqualified rule with an unstated exception is how a grant story stops being true.
  const openUngranted = { ...mk("open-ungranted", "worker"), capabilities: [] as string[] };
  check("G5 an OPEN-MODE session with NO grant DOES see the verbs — the carve-out is real and deliberate",
    names(openUngranted).includes("cotal_disconnect") && names(openUngranted).includes("cotal_connect"),
    names(openUngranted));
  check("G6 CONTROL: the SAME config with `creds` set hides them again (so G5 is open mode, not a broken fixture)",
    !names({ ...openUngranted, creds: "/nonexistent/agent.creds" }).includes("cotal_disconnect"),
    names({ ...openUngranted, creds: "/nonexistent/agent.creds" }));

  console.log("\n=== C1 CONTROL: a granted, connected agent disconnects itself ===");
  const before = seenBy(B, "subject-a");
  check("C1a CONTROL: observer-B sees subject-a PRESENT and not offline beforehand",
    !!before && before.status !== "offline", before);
  const d1 = await run("cotal_disconnect", A, cfgA, { cause: "going quiet on purpose" });
  check("C1b disconnect through the real tool SUCCEEDS", !d1.isError, d1.text);
  check("C1c it reports the departure, not a silent no-op", /Disconnected from "meshctl-conn"/.test(d1.text), d1.text);

  console.log("\n=== A1/A2 what the SUPERVISOR sees (asserted at the broker, via observer-B) ===");
  await sleep(1500);
  const after = seenBy(B, "subject-a");
  check("A1 observer-B sees subject-a OFFLINE — a deliberate departure is visible, not inferred from silence",
    after?.status === "offline", after);
  check("A2 the CAUSE travels with it — observer-B can see WHY, not merely THAT",
    !!after?.activity && after.activity.includes("going quiet on purpose"), after);

  console.log("\n=== A3 the disconnect STICKS: the self-heal must not undo a deliberate departure ===");
  await sleep(2500); // >> the 300ms retry window used above
  const later = seenBy(B, "subject-a");
  check("A3 still offline after the self-heal's retry window elapsed", later?.status === "offline", later);
  check("A3b and the agent itself agrees it is deliberately off", A.isSelfDisconnected() === true);
  // A3 and A3b are BOTH self-reported state — the presence record this endpoint writes, and its own
  // flag. Neither can tell "stayed off the mesh" apart from "came back and still reports offline",
  // which is precisely the ghost class this lane exists to close. Mutation testing caught that:
  // removing all three self-disconnect guards left A3/A3b green. So assert the CONNECTION itself,
  // and then assert it FUNCTIONALLY — a live subscription is the thing a stale record cannot fake.
  check("A3c the connection is actually DOWN, not merely reported down", A.connected === false);
  const dmTool = specs.find((s: any) => s.name === "cotal_dm")!;
  await dmTool.run(B, cfgB as any, { to: "subject-a", text: "PROBE-WHILE-DISCONNECTED" });
  await sleep(1200);
  const inboxTool = specs.find((s: any) => s.name === "cotal_inbox")!;
  const whileOff = await inboxTool.run(A, cfgA as any, { peek: true });
  check("A3d nothing is delivered live while disconnected (the functional arm)",
    !whileOff.text.includes("PROBE-WHILE-DISCONNECTED"), whileOff.text.slice(0, 200));

  console.log("\n=== named refusals (each asserted as THAT refusal) ===");
  const d2 = await run("cotal_disconnect", A, cfgA, {});
  check("R1 disconnecting again refuses as [not-connected]", d2.isError === true && d2.text.includes("[not-connected]"), d2.text);
  let reconnectErr = "";
  try { await A.reconnect(); } catch (e) { reconnectErr = (e as Error).message; }
  const rr = await run("cotal_reconnect", A, cfgA, {});
  check("R2 the RECOVERY path refuses to silently reverse a deliberate state, and names the verb that does",
    rr.isError === true && /connect\(\)/.test(rr.text), rr.text);

  console.log("\n=== C2 CONTROL (inverse): the agent brings ITSELF back through the same surface ===");
  const c1 = await run("cotal_connect", A, cfgA, {});
  check("C2a connect through the real tool SUCCEEDS", !c1.isError, c1.text);
  check("C2b it reports the space it returned to", /Connected to "meshctl-conn"/.test(c1.text), c1.text);
  await sleep(1500);
  const back = seenBy(B, "subject-a");
  check("C2c observer-B sees subject-a BACK (so A1's offline was the disconnect, not a dead fixture)",
    !!back && back.status !== "offline", back);

  const c2 = await run("cotal_connect", A, cfgA, {});
  check("R3 connecting again refuses as [already-connected]", c2.isError === true && c2.text.includes("[already-connected]"), c2.text);

  await A.stop();
  await B.stop();

  // ══ THE AUTHED ARM ═══════════════════════════════════════════════════════════════════════════
  // Everything above runs in OPEN mode — no credential, no broker ACL. That was this suite's
  // weakest property and it was found by auditing the not-measured list rather than the code: for
  // an AUTHORITY surface, being proven end-to-end only where there is no authority is the weakest
  // possible coverage. It is also the mode the real fleet does not run in — measured, every live
  // connector session on this box carries COTAL_CREDS and takes the restrictive gate arm.
  //
  // So: a real auth broker, a real minted credential, a real `capabilities: [connection]` grant,
  // and the same two verbs driven through the same `spec.run` entry point, asserted at an
  // INDEPENDENT AUTHED OBSERVER rather than from the subject's own view.
  //
  // REFUTED IF: the authed subject's self-disconnect is not visible to the authed observer, or the
  // authed connect does not bring it back. E1 is the inverse control for both — it establishes the
  // observer can see this subject at all before anything is asserted about its departure.
  console.log("\n=== THE AUTHED ARM: the same verbs, with a real credential and a real grant ===");
  const {
    CotalEndpoint, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
    serverConfig, newIdentity, setupSpaceStreams,
  } = await import("@cotal-ai/core");

  const APORT = await pickFreePort();
  const ASERVER = `nats://127.0.0.1:${APORT}`;
  if (ASERVER.includes(LIVE)) throw new Error(`REFUSING: ${ASERVER} is the live broker`);
  if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(ASERVER)) throw new Error(`REFUSING: ${ASERVER} is not loopback`);
  const aspace = "meshctl-authed";
  const sauth = await createSpaceAuth(aspace);
  const astore = mkdtempSync(join(tmpdir(), "meshctl-authed-"));
  writeFileSync(join(astore, "nats.conf"),
    `${serverConfig(sauth, [sauth], { transport: { kind: "plaintext" }, port: APORT, storeDir: join(astore, "js") })}\n`);
  const anats = spawn("nats-server", ["-c", join(astore, "nats.conf")], { stdio: "ignore", detached: true });
  const apgid = anats.pid!;
  try {
    for (let i = 0; i < 80; i++) { if (await isReachable(ASERVER)) break; await sleep(150); }

    // ⚠ THE CONTROL THAT MAKES THIS ARM MEAN ANYTHING. Everything below asserts behaviour "under
    // auth", and the cheapest way for that claim to be false is for this broker to be quietly
    // serving open mode — in which case E0–E7 would re-prove the open-mode arm under a new name and
    // read as coverage. So the enforcement is measured directly, not assumed from the config text.
    // REFUTED IF: an anonymous client can connect to ASERVER. Then this is not an authed arm.
    // Driven with the SAME client the feature uses (a credential-less `CotalEndpoint`) rather than a
    // raw nats connection — the connector package has no direct nats dependency, and this is the
    // stronger probe regardless: it is the exact code path a real ungranted session would take.
    const anonEp = new CotalEndpoint({
      space: aspace, servers: ASERVER, card: { name: "anon-probe", kind: "endpoint" },
      channels: [], consume: false, registerPresence: false, watchPresence: false,
    });
    anonEp.on("error", () => { /* expected: this endpoint is supposed to be refused */ });
    let anonDetail = "an anonymous connection SUCCEEDED — this broker is NOT enforcing auth";
    const anonOutcome = await Promise.race([
      anonEp.start().then(() => "connected" as const).catch((e: Error) => { anonDetail = e.message; return "rejected" as const; }),
      sleep(8000).then(() => "hung" as const),
    ]);
    if (anonOutcome === "connected") { try { await anonEp.stop(); } catch { /* nothing to unwind */ } }
    if (anonOutcome === "hung") anonDetail = "no verdict within 8s — inconclusive, which is NOT a pass";
    precondition("AUTHED", "EX the broker is REALLY enforcing auth — a credential-less client is REFUSED",
      anonOutcome === "rejected", anonDetail);
    console.log(`     └─ credential-less connect → ${anonOutcome}: ${anonDetail}`);

    // The launcher's job, done here the way the manager does it: mint the agent's creds from the
    // space signing key and hand the session the BYTES (config.creds is content, not a path).
    const mgrId = newIdentity();
    const mgrCreds = await mintCreds(sauth, mgrId, "provisioner");
    await setupSpaceStreams({ servers: ASERVER, space: aspace, creds: mgrCreds });
    const mgrEp = new CotalEndpoint({
      space: aspace, servers: ASERVER, creds: mgrCreds,
      card: { id: mgrId.id, name: "authed-mgr", kind: "endpoint" },
      channels: [], consume: false, registerPresence: false, watchPresence: false,
    });
    await mgrEp.start();

    // Consuming under auth means owning lifecycle-keyed broker resources, so the witness needs its
    // own uid and a credential minted against it (SPEC 13.1) — it cannot borrow the subject's.
    const obsId = newIdentity();
    const obsUid = mintLifecycleUid();
    const obsEp = new CotalEndpoint({
      space: aspace, servers: ASERVER,
      creds: await provisionAgent(mgrEp, sauth, obsId, {
        subscribe: ["general", "secret"], allowSubscribe: ["general", "secret"],
        allowPublish: ["general", "secret", "team.>"], lifecycleUid: obsUid, role: "observer",
      }),
      card: { id: obsId.id, name: "authed-observer", kind: "endpoint" },
      lifecycleUid: obsUid,
      channels: ["general", "secret"], consume: true, registerPresence: false, watchPresence: true,
    });
    const witnessed: string[] = [];
    obsEp.on("message", (m: any, d: any) => {
      witnessed.push(`#${m.channel}:${m.parts.map((p: any) => (p.kind === "text" ? p.text : "")).join("")}`);
      d.ack();
    });
    await obsEp.start();
    const authedSeen = (): { status?: string; activity?: string } | undefined => {
      const row = (obsEp.getRoster() as any[]).find((p) => (p.name ?? p.card?.name) === "authed-subject");
      return row ? { status: row.status, activity: row.activity } : undefined;
    };

    const subId = newIdentity();
    const subUid = mintLifecycleUid();
    // `role` is NOT optional decoration here: the endpoint binds a role TASK queue consumer at
    // connect, and `provisionAgentDurables` only creates that queue when `role` is passed. Omitting
    // it produced a subject that authenticated fine and then span forever on
    // `Permissions Violation for Publish to "$JS.API.CONSUMER.INFO.TASK_<space>.svc_worker"`.
    const subCreds = await provisionAgent(mgrEp, sauth, subId, {
      subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
      lifecycleUid: subUid, role: "worker",
    });
    // An AUTHED connector session: real creds bytes, the launcher's lifecycle uid, and the grant.
    const cfgAuthed: any = {
      space: aspace, name: "authed-subject", role: "worker", kind: "agent", servers: ASERVER,
      subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
      id: subId.id, creds: subCreds, lifecycleUid: subUid, capabilities: ["connection"],
    };
    const S = new MeshAgent(cfgAuthed);
    S.start(300);
    for (let i = 0; i < 90 && !S.connected; i++) await sleep(150);
    precondition("AUTHED", "E0 the AUTHED session connected with a real minted credential", S.connected, { connected: S.connected });
    await sleep(1500);

    // The gate, on a real authed config rather than a hand-built one: the verbs must be PRESENT
    // because the grant is present. G1 already proved they are absent without it.
    const authedSpecs = cotalToolSpecs(cfgAuthed, "smoke");
    const authedNames = authedSpecs.map((s: any) => s.name);
    check("E1 the verbs are on the surface of a REAL authed+granted session (not just a synthesized config)",
      authedNames.includes("cotal_disconnect") && authedNames.includes("cotal_connect"), authedNames);
    const runAuthed = async (tool: string, args?: any) => {
      const spec = authedSpecs.find((s: any) => s.name === tool);
      if (!spec) throw new Error(`fixture failed: ${tool} absent from the authed surface`);
      return spec.run(S, cfgAuthed, args);
    };
    armCheck("AUTHED", "E2 CONTROL: the authed observer can see the authed subject at all, BEFORE anything is claimed about its departure",
      authedSeen()?.status !== undefined && authedSeen()!.status !== "offline", authedSeen());

    const ed = await runAuthed("cotal_disconnect", { cause: "authed-arm" });
    armCheck("AUTHED", "E3 an AUTHED self-disconnect succeeds through the real tool", !ed.isError, ed.text);
    armCheck("AUTHED", "E4 and an INDEPENDENT AUTHED observer sees it offline — the supervisor property holds under auth, not just in open mode",
      await (async () => { for (let i = 0; i < 40; i++) { if (authedSeen()?.status === "offline") return true; await sleep(150); } return false; })(),
      authedSeen());
    armCheck("AUTHED", "E5 the cause is carried on the authed path too, so a deliberate departure is not a crash",
      /authed-arm/.test(String(authedSeen()?.activity ?? "")), authedSeen());

    const ec = await runAuthed("cotal_connect", {});
    armCheck("AUTHED", "E6 the authed agent brings ITSELF back through the same surface",
      !ec.isError, ec.text);
    armCheck("AUTHED", "E7 CONTROL: the observer sees it back (so E4's offline was the disconnect, not a dead fixture)",
      await (async () => { for (let i = 0; i < 40; i++) { const s = authedSeen(); if (s && s.status !== "offline") return true; await sleep(150); } return false; })(),
      authedSeen());

    // E8/E9 — THE HALF E6's LABEL USED TO CLAIM AND NEVER MEASURED. E6 asserted only that the call
    // did not error, under a name that promised the returned credential was "not re-minted wider".
    // A cell whose label out-runs its assertion is the same defect as a refusal naming the wrong
    // condition: it reads as covered. The label is narrowed and the claim is measured here instead.
    //
    // Measured FUNCTIONALLY and at the broker, not from the client's view of its own grant. The
    // tool gate refuses an out-of-ACL join client-side (m2), so the gate is BYPASSED deliberately —
    // `joinChannel` is the layer beneath it — and the question is put to the broker: with the
    // credential this session came back on, is a read outside its ACL served or denied?
    //
    // REFUTED IF the out-of-ACL post arrives (the return widened the grant), or if the in-ACL post
    // does NOT arrive (then E8's silence is a dead probe and proves nothing).
    await S.joinChannel("secret").catch(() => { /* the broker may reject the bind outright; either way the read must not be served */ });
    await sleep(600);
    // If the POSTER were itself denied #secret, nothing would ever be published and E8 would go
    // green having denied nothing — the vacuous pass, one layer further out than the one that bit
    // this suite already. So the publish is asserted as its own precondition: no post, no verdict.
    const outPost = await obsEp.multicast("PROBE-OUT-OF-ACL", { channel: "secret" }).catch((e: Error) => e);
    precondition("AUTHED", "E8-pre the out-of-ACL post was actually PUBLISHED, so there is something for the broker to withhold",
      !(outPost instanceof Error) && !!outPost, outPost instanceof Error ? outPost.message : outPost);
    await obsEp.multicast("PROBE-IN-ACL", { channel: "general" }).catch(() => { /* control */ });
    await sleep(1500);
    const inboxSpec = authedSpecs.find((s: any) => s.name === "cotal_inbox")!;
    const seenMsgs = await inboxSpec.run(S, cfgAuthed, { peek: true });
    armCheck("AUTHED", "E9 CONTROL: the IN-ACL post IS delivered (so E8's silence is a denial, not a dead probe)",
      seenMsgs.text.includes("PROBE-IN-ACL"), seenMsgs.text.slice(0, 300));
    armCheck("AUTHED", "E8 an out-of-ACL read is STILL denied after the self-reconnect — the credential came back no wider than it left",
      !seenMsgs.text.includes("PROBE-OUT-OF-ACL"), seenMsgs.text.slice(0, 300));

    // E10 — THE SUBTREE SHAPE, WHICH E8 DOES NOT COVER. `m3-fence` proves the wildcard escalations
    // are denied AT MINT TIME; nothing re-asked the question AFTER a reconnect, and "one concrete
    // channel is still denied" does not generalise to "a subtree grab is still denied". A credential
    // that came back with `team.>` would satisfy E8 and be a total read compromise of that subtree.
    // Same construction as E8, deliberately: bypass the client gate, publish first, assert delivery.
    await S.joinChannel("team.>").catch(() => { /* a denied bind is one of the ways this can be refused */ });
    await sleep(600);
    const subPost = await obsEp.multicast("PROBE-SUBTREE", { channel: "team.secret" }).catch((e: Error) => e);
    precondition("AUTHED", "E10-pre the subtree post was actually PUBLISHED, so there is something to withhold",
      !(subPost instanceof Error) && !!subPost, subPost instanceof Error ? subPost.message : subPost);
    await sleep(1500);
    const afterSub = await inboxSpec.run(S, cfgAuthed, { peek: true });
    // E10 is an ABSENCE assertion, and it reads a DIFFERENT snapshot than E9's positive arm — so
    // E9 cannot vouch for this one. An absence is trivially true against an empty universe: if this
    // read returned nothing at all, E10 would pass having observed nothing. The positive arm has to
    // live in the same snapshot as the absence it guards.
    armCheck("AUTHED", "E10-univ CONTROL: THIS inbox read is non-empty and still shows the in-ACL message (so E10's absence is measured against a live universe)",
      afterSub.text.includes("PROBE-IN-ACL"), afterSub.text.slice(0, 300));
    armCheck("AUTHED", "E10 a SUBTREE grab outside the ACL is denied after the reconnect too — the return did not widen the credential by shape either",
      !afterSub.text.includes("PROBE-SUBTREE"), afterSub.text.slice(0, 300));

    // E11/E12 — THE PUBLISH SIDE, WHICH E8 AND E10 STRUCTURALLY CANNOT SEE. Both of those measure
    // what the subject can RECEIVE, so a credential that came back able to POST anywhere would pass
    // them both. A widened publish grant is the louder half of the compromise: a read leak is
    // information, a write leak is an agent speaking on channels it was never admitted to.
    //
    // Driven entirely through the REAL tool for both arms, and that is the finding as much as the
    // cells are: `cotal_send` carries NO client-side publish gate (`tool-specs.ts:343` — straight to
    // `agent.send`), unlike the read side where `cotal_join`'s ACL check exists. So the broker is
    // the ONLY fence here, and nothing needed bypassing to ask it.
    //
    // REFUTED IF the out-of-ACL post is witnessed (the return widened the publish grant), or if the
    // in-ACL post is NOT witnessed (dead probe — the witness was never receiving).
    const sendSpec = authedSpecs.find((s: any) => s.name === "cotal_send")!;
    const inPub = await sendSpec.run(S, cfgAuthed, { text: "PUB-IN-ACL", channel: "general" });
    const outPub = await sendSpec.run(S, cfgAuthed, { text: "PUB-OUT-OF-ACL", channel: "secret" });
    await sleep(1800);
    armCheck("AUTHED", "E11 CONTROL: the subject's IN-ACL post IS witnessed at the broker (so E12's silence is a denial, not a dead witness)",
      witnessed.some((w) => w.includes("PUB-IN-ACL")), { witnessed, inPub: inPub.text });
    armCheck("AUTHED", "E12 the subject still CANNOT post outside its publish ACL after the self-reconnect — the return did not widen what it may SAY, only what it may hear was checked before",
      !witnessed.some((w) => w.includes("PUB-OUT-OF-ACL")), { witnessed, outPub: outPub.text });

    await S.stop();
    await obsEp.stop();
    await mgrEp.stop();
  } finally {
    try { process.kill(-apgid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 20 && anats.exitCode === null && anats.signalCode === null; i++) await sleep(100);
    try { rmSync(astore, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\nCONNECTION-CONTROL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed, ${voided} VOID)`);
  if (voided) console.log(`  ⚠ ${voided} cell(s) VOID — they did not run, so they are not evidence of anything. Do not read this as coverage.`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("SMOKE ERROR:", e); process.exitCode = 1; })
  .finally(async () => {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
    // Await the child's exit before deleting the scratch it is still writing into.
    for (let i = 0; i < 20 && nats.exitCode === null && nats.signalCode === null; i++) await sleep(100);
    try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(process.exitCode ?? 0);
  });
