import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decode, type Account } from "@nats-io/jwt";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { applyAccountLimits, chatSubject, createBrokerAuth, createSpaceAccountAuth, createSpaceAuth, loadCotalConfig, membershipBucket, mintCreds, mintLifecycleUid, newIdentity, presenceBucket, readCotalConfigFile, revokeAccountUser, standaloneConnectOpts } from "@cotal-ai/core";
import { getSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const wt = resolve(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "cotal-account-limits-"));
const root = join(dir, "root"), home = join(dir, "home"), xdg = join(dir, "xdg");
for (const path of [root, home, xdg, join(root, ".cotal")]) mkdirSync(path, { recursive: true, mode: 0o700 });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
const cli = (...args: string[]) => {
  const opts = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, opts);
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(wt, "bin/cotal.ts"), ...args], opts);
};
const port = await freePort(), servers = `nats://127.0.0.1:${port}`, space = "accountlimits";
const limits = { conn: 32, subs: 128, payload: 524288, mem_storage: 1048576, disk_storage: 4194304, consumer: 32 };
const config = join(root, ".cotal/config.json");
const connections: NatsConnection[] = [];
try {
  const fresh = await createSpaceAuth("freshlimits", { conn: 40 });
  check("public new-account API applies configured limit", decode<Account>(fresh.account.jwt).nats.limits?.conn === 40);
  check("public new-account API retains absent storage defaults", decode<Account>(fresh.account.jwt).nats.limits?.disk_storage === -1);
  const tenant = await createSpaceAccountAuth(await createBrokerAuth("tenantlimits"), "tenantlimits", { consumer: 64 });
  check("public tenant-account API applies configured consumer limit", decode<Account>(tenant.account.jwt).nats.limits?.consumer === 64);
  const revoked = await revokeAccountUser(fresh, newIdentity().id, Math.floor(Date.now() / 1000));
  const rewritten = await applyAccountLimits(revoked, { subs: 128 });
  const oldClaims = decode<Account>(revoked.account.jwt), newClaims = decode<Account>(rewritten.account.jwt);
  check("reissue retains revocations and signing keys", JSON.stringify(oldClaims.nats.revocations) === JSON.stringify(newClaims.nats.revocations) && JSON.stringify(oldClaims.nats.signing_keys) === JSON.stringify(newClaims.nats.signing_keys));
  check("partial reissue retains other saved limits", newClaims.nats.limits?.conn === 40 && newClaims.nats.limits?.subs === 128);
  check("absent API setting returns original auth unchanged", await applyAccountLimits(rewritten) === rewritten);
  check("same-valued API setting returns original auth unchanged", await applyAccountLimits(rewritten, { subs: 128 }) === rewritten);
  const unlimited = await applyAccountLimits(rewritten, { conn: -1 });
  check("explicit -1 removes saved account limit", decode<Account>(unlimited.account.jwt).nats.limits?.conn === -1);
  let invalidApi = false;
  try { await createSpaceAuth("badlimits", { conn: 0 }); } catch (error) { invalidApi = String(error).includes("accountLimits.conn"); }
  check("public provisioning API rejects invalid keyed limit", invalidApi);
  const prepared = cli("space", "create", space, "--root", root, "--json");
  check("control: space create succeeds", prepared.status === 0, prepared.stderr);
  const started = cli("up", "--no-manager", "--server", servers, "--json");
  check("control: unconfigured CLI up succeeds", started.status === 0, started.stderr);
  const original = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!original) throw new Error("CLI did not persist account trust");
  const before = decode<Account>(original.account.jwt).nats.limits;
  check("control: omitted setting keeps unlimited account claims", before?.conn === -1 && before.subs === -1 && before.payload === -1 && before.mem_storage === -1 && before.disk_storage === -1);
  const identity = newIdentity();
  const creds = await mintCreds(original, identity, "provisioner");
  const control = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  check("control: shipped minted credential connects to real broker", control.info?.port === port);
  await control.close();
  check("control: CLI down succeeds", cli("down", "--yes", "--json").status === 0);
  writeFileSync(config, JSON.stringify({ accountLimits: limits }));
  const limited = cli("up", "--no-manager", "--server", servers, "--json");
  check("configured CLI restart succeeds", limited.status === 0, limited.stderr);
  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!auth) throw new Error("account trust missing after restart");
  check("reprovision preserves account identity and signer", auth.account.pub === original.account.pub && auth.account.signingPub === original.account.signingPub);
  const after = decode<Account>(auth.account.jwt).nats.limits;
  for (const [key, value] of Object.entries(limits)) check(`configured account claim enforces ${key}`, after?.[key as keyof typeof limits] === value);
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  connections.push(nc);
  const info = await (await jetstreamManager(nc)).getAccountInfo();
  check("real broker reports configured memory storage", info.limits.max_memory === limits.mem_storage);
  check("real broker reports configured disk storage", info.limits.max_storage === limits.disk_storage);
  check("real broker reports configured consumer count", info.limits.max_consumers === limits.consumer);
  let refused = false;
  for (let i = 0; i < 33; i++) {
    try { connections.push(await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false, timeout: 1000 })); }
    catch (error) { refused = /maximum.*connections|connections.*exceeded/i.test(String(error)); break; }
  }
  check("real broker refuses connections beyond configured cap", refused);
  for (const other of connections.splice(1)) await other.close();
  let payloadRefused = false;
  try { nc.publish("$JS.API.INFO", new Uint8Array(limits.payload + 1)); } catch (error) { payloadRefused = /payload/i.test(String(error)); }
  check("real connection refuses payload above account ceiling", payloadRefused);
  const sub = nc.subscribe(`_INBOX_${identity.id}.control`);
  await nc.flush();
  check("control: subscription within configured ceiling works", !sub.isClosed());
  let subscriptionRefused = false;
  const status = (async () => { for await (const event of nc.status()) if (event.type === "error" && /maximum.*subscriptions|subscriptions.*exceeded/i.test(String(event.error))) { subscriptionRefused = true; break; } })();
  for (let i = 0; i < limits.subs + 1; i++) nc.subscribe(`_INBOX_${identity.id}.sub${i}`);
  await new Promise(resolve => setTimeout(resolve, 100));
  check("real broker refuses subscriptions above account ceiling", subscriptionRefused);
  await nc.close();
  await status;
  const supervisor = await mintCreds(auth, newIdentity(), "supervisor");
  const consumers = await connect({ servers, ...standaloneConnectOpts({ creds: supervisor, tls: false }), reconnect: false });
  connections.push(consumers);
  const manager = await jetstreamManager(consumers);
  let consumerRefused = false, createdConsumers = 0;
  for (let i = 0; i <= limits.consumer; i++) {
    try { await manager.consumers.add(`KV_${presenceBucket(space)}`, { name: `limit${i}`, ack_policy: AckPolicy.None }); createdConsumers++; }
    catch (error) { consumerRefused = /maximum.*consumers|consumers.*limit|consumers.*exceeded/i.test(String(error)); break; }
  }
  check("control: consumer creation within account ceiling succeeds", createdConsumers > 0);
  check("real broker refuses consumers beyond account ceiling", consumerRefused);
  await consumers.close();
  const writerIdentity = newIdentity();
  const writerCreds = await mintCreds(auth, writerIdentity, "agent", { lifecycleUid: mintLifecycleUid(), allowPublish: ["general"] });
  const writer = await connect({ servers, ...standaloneConnectOpts({ creds: writerCreds, tls: false }), reconnect: false });
  connections.push(writer);
  const js = jetstream(writer);
  const subject = chatSubject(space, "local", writerIdentity.id, "general");
  let stored = 0, diskRefused = false;
  for (let i = 0; i < 80; i++) {
    try { await js.publish(subject, new Uint8Array(65536)); stored++; }
    catch (error) { diskRefused = /resource|storage|space/i.test(String(error)); break; }
  }
  check("control: allowed stored message succeeds below account ceiling", stored > 0);
  check("real broker refuses writes beyond account disk ceiling", diskRefused);
  await writer.close();
  const memoryCreds = await mintCreds(auth, newIdentity(), "membership-rw");
  const memory = await connect({ servers, ...standaloneConnectOpts({ creds: memoryCreds, tls: false }), reconnect: false });
  connections.push(memory);
  const bucket = await new Kvm(memory).open(membershipBucket(space));
  let memoryStored = 0, memoryRefused = false;
  for (let i = 0; i < 300; i++) {
    try { await bucket.put(`limit${i}`, new Uint8Array(4096)); memoryStored++; }
    catch (error) { memoryRefused = /resource|storage|space/i.test(String(error)); break; }
  }
  check("control: memory-backed writes succeed below account ceiling", memoryStored > 0);
  check("real broker refuses writes beyond account memory ceiling", memoryRefused);
  await memory.close();
  const saved = auth.account.jwt;
  writeFileSync(config, JSON.stringify({ accountLimits: { ...limits, conn: 40 } }));
  const changedLive = cli("up", "--no-manager", "--json");
  check("changed limits refuse while owned broker is running", changedLive.status !== 0);
  check("live refusal leaves saved JWT unchanged", (await getSpaceAuth(workspaceSecretStore(root), space))?.account.jwt === saved);
  check("configured stack stops cleanly", cli("down", "--yes", "--json").status === 0);
  rmSync(config);
  check("existing configured mesh restarts without setting", cli("up", "--no-manager", "--json").status === 0);
  check("absent setting preserves existing configured JWT byte for byte", (await getSpaceAuth(workspaceSecretStore(root), space))?.account.jwt === saved);
  check("second configured stop succeeds", cli("down", "--yes", "--json").status === 0);
  for (const value of [null, [], "32", { conn: 0 }, { conn: -2 }, { conn: 1.5 }, { conn: "32" }, { conn: Number.MAX_SAFE_INTEGER + 1 }, { typo: 1 }]) {
    writeFileSync(config, JSON.stringify({ accountLimits: value }));
    let message = "";
    try { readCotalConfigFile(config); } catch (error) { message = String(error); }
    check("invalid limits refuse at config load and name key", message.includes("accountLimits") && message.includes(config));
  }
  writeFileSync(config, JSON.stringify({ accountLimits: { conn: 0 } }));
  const invalidUp = cli("up", "--no-manager", "--json");
  check("invalid limit refuses real CLI up with key named", invalidUp.status !== 0 && (invalidUp.stderr + invalidUp.stdout).includes("accountLimits.conn"));
  check("invalid CLI load preserves saved account claim", (await getSpaceAuth(workspaceSecretStore(root), space))?.account.jwt === saved);
  mkdirSync(join(xdg, "cotal"), { recursive: true });
  writeFileSync(join(xdg, "cotal/config.json"), JSON.stringify({ accountLimits: { conn: 48, subs: 256 } }));
  writeFileSync(config, JSON.stringify({ accountLimits: { conn: 40 } }));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const merged = loadCotalConfig(root).accountLimits;
    check("config layers merge limits per field with local precedence", merged?.conn === 40 && merged.subs === 256);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
  check("stopped reprovision accepts changed limits", cli("up", "--no-manager", "--json").status === 0);
  check("changed config is persisted after stopped reprovision", decode<Account>((await getSpaceAuth(workspaceSecretStore(root), space))!.account.jwt).nats.limits?.conn === 40);
  check("final stop succeeds", cli("down", "--yes", "--json").status === 0);
  const onDisk = readFileSync(config, "utf8");
  check("open broker refuses account-only setting", cli("up", "--no-manager", "--open", "--json").status !== 0);
  check("open refusal preserves operator config", readFileSync(config, "utf8") === onDisk);
  check("full resolver boot applies configured account ceilings", cli("up", "--no-manager", "--account-resolver", "full", "--json").status === 0);
  const fullAuth = (await getSpaceAuth(workspaceSecretStore(root), space))!;
  const full = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  check("full resolver reports configured disk ceiling", (await (await jetstreamManager(full)).getAccountInfo()).limits.max_storage === limits.disk_storage);
  await full.close();
  check("full resolver stop succeeds", cli("down", "--yes", "--json").status === 0);
  writeFileSync(config, JSON.stringify({ accountLimits: { conn: 44, disk_storage: 8388608 } }));
  check("full resolver accepts stopped claim update", cli("up", "--no-manager", "--json").status === 0);
  const fullChanged = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  check("full resolver observes updated ceiling instead of cached claim", (await (await jetstreamManager(fullChanged)).getAccountInfo()).limits.max_storage === 8388608);
  await fullChanged.close();
  check("full resolver update keeps account identity", (await getSpaceAuth(workspaceSecretStore(root), space))?.account.pub === fullAuth.account.pub);
} finally {
  for (const nc of connections) await nc.close();
  cli("down", "--yes", "--json");
  rmSync(dir, { recursive: true, force: true });
}
finish();
