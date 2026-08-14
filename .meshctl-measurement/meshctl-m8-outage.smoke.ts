/**
 * M8: is a permission denial actually INDISTINGUISHABLE from a broker outage at the call site?
 *
 * WHY THIS EXISTS. `.meshctl-measurement/DESIGN-route-refusal.md` §0 bullet 3 and §0a both say the
 * caller's denial text "is not something a caller can distinguish from a broker outage". **I have
 * the denial string (E13) and I have never had the outage string, so that sentence is an argument
 * wearing a measurement's clothes.** It is currently marked as reasoning in the note; this probe
 * either promotes it to measured or strikes it.
 *
 * WHAT WOULD REFUTE ME, STATED BEFORE ANY RESULT IS CITED. The honest prior runs AGAINST my claim:
 * `isPublishPermissionDenied` (endpoint.ts:4552) exists precisely because a typed denial carries an
 * `operation` an outage error cannot, so the two may well be separable — the open question is only
 * whether the RENDERED TEXT a tool caller receives preserves that difference.
 *   REFUTED if the two texts differ in a way a caller could branch on (a named condition, a
 *     distinct error class, anything but incidental wording). Then I strike the claim from the note.
 *   HELD only if a caller receiving one text could not tell which condition produced it.
 * I would rather refute myself here than confirm myself.
 *
 * ⚠️ THE PUBLISH PATH IS PINNED, NOT ASSUMED (the hazard fm-meshctl-2 raised, and it decides
 * whether the arms CAN differ). A *core* publish is fire-and-forget into a local buffer: with the
 * connection down the client accepts it, queues it, and the caller is told NOTHING — an absent
 * string is not a comparison. Verified in source instead: `agent.send` → `ep.multicast` →
 * `publishMsg` (`packages/core/src/endpoint.ts:2541`) → `await this.js.publish(...)`, a JetStream
 * publish that awaits a PubAck. **So this arm exercises the awaited path and a dead broker must
 * produce something.** Re-verify this citation if `publishMsg` changes.
 *
 * ⚠️ FOUR OUTCOMES, SCORED BEFORE THE RUN so silence cannot be scored to suit the sentence already
 * in the note — and the sentence is mine:
 *   1. an error naming an OUTAGE/reconnect condition  -> REFUTES the claim. Strike it from the note.
 *      Note `notLiveMsg()` (`endpoint.ts:2535`) returns "reconnecting - try again shortly", which
 *      names a condition AND a next action, i.e. the opposite of indistinguishable.
 *   2. an error naming a PERMISSION condition         -> HOLDS the claim. Implausible; recorded if seen.
 *   3. NO ANSWER (hang)                               -> a THIRD outcome, scored as DISTINGUISHABLE:
 *      a caller left waiting is in a different state than one handed a refusal. Not a pass, not a
 *      failure string, counted in its own column.
 *   4. SILENT SUCCESS (resolves without error)        -> REFUTES the claim and is a WORSE defect
 *      than the one under investigation: the caller is told it sent when nothing was stored.
 *
 * INVERSE CONTROLS — without these neither arm means anything:
 *   C1 the seat CAN publish in-ACL while the broker is up. Without it, the outage arm's failure is
 *      equally explained by "this seat could never publish", and the comparison is between two
 *      denials rather than a denial and an outage.
 *   C2 the broker is actually DOWN before the outage arm runs (asserted via isReachable, not via
 *      "we sent a signal"). A signal that missed would produce a live-broker result labelled outage.
 *
 * A HANG IS NOT A PASS. Both failure arms are raced against a timeout and a timeout is reported as
 * its own outcome, because "no answer" and "an answer I can act on" are different results and
 * counting a hang as a failure-string would fabricate one.
 *
 * REAL ENTRY POINT: `cotalToolSpecs(...).run(...)` — the same call `registerCotalTools` makes.
 * Not `agent.send`, not `ep.multicast`.
 *
 * ✅ RUN STAMP: driven `Fri Aug 14 10:24:53 PM UTC 2026` at tip `8c9c57f3`, under an exclusivity ack,
 * against an ephemeral loopback broker on port 37827. **5 passed / 0 failed / 0 hung, rc=0.**
 *   DENIAL : Couldn't send: Permissions Violation for Publish to "cotal.<space>.chat.local.<uid>.secret"
 *   OUTAGE : Couldn't send: timeout
 * **PRE-DECLARED OUTCOME 1 — the author's own claim is REFUTED and struck from the design note.**
 * (Committed UNRUN at `2a318c4f` with all four outcomes fixed in advance, so nothing here was
 * back-fitted to the result. The pre-registration was right about the direction and wrong about the
 * mechanism: the expected string was `notLiveMsg()`'s "reconnecting - try again shortly"; the actual
 * one is a bare `timeout`.)
 *
 * Run: tsx .meshctl-measurement/meshctl-m8-outage.smoke.ts   (needs nats-server on PATH; local only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams,
} from "../packages/core/src/index.js";
import { pickFreePort } from "../packages/core/smoke/_free-port.js";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
// FIRST ACTION, before anything is created: assert we are not pointed at the live broker.
if (/broker\.cotal\.ai/i.test(SERVERS)) throw new Error(`REFUSING: target is the live broker: ${SERVERS}`);
if (!/^nats:\/\/127\.0\.0\.1:/.test(SERVERS)) throw new Error(`REFUSING: target is not loopback: ${SERVERS}`);
console.log(`[safety] target=${SERVERS} — asserted not broker.cotal.ai, loopback only; inherited COTAL_* deleted`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, timedOut = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
/** Race a tool call against a bound. A timeout is its own outcome, never a pass and never a string. */
const bounded = async (label: string, p: any, ms = 20000): Promise<any | { HUNG: true }> => {
  const r = await Promise.race([Promise.resolve(p).catch((e) => ({ text: `THREW: ${(e as Error).message}`, isError: true })),
                                wait(ms).then(() => ({ HUNG: true as const }))]);
  if ((r as any)?.HUNG) { timedOut++; console.log(`  ⏱ ${label}: NO ANSWER within ${ms}ms — reported as a hang, not as a failure string`); }
  return r;
};

