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
import { mkdtempSync, writeFileSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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

const port = 4461;
const server = `nats://127.0.0.1:${port}`;
const space = "webseed";
const dir = mkdtempSync(join(tmpdir(), "cotal-webseed-"));
const storeDir = join(dir, "nats");
const conf = join(dir, "s.conf");
const log = join(dir, "s.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  const auth = await createSpaceAuth(space); // the account signing SEED
  writeFileSync(conf, serverConfig(auth, { port, storeDir }));
  const fd = openSync(log, "w");
  kids.push(spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] }));

  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
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
  const purgeCreds = await mintCreds(auth, newIdentity(), "manager"); // pre-minted once, like web

  // Seed #ops with history (via a manager endpoint — a plain publisher).
  const pub = new CotalEndpoint({
    space,
    servers: server,
    creds: mgrCreds,
    card: { name: "seed", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
  });
  await pub.start();
  for (let i = 0; i < 3; i++) await pub.multicast(`m${i}`, { channel: "ops" });
  await sleep(300);
  await pub.stop();

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
  for (const k of kids) {
    try {
      k.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
