import { createConnection } from "node:net";
import { ensureCalloutAuth, loadCalloutAuth } from "@cotal-ai/auth";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decode, type Account } from "@nats-io/jwt";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import * as core from "@cotal-ai/core";
const { applyAccountLimits, chatSubject, createBrokerAuth, createSpaceAccountAuth, createSpaceAuth, loadCotalConfig, membershipBucket, mintCreds, mintLifecycleUid, newIdentity, presenceBucket, readCotalConfigFile, revokeAccountUser, standaloneConnectOpts } = core;
import { getSpaceAuth, putSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
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
const config = join(xdg, "cotal/config.json"), projectConfig = join(root, ".cotal/config.json");
mkdirSync(join(xdg, "cotal"), { recursive: true });
const connections: NatsConnection[] = [];
try {
  const fresh = await createSpaceAuth("freshlimits", { conn: 40 });
  check("public new-account API applies configured limit", decode<Account>(fresh.account.jwt).nats.limits?.conn === 40);
  check("public new-account API retains absent storage defaults", decode<Account>(fresh.account.jwt).nats.limits?.disk_storage === -1);
  const tenant = await createSpaceAccountAuth(await createBrokerAuth("tenantlimits"), "tenantlimits", { consumer: 64 });
  check("public tenant-account API applies configured consumer limit", decode<Account>(tenant.account.jwt).nats.limits?.consumer === 64);
  const revoked = await revokeAccountUser(fresh, newIdentity().id, Math.floor(Date.now() / 1000));
  if (typeof applyAccountLimits !== "function") {
    for (const name of ["reissue retains revocations and signing keys", "partial reissue retains other saved limits", "absent API setting returns original auth unchanged", "same-valued API setting returns original auth unchanged", "explicit -1 removes saved account limit"])
      check(name, false, "account limit reissue API is absent");
  } else {
  const auxiliaryRoot = join(dir, "auxiliary");
  mkdirSync(auxiliaryRoot, { recursive: true, mode: 0o700 });
  const auxiliaryStore = workspaceSecretStore(auxiliaryRoot);
  await putSpaceAuth(auxiliaryStore, fresh);
  const callout = await ensureCalloutAuth(auxiliaryStore, { space: fresh.space, operatorSeed: fresh.operator.seed, accountPub: fresh.account.pub });
  const rewritten = await applyAccountLimits(revoked, { subs: 128 });
  await putSpaceAuth(auxiliaryStore, rewritten);
  check("applying and persisting limits preserves callout account and credentials", JSON.stringify(await loadCalloutAuth(auxiliaryStore, fresh.space)) === JSON.stringify(callout));
  check("applying and persisting limits preserves system account", (await getSpaceAuth(auxiliaryStore, fresh.space))?.sys.jwt === fresh.sys.jwt);
  check("limits leave system account and operator unchanged", JSON.stringify(rewritten.sys) === JSON.stringify(revoked.sys) && JSON.stringify(rewritten.operator) === JSON.stringify(revoked.operator));
  const oldClaims = decode<Account>(revoked.account.jwt), newClaims = decode<Account>(rewritten.account.jwt);
  check("reissue retains revocations and signing keys", JSON.stringify(oldClaims.nats.revocations) === JSON.stringify(newClaims.nats.revocations) && JSON.stringify(oldClaims.nats.signing_keys) === JSON.stringify(newClaims.nats.signing_keys));
  check("partial reissue retains other saved limits", newClaims.nats.limits?.conn === 40 && newClaims.nats.limits?.subs === 128);
  check("absent API setting returns original auth unchanged", await applyAccountLimits(rewritten) === rewritten);
  check("same-valued API setting returns original auth unchanged", await applyAccountLimits(rewritten, { subs: 128 }) === rewritten);
  const unlimited = await applyAccountLimits(rewritten, { conn: -1 });
  check("explicit -1 removes saved account limit", decode<Account>(unlimited.account.jwt).nats.limits?.conn === -1);
  }
  let invalidApi = false;
  try { await createSpaceAuth("badlimits", { conn: 0 }); } catch (error) { invalidApi = String(error).includes("accountLimits.conn"); }
  check("public provisioning API rejects invalid keyed limit", invalidApi);
  const prepared = cli("space", "create", space, "--root", root, "--json");
  check("preexisting control: space create succeeds", prepared.status === 0, prepared.stderr);
  const started = cli("up", "--no-manager", "--server", servers, "--json");
  check("preexisting control: unconfigured CLI up succeeds", started.status === 0, started.stderr);
  const original = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!original) throw new Error("CLI did not persist account trust");
  const before = decode<Account>(original.account.jwt).nats.limits;
  check("preexisting control: omitted setting keeps unlimited account claims", before?.conn === -1 && before.subs === -1 && before.payload === -1 && before.mem_storage === -1 && before.disk_storage === -1);
  const identity = newIdentity();
  const creds = await mintCreds(original, identity, "provisioner");
  const control = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  check("preexisting control: shipped minted credential connects to real broker", control.info?.port === port);
  await control.close();
  check("preexisting control: CLI down succeeds", cli("down", "--yes", "--json").status === 0);
  writeFileSync(config, JSON.stringify({ accountLimits: limits }));
  const limited = cli("up", "--no-manager", "--server", servers, "--json");
  check("configured CLI restart succeeds", limited.status === 0, limited.stderr + limited.stdout);
  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!auth) throw new Error("account trust missing after restart");
  check("reprovision preserves account identity and signer", auth.account.pub === original.account.pub && auth.account.signingPub === original.account.signingPub);
  const after = decode<Account>(auth.account.jwt).nats.limits;
  for (const [key, value] of Object.entries(limits)) check(`configured account claim records ${key}`, after?.[key as keyof typeof limits] === value);
  check("CLI reports each changed ceiling after re-sign", Object.keys(limits).every(key => (limited.stderr + limited.stdout).includes(`${key}=${limits[key as keyof typeof limits]}`)) && (limited.stderr + limited.stdout).includes("applied accountLimits"));
  check("CLI application leaves system claim unchanged", auth.sys.jwt === original.sys.jwt && auth.operator.jwt === original.operator.jwt);
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  connections.push(nc);
  const info = await (await jetstreamManager(nc)).getAccountInfo();
  check("real broker reports configured memory storage", info.limits.max_memory === limits.mem_storage);
  check("real broker reports configured disk storage", info.limits.max_storage === limits.disk_storage);
  check("real broker reports configured consumer count", info.limits.max_consumers === limits.consumer);
  let refused = false;
  for (let i = 0; i < 33; i++) {
    try { connections.push(await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false, timeout: 1000 })); }
    catch (error) { refused = connections.length >= limits.conn - 8 && connections.length <= limits.conn && /maximum.*connections|connections.*exceeded|ECONNRESET/i.test(String(error)); break; }
  }
  check("real broker refuses connections beyond configured cap", refused);
  for (const other of connections.splice(1)) await other.close();
  check("client learns account payload limit from broker INFO", nc.info?.max_payload === limits.payload);
  let payloadRefused = false;
  try { nc.publish("$JS.API.INFO", new Uint8Array(limits.payload + 1)); } catch (error) { payloadRefused = /payload/i.test(String(error)); }
  check("informed client refuses payload above negotiated ceiling", payloadRefused);
  const rawRefusal = await new Promise<string>((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let received = "", phase = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw payload probe timed out")); }, 5000);
    socket.on("error", error => {
      if (!/maximum payload|payload.*violation/i.test(received)) reject(error);
    });
    socket.on("close", () => { clearTimeout(timer); done(received); });
    socket.on("data", chunk => {
      received += chunk.toString();
      if (phase === 0 && received.includes("\r\n")) {
        const info = JSON.parse(received.split("\r\n")[0].slice(5)) as { nonce: string };
        const options = standaloneConnectOpts({ creds, tls: false }) as { authenticator: (nonce: string) => { jwt?: string; nkey?: string; sig?: string } };
        const credentials = options.authenticator(info.nonce);
        phase = 1;
        socket.write(`CONNECT ${JSON.stringify({ ...credentials, verbose: false, protocol: 1, lang: "smoke", version: "1" })}\r\nPING\r\n`);
      }
      if (phase === 1 && received.includes("PONG\r\n")) {
        phase = 2;
        socket.write(`PUB _INBOX_${identity.id}.payload ${limits.payload + 1}\r\n`);
      }
    });
  });
  check("broker itself rejects raw oversized PUB bypassing client check", /maximum payload|payload.*violation/i.test(rawRefusal), rawRefusal);
  const sub = nc.subscribe(`_INBOX_${identity.id}.control`, { max: 1, timeout: 3000 });
  await nc.flush();
  nc.publish("$JS.API.INFO", new Uint8Array(), { reply: sub.getSubject() });
  let delivered = "";
  for await (const message of sub) delivered = new TextDecoder().decode(message.data);
  check("within-cap subscription receives actual broker API reply", JSON.parse(delivered).type === "io.nats.jetstream.api.v1.account_info_response");
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
  check("consumer creation within account ceiling succeeds", createdConsumers > 0);
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
  check("allowed stored message succeeds below account ceiling", stored > 0);
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
  check("memory-backed writes succeed below account ceiling", memoryStored > 0);
  check("real broker refuses writes beyond account memory ceiling", memoryRefused);
  await memory.close();
  let saved = auth.account.jwt;
  writeFileSync(config, JSON.stringify({ accountLimits: { ...limits, conn: 40 } }));
  const changedLive = cli("up", "--no-manager", "--json");
  check("changed limits refuse while owned broker is running", changedLive.status !== 0 && (changedLive.stderr + changedLive.stdout).includes("accountLimits"));
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
    const key = value && typeof value === "object" && !Array.isArray(value) ? `accountLimits.${Object.keys(value)[0]}` : "accountLimits must be an object";
    check(`invalid limit names specific key ${key}`, message.includes(key) && message.includes(config));
  }
  for (const key of ["conn", "subs", "payload"] as const) {
    for (const value of [2147483648, 4294967295, 4294967296]) {
      writeFileSync(config, JSON.stringify({ accountLimits: { [key]: value } }));
      const overflow = cli("up", "--no-manager", "--json");
      check(`int32 overflow ${key}=${value} refuses CLI with exact key`, overflow.status !== 0 && (overflow.stderr + overflow.stdout).includes(`accountLimits.${key}`) && (overflow.stderr + overflow.stdout).includes("2147483647"));
      if (overflow.status === 0) cli("down", "--yes", "--json");
    }
  }
  for (const key of ["conn", "subs", "payload"] as const) {
    writeFileSync(config, JSON.stringify({ accountLimits: { [key]: 2147483647 } }));
    check(`int32 maximum ${key} accepted at load`, readCotalConfigFile(config).accountLimits?.[key] === 2147483647);
  }
  writeFileSync(config, JSON.stringify({ accountLimits: { mem_storage: Number.MAX_SAFE_INTEGER, disk_storage: Number.MAX_SAFE_INTEGER, consumer: Number.MAX_SAFE_INTEGER } }));
  check("JetStream limits retain safe-integer range", readCotalConfigFile(config).accountLimits?.consumer === Number.MAX_SAFE_INTEGER);
  writeFileSync(config, JSON.stringify({ accountLimits: limits }));
  check("recover known operator policy after overflow probes", cli("up", "--no-manager", "--json").status === 0);
  cli("down", "--yes", "--json");
  saved = (await getSpaceAuth(workspaceSecretStore(root), space))!.account.jwt;
  writeFileSync(config, JSON.stringify({ accountLimits: { conn: 0 } }));
  const invalidUp = cli("up", "--no-manager", "--json");
  check("invalid limit refuses real CLI up with key named", invalidUp.status !== 0 && (invalidUp.stderr + invalidUp.stdout).includes("accountLimits.conn"));
  check("invalid CLI load preserves saved account claim", (await getSpaceAuth(workspaceSecretStore(root), space))?.account.jwt === saved);
  if (invalidUp.status === 0) cli("down", "--yes", "--json");
  writeFileSync(config, JSON.stringify({ accountLimits: { ...limits, conn: 40 } }));
  for (const projectLimits of [{ conn: -1, subs: -1, payload: -1, mem_storage: -1, disk_storage: -1, consumer: -1 }, { conn: 16 }]) {
    writeFileSync(projectConfig, JSON.stringify({ accountLimits: projectLimits }));
    const project = cli("up", "--no-manager", "--json");
    check(`project policy ${projectLimits.conn} refuses real CLI naming project file and key`, project.status !== 0 && (project.stderr + project.stdout).includes(projectConfig) && (project.stderr + project.stdout).includes("accountLimits") && (project.stderr + project.stdout).includes("operator-only") && (project.stderr + project.stdout).includes(`remove accountLimits from ${projectConfig}`) && (project.stderr + project.stdout).includes(`operator file ${config} if wanted`) && !(project.stderr + project.stdout).includes("move it"));
    check(`project policy ${projectLimits.conn} cannot persist any changed claim`, (await getSpaceAuth(workspaceSecretStore(root), space))?.account.jwt === saved);
    if (project.status === 0) cli("down", "--yes", "--json");
  }
  rmSync(config);
  writeFileSync(projectConfig, JSON.stringify({ accountLimits: { conn: -1 } }));
  const projectOnly = cli("up", "--no-manager", "--json");
  check("project policy refuses even without operator setting and advises removal", projectOnly.status !== 0 && (projectOnly.stderr + projectOnly.stdout).includes(`remove accountLimits from ${projectConfig}`) && (projectOnly.stderr + projectOnly.stdout).includes(`operator file ${config} if wanted`));
  if (projectOnly.status === 0) cli("down", "--yes", "--json");
  writeFileSync(projectConfig, "{invalid JSON");
  const badJson = cli("up", "--no-manager", "--json");
  check("up refuses unparseable project config naming file", badJson.status !== 0 && (badJson.stderr + badJson.stdout).includes(projectConfig) && (badJson.stderr + badJson.stdout).includes("invalid JSON"));
  if (badJson.status === 0) cli("down", "--yes", "--json");
  rmSync(projectConfig);
  writeFileSync(config, JSON.stringify({ accountLimits: { ...limits, conn: 40 }, connectors: "invalid-unrelated", modelPolicy: null, spawn: 42 }));
  const operatorUnrelated = cli("up", "--no-manager", "--json");
  check("valid operator policy ignores malformed unrelated operator sections at startup", operatorUnrelated.status === 0 && decode<Account>((await getSpaceAuth(workspaceSecretStore(root), space))!.account.jwt).nats.limits?.conn === 40, operatorUnrelated.stderr + operatorUnrelated.stdout);
  writeFileSync(config, JSON.stringify({ accountLimits: { ...limits, conn: 40 } }));
  writeFileSync(projectConfig, JSON.stringify({ accountLimits: { conn: -1 } }));
  const spawnRefusal = cli("spawn", "--space", space);
  check("spawn refuses project accountLimits naming source and safe remedy", spawnRefusal.status !== 0 && (spawnRefusal.stderr + spawnRefusal.stdout).includes(`remove accountLimits from ${projectConfig}`) && (spawnRefusal.stderr + spawnRefusal.stdout).includes("operator-only"), spawnRefusal.stderr + spawnRefusal.stdout);
  rmSync(projectConfig);
  cli("down", "--yes", "--json");
  writeFileSync(config, JSON.stringify({ accountLimits: { ...limits, conn: 40 } }));
  writeFileSync(projectConfig, JSON.stringify({ accountLimits: { conn: 16 } }));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    let refusal = "";
    try { loadCotalConfig(root); } catch (error) { refusal = String(error); }
    check("merged public config loader refuses project accountLimits", refusal.includes(projectConfig) && refusal.includes("accountLimits") && refusal.includes("operator-only"));
    rmSync(projectConfig);
    const loaded = loadCotalConfig(root).accountLimits;
    check("operator account limits load unchanged", loaded?.conn === 40 && loaded.subs === limits.subs);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
  check("stopped reprovision accepts changed limits", cli("up", "--no-manager", "--json").status === 0);
  check("changed config is persisted after stopped reprovision", decode<Account>((await getSpaceAuth(workspaceSecretStore(root), space))!.account.jwt).nats.limits?.conn === 40);
  check("final stop succeeds", cli("down", "--yes", "--json").status === 0);
  const onDisk = readFileSync(config, "utf8");
  const openAttempt = cli("up", "--no-manager", "--open", "--json");
  check("open broker refuses account-only setting with key named", openAttempt.status !== 0 && (openAttempt.stderr + openAttempt.stdout).includes("accountLimits"));
  if (openAttempt.status === 0) cli("down", "--yes", "--json");
  check("open refusal preserves operator config", readFileSync(config, "utf8") === onDisk);
  const manifestRoot = join(dir, "manifest-root");
  mkdirSync(join(manifestRoot, ".cotal"), { recursive: true, mode: 0o700 });
  const manifest = join(manifestRoot, "open.yaml");
  writeFileSync(manifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker: { servers: "${servers}", auth: false }\nchannels:\n  general: { description: Open coordination. }\n`);
  const manifestSaved = (await getSpaceAuth(workspaceSecretStore(root), space))?.account.jwt;
  const manifestOpen = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(wt, "bin/cotal.ts"), "up", "--file", manifest, "--dry-run"], { cwd: manifestRoot, env, encoding: "utf8", timeout: 120_000 });
  check("manifest open mode refuses accountLimits by name", manifestOpen.status !== 0 && (manifestOpen.stderr + manifestOpen.stdout).includes("accountLimits requires an authenticated broker"), manifestOpen.stderr + manifestOpen.stdout);
  check("manifest refusal preserves saved account claim", (await getSpaceAuth(workspaceSecretStore(root), space))?.account.jwt === manifestSaved);
  check("full resolver boot succeeds", cli("up", "--no-manager", "--account-resolver", "full", "--json").status === 0);
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
  check("final configured broker stops", cli("down", "--yes", "--json").status === 0);
  rmSync(config);
  writeFileSync(projectConfig, JSON.stringify({ connectors: "invalid-unrelated", modelPolicy: null, spawn: 42 }));
  const unrelatedAuth = cli("up", "--no-manager", "--json");
  check("absent limits: malformed unrelated project section does not block existing authenticated mesh", unrelatedAuth.status === 0, unrelatedAuth.stderr + unrelatedAuth.stdout);
  cli("down", "--yes", "--json");
  const openRoot = join(dir, "open-root");
  mkdirSync(join(openRoot, ".cotal"), { recursive: true, mode: 0o700 });
  writeFileSync(join(openRoot, ".cotal/config.json"), JSON.stringify({ connectors: "invalid-unrelated", modelPolicy: null, spawn: 42 }));
  const openAnchor = recordSmokeSandbox({ root: openRoot, cotalHome: home, xdgConfigHome: xdg });
  const openCli = (...args: string[]) => {
    const opts = { cwd: openRoot, env, encoding: "utf8" as const, timeout: 120_000 };
    assertSmokeSandboxDown(openAnchor, args, opts);
    return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(wt, "bin/cotal.ts"), ...args], opts);
  };
  try {
    check("separate open root space create", openCli("space", "create", "openlimits", "--root", openRoot, "--json").status === 0);
    const unrelatedOpen = openCli("up", "--no-manager", "--open", "--server", `nats://127.0.0.1:${await freePort()}`, "--json");
    check("absent limits: malformed unrelated project section does not block open mesh", unrelatedOpen.status === 0, unrelatedOpen.stderr + unrelatedOpen.stdout);
  } finally {
    if (openCli("down", "--yes", "--json").status !== 0) throw new Error(`open sandbox shutdown failed; retained ${dir}`);
  }
} finally {
  for (const nc of connections) await nc.close();
  const stopped = cli("down", "--yes", "--json");
  if (stopped.status !== 0) throw new Error(`owned sandbox shutdown failed; retained ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}
finish();
