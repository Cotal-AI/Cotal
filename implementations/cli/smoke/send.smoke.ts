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
  dmDurable,
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
const EXPECTED = 36;
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
let carol: CotalEndpoint | undefined;
let dave: CotalEndpoint | undefined;
let witness: CotalEndpoint | undefined;
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

  // The admin credential for the `deliver pending` reads below is minted before bob stops, so no
  // setup sits inside the retained-card window that the by-name read depends on.
  const adminIdentity = newIdentity();
  const adminCreds = join(tmp, "admin.creds");
  const adminCredsText = await mintCreds(auth, adminIdentity, "admin");
  writeFileSync(adminCreds, adminCredsText, { mode: 0o600 });

  // A second recipient (carol) proves the filter: her send is held in the DM stream before bob's
  // read below, and that read must never list it.
  const carolIdentity = newIdentity();
  const carolUid = mintLifecycleUid();
  const carolCreds = await provisionAgent(provisioner, auth, carolIdentity, {
    lifecycleUid: carolUid,
    role: "reviewer",
    subscribe: [],
    allowSubscribe: [],
  });
  carol = new CotalEndpoint({
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

  // Dave is a live, non-consuming recipient (consume:false: no inbound consumers, so nothing acks
  // his DM durable, while registerPresence keeps his card heartbeating after the lifecycle proof).
  // The message held for him is established while he is live, so each later read has exactly one
  // CLI launch inside whatever window it depends on.
  const daveIdentity = newIdentity();
  const daveUid = mintLifecycleUid();
  const daveCreds = await provisionAgent(provisioner, auth, daveIdentity, {
    lifecycleUid: daveUid,
    role: "holder",
    subscribe: [],
    allowSubscribe: [],
  });
  dave = new CotalEndpoint({
    space,
    servers,
    creds: daveCreds,
    lifecycleUid: daveUid,
    card: { name: "dave", role: "holder", kind: "agent", id: daveIdentity.id },
    channels: [],
    consume: false,
    heartbeatMs: 500,
    ttlMs: 10_000,
  });
  dave.on("error", () => {});
  await dave.start();
  const daveDurable = dmDurable(DEV_OWNER, daveIdentity.id, daveUid);
  const daveText = `dave-held-${randomUUID().slice(0, 6)}`;
  const daveDm = await run(["send", "dm", "dave", daveText]);
  check("`cotal send dm` to live non-consuming dave exits 0", daveDm.code === 0, daveDm.stderr);
  const candidateIds = (out: string) => [...out.matchAll(/^\s+([0-9a-f-]{36})\s+from=/gm)].map((m) => m[1]);
  const daveLive = await run(["deliver", "pending", "dave", "--creds", adminCreds, "--space", space, "--server", servers]);
  const daveIds = candidateIds(daveLive.stdout);
  check(
    "`deliver pending dave` by name (live card) prints dave's exact durable, pending 1 and one candidate id",
    daveLive.code === 0 && daveLive.stdout.split("\n")[0] === daveDurable && daveLive.stdout.split("\n")[1] === "pending 1" && daveIds.length === 1,
    { code: daveLive.code, stdout: daveLive.stdout, stderr: daveLive.stderr, daveDurable },
  );
  // M2b: `--durable <name>` reads the exact consumer the by-name read printed, skipping name
  // resolution, and reports the same pending count and candidate.
  const daveByDurableLive = await run(["deliver", "pending", "dave", "--durable", daveDurable, "--creds", adminCreds, "--space", space, "--server", servers]);
  check(
    "`deliver pending dave --durable <name>` exits 0 and prints the same pending count and candidate id",
    daveByDurableLive.code === 0 && daveByDurableLive.stdout.split("\n")[1] === "pending 1" && candidateIds(daveByDurableLive.stdout).join() === daveIds.join(),
    daveByDurableLive.stdout,
  );

  // Retained offline card: stop dave after his message is held, and the pending read is the only
  // CLI launch after the stop, inside the one-TTL window the offline card is kept for.
  await dave.stop();
  const daveRetained = await run(["deliver", "pending", "dave", "--creds", adminCreds, "--space", space, "--server", servers]);
  check(
    "`deliver pending dave` by name resolves the retained offline card: same durable, pending 1, same candidate id",
    daveRetained.code === 0 && daveRetained.stdout.split("\n")[0] === daveDurable && daveRetained.stdout.split("\n")[1] === "pending 1" && candidateIds(daveRetained.stdout).join() === daveIds.join() && daveIds.length === 1,
    { code: daveRetained.code, stdout: daveRetained.stdout, stderr: daveRetained.stderr },
  );

  // M3: stop bob, send within the retained-card window (a graceful stop publishes `offline`
  // synchronously, before its lifecycle uid is retired), and assert the line names the offline
  // status rather than fabricating "delivered". This send is the only launch after bob's stop.
  await bob.stop();
  const offlineText = `offline-${randomUUID().slice(0, 6)}`;
  const offlineDm = await run(["send", "dm", "bob", offlineText]);
  check("`cotal send dm` to a just-stopped recipient still exits 0", offlineDm.code === 0, offlineDm.stderr);
  check(
    "the offline-window `send dm` line reports the recipient as offline at send, never delivered",
    /stored seq \d+/.test(offlineDm.stdout) && offlineDm.stdout.includes("recipient offline at send") && !offlineDm.stdout.includes("delivered"),
    offlineDm.stdout,
  );
  // Bob's held send is read through his exact durable, which does not depend on his card.
  const bobDurable = dmDurable(DEV_OWNER, bobIdentity.id, bobUid);
  const pendingBob = await run(["deliver", "pending", "bob", "--durable", bobDurable, "--creds", adminCreds, "--space", space, "--server", servers]);
  check("`deliver pending bob --durable` exits 0 with the admin credential", pendingBob.code === 0 && pendingBob.stdout.split("\n")[0] === bobDurable, pendingBob.stderr);
  check("`deliver pending bob --durable` reports at least one pending message", /pending [1-9]\d*/.test(pendingBob.stdout), pendingBob.stdout);
  check(
    "`deliver pending bob --durable` lists candidate ids for the offline send",
    candidateIds(pendingBob.stdout).length >= 1,
    pendingBob.stdout,
  );

  const pendingDurableMissing = await run(["deliver", "pending", "bob", "--durable", "dm_local-nope-nope", "--creds", adminCreds, "--space", space, "--server", servers]);
  check("`deliver pending bob --durable dm_local-nope-nope` exits non-zero with not-found", pendingDurableMissing.code !== 0 && /not-found/i.test(pendingDurableMissing.stderr), pendingDurableMissing.stderr);

  // Carol's card can be gone by now, so her held send's id is read through her exact durable
  // (the same owner/actor the credential-derived principal carries).
  const carolDurable = dmDurable(DEV_OWNER, carolIdentity.id, carolUid);
  const pendingCarolForId = await run(["deliver", "pending", "carol", "--durable", carolDurable, "--creds", adminCreds, "--space", space, "--server", servers]);
  const carolIdMatch = pendingCarolForId.stdout.match(/^\s*([0-9a-f-]{8,})\s+from=/m);
  check(
    "`deliver pending bob` never lists carol's held send",
    carolIdMatch !== null && !pendingBob.stdout.includes(carolIdMatch[1]),
    { carolId: carolIdMatch?.[1], pendingBobStdout: pendingBob.stdout },
  );

  // Expiry: a fresh core observer reads the presence bucket through its own watch snapshot. An
  // empty bucket replays nothing, so `waitForPresenceSnapshot` reports "timeout" there and a
  // roster with no dave would prove nothing. A live witness agent keeps one card in the bucket, so
  // a completed snapshot is a real read of the bucket, and dave's absence from it is the broker
  // having expired his card. Nothing here writes, refreshes or forges dave's card.
  const witnessIdentity = newIdentity();
  const witnessUid = mintLifecycleUid();
  const witnessCreds = await provisionAgent(provisioner, auth, witnessIdentity, {
    lifecycleUid: witnessUid,
    role: "witness",
    subscribe: [],
    allowSubscribe: [],
  });
  witness = new CotalEndpoint({
    space,
    servers,
    creds: witnessCreds,
    lifecycleUid: witnessUid,
    card: { name: "witness", role: "witness", kind: "agent", id: witnessIdentity.id },
    channels: [],
    consume: false,
    heartbeatMs: 500,
    ttlMs: 10_000,
  });
  witness.on("error", () => {});
  await witness.start();
  type BucketRead = { hydrated: boolean; witness: boolean; dave: boolean };
  const readBucket = async (): Promise<BucketRead> => {
    const obs = new CotalEndpoint({
      space, servers, creds: adminCredsText, channels: [], consume: false, registerPresence: false,
      watchPresence: true, card: { name: "send-expiry-observer", kind: "endpoint" },
    });
    obs.on("error", () => {});
    try {
      await obs.start();
      const hydrated = (await obs.waitForPresenceSnapshot(5_000)) === "snapshot";
      const roster = obs.getRoster();
      return { hydrated, witness: roster.some((p) => p.card.name === "witness"), dave: roster.some((p) => p.card.name === "dave") };
    } finally {
      await obs.stop();
    }
  };
  // Bounded wait for the broker's TTL: dave's card was last written at his stop, and the bucket
  // keeps it for one TTL (6000 ms). The loop only waits; it never turns a missing read into success.
  let expiryRead: BucketRead = { hydrated: false, witness: false, dave: true };
  for (let i = 0; i < 40; i++) {
    expiryRead = await readBucket();
    if (!expiryRead.hydrated || !expiryRead.witness || !expiryRead.dave) break;
    await wait(500);
  }
  check("the expiry observer's presence snapshot hydrated and shows the live witness", expiryRead.hydrated && expiryRead.witness, expiryRead);
  check("that hydrated snapshot holds no card for stopped dave (expired by the broker TTL)", expiryRead.hydrated && expiryRead.witness && !expiryRead.dave, expiryRead);
  const daveExpired = expiryRead.hydrated && expiryRead.witness && !expiryRead.dave;
  const daveGone = await run(["deliver", "pending", "dave", "--creds", adminCreds, "--space", space, "--server", servers]);
  check(
    "`deliver pending dave` by name after the card expired exits non-zero with not-found",
    daveExpired && daveGone.code !== 0 && /not-found: no agent "dave"/.test(daveGone.stderr),
    { code: daveGone.code, stderr: daveGone.stderr },
  );
  const daveExpiredByDurable = await run(["deliver", "pending", "dave", "--durable", daveDurable, "--creds", adminCreds, "--space", space, "--server", servers]);
  check(
    "`deliver pending dave --durable` after expiry still holds pending 1 and the same candidate id",
    daveExpiredByDurable.code === 0 && daveExpiredByDurable.stdout.split("\n")[1] === "pending 1" && candidateIds(daveExpiredByDurable.stdout).join() === daveIds.join() && daveIds.length === 1,
    daveExpiredByDurable.stdout,
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
  await carol?.stop().catch(() => {});
  await dave?.stop().catch(() => {});
  await witness?.stop().catch(() => {});
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
