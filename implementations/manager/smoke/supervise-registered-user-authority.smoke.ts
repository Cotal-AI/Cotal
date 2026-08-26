/**
 * Registered remote user-manager authority repro.
 *
 * Starts a real user-auth broker, auth service, IdP and public exchange; registers a separate
 * participant root with the production remote-entry writer (manual/user/remote, no up marker);
 * signs the participant in; then mints the existing provider's remote user bearer. The bearer
 * connects successfully as its granted user actor, but is broker-denied from the endpoint setup and
 * records surfaces a Manager must use to register `manager` as a service.
 *
 * This is a RED architecture cell, not a workaround: it proves that registry fallback plus the
 * current AuthProvider.userCredentials contract cannot make a remote Manager functional. A future
 * server/auth contract must add an explicitly-scoped service-manager authority; this test must flip
 * only when that authority is present and constrained.
 *
 * All homes, workspace roots, the broker store, and IdP state are scratch. Requires nats-server.
 * Run: pnpm smoke:supervise-registered-user-authority
 */

// The auth daemon is a real registered command and stays live, so dispatch it in a child re-exec
// before the harness creates temp directories a child must not recreate.
const subcommand = process.argv[2] ?? "";
if (subcommand === "auth-service") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) { values[key] = next; index++; }
    else values[key] = true;
  }
  const command = registry.all<Command>("command").find((candidate) => candidate.name === subcommand);
  if (!command) throw new Error("auth-service command was not registered");
  await command.run({ values, positionals, raw: rest });
  process.exit(0);
}

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
const betterAuthRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
const { betterAuth } = await import(new URL("dist/index.mjs", betterAuthRoot).href);
const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterAuthRoot).href);
const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterAuthRoot).href);
const { deviceAuthorization } = await import(new URL("dist/plugins/device-authorization/index.mjs", betterAuthRoot).href);
const { bearer: betterAuthBearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterAuthRoot).href);
const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterAuthRoot).href);
import {
  CotalEndpoint,
  createSpaceAuth,
  mintCreds,
  newIdentity,
  recordsBucket,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
} from "@cotal-ai/core";
import {
  assertUserAuthInfo,
  authDir,
  hasUserAuthState,
  userAuthStateDir,
  workspaceSecretStore,
} from "@cotal-ai/workspace";
import {
  cotalAuthProvider,
  establishIdpSession,
  grantActor,
  loadAuthServiceInfo,
  loadCalloutAuth,
} from "@cotal-ai/auth";
import { persistRemoteUserEntry } from "../../cli/src/commands/meshes-add.js";
import { pickFreePort } from "../../auth/smoke/_free-port.js";

const self = process.argv[1]!;
const participantHome = mkdtempSync(join(tmpdir(), "cotal-registered-manager-home-"));
const hostRoot = mkdtempSync(join(tmpdir(), "cotal-registered-manager-host-"));
const participantRoot = mkdtempSync(join(tmpdir(), "cotal-registered-manager-participant-"));
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = participantHome;

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const space = `registered-manager-${Math.random().toString(36).slice(2, 10)}`;
const brokerPort = await pickFreePort();
const publicPort = await pickFreePort();
const server = `nats://127.0.0.1:${brokerPort}`;
const clientId = "registered-manager-smoke";
const hostDir = userAuthStateDir(hostRoot, space);
const participantDir = userAuthStateDir(participantRoot, space);
const hostStore = workspaceSecretStore(hostRoot);
const participantStore = workspaceSecretStore(participantRoot);
let authService: ReturnType<typeof spawn> | undefined;
let broker: ReturnType<typeof spawn> | undefined;
let idpServer: ReturnType<typeof createServer> | undefined;
let endpoint: CotalEndpoint | undefined;

function spawnAuthService(): ReturnType<typeof spawn> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  env.COTAL_HOME = participantHome;
  return spawn(process.execPath, [...process.execArgv, self, "auth-service", "--space", space, "--server", server, "--exchange-public-port", String(publicPort)], {
    cwd: hostRoot,
    env,
    stdio: "ignore",
  });
}

async function awaitAuthService(timeoutMs = 15_000): Promise<{ url: string; publicUrl?: string; pid: number }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const info = loadAuthServiceInfo(hostDir);
    if (info) {
      try {
        process.kill(info.pid, 0);
        if ((await fetch(`${info.url}/health`)).ok) return info;
      } catch { /* still booting */ }
    }
    await wait(100);
  }
  throw new Error(`auth service did not become ready at ${hostDir}`);
}

