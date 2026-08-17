/**
 * THE CLI's PINNED LIVENESS PROBE — what `cotal ps` asks, what it refuses to ask, and what it says.
 *
 * THE SHAPE UNDER TEST. A class scatter's gather ends when every frozen slot has answered, or at the
 * deadline. A registration whose host died can never answer, so the deadline is paid in full on
 * every scatter in the space, forever. The fix is to let the BROKER say an instance holds no
 * subscription on its own rail — but that question is a publish on that instance's `inst` rail, and
 * a one-shot instrument minted before the class is known holds no such row. So the CLI freezes the
 * class on one connection and re-mints, pinned to exactly those ids, before scattering on a second.
 *
 * WHY THE HOOK IS THE CALLER'S AND NOT CORE'S, which is the whole reason this suite is in the CLI:
 * a refused publish does not fail. The violation arrives on the CONNECTION, asynchronously, while
 * the publish returns normally — so a probe with no grant goes quiet, and quiet is exactly what a
 * live-but-slow instance looks like. Core cannot tell those apart because core does not know what
 * the credential carries. This layer does, so it asks only what it may ask, and says so out loud
 * when the broker refuses anyway.
 *
 * THE POSITIVE CONTROL IS A CELL, not a note. Section 4 withholds ONE instance's probe grant and
 * requires the run to go slow again AND the violation to be named. Without it, "the probe made it
 * fast" is a correlation: something else could have ended the gather, and a suite that only ever
 * observes the fast path cannot tell.
 *
 * AND THE ATTRIBUTION ITSELF IS A CELL (section 6). Naming the refused instance is only useful if
 * the name is right: lifecycle tokens are variable-length, so one frozen id can be a strict prefix
 * of another, and a refusal matched anywhere inside the subject text was charged to both. Section 6
 * builds that pair and requires one refusal to stay one instance's.
 *
 * Run: pnpm smoke:scatter-pinned-probe   (needs nats-server + node on PATH; boots its own JWT broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER, instancePinnedInstrumentCapabilities,
  freezeExpectedSet, resolveService, scatterCommand,
  type EpCaller,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
// The manager is the FIXTURE, reached by source path rather than as a dependency: `implementations/*`
// never depend on each other, and a smoke must not be the thing that creates one. It is here because
// only a real registration can produce the state under test, and `packages/workspace/smoke/pid.smoke.ts`
// reaches across the same way for the same reason.
import { Manager } from "../../manager/src/manager.js";
import { pinnedLivenessProbe } from "../src/lib/control.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const EXPECTED_CELLS = 21; // predicted 14: +1 for the counter's own positive control (3a), +2 for the never-asked fallback the mutation pass found uncovered, +4 for section 6's prefix/superstring pair (review)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const MANAGER_ENDPOINT = "manager";
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `pinprobe-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(SPACE);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));

type MgrPriv = { managerInstanceId: string; serviceServe?: { nc: NatsConnection } };
const kids: ReturnType<typeof spawn>[] = [];
const conns: NatsConnection[] = [];
let releaseBroker: (() => void) | undefined;
let live: InstanceType<typeof Manager> | undefined;
let corpse: InstanceType<typeof Manager> | undefined;
try {
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  kids.push(srv);
  releaseBroker = teardownOnSignal(srv, dir);
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const rootLive = mkRoot("live"), rootCorpse = mkRoot("corpse");
  for (const r of [rootLive, rootCorpse]) recordMesh({ space: SPACE, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  live = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: rootLive });
  corpse = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: rootCorpse });
  await live.start();
  await corpse.start();
  const IID_LIVE = (live as unknown as MgrPriv).managerInstanceId;
  const IID_CORPSE = (corpse as unknown as MgrPriv).managerInstanceId;
  // The crash shape: connections drop, nothing is written, the registration survives.
  await ((corpse as unknown as MgrPriv).serviceServe as { nc: NatsConnection }).nc.close();
  await wait(500);

  /** One connection under a `control-caller-privileged` instrument pinned to exactly `pins` — the
   *  credential the CLI re-mints after its freeze, built here the same way and from the same seed. */
  const openPinned = async (pins: string[]): Promise<{ nc: NatsConnection; caller: EpCaller }> => {
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await mintCreds(auth, id, "control-caller-privileged", {
      lifecycleUid: uid,
      ...(pins.length ? { endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", pins) } : {}),
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    conns.push(nc);
    return { nc, caller: { owner: DEV_OWNER, actor: id.id, uid } };
  };

  console.log("1. the freeze names both, because a record is all the freeze knows");
  const observer = await openPinned([IID_LIVE, IID_CORPSE]);
  const jsm = await jetstreamManager(observer.nc, { checkAPI: false });
  const frozen = (await freezeExpectedSet(jsm, SPACE, MANAGER_ENDPOINT)).map((f) => f.instanceId);
  check("the class freezes to both the live manager and the corpse", frozen.includes(IID_LIVE) && frozen.includes(IID_CORPSE), frozen);

  console.log("2. the closure asks only what its credential may ask");
  // "NOT SENT" is observed on the CONNECTION's own outbound message counter, not argued from the
  // return value. Watching the instance rail instead would have been wrong twice over: a caller
  // credential holds no `sub` row on an `inst` rail (§13.9 gives it pub there and its reply rail
  // only), and a subscriber on that rail is exactly the interest the broker's no-responders verdict
  // asks about, so the instrument would have destroyed the state it was measuring.
  // The counter's own positive control is section 3's first cell: the same delta moves for an id
  // that IS pinned. A zero no instrument can be shown to notice is not evidence.
  const asker = await openPinned([IID_LIVE, IID_CORPSE]);
  const OUTSIDER = "z".repeat(26);
  const narrow = pinnedLivenessProbe(asker.nc, {
    space: SPACE, endpoint: MANAGER_ENDPOINT, caller: asker.caller,
    pinned: new Set([IID_LIVE, IID_CORPSE]), probeDeadlineMs: 2_000, report: () => {},
  });
  const outBefore = asker.nc.stats().outMsgs;
  const outsiderVerdict = await narrow.probeLiveness(OUTSIDER);
  const outsiderSent = asker.nc.stats().outMsgs - outBefore;
  check("an id OUTSIDE the pinned set is UNKNOWN - never `gone`, so it can never shortcut a deadline",
    outsiderVerdict === "unknown", outsiderVerdict);
  check("...and NOTHING left the connection for it: a request the credential cannot back is not sent",
    outsiderSent === 0, { outsiderSent });
  check("...and its row says NOT-PROBED, which is a fact about this command, not about the instance",
    narrow.livenessOf(OUTSIDER) === "not-probed", narrow.livenessOf(OUTSIDER));
  // A row can also be asked about an instance the hook NEVER SAW: a gather that ends early never
  // probes what already answered, and the scatter re-freezes on its own connection, so it can name
  // an id this credential was not minted against. That fallback is a different branch from the
  // verdicts recorded above, and the mutation pass found it uncovered, so it gets its own cells.
  const unasked = pinnedLivenessProbe(asker.nc, {
    space: SPACE, endpoint: MANAGER_ENDPOINT, caller: asker.caller,
    pinned: new Set([IID_LIVE]), probeDeadlineMs: 2_000, report: () => {},
  });
  check("an id never handed to the hook, but inside the pinned set, reads UNKNOWN: nothing was established",
    unasked.livenessOf(IID_LIVE) === "unknown", unasked.livenessOf(IID_LIVE));
  check("...and one outside the set reads NOT-PROBED without the hook ever running",
    unasked.livenessOf(OUTSIDER) === "not-probed", unasked.livenessOf(OUTSIDER));

  console.log("3. an id INSIDE the set is asked, and the broker answers about it");
  const pinnedBefore = asker.nc.stats().outMsgs;
  const goneVerdict = await narrow.probeLiveness(IID_CORPSE);
  const pinnedSent = asker.nc.stats().outMsgs - pinnedBefore;
  check("a PINNED id DOES move the counter (the positive control that makes cell 2 mean something)",
    pinnedSent >= 1, { pinnedSent, outsiderSent });
  check("the corpse is affirmed GONE by the broker", goneVerdict === "gone", goneVerdict);
  check("...and its row says the registration is stale", narrow.livenessOf(IID_CORPSE) === "gone", narrow.livenessOf(IID_CORPSE));
  const liveVerdict = await narrow.probeLiveness(IID_LIVE);
  check("a LIVE instance is never `gone` - it holds its subscriptions, so the broker reports interest", liveVerdict !== "gone", liveVerdict);

  console.log("4. THE POSITIVE CONTROL: withhold ONE probe grant and the saving disappears");
  // Same corpse, same scatter, ONE row removed from the credential. If the timing below did not move,
  // the probe would not be what produces the fast path and every claim in this suite would be a
  // coincidence. It also reproduces the failure this design exists to make impossible: a missing
  // grant that presents as a slow manager.
  const withheld = await openPinned([IID_LIVE]); // the corpse's row, deliberately absent
  const violations: string[] = [];
  const blind = pinnedLivenessProbe(withheld.nc, {
    space: SPACE, endpoint: MANAGER_ENDPOINT, caller: withheld.caller,
    // The corpse IS in the pinned set as far as the closure knows, so it publishes — and the broker
    // refuses. This is the case the closure cannot prevent and must therefore report.
    pinned: new Set([IID_LIVE, IID_CORPSE]), probeDeadlineMs: 4_000, report: (l) => violations.push(l),
  });
  const svcBlind = await resolveService(withheld.nc, SPACE, MANAGER_ENDPOINT, withheld.caller, { deadlineMs: 8_000 });
  const tBlind = Date.now();
  const rBlind = await scatterCommand(withheld.nc, SPACE, svcBlind, "ps", undefined, { deadlineMs: 3_000, probeLiveness: blind.probeLiveness });
  const blindMs = Date.now() - tBlind;
  check("WITHOUT the corpse's probe grant the gather pays the full deadline again", blindMs >= 2_900, { blindMs, budgetMs: 3_000 });
  check("the broker's refusal is REPORTED, not left to expire into silence", violations.length >= 1, violations);
  check("...and it names the instance whose rail was refused", violations.some((v) => v.includes(IID_CORPSE)), violations);
  check("...and the row says the probe was REFUSED, distinct from an instance that stayed silent",
    blind.livenessOf(IID_CORPSE) === "probe-refused", blind.livenessOf(IID_CORPSE));
  check("the corpse is still reported unreachable, never dropped (pin 3 holds either way)", rBlind.missing.includes(IID_CORPSE), rBlind.missing);

  console.log("5. and with the grant, the same scatter ends early");
  const granted = await openPinned([IID_LIVE, IID_CORPSE]);
  const armed = pinnedLivenessProbe(granted.nc, {
    space: SPACE, endpoint: MANAGER_ENDPOINT, caller: granted.caller,
    pinned: new Set([IID_LIVE, IID_CORPSE]), probeDeadlineMs: 4_000, report: (l) => violations.push(l),
  });
  const svcArmed = await resolveService(granted.nc, SPACE, MANAGER_ENDPOINT, granted.caller, { deadlineMs: 8_000 });
  const tArmed = Date.now();
  const rArmed = await scatterCommand(granted.nc, SPACE, svcArmed, "ps", undefined, { deadlineMs: 3_000, probeLiveness: armed.probeLiveness });
  const armedMs = Date.now() - tArmed;
  check("WITH it, the gather ends as soon as the corpse is accounted for", armedMs < 1_000 && rArmed.missing.includes(IID_CORPSE), { armedMs, blindMs, missing: rArmed.missing });
  check("and no permission violation was raised on the granted connection", violations.every((v) => !v.includes(granted.caller.actor)), violations);

  console.log("6. one refusal is ONE instance's refusal, even when another frozen id is its prefix");
  // FOUND BY REVIEW, and it is a wrong ANSWER rather than a slow one. A lifecycle token is
  // `[a-z0-9]{26,32}`, so one frozen id can be a strict prefix of another; attribution used to test
  // whether the refused subject CONTAINED an id, and a single refusal on the longer rail was then
  // charged to both. The operator is told the CLI could not ask about a manager it never published
  // for, and that manager's row reads `probe-refused` on evidence from someone else's rail.
  //
  // The ids are FABRICATED and pinned in the credential, not registered: what is under test is the
  // attribution of a broker refusal to a rail, which needs no instance behind it. The credential
  // carries the SHORTER id's rail and not the longer one's, so the broker refuses exactly one probe
  // and the shorter id's own probe can still be answered - by the broker, with the no-responders
  // verdict its empty rail earns.
  const PREFIX_ID = "p".repeat(26);
  const LONGER_ID = `${PREFIX_ID}9`;
  const pairConn = await openPinned([PREFIX_ID]);
  const pairViolations: string[] = [];
  const pair = pinnedLivenessProbe(pairConn.nc, {
    space: SPACE, endpoint: MANAGER_ENDPOINT, caller: pairConn.caller,
    pinned: new Set([PREFIX_ID, LONGER_ID]), probeDeadlineMs: 3_000, report: (l) => pairViolations.push(l),
  });
  await pair.probeLiveness(LONGER_ID);
  check("the refusal of the LONGER id produces exactly ONE violation line, not one per id inside it",
    pairViolations.length === 1, pairViolations);
  check("...attributed to the instance whose rail was actually refused", pairViolations[0]?.includes(`instance ${LONGER_ID}:`), pairViolations);
  check("...and that id's row says probe-refused (the attribution happened at all)", pair.livenessOf(LONGER_ID) === "probe-refused", pair.livenessOf(LONGER_ID));
  const prefixVerdict = await pair.probeLiveness(PREFIX_ID);
  check("THE POINT: the id that is a PREFIX of the refused one keeps its own verdict, from its own rail",
    prefixVerdict === "gone" && pair.livenessOf(PREFIX_ID) === "gone", { prefixVerdict, row: pair.livenessOf(PREFIX_ID), pairViolations });
} finally {
  for (const nc of conns) { try { await nc.drain(); } catch { /* ignore */ } }
  await live?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker?.();
}

const counted = pass + fail;
if (counted !== EXPECTED_CELLS) {
  console.log(`  ✗ FAIL: expected ${EXPECTED_CELLS} cells, ran ${counted} - a cell that stops running stops guarding`);
  fail++;
}
console.log(`\n${fail === 0 ? "SCATTER PINNED PROBE SMOKE OK ✅" : "SCATTER PINNED PROBE SMOKE FAILED"}  (${pass} passed, ${fail} failed, ${EXPECTED_CELLS} expected)`);
process.exit(fail === 0 ? 0 : 1);
