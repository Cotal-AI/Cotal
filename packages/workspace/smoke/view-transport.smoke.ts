/**
 * MeshView connection status across a real broker outage. Run: pnpm smoke:view-transport (needs
 * nats-server on PATH).
 *
 * When the broker stops, nats.js reconnects on its own and the endpoint's `connection` event can
 * stay true for the whole outage; only its `transport` edge goes false. Every surface reads
 * `status.connected` from this model, so the model has to follow both. The observer is built with
 * `openObserver`, the same constructor `cotal watch` and `cotal console` use, and the broker is
 * stopped and restarted on the same port and store.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshView, type MeshSnapshot } from "../src/view/mesh-view.js";
import { openObserver } from "../src/view/observer.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
async function until(probe: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!probe() && Date.now() - t0 < ms) await wait(100);
  return probe();
}

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const boot = (): ChildProcess => spawn("nats-server", ["-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const ready = () => awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
let srv = boot();
let release = teardownOnSignal(srv, dir);
let view: MeshView | undefined;

try {
  await ready();
  const space = "view-transport";
  await setupSpaceStreams({ servers, space });
  const ep = openObserver({ space, server: servers, name: "watch" });
  view = new MeshView(ep, {});
  let rendered: MeshSnapshot | undefined;
  view.on("change", (s: MeshSnapshot) => (rendered = s));
  await view.start();

  check("the view reports connected once started", await until(() => rendered?.status.connected === true, 3000), rendered?.status);

  await killAndAwaitExit(srv, "SIGTERM");
  release();
  check("the view reports disconnected while the broker is down", await until(() => rendered?.status.connected === false, 5000), rendered?.status);
  check("a snapshot pulled on demand agrees", view.snapshot().status.connected === false, view.snapshot().status);

  srv = boot();
  release = teardownOnSignal(srv, dir);
  await ready();
  check("the view reports connected again after the broker restarts", await until(() => rendered?.status.connected === true, 15000), rendered?.status);
} finally {
  await view?.stop().catch(() => undefined);
  await killAndAwaitExit(srv, "SIGKILL");
  release();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