try {
  mkdirSync(join(hostRoot, ".cotal"), { recursive: true });
  mkdirSync(join(participantRoot, ".cotal"), { recursive: true });

  // Real local host authority: only this root has account signer + auth service state.
  const auth = await createSpaceAuth(space);
  const { saveSpaceAuth } = await import("@cotal-ai/workspace");
  saveSpaceAuth(authDir(hostRoot), auth);
  // Bring up the IdP before provider preparation, rather than hand-writing auth state or
  // bypassing the provider seam.
  let handler: ReturnType<typeof toNodeHandler> | undefined;
  idpServer = createServer((request, response) => handler!(request, response));
  await new Promise<void>((resolve) => idpServer!.listen(0, "127.0.0.1", resolve));
  const address = idpServer.address();
  if (address === null || typeof address === "string") throw new Error("IdP did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({
    baseURL: origin,
    secret: "registered-manager-smoke-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === clientId }),
      betterAuthBearer(),
    ],
  });
  handler = toNodeHandler(idp);
  const preparedHost = await cotalAuthProvider.prepareServer({
    space,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore,
    dir: hostDir,
    idpUrl,
  });
  check("host provider prepared user-auth state against the real IdP", Boolean(preparedHost));

  const storeDir = mkdtempSync(join(tmpdir(), "cotal-registered-manager-js-"));
  writeFileSync(join(hostRoot, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: brokerPort,
    storeDir,
    extraAccounts: preparedHost.extraAccounts,
  }));
  broker = spawn("nats-server", ["-c", join(hostRoot, "server.conf")], { stdio: "ignore" });
  let brokerReady = false;
  for (let tries = 0; tries < 50 && broker.exitCode === null; tries++) {
    try {
      const nc = await connect({
        servers: server,
        ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }),
        maxReconnectAttempts: 0,
        timeout: 300,
      });
      await nc.close();
      brokerReady = true;
      break;
    } catch { await wait(100); }
  }
  check("user-auth broker is running", brokerReady && broker.exitCode === null);
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  authService = spawnAuthService();
  const service = await awaitAuthService();
  check("host auth service exposes a public exchange", typeof service.publicUrl === "string" && service.publicUrl.startsWith("http://127.0.0.1:"), service);

  const signup = await idp.api.signUpEmail({
    body: { email: "participant@example.test", password: "correct-horse-battery", name: "Participant" },
    returnHeaders: true,
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const approve = async (userCode: string): Promise<void> => {
    await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
    const response = await fetch(`${idpUrl}/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ userCode }),
    });
    if (!response.ok) throw new Error(`device approval failed: HTTP ${response.status}`);
  };
  const { sub } = await establishIdpSession({
    dir: participantHome,
    idpUrl,
    clientId,
    onPrompt: (prompt) => void approve(prompt.userCode),
  });
  const owner = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });
  check("participant login is established", typeof sub === "string" && sub.length > 0);
  grantActor(hostDir, { owner, actor: "cli", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"] });

  const callout = await loadCalloutAuth(hostStore, space);
  if (!callout) throw new Error("host callout material is missing after preparation");
  persistRemoteUserEntry(space, server, participantRoot, {
    space,
    server,
    tlsRequired: false,
    userAuth: assertUserAuthInfo({
      provider: "cotal",
      idp: { url: idpUrl, issuer: origin, audience: origin },
      endpoints: { url: service.publicUrl },
    }),
    sentinelCreds: callout.sentinelCreds,
  }, false, false);
  check("participant registry entry is remote user mode", existsSync(participantDir));
  check("participant has no local hosting marker", hasUserAuthState(participantRoot, space) === false);

  // The existing provider seam is enough for an ordinary remote USER connection. This establishes
  // the control condition: the later denial is lack of manager service authority, not login/dial.
  const material = await cotalAuthProvider.userCredentials({
    store: participantStore,
    dir: participantDir,
    space,
    actor: "cli",
  });
  const payload = JSON.parse(Buffer.from(material.bearer.split(".")[1]!, "base64url").toString("utf8")) as {
    sub: string;
    act: { actor: string; lifecycleUid: string };
  };
  endpoint = new CotalEndpoint({
    space,
    servers: server,
    bearer: () => cotalAuthProvider.userCredentials({ store: participantStore, dir: participantDir, space, actor: "cli" }).then((value) => value.bearer),
    sentinelCreds: material.sentinelCreds,
    lifecycleUid: payload.act.lifecycleUid,
    channels: [],
    consume: false,
    watchChannels: false,
    card: { owner: payload.sub, actor: payload.act.actor, name: "registered-participant", kind: "endpoint" },
  });
  endpoint.on("error", () => {});
  await endpoint.start();
  check("existing provider bearer connects from the registry-only participant", endpoint.principal.owner === owner && endpoint.principal.actor === "cli", endpoint.principal);

  // Manager.start() needs both endpoint stream setup (manager.ts:4566-4579) and records/auth KV
  // authority for service registration (manager.ts:4509-4522, 4696). A normal user bearer is
  // intentionally an agent-profile bearer. Probe the first write-free prerequisite: even
  // STREAM.INFO on records is broker-denied; no client-side inference can promote it.
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ bearer: material.bearer, sentinelCreds: material.sentinelCreds, tls: false }), maxReconnectAttempts: 0 });
  let refusal = "";
  try {
    await (await jetstreamManager(nc)).streams.info(`KV_${recordsBucket(space)}`);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
  check("remote signed-in bearer cannot read manager service records (no endpoint-registration authority)", refusal.length > 0 && /permission|authorization|responders/i.test(refusal), refusal);

  console.log(`\nSUPERVISE REGISTERED USER AUTHORITY REPRO ${fail === 0 ? "RED OBSERVED ✅" : "FAILED"} (${pass} passed, ${fail} failed)`);
} catch (error) {
  fail++;
  console.log("  ✗ FAIL: harness threw", error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await endpoint?.stop().catch(() => {});
  try { authService?.kill("SIGTERM"); } catch { /* already gone */ }
  try { broker?.kill("SIGTERM"); } catch { /* already gone */ }
  await wait(200);
  idpServer?.close();
  rmSync(participantHome, { recursive: true, force: true });
  rmSync(participantRoot, { recursive: true, force: true });
  rmSync(hostRoot, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}

process.exit(fail === 0 ? 0 : 1);
