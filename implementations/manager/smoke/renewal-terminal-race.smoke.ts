/**
 * RENEWAL-vs-TERMINAL RACE probe (control-surface v0.4, arbiter-recorded residual).
 * Run: pnpm smoke:renewal-terminal-race   (needs nats-server on PATH; boots its own broker)
 *
 * THIS IS A REPRODUCTION, NOT A REGRESSION TEST YET. It is deliberately NOT in `smoke:ci`: it is
 * expected to FAIL while the defect stands, and it becomes the regression test once a fix lands.
 *
 * READ THIS BEFORE DESIGNING THE FIX. The shape resembles the session-capacity race (B1) and the
 * remedy is NOT the same. B1 took a RESERVATION because the correct outcome there was "admit exactly
 * N". Here the correct outcome is "NO CREDENTIAL" — so a reservation is wrong, and a retry is wrong,
 * because the right answer is not "a credential minted later". The shape is to make the writes
 * conditional on the same latch read the teardown orders against, so both cannot win.
 *
 * THE DEFECT. `renewManagedStaticCred` reads the terminal latch at ENTRY and then performs four
 * awaits before its writes:
 *
 *     if (a.terminalizing) throw …          <- the check
 *     await mintCreds(…)                     <- yield 1
 *     await withLifecycleExecutor(… recordSlotCredential, appendStaticCredentialRow …)   <- yield 2, DURABLE ROW
 *     await secrets.put(agentSecretKeyForFile(creds))                                     <- yield 3, WRITE 1
 *     await materializeSecretToFile(…, creds)                                             <- yield 4, WRITE 2
 *
 * The retirement cleanup deletes exactly those two artifacts, by the same key and the same path. So a
 * despawn landing inside that window latches `terminalizing`, cleanup deletes the credential, and an
 * in-flight renewal re-creates it afterwards — for a lifecycle whose terminal has begun.
 *
 * TWO GUARDS AT THE SAME POSITION ARE ONE GUARD: the renewal sweep filter also reads `terminalizing`,
 * and it also sits before the same four awaits. A reviewer counting guards finds two and stops.
 *
 * WHY THE DURABLE ROW IS THE ASSERTION AND THE FILE IS NOT. A stale file on disk is recoverable by
 * re-running cleanup. A static-credential ROW for a retired lifecycle is a claim IN THE JOURNAL that
 * the credential is legitimate, and the journal is the authority. The row is also a deterministic KV
 * read, where catching the file before cleanup is timing-dependent — so the probe asserts on the
 * artifact rather than on the interleaving.
 *
 * TWO THINGS A FIXER NEEDS, AND THEY DO NOT CANCEL EACH OTHER.
 *
 *  1. THE WINDOW IS WIDE ONCE ENTERED. It reproduced on the FIRST attempt that reached the race,
 *     with no help — no injected clock, no fake timers, no patched interleaving.
 *  2. HOW OFTEN PRODUCTION ENTERS IT IS UNMEASURED. This probe calls `renewManagedStaticCred`
 *     DIRECTLY. Production reaches it only through the renewal sweep, which filters on
 *     `health.state === "healthy"` and near-expiry (manager.ts ~:939/:944) — a gate this probe
 *     bypasses entirely. So the run says nothing about the RATE at which production arrives at the
 *     window, and "rare" is not established either way. Both halves belong in any prioritisation:
 *     overstating a hole misallocates attention exactly as reassuring copy does.
 *
 * THE DEFECT BLOCKS ITS OWN RE-TEST, so a rate cannot be read off repeated attempts here. After the
 * first hit, every later attempt is refused at spawn — "the name is reserved pending retirement" —
 * because the alias frees only when teardown completes, and the defect is that teardown does not
 * complete. TO MEASURE A RATE, USE A FRESH ALIAS PER ATTEMPT. Reporting hits-over-attempts from this
 * file as written would be a number that is not a count.
 *
 * CONCURRENCY IS STRUCTURAL, NOT AN UNLUCKY SCHEDULE: renewal is reached from a `setInterval` sweep
 * and despawn is caller-triggered from the ep door, so every `await` above is a yield point a
 * despawn can be scheduled into. This probe drives the same window directly rather than waiting for
 * the timer, and reports HITS OUT OF ATTEMPTS rather than a boolean — the window's width is the
 * thing a fixer needs, and one hit is enough to establish reachability.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, mintCreds, newIdentity, standaloneConnectOpts, registry, DEV_OWNER,
  setupSpaceStreams, recordsBucket, epAuthBucket, parseLedgerRow, credRowKey,
  type AgentHandle, type Connector, type LaunchSpec, type Presence, type CredentialLedgerRow,
} from "@cotal-ai/core";
import {
  staticLifecycleTransport, readStaticSlot,
} from "../src/static-lifecycle.js";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";

const ATTEMPTS = 12;
let hitsRow = 0, hitsFile = 0, refused = 0, completed = 0;

const space = `renewal-race-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-renewal-race-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "racer.md"),
  `---\nname: racer\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`,
);

// `mgr.start()` reads the space auth from the workspace authDir — session-cap (the other suite that
// calls start()) does this; static-lifecycle does not need it because it drives startAgent directly.
saveSpaceAuth(authDir(workspaceRoot), auth);
const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {},
  waitForPresenceSnapshot: () => Promise.resolve(), getRoster: (): Presence[] => [],
};
registry.register({ kind: "connector", name: "smoke-race", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) } as Connector);

type Agent = { id: string; name: string; lifecycleUid: string; terminalizing?: boolean; secretPaths?: { creds?: string } };
const M = mgr as unknown as {
  agents: Map<string, Agent>;
  renewManagedStaticCred(a: Agent): Promise<void>;
  despawnAuthorized(a: Agent, graceful: boolean, wait: boolean): { ok: boolean };
};

/** The journal's own view: every credential row the slot names, for one lifecycle. */
async function credRowsFor(alias: string, actor: string, uid: string): Promise<CredentialLedgerRow[]> {
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor, lifecycleUid: uid, alias } });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    const slot = await readStaticSlot(t, DEV_OWNER, alias);
    const rows: CredentialLedgerRow[] = [];
    for (const id of slot?.row.credentialIds ?? []) {
      const e = await t.getAuth(credRowKey(uid, id));
      if (e !== undefined) rows.push(parseLedgerRow(e.value, credRowKey(uid, id)));
    }
    return rows;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

