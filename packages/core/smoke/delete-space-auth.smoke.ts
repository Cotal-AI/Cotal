/**
 * `deleteSpace` on a real JWT broker (#2658). Before, every delete under auth was refused and
 * swallowed: the console passed its `admin` credential, which holds no `STREAM.DELETE`, and
 * `deleteSpace` dropped each refusal, so a space delete reported success and kept every stream.
 *
 *  1. A credential that cannot delete is refused loudly: `deleteSpace` throws, and every stream the
 *     space had is still there.
 *  2. The space's trust material deletes it: `deleteSpace` mints its own `teardown`, and no stream
 *     of the space is left.
 *  3. A second delete of the gone space resolves, because a stream that is not found is not a
 *     refusal.
 *
 * Run: pnpm smoke:delete-space-auth   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import {
  createSpaceAuth, deleteSpace, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams,
  spaceDeletionStreams, standaloneConnectOpts,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}
function expect(cond: boolean, detail: unknown): void {
  if (!cond) throw new Error(JSON.stringify(detail));
}

const space = "delspace";
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

/** The space's deletion targets that exist, read under a `teardown` credential (it holds `STREAM.INFO`). */
async function present(): Promise<string[]> {
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid() }), tls: false }) });
  try {
    const jsm = await jetstreamManager(nc, { timeout: 3_000 });
    const found: string[] = [];
    for (const s of spaceDeletionStreams(space)) {
      try {
        await jsm.streams.info(s);
        found.push(s);
      } catch (e) {
        if (!(e instanceof JetStreamApiError && e.code === JetStreamApiCodes.StreamNotFound)) throw e;
      }
    }
    return found;
  } finally {
    await nc.close();
  }
}

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const before = await present();
  console.log(`space ${space}: ${before.length} of ${spaceDeletionStreams(space).length} deletion targets exist`);

  await check("an admin credential's delete throws and keeps every stream", async () => {
    expect(before.length > 0, { before });
    let refusal: unknown;
    try {
      await deleteSpace({ servers, creds: await mintCreds(auth, newIdentity(), "admin"), space });
    } catch (e) {
      refusal = e;
    }
    const after = await present();
    expect(refusal instanceof Error && after.length === before.length, {
      refusal: (refusal as Error | undefined)?.message?.slice(0, 200), before: before.length, after: after.length,
    });
    console.log(`    refused: ${(refusal as Error).message.slice(0, 120)}`);
  });

  await check("the space's trust material deletes every stream", async () => {
    await deleteSpace({ servers, auth, space });
    const after = await present();
    expect(after.length === 0, { after });
  });

  await check("a second delete of the gone space resolves", async () => {
    await deleteSpace({ servers, auth, space });
  });
} finally {
  await killAndAwaitExit(broker);
  releaseBroker();
}

console.log(`\ndelete-space-auth.smoke: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed > 0 || passed !== 3) process.exitCode = 1;
