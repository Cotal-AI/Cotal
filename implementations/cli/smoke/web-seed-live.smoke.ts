/**
 * LIVE-broker e2e for the `cotal web` account-seed hardening (#102/#103). After dropping the
 * account signing seed, the dashboard connects with an ADMIN cred and purges channels with a
 * SEPARATELY pre-minted MANAGER cred (minted once at startup), instead of re-minting from the seed
 * per delete. This proves the behavioral guarantee that change must keep — against a real JWT-auth
 * broker:
 *   • the pre-minted manager cred purges a channel (web's delete path still works), and
 *   • the admin connection cred CANNOT purge (which is *why* web pre-mints a manager cred — if admin
 *     could, the separate mint would be pointless).
 *
 * Needs `nats-server` on PATH (like the other auth smokes). Kills only the broker it spawns.
 * Run: pnpm smoke:web-seed:live
 */
import { once } from "node:events";
import { closeSync, mkdtempSync, writeFileSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  CotalEndpoint,
  clearChannel,
  createSpaceAuth,
  isReachable,
  mintCreds,
  newIdentity,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { killAndAwaitExit } from "@cotal-ai/smoke-kit";

async function freePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("free-port probe did not bind a TCP port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const space = "webseed";
const dir = mkdtempSync(join(tmpdir(), "cotal-webseed-"));
const storeDir = join(dir, "nats");
const conf = join(dir, "s.conf");
const log = join(dir, "s.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let broker: ReturnType<typeof spawn> | undefined;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  const auth = await createSpaceAuth(space); // the account signing SEED
  writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir }));
  const fd = openSync(log, "w");
  try {
    broker = spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(server, { creds: mgrCreds })) {
      up = true;
      break;
    }
    await sleep(200);
  }
  ok("JWT-auth broker up", up, up ? undefined : readFileSync(log, "utf8").slice(-400));

  await setupSpaceStreams({ servers: server, space, creds: mgrCreds });
  await seedChannelRegistry({ servers: server, space, creds: mgrCreds, file: { channels: { ops: { replay: true } } } });

  // web's NEW model: connect as ADMIN, pre-mint ONE MANAGER cred for the purge, drop the seed.
  const adminCreds = await mintCreds(auth, newIdentity(), "admin");
  const purgeCreds = await mintCreds(auth, newIdentity(), "channel-purger"); // pre-minted once, like web
  const publisherCreds = await mintCreds(auth, newIdentity(), "operator");

  // Seed #ops through the same self-scoped operator publish surface a CLI message uses.
  const pub = new CotalEndpoint({
    space,
    servers: server,
    creds: publisherCreds,
    card: { name: "seed", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
  });
  const publisherErrors: string[] = [];
  pub.on("error", (error: Error) => publisherErrors.push(error.message));
  try {
    await pub.start();
    try {
      await pub.multicast("seeded history", { channel: "ops" });
    } catch (error) {
      publisherErrors.push(error instanceof Error ? error.message : String(error));
    }
    await sleep(300);
    ok("operator publisher seeds #ops without broker permission violations", publisherErrors.length === 0, publisherErrors);
  } finally {
    await pub.stop().catch(() => {});
  }

  // The ADMIN connection cred (what web connects with) must NOT be able to purge — that's the whole
  // reason web mints a manager cred separately.
  let adminBlocked = false;
  try {
    await clearChannel({ servers: server, space, channel: "ops", creds: adminCreds });
  } catch {
    adminBlocked = true;
  }
  ok("admin connection cred CANNOT purge (why web pre-mints a manager cred)", adminBlocked);

  // The pre-minted MANAGER cred purges the channel — web's delete path works after the seed-drop.
  const result = await clearChannel({ servers: server, space, channel: "ops", creds: purgeCreds });
  ok(
    "pre-minted manager cred purges the channel (web delete works post-seed-drop)",
    result !== undefined && (result.purged ?? 0) >= 1,
    result,
  );

  console.log(`\nweb account-seed live e2e: ${pass} checks passed`);
} finally {
  if (broker) await killAndAwaitExit(broker, "SIGKILL", 5_000);
  const brokerStopped = broker === undefined || broker.exitCode !== null || broker.signalCode !== null;
  if (!brokerStopped) throw new Error(`web-seed broker did not stop; preserving scratch state at ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
