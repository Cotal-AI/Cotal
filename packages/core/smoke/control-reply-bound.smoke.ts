/**
 * Bounded control-reply smoke (closure (i)) — the runtime round-trip the publish-only control-auth
 * smoke can't cover. Spins its OWN JWT-auth nats-server, stands up a manager-cred endpoint that serves
 * the lifecycle tiers with `boundReply:true` (exactly as the real supervisor does), and proves an agent
 * actually RECEIVES the reply on the sender's OWN bounded subtree (`ctl.<tier>.<caller>.reply.<uuid>`),
 * NOT the per-id `_INBOX`. This is what lets the manager cred drop its position-1 inbox publish wildcard
 * and become a self-scoped publish allow-list (proven separately in control-auth):
 *   - spawn-capable agent: requestControl(manager) AND requestControl(self) both get a bounded reply
 *     (its cred grants `ctl.manager.<id>.reply.>` + `ctl.self.<id>.reply.>`);
 *   - plain agent: requestControl(manager) is DENIED at publish (no spawn capability), requestControl(self)
 *     still round-trips (every agent gets the self-tier reply sub).
 *
 * Run: pnpm smoke:control-reply-bound   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `ctlbound-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-ctlbound-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const agent = (creds: string, id: string, name: string) =>
  new CotalEndpoint({
    space, servers: SERVERS, creds, card: { id, name, kind: "agent" },
    consume: false, registerPresence: false, watchPresence: false,
  });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // The supervisor stand-in: serve the lifecycle tiers with bounded replies (manager.ts does the same).
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds, card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", (e: Error) => console.error("  [mgr]", e.message));
  await mgr.start();
  mgr.serveControl(CONTROL_PRIVILEGED, (req) => ({ ok: true, data: { echoed: req.op, tier: "manager" } }), { boundReply: true });
  mgr.serveControl(CONTROL_SELF_SERVICE, (req) => ({ ok: true, data: { echoed: req.op, tier: "self" } }), { boundReply: true });
  await wait(200);

  // Spawn-capable agent: may call BOTH the privileged and self tiers.
  const capId = newIdentity();
  const capCreds = await mintCreds(auth, capId, "agent", { allowSubscribe: ["general"], capabilities: ["spawn"] });
  const cap = agent(capCreds, capId.id, "cap");
  cap.on("error", (e: Error) => console.error("  [cap]", e.message));
  await cap.start();

  const r1 = await cap.requestControl(CONTROL_PRIVILEGED, { op: "ps" });
  check("spawn-capable agent: requestControl(manager) bounded reply received", r1.ok === true && (r1.data as { echoed?: string })?.echoed === "ps", r1);
  const r2 = await cap.requestControl(CONTROL_SELF_SERVICE, { op: "stop" });
  check("spawn-capable agent: requestControl(self) bounded reply received", r2.ok === true && (r2.data as { tier?: string })?.tier === "self", r2);

  // Plain agent: self tier only. The privileged request is denied at PUBLISH (no spawn capability) — the
  // request promise rejects rather than hanging on a missing reply sub.
  const plainId = newIdentity();
  const plainCreds = await mintCreds(auth, plainId, "agent", { allowSubscribe: ["general"] });
  const plain = agent(plainCreds, plainId.id, "plain");
  // EXPECTED: the privileged-tier probe below subscribes `ctl.manager.<plain>.reply.…`, which a
  // non-spawn agent lacks — the broker denies it (the whole point), surfacing as an async endpoint error.
  plain.on("error", () => {});
  await plain.start();

  let denied = false;
  try { await plain.requestControl(CONTROL_PRIVILEGED, { op: "ps" }, 1500); } catch { denied = true; }
  check("plain agent: requestControl(manager) is DENIED (no spawn capability)", denied);
  const r4 = await plain.requestControl(CONTROL_SELF_SERVICE, { op: "stop" });
  check("plain agent: requestControl(self) bounded reply received", r4.ok === true && (r4.data as { tier?: string })?.tier === "self", r4);

  await plain.stop();
  await cap.stop();
  await mgr.stop();

  console.log(`\nCONTROL-REPLY-BOUND SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
