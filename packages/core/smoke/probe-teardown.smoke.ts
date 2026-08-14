/** probeConnect must release the connection it never established (#389).
 *
 *  `probeConnect` exists to be pointed at addresses that may not answer, so it is the one connect
 *  site where a failed dial is the NORMAL case rather than an error. Against an address that
 *  BLACKHOLES (SYN unanswered) rather than REFUSES (RST), it used to return its correct verdict on
 *  the deadline and then leak the pending socket: `@nats-io/transport-node`'s `NodeTransport.dial()`
 *  holds the socket in a local until the handshake resolves, so `this.socket` is still undefined
 *  when the client's connect timeout fires and `transport.close()` destroys nothing. One orphaned
 *  socket per probe, freed only by the OS SYN timeout minutes later — so the PROCESS COULD NOT EXIT.
 *
 *  Two claims, proven as two separate things, because only the second was ever broken:
 *    TIMING   — the call returns inside its contract deadline. This was ALWAYS true; asserted so a
 *               fix that bought exit-cleanliness by blowing the deadline cannot pass here.
 *    RESOURCE — sockets return to baseline, and a probing process EXITS ON ITS OWN. Counted, never
 *               assumed: a leak cell that does not count is vacuous.
 *
 *  All three address classes run, because the defect was address-class dependent and a cell that
 *  only drives the broken one cannot show that. The dialable case is the inverse control: it proves
 *  the success path's teardown is real and that "no leak" is not just "no connection ever made".
 *
 *  This file NEVER touches a real deployment: every address is loopback or a non-routable literal,
 *  asserted as the first thing it does. The teardown under test must be a real socket release —
 *  an `unref`/force-exit would delete the symptom and this cell's ability to see a future hang. */
import { createConnection, createServer, type AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { probeConnect } from "../src/endpoint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFUSING = "nats://127.0.0.1:1"; // closed loopback port: answers RST
const BLACKHOLE = "nats://192.0.2.1:4222"; // RFC-5737 TEST-NET-1: non-routable by standard
const TIMEOUT_MS = 1_000;
const N = 5;

let pass = 0;
const fail: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); return; }
  fail.push(name);
  console.log(`  ✗ ${name}${detail === undefined ? "" : `\n      ${JSON.stringify(detail)}`}`);
}

// ---------------------------------------------------------------------------
// FIRST ACTION: nothing here may point at a real deployment.
// ---------------------------------------------------------------------------
for (const addr of [REFUSING, BLACKHOLE]) {
  if (!/^nats:\/\/(127\.0\.0\.1|192\.0\.2\.\d+):/.test(addr))
    throw new Error(`refusing to run: ${addr} is neither loopback nor a non-routable test literal`);
  if (/cotal\.ai/i.test(addr)) throw new Error(`refusing to run: ${addr} names a real deployment`);
}
console.log("probe-teardown (#389): targets are loopback / RFC-5737 only\n");

// ---------------------------------------------------------------------------
// Socket census. /proc/self/fd is the ground truth for a leaked handle; Node's own
// active-resource view is the second witness, so a leak has to hide from both.
// ---------------------------------------------------------------------------
const socketFds = (): number[] => {
  const out: number[] = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    try { if (readlinkSync(`/proc/self/fd/${fd}`).startsWith("socket:")) out.push(Number(fd)); }
    catch { /* closed under us mid-scan */ }
  }
  return out;
};
const census = () => ({
  sockets: socketFds().length,
  handles: process.getActiveResourcesInfo().filter((r) => /socket|tcp/i.test(r)).length,
});
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// PRECONDITION — the blackhole literal must really blackhole HERE.
// If this environment answers 192.0.2.1 with an ICMP unreachable, the address REFUSES, the socket
// dies on its own, and every assertion below would pass without exercising the defect at all. That
// is the vacuous-green shape this whole file exists to prevent, so it is a hard failure, never a
// skip: a cell that quietly stops testing is worse than one that is absent.
// ---------------------------------------------------------------------------
const rawDialOutcome = (host: string, port: number, ms: number) =>
  new Promise<string>((resolve) => {
    const s = createConnection({ host, port });
    const done = (o: string) => { try { s.destroy(); } catch { /* gone */ } resolve(o); };
    s.setTimeout(ms);
    s.on("connect", () => done("connected"));
    s.on("timeout", () => done("blackhole"));
    s.on("error", (e: NodeJS.ErrnoException) => done(`error:${e.code}`));
  });

console.log("the fixtures are the classes this file claims they are");
check("the blackhole literal really blackholes on this box (else every check below is vacuous)",
  (await rawDialOutcome("192.0.2.1", 4222, 2_000)) === "blackhole");
