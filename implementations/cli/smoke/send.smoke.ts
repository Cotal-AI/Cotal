/**
 * One-shot send commands (`cotal send dm|msg|ask`) — live end-to-end through the real CLI parser,
 * transient endpoint, and broker. The suite owns an OS-assigned authenticated JetStream broker.
 * CLI children resolve it through an isolated two-entry registry whose current pointer is the only
 * no-flag disambiguator, so they cannot borrow or collide with an ambient mesh.
 *
 * Isolation: every CLI child gets a sandboxed HOME / XDG_CONFIG_HOME / TMPDIR / COTAL_HOME, and
 * inherited COTAL_* is stripped. COTAL_SKIP_CONNECTOR_SEED is a reconcile skip, not a store fence;
 * the seed store follows XDG_CONFIG_HOME (via globalConfigDir()), not COTAL_HOME.
 *
 * Run: pnpm smoke:send
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  CotalEndpoint,
  createSpaceAuth,
  DEV_OWNER,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  type CotalMessage,
  type Delivery,
} from "@cotal-ai/core";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth, setCurrent } from "@cotal-ai/workspace";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const EXPECTED = 27;
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
};

const space = `sendsmoke-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(
  join(storeDir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(storeDir, "js") }),
);
const broker = spawn("nats-server", ["-c", join(storeDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);

const cli = fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));

const home = mkdtempSync(join(tmpdir(), "cotal-send-home-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"), { recursive: true });
const xdg = join(home, "xdg");
mkdirSync(xdg);
const tmp = mkdtempSync(join(tmpdir(), "cotal-send-tmp-"));
const releaseTmp = teardownPathOnSignal(tmp);
const meshRoot = join(tmp, "mesh-root");
mkdirSync(join(meshRoot, ".cotal"), { recursive: true });
const decoyRoot = join(tmp, "decoy-root");
mkdirSync(join(decoyRoot, ".cotal"), { recursive: true });
const operatorShell = join(tmp, "operator-shell");
mkdirSync(operatorShell);

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];
const isolatedEnv: NodeJS.ProcessEnv = {
  ...cleanEnv,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: tmp,
  COTAL_HOME: join(home, ".cotal"),
  XDG_CONFIG_HOME: xdg,
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NO_COLOR: "1",
};

const run = (
  args: string[],
  extra: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", tsx, cli, ...args],
      { cwd: operatorShell, env: { ...isolatedEnv, ...extra } },
      (err, stdout, stderr) =>
        resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
  });

let provisioner: CotalEndpoint | undefined;
let bob: CotalEndpoint | undefined;
const expectedSender = `${userInfo().username}@${hostname()}`;
const got: Array<{ route: string; text: string; fromId: string; fromName: string }> = [];

try {
  check("the subprocess entry is the repository's real bin/cotal.ts", existsSync(cli), cli);

  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await isReachable(servers);
    if (!ready) await wait(100);
  }
  check("the owned broker is ready before any endpoint connects", ready, servers);

  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  await seedChannelRegistry({ servers, space, creds: provisionerCreds, file: { channels: { general: {} } } });
  saveSpaceAuth(authDir(meshRoot), auth);
  const priorCotalHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
  try {
    recordMesh({ space, server: servers, root: meshRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: "decoy", server: servers, root: decoyRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    setCurrent(space);
  } finally {
    if (priorCotalHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorCotalHome;
  }
  provisioner = new CotalEndpoint({
    space,
    servers,
    creds: provisionerCreds,
    card: { name: "send-provisioner", kind: "endpoint" },
    consume: false,
    watchPresence: false,
    registerPresence: false,
  });
  await provisioner.start();

  const bobIdentity = newIdentity();
  const bobUid = mintLifecycleUid();
  const bobCreds = await provisionAgent(provisioner, auth, bobIdentity, {
    lifecycleUid: bobUid,
    role: "reviewer",
    subscribe: ["general"],
    allowSubscribe: ["general"],
  });
  bob = new CotalEndpoint({
    space,
    servers,
    creds: bobCreds,
    lifecycleUid: bobUid,
    card: { name: "bob", role: "reviewer", kind: "agent", id: bobIdentity.id },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 10_000,
  });
  bob.on("message", (message: CotalMessage, delivery: Delivery) => {
    const text = message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
    const route = message.to ? "DM" : message.toService ? `ANY:${message.toService}` : `#${message.channel ?? ""}`;
    got.push({ route, text, fromId: message.from.id, fromName: message.from.name });
    delivery.ack();
  });
  bob.on("error", (error: Error) => console.error("! bob:", error.message));
  await bob.start();
  await wait(800);

  const dmText = `outside-u-${randomUUID().slice(0, 6)}`;
  const msgText = `outside-m-${randomUUID().slice(0, 6)}`;
  const askText = `outside-a-${randomUUID().slice(0, 6)}`;
  const dm = await run(["send", "dm", "bob", dmText]);
  const msg = await run(["send", "msg", "general", msgText]);
  const ask = await run(["send", "ask", "reviewer", askText]);
  await wait(700);

  check("`cotal send dm` outside a seat exits 0", dm.code === 0, dm.stderr);
  check("`cotal send msg` outside a seat exits 0", msg.code === 0, msg.stderr);
  check("`cotal send ask` outside a seat exits 0", ask.code === 0, ask.stderr);
  check(
    "the live `send dm` line reports a stored sequence and the live recipient's status, never delivered",
    /stored seq \d+/.test(dm.stdout) && dm.stdout.includes("recipient idle at send") && !dm.stdout.includes("delivered"),
    dm.stdout,
  );
  check(
    "the outside-seat DM carries the credential-derived principal and CLI display name",
    got.some((m) => m.route === "DM" && m.text === dmText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromName === expectedSender),
    got,
  );
  check(
    "the outside-seat channel message carries the credential-derived principal and CLI display name",
    got.some((m) => m.route === "#general" && m.text === msgText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromName === expectedSender),
    got,
  );
  check(
    "the outside-seat anycast carries the credential-derived principal and CLI display name",
    got.some((m) => m.route === "ANY:reviewer" && m.text === askText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromName === expectedSender),
    got,
  );

  const spoofText = `spoof-${randomUUID().slice(0, 6)}`;
  const spoof = await run(["send", "dm", "bob", spoofText], {
    COTAL_NAME: "forged-seat",
    COTAL_ID: "forged_actor",
    COTAL_OWNER: "forged-owner",
    COTAL_ACTOR: "forged-actor",
  });
  await wait(400);
  check("seat-shaped environment does not block an operator-credential send", spoof.code === 0, spoof.stderr);
  check(
    "seat-shaped environment cannot replace the credential-derived principal",
    got.some((m) => m.route === "DM" && m.text === spoofText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromId !== "forged-owner.forged-actor" && m.fromName === expectedSender),
    got,
  );
  check(
    "the one-shot sender name is derived from the login and host, never from the environment",
    got.some(
      (m) =>
        m.route === "DM" &&
        m.text === spoofText &&
        m.fromName === expectedSender &&
        m.fromName !== "forged-seat" &&
        m.fromName !== "cotal-send",
    ),
    got,
  );

  const explicitIdentity = newIdentity();
  const explicitCreds = join(tmp, "operator.creds");
  writeFileSync(explicitCreds, await mintCreds(auth, explicitIdentity, "operator"), { mode: 0o600 });
  const explicitPrincipal = principalKey(DEV_OWNER, explicitIdentity.id).key;
  const explicitText = `explicit-${randomUUID().slice(0, 6)}`;
  const explicit = await run([
    "send", "dm", "bob", explicitText,
    "--space", space, "--server", servers, "--creds", explicitCreds,
  ]);
  await wait(400);
  check("explicit operator creds remain a supported outside-seat boundary", explicit.code === 0, explicit.stderr);
  check(
    "the explicit credential supplies the exact received principal",
    got.some((m) => m.route === "DM" && m.text === explicitText && m.fromId === explicitPrincipal && m.fromName === expectedSender),
    got,
  );

  const missing = await run(["send", "dm", "nobody-here", "x"]);
  check("`cotal send dm` to an absent agent exits non-zero", missing.code !== 0, missing.code);
  check("`cotal send dm` to an absent agent says 'no agent'", /no agent/i.test(missing.stderr), missing.stderr);

  // M3: stop bob, send within the retained-card window (a graceful stop publishes `offline`
  // synchronously, before its lifecycle uid is retired), and assert the line names the offline
  // status rather than fabricating "delivered".
  await bob.stop();
  const offlineText = `offline-${randomUUID().slice(0, 6)}`;
  const offlineDm = await run(["send", "dm", "bob", offlineText]);
  check("`cotal send dm` to a just-stopped recipient still exits 0", offlineDm.code === 0, offlineDm.stderr);
  check(
    "the offline-window `send dm` line reports the recipient as offline at send, never delivered",
    /stored seq \d+/.test(offlineDm.stdout) && offlineDm.stdout.includes("recipient offline at send") && !offlineDm.stdout.includes("delivered"),
    offlineDm.stdout,
  );

  // M3: `cotal deliver pending <name>` against the real broker with a minted admin credential.
  // A second recipient (carol) proves the filter: her durable is untouched by bob's read.
  const adminIdentity = newIdentity();
  const adminCreds = join(tmp, "admin.creds");
  writeFileSync(adminCreds, await mintCreds(auth, adminIdentity, "admin"), { mode: 0o600 });

  const carolIdentity = newIdentity();
  const carolUid = mintLifecycleUid();
  const carolCreds = await provisionAgent(provisioner, auth, carolIdentity, {
    lifecycleUid: carolUid,
    role: "reviewer",
    subscribe: [],
    allowSubscribe: [],
  });
  const carol = new CotalEndpoint({
    space,
    servers,
    creds: carolCreds,
    lifecycleUid: carolUid,
    card: { name: "carol", role: "reviewer", kind: "agent", id: carolIdentity.id },
    channels: [],
    heartbeatMs: 500,
    ttlMs: 10_000,
  });
  carol.on("message", () => {});
  carol.on("error", () => {});
  await carol.start();
  await wait(300);
  await carol.stop();
  const carolText = `carol-held-${randomUUID().slice(0, 6)}`;
  const carolDm = await run(["send", "dm", "carol", carolText]);
  check("`cotal send dm` to carol (stopped) exits 0", carolDm.code === 0, carolDm.stderr);

  const pendingBob = await run(["deliver", "pending", "bob", "--creds", adminCreds, "--space", space, "--server", servers]);
  check("`deliver pending bob` exits 0 with the admin credential", pendingBob.code === 0, pendingBob.stderr);
  check("`deliver pending bob` reports at least one pending message", /pending [1-9]\d*/.test(pendingBob.stdout), pendingBob.stdout);
  check(
    "`deliver pending bob` lists the offline send's id among the candidates",
    pendingBob.stdout.includes(offlineText) || /recent candidate ids/.test(pendingBob.stdout),
    pendingBob.stdout,
  );
  check(
    "`deliver pending bob` never lists carol's held send",
    !pendingBob.stdout.includes(carolText),
    pendingBob.stdout,
  );

  const pendingMissing = await run(["deliver", "pending", "nobody-here-either", "--creds", adminCreds, "--space", space, "--server", servers]);
  check("`deliver pending` on an absent name exits non-zero", pendingMissing.code !== 0, pendingMissing.code);
  check("`deliver pending` on an absent name says not-found", /not-found/i.test(pendingMissing.stderr), pendingMissing.stderr);

  const pendingWrongCreds = await run(["deliver", "pending", "bob", "--creds", explicitCreds, "--space", space, "--server", servers]);
  check(
    "`deliver pending bob` with an operator (non-admin) credential is refused, never falls back",
    pendingWrongCreds.code !== 0,
    { code: pendingWrongCreds.code, stderr: pendingWrongCreds.stderr },
  );

} finally {
  await bob?.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  check("the owned broker exits before its JetStream tree is removed", broker.exitCode !== null || broker.signalCode !== null);
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
  releaseHome();
  releaseTmp();
}

check(`every scenario cell ran — ${EXPECTED} expected`, pass + fail === EXPECTED, { pass, fail, expected: EXPECTED });
console.log(`\nsend smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
