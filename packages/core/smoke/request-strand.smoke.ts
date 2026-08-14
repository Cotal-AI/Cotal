/**
 * In-flight request strand smoke. A request/reply call carries its reply subscription AND its
 * timeout timer on the connection it was issued on (`noMux` + an explicit reply subject). A rebuild
 * drains that connection, so before this guard the caller's promise settled NEVER: not the reply,
 * not even its own timeout. A caller that hangs forever is worse than one that fails, because it
 * cannot report which way it went.
 *
 * Asserts the guard: an in-flight request is SETTLED (rejected) when the connection is rebuilt or
 * stopped underneath it, with a message that says the request was published and its outcome is
 * unknown — never that it did not happen.
 *
 * The bound is the assertion. A hang is not an observation; a hang with a stated bound is. Each
 * arm races the request against a watchdog set well past the request's own deadline, so "never
 * settled" is a measured result rather than an inference from a wedged process.
 *
 * Run: pnpm smoke:request-strand   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { CotalEndpoint, isReachable, spacePrefix } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes("broker.cotal.ai")) throw new Error("REFUSING: live broker");
if (!/^nats:\/\/127\.0\.0\.1:/.test(SERVERS)) throw new Error("REFUSING: not loopback");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (p: ReturnType<typeof spawn>, ms = 3000): Promise<void> =>
  new Promise((res) => {
    if (p.exitCode !== null || p.signalCode !== null) return res();
    p.once("exit", () => res()); setTimeout(res, ms);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** Race a call against a watchdog. `"stranded"` means it never settled inside the bound. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ state: "resolved" | "rejected" | "stranded"; error?: Error }> {
  const tag = Symbol("watchdog");
  const r = await Promise.race([
    p.then(() => ({ state: "resolved" as const }), (e: Error) => ({ state: "rejected" as const, error: e })),
    wait(ms).then(() => tag),
  ]);
  return r === tag ? { state: "stranded" } : (r as { state: "resolved" | "rejected"; error?: Error });
}

const space = `req-strand-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-reqstrand-"));
writeFileSync(join(dir, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${dir}/js" }\n`);
const srv = spawn("nats-server", ["-c", join(dir, "nats.conf")], { stdio: "ignore" });

let ep: CotalEndpoint | undefined;
let responder: Awaited<ReturnType<typeof connect>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  ep = new CotalEndpoint({
    space, servers: SERVERS,
    card: { name: "caller", kind: "agent" },
    channels: ["general"],
  });
  await ep.start();

  // A responder scoped to THIS control service only. `ctl.delivery.<...>` shares the `ctl.`
  // namespace, so a `cotal.>` responder would answer the endpoint's own Plane-3 probes and wedge it.
  const svcSubject = `${spacePrefix(space)}.ctl.strandprobe.>`;
  responder = await connect({ servers: SERVERS });
  let replyDelayMs = 0;
  void (async () => {
    const sub = responder!.subscribe(svcSubject);
    for await (const m of sub) {
      if (!m.reply) continue;
      const d = replyDelayMs;
      void (async () => { await wait(d); try { m.respond(JSON.stringify({ ok: true })); } catch { /* gone */ } })();
    }
  })().catch(() => {});
  await wait(200);

  // ---- CONTROL: the identical call, uninterrupted, must resolve. Without this arm a rejection
  //      below would prove only that the probe's responder is broken.
  replyDelayMs = 300;
  const control = await settleWithin(ep.requestControl("strandprobe", { op: "noop" }, 5000), 8000);
  check("CONTROL: an uninterrupted request resolves through the same path", control.state === "resolved", control);

  // ---- ARM 1: rebuild the connection mid-flight.
  replyDelayMs = 4000; // outlives the rebuild, so only the guard can settle this
  const inFlight = ep.requestControl("strandprobe", { op: "noop" }, 5000);
  const settled = settleWithin(inFlight, 20000); // 4x the request's own deadline
  await wait(300);
  await ep.reconnect();
  const r1 = await settled;
  check("a request in flight across a REBUILD is settled, not stranded", r1.state !== "stranded", r1.state);
  check("it REJECTS (a caller gets a failure it can act on)", r1.state === "rejected", r1);
  check("the refusal names the connection rebuild as the cause",
    /connection was rebuilt/i.test(r1.error?.message ?? ""), r1.error?.message);
  check("it does NOT claim the request never happened - the outcome is reported as UNKNOWN",
    /outcome is UNKNOWN/i.test(r1.error?.message ?? "") && /WAS published/i.test(r1.error?.message ?? ""),
    r1.error?.message);

  // ---- ARM 2: stop the endpoint mid-flight.
  const inFlight2 = ep.requestControl("strandprobe", { op: "noop" }, 5000);
  const settled2 = settleWithin(inFlight2, 20000);
  await wait(300);
  await ep.stop();
  const r2 = await settled2;
  check("a request in flight across a STOP is settled, not stranded", r2.state !== "stranded", r2.state);
  check("the stop refusal names the stop as the cause",
    /connection was stopped/i.test(r2.error?.message ?? ""), r2.error?.message);
  ep = undefined;

  console.log(`\nREQUEST-STRAND SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await ep?.stop(); } catch { /* ignore */ }
  try { await responder?.drain(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
