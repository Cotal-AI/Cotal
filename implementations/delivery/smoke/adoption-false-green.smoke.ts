/**
 * REGRESSION GATE: the class-2 adoption reply must be PROOF of broker adoption, never a false green.
 *
 * `Manager.renewDaemonCreds` re-signs the daemon creds and requests `reloadCreds` on the
 * delivery-admin rail, recording the reply as `adoption.ok` — which `cotal doctor auth` renders as
 * "daemon adopted". The shipped defect this file first reproduced: that reply was built from the
 * credential the daemon FETCHED, not one the broker ACCEPTED — `swapConnectionOntoFreshCreds` awaited
 * an `nc.reconnect()` that returns immediately and swallowed any refusal, so a re-signed-but-refused
 * cred read as adopted, and for DELIVERY the forced reconnect even STRANDED the admin rail the
 * failure would have travelled on.
 *
 * THE FIX this gate locks in: the proof-of-record is a DISPOSABLE PREFLIGHT connection presenting
 * exactly the candidate, run BEFORE the live cache is touched. So a broker-refused generation is a
 * STRUCTURED per-component FAILURE (never a green), the resident connection + admin rail are never
 * disturbed, and both components are proved INDEPENDENTLY (one failing neither masks nor is masked by
 * the other). The non-material error text keeps the secret-derived generation token off the wire and
 * out of the persisted renewal record.
 *
 * TWO scenarios, one per component (the fix covers BOTH; the no-fix-without-repro rule is per
 * component):
 *   A. DELIVERY rogue, membership trusted — delivery is refused (ok:false), membership adopts.
 *   B. MEMBERSHIP rogue, delivery trusted — membership is refused (ok:false), delivery adopts. The
 *      feed must START on a trusted cred first, or it is absent (a different defect, different fix).
 *
 * Each scenario gets its OWN broker, space, staged root, and daemon process. Sharing a space is not
 * an option: the delivery lease is per shard, so a second daemon in the same space refuses to bind.
 * Full isolation also keeps a broken connection in one scenario from contaminating the other.
 *
 * History: this began as the defect-POSITIVE repro (the false green reproduced on a real rail,
 * 14/14). With the fix in, the assertions are inverted — it now fails loudly if a rejected generation
 * is ever reported adopted, if one component's failure hides the other, if the rail self-strands, or
 * if a digest leaks.
 *
 * NOTE: runs the BUILT dist — `pnpm build` first.
 * Run: pnpm exec tsx implementations/delivery/smoke/adoption-false-green.smoke.ts
 *      (needs `nats-server` on PATH; local-only; ~60s)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  createSpaceAuth,
  isReachable,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cotalJs = join(repoRoot, "bin", "dist", "cotal.js");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const until = async (cond: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
async function adminReq(ep: CotalEndpoint): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  let last: Error | undefined;
  for (let i = 0; i < 12; i++) {
    try { return await ep.requestDeliveryAdmin("reloadCreds", {}, 15_000); }
    catch (e) { last = e as Error; await wait(500); }
  }
  throw last ?? new Error("adminReq: no attempts ran");
}

const cleanups: Array<() => void> = [];

/** A fully isolated rail: its own broker, space, staged root, daemon, and renewal-owner endpoint. */
async function scenario(tag: string, rogueComponent: "delivery" | "membership"): Promise<void> {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const space = `adopt-fg-${tag}-${randomUUID().slice(0, 8)}`;
  const auth = await createSpaceAuth(space);
  // The ROGUE signer: a second, structurally valid space auth whose operator is NOT in this
  // broker's server.conf, so anything it signs is refused here. Same shape, untrusted chain.
  const rogue = await createSpaceAuth(space);
  const obsCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());

  const dir = mkdtempSync(join(tmpdir(), `cotal-adopt-fg-${tag}-`));
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port, storeDir: join(dir, "js") }));
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  cleanups.push(() => { srv.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });

  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root = mkdtempSync(join(tmpdir(), `cotal-adopt-fg-${tag}-root-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const credsPath = join(root, ".cotal", "delivery.creds");
  const rwPath = join(root, ".cotal", "membership-rw.creds");
  const dlvId = newIdentity();
  const rwId = newIdentity();
  // Long windows: this repro is about the EXPLICIT path, so no 75% backstop fires mid-run and
  // confuses attribution.
  writeFileSync(credsPath, await mintCreds(auth, dlvId, "delivery", { expiresInSeconds: 600 }), { mode: 0o600 });
  writeFileSync(rwPath, await mintCreds(auth, rwId, "membership-rw", { expiresInSeconds: 600 }), { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership-observer.creds"), obsCreds, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "connection-evictor.creds"), evictorCreds, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership.json"), JSON.stringify({ accountId: auth.account.pub }), { mode: 0o600 });

  let out = "";
  const daemon = spawn(process.execPath, [cotalJs, "deliver", "--space", space, "--server", servers, "--creds", credsPath], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" },
  });
  daemon.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  daemon.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
  cleanups.push(() => { daemon.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });

  check(`${tag}: daemon boots on the trusted delivery cred`, await until(() => out.includes("delivery daemon up"), 15_000), out.slice(-500));
  // The feed MUST come up trusted first. Starting it rogue would leave it absent, which is the
  // DIFFERENT absent-feed defect and would prove nothing about adoption.
  check(`${tag}: membership feed starts trusted (so this is not the absent-feed defect)`, await until(() => out.includes("membership feed up"), 12_000), out.slice(-500));

  const supId = newIdentity();
  const sup = new CotalEndpoint({
    space, servers,
    creds: await mintCreds(auth, supId, "supervisor"),
    card: { id: supId.id, name: "renewal-owner", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  sup.on("error", () => {});
  await sup.start();
  cleanups.push(() => { void sup.stop?.(); });

  // Control, COMPONENT-SPECIFIC: a genuine re-sign by the TRUSTED signer on the SAME component
  // that is about to go rogue. This proves that component's path accepts a good CHANGED
  // generation, so the later green cannot be dismissed as "this harness always sees ok" and,
  // more importantly, cannot be explained by that component's path being inert.
  if (rogueComponent === "delivery")
    writeFileSync(credsPath, await mintCreds(auth, dlvId, "delivery", { expiresInSeconds: 600 }), { mode: 0o600 });
  else
    writeFileSync(rwPath, await mintCreds(auth, rwId, "membership-rw", { expiresInSeconds: 600 }), { mode: 0o600 });
  const good = await adminReq(sup);
  check(`${tag}: control - a trusted ${rogueComponent} re-sign replies ok`, good.ok === true, JSON.stringify(good));
  const mark = out.length;

  // THE REPRO. Same nkey subject, signed by the untrusted operator: the file genuinely changed,
  // so the "still holds the previous cred" guard cannot see it, but the broker will refuse it.
  if (rogueComponent === "delivery")
    writeFileSync(credsPath, await mintCreds(rogue, dlvId, "delivery", { expiresInSeconds: 600 }), { mode: 0o600 });
  else
    writeFileSync(rwPath, await mintCreds(rogue, rwId, "membership-rw", { expiresInSeconds: 600 }), { mode: 0o600 });

  const reply = await adminReq(sup);
  console.log(`\n  [repro ${tag}] reloadCreds reply on a broker-REJECTED ${rogueComponent.toUpperCase()} credential:\n  ${JSON.stringify(reply)}\n`);

  const other = rogueComponent === "delivery" ? "membership" : "delivery";
  const data = (reply.data ?? {}) as {
    delivery?: { ok?: boolean; brokerAccepted?: { identity?: string; exp?: number }; error?: string };
    membership?: { ok?: boolean; brokerAccepted?: { identity?: string; exp?: number }; error?: string };
  };
  const rogueOut = rogueComponent === "delivery" ? data.delivery : data.membership;
  const otherOut = rogueComponent === "delivery" ? data.membership : data.delivery;
  const replyJson = JSON.stringify(reply);

  // THE GATE. A broker-refused generation is a STRUCTURED FAILURE, never a green — the disposable
  // preflight proves broker acceptance BEFORE the live cache is touched, so a refused cred fails here.
  check(`${tag} GATE: reloadCreds returns a top-level FAILURE for a ${rogueComponent} cred the broker refuses`, reply.ok === false, replyJson);
  check(`${tag} GATE: the ${rogueComponent} component is ok:false with NO brokerAccepted window`, rogueOut?.ok === false && rogueOut?.brokerAccepted === undefined, replyJson);
  check(`${tag} GATE: the failure reason names broker non-acceptance`, /did not accept/i.test(rogueOut?.error ?? ""), rogueOut?.error ?? "(no error)");
  // Non-short-circuit aggregate: the NON-rogue component is still broker-ACCEPTED INDEPENDENTLY — one
  // component's rejection neither masks nor is masked by the other.
  check(`${tag} GATE: the other component (${other}) is broker-accepted independently`, otherOut?.ok === true && typeof otherOut?.brokerAccepted?.identity === "string" && typeof otherOut?.brokerAccepted?.exp === "number", replyJson);
  // The ephemeral generation token (SHA-256 = 64 hex) must never appear anywhere in the reply.
  check(`${tag} GATE: no fingerprint digest leaks into the reply`, !/[0-9a-f]{64}/i.test(replyJson), replyJson);
  // Rail survival, now for BOTH components: preflight rejects the candidate on a disposable connection
  // BEFORE the live one is touched, so a rejected DELIVERY cred no longer strands the delivery-admin
  // responder (the pre-fix availability hazard). The rail must answer a follow-up request either way.
  let railAlive = true;
  try { await adminReq(sup); } catch { railAlive = false; }
  check(`${tag} GATE: the admin rail stays up after a rejected ${rogueComponent} cred (no self-strand)`, railAlive, out.slice(mark).slice(-400));
}

try {
  console.log("\nSCENARIO A - rogue DELIVERY credential, membership left trusted");
  await scenario("A", "delivery");
  console.log("\nSCENARIO B - rogue MEMBERSHIP credential, delivery left trusted");
  await scenario("B", "membership");

  console.log(`\n${fail ? "✗" : "✓"} ADOPTION-PROOF REGRESSION GATE ${pass}/${pass + fail}`);
  if (fail) console.log("  (a FAIL means a rejected generation was reported adopted, a component was masked, the rail self-stranded, or a digest leaked - the adoption proof regressed)");
} finally {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* teardown is best-effort */ } }
  await wait(300);
}
process.exit(fail ? 1 : 0);
