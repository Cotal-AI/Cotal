/**
 * One-shot send commands (`cotal send dm|msg|ask`) — live end-to-end through the real CLI parser,
 * transient endpoint, and broker. The suite owns an OS-assigned open JetStream broker and passes
 * its address explicitly to every participant, so it cannot borrow or collide with an ambient mesh.
 *
 * Isolation: every CLI child gets a sandboxed HOME / XDG_CONFIG_HOME / TMPDIR / COTAL_HOME, and
 * inherited COTAL_* is stripped. COTAL_SKIP_CONNECTOR_SEED is a reconcile skip, not a store fence;
 * the seed store follows XDG_CONFIG_HOME (via globalConfigDir()), not COTAL_HOME.
 *
 * Run: pnpm smoke:send
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const EXPECTED = 15;
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

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url));

const home = mkdtempSync(join(tmpdir(), "cotal-send-home-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"), { recursive: true });
const xdg = join(home, "xdg");
mkdirSync(xdg);
const tmp = mkdtempSync(join(tmpdir(), "cotal-send-tmp-"));
const releaseTmp = teardownPathOnSignal(tmp);
const meshRoot = join(tmp, "mesh-root");
mkdirSync(join(meshRoot, ".cotal"), { recursive: true });

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
      ["--import", "tsx", cli, ...args],
      { cwd: root, env: { ...isolatedEnv, ...extra } },
      (err, stdout, stderr) =>
        resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
  });

let provisioner: CotalEndpoint | undefined;
let bob: CotalEndpoint | undefined;
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

  const target: string[] = [];

  const dmText = `outside-u-${randomUUID().slice(0, 6)}`;
  const msgText = `outside-m-${randomUUID().slice(0, 6)}`;
  const askText = `outside-a-${randomUUID().slice(0, 6)}`;
  const dm = await run(["send", "dm", "bob", dmText, ...target]);
  const msg = await run(["send", "msg", "general", msgText, ...target]);
  const ask = await run(["send", "ask", "reviewer", askText, ...target]);
  await wait(700);

  check("`cotal send dm` outside a seat exits 0", dm.code === 0, dm.stderr);
  check("`cotal send msg` outside a seat exits 0", msg.code === 0, msg.stderr);
  check("`cotal send ask` outside a seat exits 0", ask.code === 0, ask.stderr);
  check(
    "the outside-seat DM carries the credential-derived principal and CLI display name",
    got.some((m) => m.route === "DM" && m.text === dmText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromName === "cotal-send"),
    got,
  );
  check(
    "the outside-seat channel message carries the credential-derived principal and CLI display name",
    got.some((m) => m.route === "#general" && m.text === msgText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromName === "cotal-send"),
    got,
  );
  check(
    "the outside-seat anycast carries the credential-derived principal and CLI display name",
    got.some((m) => m.route === "ANY:reviewer" && m.text === askText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromName === "cotal-send"),
    got,
  );

  const spoofText = `spoof-${randomUUID().slice(0, 6)}`;
  const spoof = await run(["send", "dm", "bob", spoofText, ...target], {
    COTAL_NAME: "forged-seat",
    COTAL_ID: "forged_actor",
    COTAL_OWNER: "forged-owner",
    COTAL_ACTOR: "forged-actor",
  });
  await wait(400);
  check("seat-shaped environment does not block an operator-credential send", spoof.code === 0, spoof.stderr);
  check(
    "seat-shaped environment cannot replace the credential-derived principal",
    got.some((m) => m.route === "DM" && m.text === spoofText && m.fromId.startsWith(`${DEV_OWNER}.`) && m.fromId !== "forged-owner.forged-actor" && m.fromName === "cotal-send"),
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
    got.some((m) => m.route === "DM" && m.text === explicitText && m.fromId === explicitPrincipal && m.fromName === "cotal-send"),
    got,
  );

  const missing = await run(["send", "dm", "nobody-here", "x", ...target]);
  check("`cotal send dm` to an absent agent exits non-zero", missing.code !== 0, missing.code);
  check("`cotal send dm` to an absent agent says 'no agent'", /no agent/i.test(missing.stderr), missing.stderr);

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
