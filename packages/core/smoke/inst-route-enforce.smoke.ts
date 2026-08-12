/**
 * B6 enforcement: does the BROKER honour the exact instance pin, and refuse it when unpinned?
 *
 * `inst-route-grant` proves what we MINT. This proves what is ENFORCED, and they are different
 * claims: a minted row is a statement about a credential, a broker verdict is a statement about the
 * wire. The mint suite would stay green if every row we issue were ignored.
 *
 * THE DISCRIMINATOR IS ONE MINT INPUT, NOT TWO PROFILES. The same profile is minted twice in the
 * same run against the same broker - once with the resolved `instanceId` pin and once without - and
 * the instance route must flip from refused to accepted. Comparing two different profiles would
 * confound the pin with everything else that differs between them; comparing one profile against
 * itself isolates the thing C actually changed.
 *
 * THE SHAPE IS BORROWED AND SO IS THE CLASSIFIER, from a probe cs-lane-session executed and then
 * published a defect in. Both are load-bearing:
 *
 *   - Take a REAL row out of `permissionsFor` for this principal, substitute only the trailing nonce
 *     wildcard, and publish it as the CONTROL. Then rewrite ONLY the route segment and publish that.
 *     Same credential, same run, one token different.
 *   - THREE outcomes, never two. Folding every non-permission error into "allowed" silently counts a
 *     TIMEOUT as success, and the control arm is the one that asserts success - so under load the
 *     fixture passes while measuring nothing. An instrument that fails toward the answer you expect
 *     is the worst kind.
 *
 * WHAT IS DELIBERATELY NOT BORROWED: its connect. It hand-rolls `inboxPrefix` from `identity.id`,
 * which equals `idFromCreds(creds)` only by a coincidence of the current cred shape - its own author
 * retracted that publicly. A scoped grant allows only `_INBOX_<connId>.>`, so a drifted prefix gets
 * the ALLOWED arm refused on its SUBSCRIPTION and poisons the CONTROL rather than the claim, which
 * reads as a green denied arm. `standaloneConnectOpts` derives it from the credential and cannot
 * drift. The fixture also asserts its own broker first: being pointed elsewhere is observationally
 * identical to being refused.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:inst-route-enforce
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, mintLifecycleUid, permissionsFor,
  standaloneConnectOpts, setupSpaceStreams, isReachable, DEV_OWNER, BASELINE_LIFECYCLE_ENDPOINT,
  type EpCapability,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `instenf-${randomUUID().slice(0, 8)}`;
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-instenf-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });

/** The broker's verdict on ONE subject under ONE credential. Three outcomes; a timeout is not one
 *  of the two arms and must never be counted as either. */
type Verdict = "allowed" | "denied" | string;
async function publishAs(creds: string, subject: string, assertPort: boolean): Promise<Verdict> {
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  try {
    if (assertPort && nc.info?.port !== PORT)
      return `void: fixture reached port ${nc.info?.port}, not its own ${PORT}`;
    await nc.request(subject, new Uint8Array(0), { timeout: 2000 });
    return "allowed"; // something answered; the broker accepted the publish
  } catch (e) {
    const m = String((e as Error).message).toLowerCase();
    if (m.includes("permission") || m.includes("authorization")) return "denied";
    if (m.includes("503") || m.includes("no responders")) return "allowed"; // ACCEPTED, nothing serving
    return `void: ${(e as Error).message}`;
  } finally {
    await nc.drain().catch(() => { /* already gone */ });
  }
}

/** A real minted row with the trailing nonce wildcard made concrete, so it is publishable. */
const concrete = (row: string) => `${row.slice(0, -1)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const rowsOf = (perms: unknown) => ((perms as { pub?: { allow?: string[] } }).pub?.allow ?? []);

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { if (await isReachable(SERVERS)) { up = true; break; } await new Promise((r) => setTimeout(r, 100)); }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // The instance a `--on` invocation resolved. C pins exactly this one at mint.
  const TARGET_IID = mintLifecycleUid();
  const pin: EpCapability[] = [{ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "ps", instanceId: TARGET_IID }];

  for (const arm of [{ name: "PINNED (what `--on` mints under C)", caps: pin, wantInst: "allowed" },
                     { name: "UNPINNED (the same profile, same run, one mint input removed)", caps: undefined, wantInst: "denied" }] as const) {
    console.log(`\nCELL - ${arm.name}`);
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await mintCreds(auth, id, "control-caller-privileged", {
      lifecycleUid: uid, ...(arm.caps ? { endpointCapabilities: arm.caps } : {}),
    });
    const rows = rowsOf(permissionsFor("control-caller-privileged", space,
      { owner: DEV_OWNER, actor: id.id, connId: id.id, lifecycleUid: uid } as never,
      { lifecycleUid: uid, ...(arm.caps ? { endpointCapabilities: arm.caps } : {}) } as never));

    // CONTROL first: a real ordinary row must be ACCEPTED. If it is not, this credential proves
    // nothing about the instance route and the arm is VOID rather than a denial.
    const oneRow = rows.find((r) => /\.ep\.one\./.test(r) && r.includes(".ps."));
    check(`${arm.name}: the fixture found a real ep.one row to use as its control`, oneRow !== undefined, rows.slice(0, 2));
    const control = await publishAs(creds, concrete(oneRow!), true);
    check(`${arm.name}: CONTROL - the ordinary route is ALLOWED (else this arm is void)`, control === "allowed", control);

    // Then the instance route: the SAME row with only its route segment rewritten.
    const instRow = rows.find((r) => r.includes(".ep.inst."))
      ?? oneRow!.replace(/\.ep\.one\./, `.ep.inst.`).replace(`.${BASELINE_LIFECYCLE_ENDPOINT}.`, `.${BASELINE_LIFECYCLE_ENDPOINT}.${TARGET_IID}.`);
    const verdict = await publishAs(creds, concrete(instRow), false);
    check(`${arm.name}: the broker ${arm.wantInst === "allowed" ? "ACCEPTS" : "REFUSES"} the instance route`,
      verdict === arm.wantInst, { verdict, want: arm.wantInst, subject: instRow.slice(0, 90) });
  }

  console.log("\nThe two arms differ in exactly one mint input, so the pin is what the broker honoured.");
} finally {
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
}

console.log(`\ninst-route-enforce: ${pass} checks passed`);
