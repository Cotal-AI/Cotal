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
/** Every cell that reached a verdict — the input to the roll call. A pass count alone cannot tell a
 *  suite that answered every question from one that died after cell N, because a cell that never ran
 *  leaves no trace to be missed. */
const ran: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown) => {
  ran.push(name);
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const DECLARED = ["RS-ctl", "RS1a", "RS1b", "RS1c", "RS1d", "RS2a", "RS2b", "RS3a", "RS3b", "RS4a", "RS4b", "RS4c"];
/** Printed from `finally`, so a run that throws still says how many of its questions it asked. */
const rollCall = () => {
  const hit = (ids: string[], n: string) => ids.some((id) => n === id || n.startsWith(`${id} `));
  const evaluated = DECLARED.filter((id) => ran.some((n) => n === id || n.startsWith(`${id} `)));
  const missing = DECLARED.filter((id) => !evaluated.includes(id));
  const undeclared = ran.filter((n) => !hit(DECLARED, n));
  console.log(`\n  ROLL CALL: ${DECLARED.length} declared — ${evaluated.length} EVALUATED, ${missing.length} NEVER RAN.`);
  if (missing.length) {
    console.log(`  ⚠ NEVER RAN — not a pass and not a failure, a question never asked: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
  if (undeclared.length) {
    console.log(`  ⚠ ${undeclared.length} cell(s) ran under an UNDECLARED name (declaration and code have drifted): ${undeclared.join(" | ")}`);
    process.exitCode = 1;
  }
  if (!missing.length && !undeclared.length) console.log(`  ✓ all ${DECLARED.length} declared cells were EVALUATED.`);
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
  check("RS-ctl CONTROL: an uninterrupted request resolves through the same path", control.state === "resolved", control);

  // ---- ARM 1: rebuild the connection mid-flight.
  replyDelayMs = 4000; // outlives the rebuild, so only the guard can settle this
  const inFlight = ep.requestControl("strandprobe", { op: "noop" }, 5000);
  const settled = settleWithin(inFlight, 20000); // 4x the request's own deadline
  await wait(300);
  await ep.reconnect();
  const r1 = await settled;
  check("RS1a a request in flight across a REBUILD is settled, not stranded", r1.state !== "stranded", r1.state);
  check("RS1b it REJECTS (a caller gets a failure it can act on)", r1.state === "rejected", r1);
  check("RS1c the refusal names the connection rebuild as the cause",
    /connection was rebuilt/i.test(r1.error?.message ?? ""), r1.error?.message);
  check("RS1d it does NOT claim the request never happened - the outcome is reported as UNKNOWN",
    /outcome is UNKNOWN/i.test(r1.error?.message ?? "") && /WAS published/i.test(r1.error?.message ?? ""),
    r1.error?.message);

  // ---- ARM 2: stop the endpoint mid-flight.
  const inFlight2 = ep.requestControl("strandprobe", { op: "noop" }, 5000);
  const settled2 = settleWithin(inFlight2, 20000);
  await wait(300);
  await ep.stop();
  const r2 = await settled2;
  check("RS2a a request in flight across a STOP is settled, not stranded", r2.state !== "stranded", r2.state);
  check("RS2b the stop refusal names the stop as the cause",
    /connection was stopped/i.test(r2.error?.message ?? ""), r2.error?.message);

  // ---- ARM 3: the hole the sweep alone left open, found by adversarial review and measured there
  // before it was measured here. Sweeping in-flight requests does NOT close ADMISSION, and stop()
  // then awaits a presence publish and a drain with `this.nc` still set — so a request issued AFTER
  // the sweep was admitted, registered a rejector nobody would ever call, and hung. Review measured
  // it unsettled at 15s against its own 8s deadline. The sweep is not the guarantee; the latch is.
  //
  // This arm races a request against the stop deliberately: it must be REFUSED at admission, and
  // the refusal must say NOTHING HAPPENED — a request that was never published is safe to retry,
  // which is the opposite advice from a stranded one whose outcome is unknown.
  const ep3 = new CotalEndpoint({ space, servers: SERVERS, card: { name: "caller-3", kind: "agent" }, channels: ["general"] });
  await ep3.start();
  const stopping = ep3.stop();
  const afterSweep = settleWithin(ep3.requestControl("strandprobe", { op: "noop" }, 8000), 15000);
  const r3 = await afterSweep;
  await stopping;
  check("RS3a a request issued DURING a stop is not stranded either", r3.state !== "stranded", r3.state);
  check("RS3b it is refused at ADMISSION, and says nothing happened (safe to retry, unlike a strand)",
    r3.state === "rejected" && /NOTHING HAPPENED/i.test(r3.error?.message ?? ""), r3.error?.message);
  ep = undefined;

  // ---- ARM 4: THE TWO FAILURES HAVE OPPOSITE REMEDIES AND USED TO BE THE SAME BARE ERROR -------
  // RS1d and RS3b above assert the two MESSAGES, and that is exactly as far as English gets you: a
  // caller cannot branch on a sentence without matching it. Both sites threw `new Error(...)` with
  // no code, no own field and no discriminant, so the ordinary
  // `try { await ep.requestControl(...) } catch { retry(); }` retried BOTH — including the one whose
  // request was already published and whose outcome is unknown, where a retry can duplicate a
  // control-plane action. Found in review, with a probe that counted two retries from that catch.
  const strandErr = r1.error as Partial<{ disposition: string }> | undefined;
  const admissionErr = r3.error as Partial<{ disposition: string }> | undefined;
  check("RS4a the STRANDED request is tagged `unknown` — it was published, so a blind retry can duplicate a control-plane action",
    strandErr?.disposition === "unknown", { disposition: strandErr?.disposition, message: r1.error?.message });
  check("RS4b the REFUSED-AT-ADMISSION request is tagged `not-published` — nothing was sent, so it is safe to retry",
    admissionErr?.disposition === "not-published", { disposition: admissionErr?.disposition, message: r3.error?.message });
  // THE CELL THAT MAKES THE FIELD LOAD-BEARING, and it asserts BOTH callers so the difference is
  // the discriminator and not the fixture. The naive arm is expected to be WRONG — it is here as
  // the control that shows the two errors are otherwise indistinguishable to a caller.
  const bothErrors = [r1.error, r3.error];
  const naiveRetries = bothErrors.filter((e) => e !== undefined).length;
  const discriminatedRetries = bothErrors.filter((e) => (e as Partial<{ disposition: string }>)?.disposition === "not-published").length;
  check("RS4c a caller branching on the tag retries exactly the safe one, where the naive `catch { retry() }` retries both",
    naiveRetries === 2 && discriminatedRetries === 1, { naiveRetries, discriminatedRetries });

  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  // Roll call BEFORE the verdict line: it can itself set a non-zero exit (a declared cell that never
  // ran), and a verdict printed first would read OK about a run it had not finished judging.
  rollCall();
  console.log(`\nREQUEST-STRAND SMOKE ${fail === 0 && !process.exitCode ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  try { await ep?.stop(); } catch { /* ignore */ }
  try { await responder?.drain(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
