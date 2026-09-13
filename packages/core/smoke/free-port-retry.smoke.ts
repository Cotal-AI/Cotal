/**
 * `startOnFreePort` proofs: a port lost between pick and bind is a retry, not a
 * dead run (#1583).
 *
 * `pickFreePort` closes its probe before the caller binds, so the port belongs
 * to nobody in between. The observed loss was a fixture broker promised 45019
 * on a parallel shard; the readiness loop waited its full 10s and the job
 * aborted after five suites. The window cannot be closed for a spawned process,
 * so what is graded here is the recovery: another port, a bounded count, and a
 * failure that names every port it tried.
 */
import { createConnection, createServer, type Server } from "node:net";
import { pickFreePort, startOnFreePort } from "./_free-port.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const GREETING = "COTAL-FIXTURE\n";

/** A listener that answers, so readiness is measured the way the call sites
 *  measure it: `isReachable` connects and speaks NATS, it does not ask whether
 *  the port is occupied. A squatter occupies the port and says nothing. */
const listen = (port: number, speak = true): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      if (speak) socket.end(GREETING);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

/** Occupies the port and never answers — a foreign process, not our fixture. */
const squat = (port: number): Promise<Server> => listen(port, false);

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

/** Connected AND greeted, within a bound. Occupancy alone is not readiness. */
const reachable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const settle = (answer: boolean) => {
      socket.destroy();
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => settle(false), 500);
    socket.once("error", () => settle(false));
    socket.once("data", (chunk) => settle(chunk.toString().includes("COTAL-FIXTURE")));
  });

// ── Accept control ───────────────────────────────────────────────────────────
// A port nobody steals binds on the first try. Without this, "retries until it
// works" would pass just as happily for an implementation that always retries.
{
  const run = await startOnFreePort(listen, reachable, close);
  ok("a free port binds on the first attempt", run.attempts === 1, run.attempts);
  ok("the accept control really bound", await reachable(run.port));
  await close(run.started);
}

// ── The defect ───────────────────────────────────────────────────────────────
// The first port is taken between pick and bind, exactly as the shard did it:
// a squatter holds it, so the caller's listener cannot have it.
{
  const squatters: Server[] = [];
  let attemptsSeen = 0;
  const stolenFirst = async (port: number): Promise<Server> => {
    attemptsSeen++;
    if (attemptsSeen === 1) {
      // Hold it and hand back a listener that is NOT on this port, the shape a
      // spawned broker has when its port was taken: a live process, nothing
      // answering where the caller was promised.
      squatters.push(await squat(port));
      return await listen(await pickFreePort());
    }
    return await listen(port);
  };

  const run = await startOnFreePort(stolenFirst, reachable, close);
  ok("a stolen port is retried, not fatal", run.attempts === 2, run);
  ok("the retry landed on a different port", !squatters.some((s) => (s.address() as { port: number }).port === run.port));
  ok("the caller's listener holds the port it reports", await reachable(run.port));
  await close(run.started);
  for (const s of squatters) await close(s);
}

// ── The bound, and what a failure says ───────────────────────────────────────
{
  const started: Server[] = [];
  const neverUp = async (_port: number): Promise<Server> => {
    const server = await listen(await pickFreePort());
    started.push(server);
    return server;
  };
  let message = "";
  try {
    await startOnFreePort(neverUp, async () => false, close, { attempts: 3 });
  } catch (error) {
    message = (error as Error).message;
  }
  ok("it gives up after the bound instead of spinning", started.length === 3, started.length);
  ok("the failure names the attempt count", message.includes("3 attempt(s)"), message);
  ok("the failure names every port it tried", message.split(",").length === 3, message);
  ok("every failed attempt was stopped", started.every((s) => !s.listening));
}

// ── What the give-up message can and cannot tell apart ──────────────────────
// Every unready start is "never became reachable" from in here, because both
// failures leave the port OCCUPIED: a collision leaves it to the squatter, a
// broken server holds it itself. Only the caller knows which, so `describe`
// is the seam that makes the message true rather than merely specific.
{
  const started: Server[] = [];
  const gone = new Set<Server>();
  const startAndDie = async (port: number): Promise<Server> => {
    const server = await listen(await pickFreePort());
    started.push(server);
    if (started.length === 1) { await close(server); gone.add(server); }
    return server;
  };
  let message = "";
  try {
    await startOnFreePort(startAndDie, async () => false, close, {
      attempts: 2,
      describe: (server) => (gone.has(server) ? "exited 1: address already in use" : "still running, so it bound the port and never answered"),
    });
  } catch (error) {
    message = (error as Error).message;
  }
  ok("a start that DIED and one that went silent do not read the same", 
    message.includes("address already in use") && message.includes("still running"), message);
  ok("the caller's description reaches the give-up message at all",
    message.includes("never became reachable — "), message);
  for (const s of started) if (!gone.has(s)) await close(s);
}

// ── The retry waits for the previous attempt to be GONE ─────────────────────
// A `stop` that resolves when the kill was SENT rather than when the process
// exited leaves three live children racing each other for the next port, and
// the helper cannot tell: it only sees a promise resolve. The contract is that
// the next attempt does not begin until this one has.
{
  const events: string[] = [];
  const slowStop = async (server: Server): Promise<void> => {
    await new Promise((done) => setTimeout(done, 120));
    events.push("stopped");
    await close(server);
  };
  try {
    await startOnFreePort(
      async (port) => { events.push("started"); return await listen(await pickFreePort()); },
      async () => false,
      slowStop,
      { attempts: 3 },
    );
  } catch { /* exhausting the attempts is the point */ }
  ok("no attempt begins before the previous one has stopped",
    events.join(",") === "started,stopped,started,stopped,started,stopped", events);
}

// ── Refusals ────────────────────────────────────────────────────────────────
{
  let refused = "";
  try {
    await startOnFreePort(listen, reachable, close, { attempts: 0 });
  } catch (error) {
    refused = (error as Error).message;
  }
  ok("a zero bound is refused, not silently treated as one", refused.includes("at least 1"), refused);
}

console.log(`free-port-retry.smoke: ${pass} checks passed`);
