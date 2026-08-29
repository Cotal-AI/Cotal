/**
 * REAL NATS TRANSPORT EDGES REACH CotalEndpoint AND MeshAgent WITHOUT FLAPPING READINESS.
 *
 * The unit-shaped transport-liveness smoke controls the status iterator so it can prove epoch
 * staleness deterministically. This companion owns a throwaway nats-server on an OS-assigned port
 * and proves the public nats.js lifecycle produces the ruled disconnect/reconnect edges in practice.
 * It never starts or stops a Cotal stack and it scrubs inherited broker configuration before dialing.
 *
 * Run: pnpm smoke:transport-liveness:broker
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { isReachable } from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "../../../packages/core/smoke/_ephemeral-only.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

scrubAmbientBrokerEnv();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn: () => boolean, timeoutMs = 12_000): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
};
const awaitExit = (proc: ChildProcess, timeoutMs = 4_000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
};

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
assertEphemeralBroker(servers);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const configPath = join(dir, "server.conf");
writeFileSync(configPath, `port: ${port}\njetstream { store_dir: "${join(dir, "js")}" }\n`);
const startBroker = (): ChildProcess => spawn("nats-server", ["-c", configPath], { stdio: "ignore" });
let broker = startBroker();
const releases = [teardownOnSignal(broker, dir)];

const cfg: AgentConfig = {
  space: `transport-live-${port}`,
  name: "transport-live-agent",
  servers,
  kind: "agent",
  tls: false,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
};
const agent = new MeshAgent(cfg);
const transport: Array<{ connected: boolean; server?: string }> = [];
const readiness: Array<{ connected: boolean }> = [];
let terminalIssueAtError: string | undefined;
agent.on("transport", (event) => transport.push(event));
agent.on("connection", (event) => readiness.push(event));
// MeshAgent registered its endpoint error handler in its constructor, before this listener. When the
// real supervisor emits its terminal error, read the public diagnostic AFTER MeshAgent processed it
// and BEFORE later re-establish attempts can report a newer pre-bind failure.
agent.ep.on("error", (error: Error) => {
  if (/^mesh connection closed/.test(error.message)) terminalIssueAtError = agent.connectionIssue;
});

try {
  check("the owned throwaway broker starts", await until(() => false, 0) || await (async () => {
    for (let i = 0; i < 80; i++) { if (await isReachable(servers)) return true; await sleep(50); }
    return false;
  })());
  await agent.start(100);
  check(
    "initial transport=true arrives before or with full-bind readiness",
    await until(() => agent.transportConnected && agent.connected) &&
      transport[0]?.connected === true && readiness[0]?.connected === true,
    { transport, readiness, live: agent.transportConnected, ready: agent.connected },
  );

  broker.kill("SIGKILL");
  await awaitExit(broker);
  check(
    "a real broker loss emits transport=false while full-bind readiness does not flap",
    await until(() => !agent.transportConnected) && agent.connected === true &&
      transport.some((event) => event.connected === false) && readiness.length === 1,
    { transport, readiness, live: agent.transportConnected, ready: agent.connected },
  );

  broker = startBroker();
  releases.push(teardownOnSignal(broker, dir));
  check("the replacement broker starts", await (async () => {
    for (let i = 0; i < 80; i++) { if (await isReachable(servers)) return true; await sleep(50); }
    return false;
  })());
  check(
    "a real nats.js reconnect emits transport=true without another full-bind readiness edge",
    await until(() => agent.transportConnected) && agent.connected === true &&
      transport.filter((event) => event.connected === true).length >= 2 && readiness.length === 1,
    { transport, readiness, live: agent.transportConnected, ready: agent.connected },
  );

  // Keep the broker down until nats.js exhausts its reconnect attempts and closes the real current
  // connection. This reaches CotalEndpoint.superviseConnection through nc.closed(), not through a
  // constructed fake, and observes the MeshAgent diagnostic the user-facing status surface reads.
  const ep = agent.ep as unknown as {
    nc?: {
      setServers(servers: string[]): void;
      reconnect(): Promise<void>;
    };
    reestablishLoop(): Promise<void>;
  };
  ep.reestablishLoop = async () => {};
  const unreachablePort = await pickFreePort();
  ep.nc!.setServers([`127.0.0.1:${unreachablePort}`]);
  await ep.nc!.reconnect();
  // The transport clause is load-bearing, not decoration. A terminal close that left transport
  // true would render as "connecting" to any consumer deriving state from the two flags, so a
  // permanently dead session would report itself as one still coming up. The stop cell below
  // proves stop() clears the flag; only this proves a REAL close does, through nc.closed() and
  // the status iterator rather than a hand-pushed status value.
  check(
    "a REAL terminal close marks readiness false, clears transport, and exposes its user-visible reason",
    await until(
      () =>
        !agent.connected &&
        !agent.transportConnected &&
        /mesh connection closed/.test(terminalIssueAtError ?? ""),
      30_000,
    ),
    { ready: agent.connected, terminalIssueAtError, latestIssue: agent.connectionIssue, transport },
  );

  await agent.stop();
  check("clean stop clears readiness and transport", agent.connected === false && agent.transportConnected === false, {
    ready: agent.connected,
    live: agent.transportConnected,
  });
} finally {
  await agent.stop().catch(() => {});
  broker.kill("SIGKILL");
  await awaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  for (const release of releases) release();
}

const EXPECTED_CELLS = 7;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
console.log(`SUITE COMPLETE: ${ran} cells`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