check("the refusing literal really refuses (ECONNREFUSED, not a silent drop)",
  (await rawDialOutcome("127.0.0.1", 1, 2_000)) === "error:ECONNREFUSED");
if (fail.length) { console.log("\nfixture preconditions failed — the rest would prove nothing"); process.exit(1); }

// ---------------------------------------------------------------------------
// A dialable broker, for the inverse control. Own scratch dir; the pid is recorded AT CREATION and
// is the only pid this file will ever signal.
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "cotal-probe-teardown-"));
const port = await new Promise<number>((resolve) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const { port: p } = srv.address() as AddressInfo;
    srv.close(() => resolve(p)); // released before nats-server binds it
  });
});
const DIALABLE = `nats://127.0.0.1:${port}`;
writeFileSync(join(scratch, "nats.conf"),
  `host: "127.0.0.1"\nport: ${port}\nstore_dir: "${join(scratch, "store")}"\njetstream: enabled\n`);
const broker = spawn("nats-server", ["-c", join(scratch, "nats.conf")], { stdio: "ignore" });
const BROKER_PID = broker.pid!;

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = (await rawDialOutcome("127.0.0.1", port, 200)) === "connected";
    if (!up) await settle(100);
  }
  if (!up) throw new Error("the inverse-control broker never came up");

  // -------------------------------------------------------------------------
  // TIMING + RESOURCE, per address class, in one pass.
  // -------------------------------------------------------------------------
  for (const [label, addr, wantOk] of [
    ["refusing", REFUSING, false],
    ["dialable (INVERSE CONTROL)", DIALABLE, true],
    ["blackholing", BLACKHOLE, false],
  ] as const) {
    console.log(`\n${label}: ${addr}`);
    await settle();
    const before = census();
    const results: string[] = [];
    const started = Date.now();
    for (let i = 0; i < N; i++) {
      const r = await probeConnect(addr, { timeoutMs: TIMEOUT_MS });
      results.push(r.ok ? "ok" : r.reason);
    }
    const elapsed = Date.now() - started;
    await settle(); // a correct teardown has landed by now; a leaked socket has not
    const after = census();

    // WHICH answer — a probe that returns the wrong verdict quickly is not a fixed probe.
    check(`${label}: every probe returned ${wantOk ? "ok" : "unreachable"}`,
      results.every((r) => r === (wantOk ? "ok" : "unreachable")), results);
    // TIMING: the contract deadline was never the broken half, and must not become it.
    check(`${label}: ${N} probes finished inside ${N} deadlines (${elapsed}ms <= ${N * TIMEOUT_MS + 1500}ms)`,
      elapsed <= N * TIMEOUT_MS + 1_500, { elapsed });
    // RESOURCE: counted, both witnesses. THIS is the assertion #389 breaks.
    check(`${label}: socket fds returned to baseline after ${N} probes (leaked 0)`,
      after.sockets - before.sockets === 0, { before: before.sockets, after: after.sockets });
    check(`${label}: no live socket handles left in the loop after ${N} probes`,
      after.handles === 0, { handles: after.handles });
  }

  // -------------------------------------------------------------------------
  // THE HANG, as its own end-to-end claim. Socket counts are the mechanism; "the process could not
  // exit" was the user-visible defect, and only a real child process can show it. The child probes
  // the blackhole and then falls off the end of its script holding nothing open on purpose, so its
  // exit is a direct read of whether probeConnect released the socket. A leaked socket keeps the
  // libuv loop alive and the child has to be killed instead.
  // -------------------------------------------------------------------------
  console.log("\nthe hang itself: a probing process exits on its own");
  const child = spawnSync(process.execPath, [
    "--import", "tsx", join(HERE, "probe-teardown.child.ts"), BLACKHOLE, String(TIMEOUT_MS),
  ], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  check("the child printed its verdict (it got that far)", /RETURNED/.test(child.stdout ?? ""), child.stdout);
  check("the child process EXITED BY ITSELF, and was not killed at the timeout",
    child.signal === null && child.status === 0, { status: child.status, signal: child.signal, stderr: child.stderr?.slice(0, 400) });
} finally {
  const comm = spawnSync("ps", ["-p", String(BROKER_PID), "-o", "comm="], { encoding: "utf8" }).stdout.trim();
  if (comm === "nats-server") process.kill(BROKER_PID, "SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(fail.length === 0
  ? `\nprobe-teardown (#389): ${pass} checks passed`
  : `\nprobe-teardown (#389): ${fail.length} FAILED\n  - ${fail.join("\n  - ")}`);
process.exit(fail.length === 0 ? 0 : 1);
