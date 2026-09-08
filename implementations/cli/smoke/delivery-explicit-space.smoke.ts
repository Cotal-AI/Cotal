/**
 * LIVE: the shipped control-plane ensure must use the explicitly selected space when one broker root
 * holds several account signers. The real ensureControlPlane path mints and starts delivery, then
 * starts the manager. Its selected delivery credential must name the requested account. A caller
 * that omits the space is still ambiguous and must refuse before minting anything.
 *
 * Run: pnpm smoke:delivery-explicit-space
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { accountFromCreds, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "../../../packages/core/smoke/_ephemeral-only.js";
import { assertScratchHeld, makeScratch } from "../../../bin/smoke/_scratch.js";
import { authDir, canonicalLocalProcessPath, connectionEvictorCredsKey, DELIVERY_CREDS_KIND, DELIVERY_PIDFILE, deliveryCredsKey, MANAGER_PIDFILE, membershipConfigPath, membershipObserverCredsKey, membershipRwCredsKey, saveBrokerAuth, saveSpaceAccountAuth, workspaceSecretStore } from "@cotal-ai/workspace";

scrubAmbientBrokerEnv();
const scratch = makeScratch("cotal-delivery-explicit-space-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const xdg = join(home, "xdg");
const serverPort = await new Promise<number>((resolvePort, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address() as AddressInfo;
    socket.close(() => resolvePort(address.port));
  });
});
const server = `nats://127.0.0.1:${serverPort}`;
assertEphemeralBroker(server);
assertScratchHeld(root, "delivery explicit-space fixture");
mkdirSync(join(root, ".cotal"), { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.HOME = home;
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";
process.chdir(root);

const natsServer = process.env.NATS_SERVER_BIN ?? "nats-server";
const broker = await createBrokerAuth("delivery-explicit-space");
const alphaAccount = await createSpaceAccountAuth(broker, "alpha");
const clouddevAccount = await createSpaceAccountAuth(broker, "clouddev");
const alpha = composeSpaceAuth(broker, alphaAccount);
const clouddev = composeSpaceAuth(broker, clouddevAccount);
saveBrokerAuth(authDir(root), broker);
saveSpaceAccountAuth(authDir(root), alphaAccount);
saveSpaceAccountAuth(authDir(root), clouddevAccount);
const conf = join(root, "server.conf");
writeFileSync(conf, serverConfig(broker, [alphaAccount, clouddevAccount], {
  transport: { kind: "plaintext" },
  port: serverPort,
  host: "127.0.0.1",
  storeDir: join(root, "js"),
}));

let pass = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (!condition) throw new Error(`FAIL: ${name}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readPid = (template: string, space: string): number | undefined => {
  const path = canonicalLocalProcessPath(template, { root, space });
  return existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : undefined;
};
const stopPid = async (pid: number | undefined): Promise<void> => {
  if (!pid || !alive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 100 && alive(pid); i++) await wait(50);
  if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
};
let brokerChild: ChildProcess | undefined;
try {
  brokerChild = spawn(natsServer, ["-c", conf], { stdio: "ignore" });
  for (let i = 0; i < 100 && !(await isReachable(server)); i++) await wait(50);
  check("the two-account broker is reachable", await isReachable(server));
  await setupSpaceStreams({ servers: server, space: "alpha", creds: await mintCreds(alpha, newIdentity(), "provisioner") });
  await setupSpaceStreams({ servers: server, space: "clouddev", creds: await mintCreds(clouddev, newIdentity(), "provisioner") });
  const store = workspaceSecretStore(root);
  const composition = { injected: false as const, root };
  await store.put(membershipObserverCredsKey("clouddev", composition), await mintMembershipObserverCreds(clouddev, newIdentity()));
  await store.put(membershipRwCredsKey("clouddev", composition), await mintCreds(clouddev, newIdentity(), "membership-rw"));
  await store.put(connectionEvictorCredsKey("clouddev", composition), await mintConnectionEvictorCreds(clouddev, newIdentity()));
  mkdirSync(join(membershipConfigPath(root, "clouddev"), ".."), { recursive: true });
  writeFileSync(membershipConfigPath(root, "clouddev"), JSON.stringify({ accountId: clouddev.account.pub }));

  process.argv[1] = join(resolve(import.meta.dirname, "..", "..", ".."), "bin", "cotal.ts");
  const { ensureControlPlane } = await import("../src/lib/delivery-proc.js");

  let implicitError = "";
  try { await ensureControlPlane({ server }); } catch (error) { implicitError = (error as Error).message; }
  check("without an explicit space the two-account root still refuses", /holds 2 spaces|refuses to pick one/.test(implicitError), implicitError);
  check("the implicit refusal happens before any delivery credential is minted", await workspaceSecretStore(root).get(deliveryCredsKey("alpha", { injected: false, root })) === undefined && await workspaceSecretStore(root).get(deliveryCredsKey("clouddev", { injected: false, root })) === undefined);

  let explicitError = "";
  try { await ensureControlPlane({ space: "clouddev", server }); } catch (error) { explicitError = (error as Error).message; }
  check("the real ensureControlPlane path accepts an explicit space on a two-account root", explicitError === "", explicitError);
  const key = deliveryCredsKey("clouddev", { injected: false, root });
  const selectedCreds = await workspaceSecretStore(root).get(key);
  check("the selected space's delivery credential was written through the stock SecretStore seam", selectedCreds !== undefined, key);
  check("the selected account signs the delivery credential", accountFromCreds(selectedCreds!) === clouddev.account.pub, {
    got: accountFromCreds(selectedCreds!),
    selected: clouddev.account.pub,
    sibling: alpha.account.pub,
  });
  check("the sibling account did not receive the delivery credential", await workspaceSecretStore(root).get(deliveryCredsKey("alpha", { injected: false, root })) === undefined);

  await stopPid(readPid(MANAGER_PIDFILE, "clouddev"));
  await stopPid(readPid(DELIVERY_PIDFILE, "clouddev"));
  await workspaceSecretStore(root).delete(DELIVERY_CREDS_KIND);
  await workspaceSecretStore(root).delete(deliveryCredsKey("clouddev", { injected: false, root }));

  console.log(`\nDELIVERY EXPLICIT-SPACE SMOKE OK ✅ (${pass} checks passed)`);
} finally {
  await stopPid(readPid(MANAGER_PIDFILE, "clouddev"));
  await stopPid(readPid(DELIVERY_PIDFILE, "clouddev"));
  if (brokerChild?.exitCode === null) {
    brokerChild.kill("SIGTERM");
    await Promise.race([once(brokerChild, "exit"), wait(5000)]);
    if (brokerChild.exitCode === null) brokerChild.kill("SIGKILL");
  }
  rmSync(scratch, { recursive: true, force: true });
}
