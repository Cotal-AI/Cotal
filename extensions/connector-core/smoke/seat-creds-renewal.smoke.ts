/**
 * Managed-seat credential renewal: configFromEnv must preserve the credential FILE as a source,
 * not freeze its contents at boot. A re-signed same-identity file must carry a live MeshAgent past
 * the first JWT's expiry, and the real cotal_reconnect tool must rebuild on the replacement.
 *
 * Run: pnpm smoke:seat-creds-renewal
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CotalEndpoint,
  createSpaceAuth,
  credsClaims,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { configFromEnv } from "../src/config.js";
import { MeshAgent } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await wait(50);
  return condition();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3_000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${name}`, detail ?? "");
  }
};

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `seat-renewal-${process.pid}`;
const dir = mkdtempSync(join("/var/tmp", SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
const configPath = join(dir, "server.conf");
writeFileSync(configPath, serverConfig(auth, [auth], {
  transport: { kind: "plaintext" },
  port,
  storeDir: join(dir, "js"),
}));
const server = spawn("nats-server", ["-D", "-c", configPath], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(server, dir);
let manager: CotalEndpoint | undefined;
let agent: MeshAgent | undefined;

try {
  let brokerReady = false;
  for (let i = 0; i < 50 && !brokerReady; i++) {
    brokerReady = await isReachable(servers);
    if (!brokerReady) await wait(100);
  }
  check("isolated auth broker starts on its assigned non-default port", brokerReady && port !== 4222, servers);
  assert.equal(brokerReady, true, `auth broker did not start at ${servers}`);

  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  manager = new CotalEndpoint({
    space,
    servers,
    creds: provisionerCreds,
    card: { name: "provisioner", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
  });
  manager.on("error", () => {});
  await manager.start();

  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const ttlSeconds = 6;
  const initial = await provisionAgent(manager, auth, identity, {
    lifecycleUid,
    expiresInSeconds: ttlSeconds,
    durableMembership: false,
  });
  const initialExp = credsClaims(initial).exp!;
  const credsPath = join(dir, "seat.creds");
  writeFileSync(credsPath, initial, { mode: 0o600 });

  const config = configFromEnv({
    COTAL_NAME: "renewing-seat",
    COTAL_KIND: "agent",
    COTAL_SPACE: space,
    COTAL_SERVERS: servers,
    COTAL_CREDS: credsPath,
    COTAL_LIFECYCLE_UID: lifecycleUid,
  });
  check("connector config preserves a managed creds file as a source", typeof config.creds === "function", typeof config.creds);
  check("connector config fixes card.id from the first credential read", config.id === identity.id, config.id);

  agent = new MeshAgent(config);
  agent.on("error", () => {});
  await agent.start(100);
  check("managed seat connects through configFromEnv", agent.connected, agent.connectionIssue);

  const renewed = await mintCreds(auth, identity, "agent", {
    lifecycleUid,
    expiresInSeconds: 60,
  });
  writeFileSync(credsPath, renewed, { mode: 0o600 });
  check("renewal replaces the on-disk file with the same nkey", credsClaims(renewed).sub === identity.id);

  await wait(Math.max(0, initialExp * 1000 + 1_200 - Date.now()));
  check(
    "seat remains mesh-connected after the credential held at boot expires",
    await until(() => agent!.connected, 4_000),
    agent.connectionIssue,
  );

  const reconnect = cotalToolSpecs(config).find((spec) => spec.name === "cotal_reconnect");
  assert.ok(reconnect, "cotal_reconnect tool is registered");
  const result = await reconnect.run(agent, config, {});
  check(
    "cotal_reconnect adopts the renewed file and reports connected after the old JWT expiry",
    result.isError !== true && result.text.startsWith("Reconnected ✓"),
    result.text,
  );

  console.log(
    failed === 0
      ? `\nSEAT CREDS RENEWAL SMOKE OK ✅  (${passed} passed, ${failed} failed)`
      : `\nSEAT CREDS RENEWAL SMOKE FAILED ❌  (${passed} passed, ${failed} failed)`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await agent?.stop();
  await manager?.stop();
  server.kill("SIGKILL");
  await awaitExit(server);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