const space = `meshctl-m8-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "meshctl-m8-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
}));
// `detached` so the whole process GROUP can be signalled: a spawn() pid on a wrapper command is not
// the daemon's pid, and this probe's entire result depends on the broker actually being dead.
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore", detached: true });
let killed = false;
const killGroup = () => {
  if (killed || srv.pid === undefined) return;
  killed = true;
  try { process.kill(-srv.pid, "SIGKILL"); } catch { try { srv.kill("SIGKILL"); } catch { /* already gone */ } }
};

let denial = "", outage = "";
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgrEp = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  await mgrEp.start();

  const subId = newIdentity();
  const subUid = mintLifecycleUid();
  // `role` is load-bearing: without it no TASK queue is provisioned and the endpoint spins on a
  // permissions violation that has nothing to do with what this probe measures.
  const subCreds = await provisionAgent(mgrEp, auth, subId, {
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
    lifecycleUid: subUid, role: "worker",
  });
  const cfg: any = {
    space, name: "outage-subject", role: "worker", kind: "agent", servers: SERVERS,
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
    id: subId.id, creds: subCreds, lifecycleUid: subUid, capabilities: ["connection"],
  };
  const { MeshAgent } = await import("../extensions/connector-core/src/agent.js");
  const { cotalToolSpecs } = await import("../extensions/connector-core/src/tool-specs.js");
  const S = new MeshAgent(cfg);
  S.start(300);
  for (let i = 0; i < 90 && !S.connected; i++) await wait(150);
  check("M8-0 PRECONDITION: the authed seat connected with a real minted credential", S.connected, { connected: S.connected });

  const specs = cotalToolSpecs(cfg, "smoke");
  const sendSpec = specs.find((s: any) => s.name === "cotal_send");
  if (!sendSpec) throw new Error("fixture failed: cotal_send absent from the surface");
  const send = (args: any) => sendSpec.run(S, cfg, args);

  // C1 — the inverse control that makes the outage arm mean anything.
  const inAcl = await bounded("C1", send({ text: "M8-IN-ACL-LIVE", channel: "general" }));
  check("M8-C1 CONTROL: the seat CAN publish in-ACL while the broker is up — so a later failure is not 'this seat never could'",
    inAcl?.isError !== true, inAcl?.text);

  // ARM A — the denial, re-captured in THIS run so the comparison is like-for-like, not across runs.
  const denied = await bounded("A", send({ text: "M8-OUT-OF-ACL", channel: "secret" }));
  denial = String(denied?.text ?? "");
  check("M8-A the out-of-ACL post is refused (isError) rather than silently accepted", denied?.isError === true, denial);

  // Take the broker down, then PROVE it is down before attributing anything to an outage.
  killGroup();
  let down = false;
  for (let i = 0; i < 60; i++) { if (!(await isReachable(SERVERS))) { down = true; break; } await wait(200); }
  check("M8-C2 CONTROL: the broker is actually unreachable before the outage arm runs (asserted, not assumed from sending a signal)",
    down, { reachable: !down });

  // ARM B — the outage, on the seat's OWN in-ACL channel, so the only changed variable is the broker.
  const out = await bounded("B", send({ text: "M8-IN-ACL-DEAD", channel: "general" }));
  const hung = (out as any)?.HUNG === true;
  outage = hung ? "<NO ANSWER — hung>" : String((out as any)?.text ?? "");
  // Outcome 4 is the one that must never be scored as "well, it didn't error, so they differ".
  const silentSuccess = !hung && (out as any)?.isError !== true;
  check("M8-B the in-ACL post against a dead broker is NOT silently accepted — the caller is not told it sent when nothing was stored",
    !silentSuccess, { silentSuccess, outage });
  if (silentSuccess)
    console.log(`  ⚠ OUTCOME 4 (pre-declared): SILENT SUCCESS against a dead broker. This refutes the\n` +
                `    claim AND is a worse defect than the one under investigation.`);

  // ---- The comparison. RECORDED, and the discriminability computed rather than eyeballed. ----
  const names = (s: string) => ({
    permissionWord: /permission|violation|denied|not allowed|acl/i.test(s),
    outageWord: /timeout|timed out|no responders|disconnect|connection|unreachable|closed/i.test(s),
  });
  const dn = names(denial), on = names(outage);
  console.log("\n  ▸ RECORDED — the two strings a caller actually receives:");
  console.log(`      DENIAL : ${JSON.stringify(denial.slice(0, 240))}`);
  console.log(`      OUTAGE : ${JSON.stringify(outage.slice(0, 240))}`);
  console.log(`      identical: ${denial === outage}`);
  console.log(`      denial names a permission condition: ${dn.permissionWord} | names an outage condition: ${dn.outageWord}`);
  console.log(`      outage names a permission condition: ${on.permissionWord} | names an outage condition: ${on.outageWord}`);
  // Map onto the four pre-declared outcomes rather than inventing a rule now that results exist.
  const outcome = hung ? 3
    : silentSuccess ? 4
    : on.permissionWord && !on.outageWord ? 2
    : 1;
  const separable = outcome !== 2 && (denial !== outage);
  console.log(`\n  ▸ PRE-DECLARED OUTCOME: ${outcome} — ${
    outcome === 1 ? "error naming an OUTAGE/reconnect condition"
    : outcome === 2 ? "error naming a PERMISSION condition"
    : outcome === 3 ? "NO ANSWER (hang)"
    : "SILENT SUCCESS"}`);
  console.log(`  ▸ VERDICT ON MY OWN CLAIM ("indistinguishable from a broker outage"):`);
  console.log(separable
    ? `      REFUTED — the two are separable by a caller (outcome ${outcome}).\n` +
      `      The note's sentence must be STRUCK, not softened.`
    : `      HELD — a caller receiving one text could not tell which condition produced it.`);
} finally {
  killGroup();
  await new Promise((res) => { if (srv.exitCode !== null || srv.signalCode !== null) return res(undefined);
                               srv.once("exit", () => res(undefined)); setTimeout(() => res(undefined), 3000); });
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nM8 OUTAGE ${fail ? "FAILED ❌" : "OK ✅"}  (${pass} passed, ${fail} failed, ${timedOut} hung)`);
process.exit(fail ? 1 : 0);
