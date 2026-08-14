/**
 * M3 drive: WHAT THE BROKER ENFORCES vs WHAT THE CLIENT DECIDES — the real specification for a
 * self-directed connect / re-target. Every assertion here is driven at an ephemeral nats-server,
 * never inferred from the client.
 *
 * The question the design must answer: if an agent could aim its own connection at a different
 * space or a different broker, WHAT WOULD IT REACH? Measured, not reasoned.
 *
 * REFUTATION CONDITIONS — stated before any result is cited:
 *   F1 cross-space  REFUTED if agent-A's cred can subscribe to space-B's chat on the same broker.
 *   F2 cross-broker REFUTED if agent-A's cred can CONNECT to a broker that does not trust its account.
 *   F3 escalation   REFUTED if a `provisioner` cred minted from the on-disk SpaceAuth reaches no
 *                   more than the agent cred (i.e. the mint path grants nothing extra).
 * INVERSE CONTROLS (an arm that CAN differ, through the same code path):
 *   C1 agent-A's cred subscribing to its own in-ACL channel on space-A must be ALLOWED.
 *   C2 that same cred must CONNECT successfully to the broker that DOES trust it.
 *   Without C1/C2 a "denied" could just be a broken probe.
 *
 * Run: tsx packages/core/meshctl-m3-fence.smoke.ts   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, createSpaceAccountAuth, composeSpaceAuth, mintCreds, provisionAgent,
  mintLifecycleUid, serverConfig, newIdentity, setupSpaceStreams, chatSubject, spacePrefix,
} from "./src/index.js";
import { pickFreePort } from "./smoke/_free-port.js";

const PORT_AB = await pickFreePort();
const PORT_C = await pickFreePort();
const SRV_AB = `nats://127.0.0.1:${PORT_AB}`;
const SRV_C = `nats://127.0.0.1:${PORT_C}`;

// ---- FIRST ACTION: assert neither target is the live broker. -----------------------------
for (const s of [SRV_AB, SRV_C]) {
  if (s.includes("broker.cotal.ai")) throw new Error(`REFUSING: ${s} is the live broker`);
  if (!/^nats:\/\/127\.0\.0\.1:/.test(s)) throw new Error(`REFUSING: ${s} is not loopback`);
}
console.log(`[safety] targets ${SRV_AB} + ${SRV_C} — asserted not broker.cotal.ai, loopback only`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (p: ReturnType<typeof spawn>, ms = 3000): Promise<void> =>
  new Promise((res) => {
    if (p.exitCode !== null || p.signalCode !== null) return res();
    p.once("exit", () => res());
    setTimeout(res, ms);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** Can this cred CONNECT to this server at all? The cross-broker fence is a connect-time fence. */
async function tryConnect(servers: string, creds: string, id: string): Promise<"connected" | "refused"> {
  try {
    const nc = await connect({
      servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0,
    });
    await nc.drain().catch(() => {});
    return "connected";
  } catch {
    return "refused";
  }
}

/** Subscribe with a scoped cred; "denied" on a permission/authorization violation. */
async function trySubscribe(servers: string, creds: string, id: string, subject: string, graceMs = 400) {
  let nc;
  try {
    nc = await connect({
      servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0,
    });
  } catch {
    // WAS: `return "denied"` — "could not even connect ⇒ certainly cannot subscribe". True, and
    // still the MX13 defect: it lets a NON-permission failure satisfy a cell that claims a
    // permission fence. MX13 killed exactly this shape on E18, where a missing-stream error stood
    // in for the deleted ACL and the cell stayed green. C1/C2 make it residual here rather than
    // active — they prove this cred connects and subscribes on this broker — but a control that
    // holds globally does not exclude a transient failure inside one cell. Reported distinctly so
    // a substitution is loud instead of silent.
    return "unreachable" as const;
  }
  let denied = false;
  void (async () => {
    for await (const s of nc.status()) {
      const blob = `${(s as any).type ?? ""} ${(s as any).data ?? ""}`;
      if (/permission|authorization/i.test(blob)) denied = true;
    }
  })().catch(() => {});
  const sub = nc.subscribe(subject, { callback: (err) => { if (err) denied = true; } });
  // Same correction: a flush that fails for ANY reason used to set `denied`, so a dropped socket
  // read as a permission fence. Tracked apart.
  let unreachable = false;
  await nc.flush().catch(() => { unreachable = true; });
  await wait(graceMs);
  try { sub.unsubscribe(); } catch { /* ignore */ }
  await nc.drain().catch(() => {});
  // `denied` wins over `unreachable`: a permission violation observed on the status stream is a
  // POSITIVE observation of the fence, and it commonly arrives alongside a torn-down connection.
  // Only an unreachable arm with NO permission evidence is reported as unreachable.
  if (denied) return "denied" as const;
  return unreachable ? ("unreachable" as const) : ("allowed" as const);
}

const spaceA = `fence-a-${randomUUID().slice(0, 8)}`;
const spaceB = `fence-b-${randomUUID().slice(0, 8)}`;
const spaceC = `fence-c-${randomUUID().slice(0, 8)}`;

// Broker AB trusts spaces A and B (same operator). Broker C trusts only C — a FOREIGN operator.
const authA = await createSpaceAuth(spaceA);
// Space B is a SECOND space account signed by the SAME broker operator — the realistic "another
// space on the broker I am already connected to" that a re-target would aim at.
const authB = composeSpaceAuth(authA, await createSpaceAccountAuth(authA, spaceB));
const authC = await createSpaceAuth(spaceC); // an independent broker: a FOREIGN operator

