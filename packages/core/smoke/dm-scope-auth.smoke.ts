/**
 * DM owner-scoping smoke (`allowDmOwners`) — the acceptance gate for narrowing an agent's DM SEND ACL.
 *
 * Before this option the agent mint hardcoded `inst.*.*.<owner>.<actor>`: every agent on a space could
 * DM every other agent, and a multi-tenant deployment could not confine one tenant's agents to its own
 * people. `allowDmOwners` emits one grant per permitted recipient owner instead of the single wildcard.
 *
 * The load-bearing invariant, checked from both sides here: ABSENT is not EMPTY.
 *   - omitted   ⇒ ["*"] — byte-identical to the historical grant, so upgrading narrows nobody;
 *   - []        ⇒ no DM send at all, an explicit and honoured choice.
 * If those two collapsed into each other, deploying this would silently cut the DM plane of every
 * existing space on upgrade — which is precisely the failure a default-deny reflex would introduce.
 *
 * What is NOT weakened is checked too: the SENDER slots stay forge-locked, the recipient ACTOR slot
 * stays a wildcard, and the RECEIVE lane is untouched (this narrows sending, never reading).
 *
 * Run: pnpm smoke:dm-scope:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, mintCreds, mintLifecycleUid, serverConfig, newIdentity,
  setupSpaceStreams, unicastSubject, permissionsFor,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (p: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((res) => { if (p.exitCode !== null || p.signalCode !== null) return res(); p.once("exit", () => res()); setTimeout(res, t); });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

// Three valid DERIVED owners (u_ + 26 base32-lower), nkey-disjoint by construction as the callout mints.
const OWNER_A = "u_" + "a".repeat(26); // the SENDER under test
const OWNER_B = "u_" + "b".repeat(26); // IN policy
const OWNER_C = "u_" + "c".repeat(26); // OUT of policy
// Fixed (not minted) so the two permissionsFor() calls compared below differ in ONE input only.
const LIFECYCLE_PROBE = "abcdefghij0123456789klmnop";

async function tryPublish(creds: string, subject: string, id: string): Promise<"allowed" | "denied"> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  try {
    await nc.request(subject, new Uint8Array(0), { timeout: 500 });
    return "allowed"; // a responder replied — or, with no handler on the subject, see catch (no-responders ⇒ accepted)
  } catch (e) {
    const m = (e as Error).message.toLowerCase();
    return m.includes("authorization") || m.includes("permission") ? "denied" : "allowed";
  } finally { await nc.drain().catch(() => {}); }
}

async function trySubscribe(creds: string, id: string, subject: string, graceMs = 350): Promise<"allowed" | "denied"> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  let denied = false;
  void (async () => { for await (const s of nc.status()) { if (/permission|authorization/i.test(`${(s as { type?: string }).type ?? ""} ${(s as { data?: unknown }).data ?? ""}`)) denied = true; } })().catch(() => {});
  const sub = nc.subscribe(subject, { callback: (err) => { if (err) denied = true; } });
  await nc.flush().catch(() => { denied = true; });
  await wait(graceMs);
  try { sub.unsubscribe(); } catch { /* draining */ }
  await nc.drain().catch(() => {});
  return denied ? "denied" : "allowed";
}

