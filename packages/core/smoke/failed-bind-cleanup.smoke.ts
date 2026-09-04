/**
 * A failed endpoint bind must close the transport it already opened.
 *
 * Core NATS connect succeeds, then the fixture makes the first presence bind throw. Retrying the
 * same endpoint used to overwrite `nc` while leaving each prior transport established. A connector
 * retry loop turned that into one leaked TCP connection every three seconds.
 *
 * Run: pnpm smoke:failed-bind-cleanup
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = await pickFreePort();
const MON = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-m", String(MON)], {
  stdio: "ignore",
});
const releaseBroker = teardownOnSignal(broker, dir);

let cells = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  cells++;
  if (condition) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

let endpoint: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(100);
  }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS}`);

  const connectionCount = async (): Promise<number> => {
    const response = await fetch(`http://127.0.0.1:${MON}/varz`);
    if (!response.ok) throw new Error(`monitor returned ${response.status}`);
    const body = (await response.json()) as { connections?: number };
    if (!Number.isInteger(body.connections)) throw new Error("monitor response omitted connections");
    return body.connections!;
  };

  endpoint = new CotalEndpoint({
    space: "failed-bind-cleanup",
    servers: SERVERS,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    watchChannels: false,
    card: { name: "retrying-client", kind: "endpoint" },
  });
  endpoint.on("error", () => {});
  (endpoint as unknown as { startPresenceWatch: () => Promise<void> }).startPresenceWatch = async () => {
    throw new Error("fixture post-connect bind failure");
  };

  const counts: number[] = [];
  let refusals = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await endpoint.start();
    } catch {
      refusals++;
    }
    await wait(100);
    counts.push(await connectionCount());
  }

  check("CONTROL: every attempt reaches the post-connect bind failure", refusals === 3, { refusals });
  check("A FAILED BIND CLOSES ITS TRANSPORT BEFORE THE CALLER RETRIES", counts.every((count) => count === 0), {
    counts,
  });
} finally {
  await endpoint?.stop().catch(() => {});
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nfailed bind cleanup smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