const dir = mkdtempSync(join(tmpdir(), "meshctl-m3-"));
writeFileSync(join(dir, "ab.conf"), serverConfig(authA, [authA, authB], { transport: { kind: "plaintext" }, port: PORT_AB, storeDir: join(dir, "js-ab") }));
writeFileSync(join(dir, "c.conf"), serverConfig(authC, [authC], { transport: { kind: "plaintext" }, port: PORT_C, storeDir: join(dir, "js-c") }));
const srvAB = spawn("nats-server", ["-c", join(dir, "ab.conf")], { stdio: "ignore" });
const srvC = spawn("nats-server", ["-c", join(dir, "c.conf")], { stdio: "ignore" });

const noop = {
  commitAcl: async () => {}, reissueAcl: async () => {}, provisionDmInbox: async () => {},
  provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {},
};

try {
  for (const s of [SRV_AB, SRV_C]) {
    let up = false;
    for (let i = 0; i < 50; i++) { if (await isReachable(s)) { up = true; break; } await wait(200); }
    if (!up) throw new Error(`nats-server did not come up on ${s}`);
  }
  await setupSpaceStreams({ servers: SRV_AB, space: spaceA, creds: await mintCreds(authA, newIdentity(), "provisioner") });
  await setupSpaceStreams({ servers: SRV_AB, space: spaceB, creds: await mintCreds(authB, newIdentity(), "provisioner") });

  // The agent as it actually exists: read ACL = ["general"] in space A only.
  const a = newIdentity();
  const aCreds = await provisionAgent(noop, authA, a, {
    subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: mintLifecycleUid(),
  });

  console.log("\n--- INVERSE CONTROLS (these must PASS, or every denial below is a broken probe) ---");
  check("C1: agent-A cred subscribes its OWN in-ACL channel in space A — ALLOWED",
    (await trySubscribe(SRV_AB, aCreds, a.id, chatSubject(spaceA, "*", "*", "general"))) === "allowed");
  check("C2: agent-A cred CONNECTS to the broker that trusts its account — CONNECTED",
    (await tryConnect(SRV_AB, aCreds, a.id)) === "connected");

  console.log("\n--- F1: CROSS-SPACE re-target on the SAME broker ---");
  check("F1a: agent-A cred → space B's chat.*.general — DENIED",
    (await trySubscribe(SRV_AB, aCreds, a.id, chatSubject(spaceB, "*", "*", "general"))) === "denied");
  check("F1b: agent-A cred → space B's whole-space wildcard — DENIED",
    (await trySubscribe(SRV_AB, aCreds, a.id, `${spacePrefix(spaceB)}.>`)) === "denied");
  check("F1c: agent-A cred → its OWN space's firehose wildcard — DENIED",
    (await trySubscribe(SRV_AB, aCreds, a.id, `${spacePrefix(spaceA)}.>`)) === "denied");
  check("F1d: agent-A cred → an out-of-ACL channel in its OWN space — DENIED",
    (await trySubscribe(SRV_AB, aCreds, a.id, chatSubject(spaceA, "*", "*", "secret"))) === "denied");

  console.log("\n--- F2: CROSS-BROKER re-target (foreign operator) ---");
  check("F2: agent-A cred → broker C (does not trust its account) — CONNECT REFUSED",
    (await tryConnect(SRV_C, aCreds, a.id)) === "refused");

  console.log("\n--- F3: does the on-disk MINT path grant more than the agent holds? ---");
  // This is the escalation question. `mintCreds(SpaceAuth, …)` needs the space trust material —
  // the same material a workspace-layer self-connect would reach for. If an agent process can read
  // it, the mint, not the connect verb, is the authority.
  // F1d established that agent-A is DENIED chat.*.secret. If the same on-disk SpaceAuth can mint a
  // SECOND agent cred that names `secret` in its own allowSubscribe, then the ACL is chosen at MINT
  // time by whoever holds the trust material — and a self-connect that reaches the mint would be a
  // real escalation. Same broker, same subject, same probe as F1d: only the mint differs.
  const selfMinted = newIdentity();
  const wideCreds = await provisionAgent(noop, authA, selfMinted, {
    subscribe: ["secret"], allowSubscribe: ["secret"], lifecycleUid: mintLifecycleUid(),
  });
  const wideReach = await trySubscribe(SRV_AB, wideCreds, selfMinted.id, chatSubject(spaceA, "*", "*", "secret"));
  check("F3: a cred minted from the SAME on-disk SpaceAuth with a SELF-CHOSEN ACL reaches chat.*.secret, which agent-A was DENIED at F1d — the ACL is decided at MINT time, so the trust material IS the authority",
    wideReach === "allowed", `got ${wideReach}`);

  // And the corroborating negative: `provisioner` is genuinely least-privilege — it is NOT a
  // god-cred. Recording this so the design never treats "mint a provisioner" as a shortcut.
  const provCreds = await mintCreds(authA, newIdentity(), "provisioner");
  const provReach = await trySubscribe(SRV_AB, provCreds, "prov-probe", `${spacePrefix(spaceA)}.>`);
  check("F3b: a `provisioner` cred is still DENIED the space firehose — least-privilege holds; escalation comes from a chosen ACL, not from a privileged role name",
    provReach === "denied", `got ${provReach}`);

  console.log(`\nM3 FENCE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message, (e as Error).stack);
  process.exitCode = 1;
} finally {
  srvAB.kill("SIGKILL"); srvC.kill("SIGKILL");
  await awaitExit(srvAB); await awaitExit(srvC);
  rmSync(dir, { recursive: true, force: true });
  console.log("[cleanup] brokers exited, scratch removed");
}
