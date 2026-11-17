/**
 * One deadline bounds an acquisition, whichever of a live holder or a live reclaimer is in the way
 * (#3249). The synchronous `acquireLock` checked its deadline only against a live holder: over a
 * stale lock whose `.reclaim` sentinel another live process held, it slept and retried with no
 * deadline check, so a zero-wait acquisition blocked the event loop until the sentinel went away.
 *
 * A child process holds the sentinel of a stale lock for HOLD_MS, then releases it.
 *
 *  1. A zero-wait `acquireLock` throws long before the reclaimer releases, naming that reclaimer.
 *  2. The same for `acquireLockAsync`, which already obeyed one deadline.
 *  3. A wait longer than the hold reaches the lock once the reclaimer is done, so the bound does not
 *     turn a reclaim in progress into a refusal.
 *
 * Run: pnpm smoke:advisory-lock-reclaim-deadline
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";

// The shipped build, as an embedder loads it.
const { acquireLock, acquireLockAsync, inspectLock } = await import("../dist/advisory-lock.js");

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}
function expect(cond: boolean, detail: unknown): void {
  if (!cond) throw new Error(JSON.stringify(detail));
}

const HOLD_MS = 3_000;
const root = mkdtempSync(join(tmpdir(), "cotal-lock-reclaim-"));
const dist = new URL("../dist/advisory-lock.js", import.meta.url).href;

/** A canonical lock whose owner is a process that has exited: stale, so an acquirer must reclaim it. */
function staleLock(path: string): void {
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(path, `${JSON.stringify({ pid: gone, start: "0", nonce: "gone", ts: Date.now() })}\n`);
}

/** A live process that takes `<path>.reclaim` the way a reclaimer does and holds it for HOLD_MS. */
async function liveReclaimer(path: string): Promise<{ pid: number; released: Promise<void> }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { acquireLock } = await import(${JSON.stringify(dist)});
    const held = acquireLock(${JSON.stringify(`${path}.reclaim`)}, { waitMs: 0 });
    process.stdout.write("held\\n");
    setTimeout(() => { held.release(); process.exit(0); }, ${HOLD_MS});
  `], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`reclaimer exited ${code} before holding the sentinel`)));
  });
  const released = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { pid: child.pid as number, released };
}

try {
  await check("a zero-wait acquireLock over a live reclaimer throws before it releases, naming it", async () => {
    const path = join(root, "sync.lock");
    staleLock(path);
    const reclaimer = await liveReclaimer(path);
    const started = Date.now();
    let error: unknown;
    try {
      acquireLock(path, { waitMs: 0 }).release();
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - started;
    await reclaimer.released;
    expect(error instanceof Error && elapsed < HOLD_MS / 3 && (error as Error).message.includes(`pid ${reclaimer.pid}`), {
      error: (error as Error | undefined)?.message?.slice(0, 160), elapsed, hold: HOLD_MS,
    });
  });

  await check("and so does acquireLockAsync", async () => {
    const path = join(root, "async.lock");
    staleLock(path);
    const reclaimer = await liveReclaimer(path);
    const started = Date.now();
    let error: unknown;
    try {
      (await acquireLockAsync(path, { waitMs: 0 })).release();
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - started;
    await reclaimer.released;
    expect(error instanceof Error && elapsed < HOLD_MS / 3 && (error as Error).message.includes(`pid ${reclaimer.pid}`), {
      error: (error as Error | undefined)?.message?.slice(0, 160), elapsed, hold: HOLD_MS,
    });
  });

  await check("a wait longer than the hold reaches the lock once the reclaimer is done", async () => {
    const path = join(root, "wait.lock");
    staleLock(path);
    const reclaimer = await liveReclaimer(path);
    const started = Date.now();
    const held = acquireLock(path, { waitMs: HOLD_MS * 3 });
    const elapsed = Date.now() - started;
    const state = inspectLock(path).state;
    held.release();
    await reclaimer.released;
    expect(state === "active" && elapsed >= HOLD_MS / 2, { state, elapsed, hold: HOLD_MS });
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nadvisory-lock-reclaim-deadline.smoke: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed > 0 || passed !== 3) process.exitCode = 1;