const space = `dmscope-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // Three agents, all owned by A, differing ONLY in how allowDmOwners is expressed. Same owner and
  // channel ACL throughout, so any difference measured below is attributable to that one option.
  const base = { allowSubscribe: ["general"], allowPublish: ["general"] };
  const idScoped = newIdentity(), idAbsent = newIdentity(), idEmpty = newIdentity();
  const scoped = await mintCreds(auth, idScoped, "agent", {
    ...base, principal: { owner: OWNER_A, actor: "scoped" }, lifecycleUid: mintLifecycleUid(), allowDmOwners: [OWNER_B],
  });
  const absent = await mintCreds(auth, idAbsent, "agent", {
    ...base, principal: { owner: OWNER_A, actor: "absent" }, lifecycleUid: mintLifecycleUid(), // no allowDmOwners AT ALL
  });
  const empty = await mintCreds(auth, idEmpty, "agent", {
    ...base, principal: { owner: OWNER_A, actor: "empty" }, lifecycleUid: mintLifecycleUid(), allowDmOwners: [],
  });

  console.log(`SCOPED agent — allowDmOwners: ["${OWNER_B.slice(0, 6)}…"]:`);
  check("DM an IN-POLICY owner ALLOWED",
    await tryPublish(scoped, unicastSubject(space, OWNER_B, "anyone", OWNER_A, "scoped"), idScoped.id) === "allowed");
  check("DM an OUT-OF-POLICY owner DENIED (the whole point)",
    await tryPublish(scoped, unicastSubject(space, OWNER_C, "anyone", OWNER_A, "scoped"), idScoped.id) === "denied");
  check("the recipient ACTOR slot stays a WILDCARD — a SECOND actor of the same owner is ALLOWED",
    await tryPublish(scoped, unicastSubject(space, OWNER_B, "secondActor", OWNER_A, "scoped"), idScoped.id) === "allowed");
  // The list is exactly what was declared: core adds no implicit self entry. A deployment that wants
  // self-DM puts its own owner in the list (the platform policy layer does); core does not guess.
  check("the scope is EXACTLY as declared — the agent's OWN owner is not implicitly added",
    await tryPublish(scoped, unicastSubject(space, OWNER_A, "absent", OWNER_A, "scoped"), idScoped.id) === "denied");
  // Narrowing the send ACL must not weaken the identity pin that was already there.
  check("FORGE a DM as another actor, even to an IN-POLICY recipient, still DENIED",
    await tryPublish(scoped, unicastSubject(space, OWNER_B, "anyone", OWNER_A, "absent"), idScoped.id) === "denied");
  // Scoping is SEND-side only. Asserted structurally against the SHIPPED builder rather than by
  // probing a subscribe: an agent has no native grant on its own `inst.>` lane at all (DMs arrive
  // over the Plane-3 delivery plane), so a subscribe probe there would be measuring the wrong thing
  // and would read "denied" on stock too. What must hold is that the read boundary is UNCHANGED.
  const permsOf = (dm?: string[]) => permissionsFor("agent", space, { owner: OWNER_A, actor: "probe", connId: "probeconn0001", lifecycleUid: LIFECYCLE_PROBE }, {
    ...base, ...(dm ? { allowDmOwners: dm } : {}),
  }) as { sub: { allow: string[] }; pub: { allow: string[] } };
  const pScoped = permsOf([OWNER_B]), pAbsent = permsOf();
  check("narrowing the DM send ACL leaves the READ boundary byte-identical",
    JSON.stringify(pScoped.sub.allow) === JSON.stringify(pAbsent.sub.allow),
    { scoped: pScoped.sub.allow.length, absent: pAbsent.sub.allow.length });
  // Bounds the blast radius: nothing but the DM grants may move, or this option is quietly editing
  // some other rail. Compared both ways, so an ADDED non-DM grant fails as loudly as a dropped one.
  const onlyDm = (a: string[], b: string[]) => a.filter((x) => !b.includes(x)).every((x) => x.includes(".inst."));
  check("and the ONLY publish grants that differ are DM grants",
    onlyDm(pScoped.pub.allow, pAbsent.pub.allow) && onlyDm(pAbsent.pub.allow, pScoped.pub.allow),
    { added: pScoped.pub.allow.filter((x) => !pAbsent.pub.allow.includes(x)) });

  console.log("\nABSENT vs EMPTY — the invariant the upgrade path rests on:");
  check("ABSENT ⇒ the historical wildcard: DM owner B ALLOWED",
    await tryPublish(absent, unicastSubject(space, OWNER_B, "anyone", OWNER_A, "absent"), idAbsent.id) === "allowed");
  check("ABSENT ⇒ the historical wildcard: DM owner C ALLOWED TOO (no narrowing on upgrade)",
    await tryPublish(absent, unicastSubject(space, OWNER_C, "anyone", OWNER_A, "absent"), idAbsent.id) === "allowed");
  check("EMPTY ⇒ no DM send at all: owner B DENIED",
    await tryPublish(empty, unicastSubject(space, OWNER_B, "anyone", OWNER_A, "empty"), idEmpty.id) === "denied");
  check("EMPTY ⇒ no DM send at all: owner C DENIED",
    await tryPublish(empty, unicastSubject(space, OWNER_C, "anyone", OWNER_A, "empty"), idEmpty.id) === "denied");
  // Stated as its own cell so a collapse of the two cannot pass as a partial green somewhere above.
  check("ABSENT and EMPTY are therefore NOT the same value",
    await tryPublish(absent, unicastSubject(space, OWNER_C, "anyone", OWNER_A, "absent"), idAbsent.id) === "allowed" &&
    await tryPublish(empty, unicastSubject(space, OWNER_C, "anyone", OWNER_A, "empty"), idEmpty.id) === "denied");

  console.log(`\nDM-SCOPE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (pass + fail !== 12) { console.log(`  ✗ FAIL: expected 12 cells, ran ${pass + fail}`); process.exitCode = 1; }
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