try {
  // The space streams the manager's own connection authorizes against. Omitting this is an
  // Authorization Violation at `mgr.start()`, not a defect in anything under test.
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();
  // The fake runtime's agent never joins the mesh, so the readiness wait would time out at 30s per
  // spawn and every attempt would be SKIPPED — a probe that reports "not reproduced" having never
  // reached the race. session-cap stubs this for the same reason.
  (mgr as unknown as { awaitReadiness(): Promise<{ ok: true }> }).awaitReadiness = async () => ({ ok: true });
  console.log(`renewal-vs-terminal race probe — ${ATTEMPTS} attempts\n`);

  for (let i = 0; i < ATTEMPTS; i++) {
    const spawned = await mgr.startAgent({ name: "racer", agent: "smoke-race" });
    if (!spawned.ok) { console.log(`  attempt ${i + 1}: spawn failed (${spawned.error}) — skipped`); continue; }
    const a = M.agents.get("racer");
    if (!a) { console.log(`  attempt ${i + 1}: no managed agent after spawn — skipped`); continue; }
    const { id: actor, lifecycleUid: uid, secretPaths } = a;
    const credsPath = secretPaths?.creds;

    // THE RACE. Start the renewal and do NOT await it; despawn while it is between its latch read
    // and its writes. Both are ordinary paths — no injection, no patched clock, no fake timers.
    const renewal = M.renewManagedStaticCred(a).then(() => { completed++; return "completed" as const })
      .catch((e) => { refused++; return `refused: ${(e as Error).message.slice(0, 60)}` as const });
    M.despawnAuthorized(a, false, true);
    const outcome = await renewal;
    for (let w = 0; w < 100 && M.agents.has("racer"); w++) await new Promise((r) => setTimeout(r, 50));

    const rows = await credRowsFor("racer", actor, uid);
    const active = rows.filter((r) => r.state === "active");
    const fileBack = credsPath !== undefined && existsSync(credsPath);
    if (active.length > 0) hitsRow++;
    if (fileBack) hitsFile++;
    console.log(`  attempt ${i + 1}: renewal ${outcome} · rows ${rows.length} (active ${active.length}) · creds file ${fileBack ? "PRESENT" : "gone"}`);
  }

  console.log(`\n── RESULT ──────────────────────────────────────────────`);
  console.log(`  attempts                                   ${ATTEMPTS}`);
  console.log(`  renewal REFUSED at the latch (correct)     ${refused}`);
  console.log(`  renewal COMPLETED past the terminal        ${completed}`);
  console.log(`  ACTIVE credential row for a retired uid    ${hitsRow}   <- the journal claims a live credential`);
  console.log(`  credential FILE present after cleanup      ${hitsFile}`);
  console.log(`\n  ${hitsRow > 0 ? "REPRODUCED" : "NOT reproduced in this run"} — one hit establishes reachability; zero does NOT establish absence.`);
} finally {
  await mgr.stop().catch(() => {});
  await stopBroker();
}
process.exit(0); // a probe reports; it does not gate
