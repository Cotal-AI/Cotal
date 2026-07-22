/**
 * REGRESSION (blocker 1): the delivery resident-swap must be armed only AFTER the aggregate reply is
 * sent, never while the aggregate handler is still open.
 *
 * `handleDeliveryAdmin` proves delivery + membership together (`Promise.all`) and only then responds.
 * If the delivery swap (`nc.reconnect()`) were armed inside `reloadCreds` — i.e. as soon as the
 * delivery proof returns, while the membership proof is still in flight — a slow membership proof (the
 * NORM for a remote broker: a fresh TCP+TLS+auth handshake, tens to hundreds of ms) lets the reconnect
 * fire before `m.respond` flushes, on the SAME connection the reply rides. `m.respond` does not throw,
 * so `serveControl`'s catch is blind; the reply is silently dropped and the manager waits out the full
 * request bound and records a FALSE "no delivery-admin responder" for a renewal that actually
 * succeeded. The fix moves `scheduleResidentSwap()` to AFTER `Promise.all` settles in
 * `handleDeliveryAdmin`, immediately before the reply is returned+responded.
 *
 * This isolates that exact timing with REAL nats connections (the shape ss-rev-engineer used to prove
 * the strand): a responder receives a request and either arms `nc.reconnect()` BEFORE responding (the
 * pre-fix pattern) or responds first and arms it AFTER (the fix), with a slow "other proof" window in
 * between. The requester uses the manager's 15s bound.
 *
 * OLD pattern MUST strand (the harness detects the bug); NEW pattern MUST deliver (the fix holds).
 * Run: pnpm exec tsx implementations/delivery/smoke/adoption-swap-strand.smoke.ts
 *      (needs `nats-server` on PATH; local-only; plain no-auth broker; ~40s)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SWAP_DEFER_MS = 250; // matches CotalEndpoint.RESIDENT_SWAP_DEFER_MS
const REQUEST_BOUND_MS = 15_000; // matches DELIVERY_ADMIN_RELOAD_TIMEOUT_MS
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

/** Serve ONE request with the resident-swap armed either before or after the reply, with a `slowMs`
 *  "other proof" window in between. Returns whether the requester received the reply within the bound. */
async function replyDelivered(servers: string, armAfterRespond: boolean, slowMs: number): Promise<{ delivered: boolean; ms: number }> {
  const responder = await connect({ servers, name: "responder", maxReconnectAttempts: -1 });
  const sub = responder.subscribe("adopt.reload");
  void (async () => {
    for await (const m of sub) {
      if (armAfterRespond) {
        await wait(slowMs);                                             // membership proof still in flight
        try { m.respond("ok"); } catch { /* serveControl swallows */ } // reply on the still-live conn
        setTimeout(() => { void responder.reconnect().catch(() => {}); }, SWAP_DEFER_MS); // swap AFTER reply
      } else {
        setTimeout(() => { void responder.reconnect().catch(() => {}); }, SWAP_DEFER_MS); // swap armed EARLY
        await wait(slowMs);
        try { m.respond("ok"); } catch { /* the pre-fix silent drop */ }
      }
      break; // one request per run
    }
  })();
  await wait(150);
  const requester = await connect({ servers, name: "requester", maxReconnectAttempts: -1 });
  const t0 = Date.now();
  let delivered = false;
  try { await requester.request("adopt.reload", "", { timeout: REQUEST_BOUND_MS }); delivered = true; } catch { delivered = false; }
  const ms = Date.now() - t0;
  await Promise.allSettled([responder.close(), requester.close()]);
  return { delivered, ms };
}

const cleanups: Array<() => void> = [];
try {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "cotal-adopt-strand-"));
  writeFileSync(join(dir, "nats.conf"), `port: ${port}\n`);
  const srv = spawn("nats-server", ["-c", join(dir, "nats.conf")], { stdio: "ignore" });
  cleanups.push(() => { srv.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  let up: NatsConnection | undefined;
  for (let i = 0; i < 50; i++) { try { up = await connect({ servers, maxReconnectAttempts: 0 }); break; } catch { await wait(200); } }
  if (!up) throw new Error("nats-server did not come up");
  await up.close();

  // A membership proof that settles at 1s (> the 250ms swap timer) — the remote-broker norm.
  const old = await replyDelivered(servers, false, 1_000);
  console.log(`  [old] swap-armed-before-reply, slow=1000ms → delivered=${old.delivered} in ${old.ms}ms`);
  check("OLD pattern (swap armed while the aggregate is open) STRANDS the reply", old.delivered === false, `unexpectedly delivered in ${old.ms}ms`);

  const fixed = await replyDelivered(servers, true, 1_000);
  console.log(`  [new] swap-armed-after-reply, slow=1000ms → delivered=${fixed.delivered} in ${fixed.ms}ms`);
  check("NEW pattern (swap armed after the reply) DELIVERS the reply", fixed.delivered === true, `stranded after ${fixed.ms}ms`);
  check("NEW pattern reply arrives at the proof time, not the request bound", fixed.delivered && fixed.ms < REQUEST_BOUND_MS - 1_000, `${fixed.ms}ms`);

  console.log(`\n${fail ? "✗" : "✓"} ADOPTION SWAP-STRAND REGRESSION ${pass}/${pass + fail}`);
} finally {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* best-effort */ } }
  await wait(300);
}
process.exit(fail ? 1 : 0);
