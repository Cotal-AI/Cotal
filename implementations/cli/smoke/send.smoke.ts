/**
 * One-shot send commands (`cotal send -t|-c|-r`) — live end-to-end through the real CLI parser,
 * transient endpoint, and broker. The suite owns an OS-assigned authenticated JetStream broker.
 * CLI children resolve it through an isolated two-entry registry whose current pointer is the only
 * no-flag disambiguator, so they cannot borrow or collide with an ambient mesh.
 *
 * Isolation: every CLI child gets a sandboxed HOME / XDG_CONFIG_HOME / TMPDIR / COTAL_HOME, and
 * inherited COTAL_* is stripped. COTAL_SKIP_CONNECTOR_SEED is a reconcile skip, not a store fence;
 * the seed store follows XDG_CONFIG_HOME (via globalConfigDir()), not COTAL_HOME.
 *
 * Leak check (#4091): each one-shot send reads presence and the channel registry once, with no watch
 * consumer, and a channel send reads that channel's policy with a Direct Get, so the consumer count
 * on both buckets is the same before and after the sends. The old watch, and the policy read's scan,
 * left one consumer per send on the bucket they read for five minutes. `cotal channel` on the same
 * operator credential reads the registry with a Direct Get and leaves no consumer either. An operator
 * credential passed with `--creds` reads the same way. An agent credential, which holds no Direct
 * Get row, watches instead, and one that may not read presence is refused.
 * operator credential reads the registry with a Direct Get and leaves no consumer either. A post to
 * an unregistered channel reads that channel's retained count once with STREAM.INFO, which opens no
 * consumer.
 *
 * Run: pnpm smoke:send
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  channelBucket,
  CotalEndpoint,
  createSpaceAuth,
  credsProblem,
  DEV_OWNER,
  dmDurable,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  presenceBucket,
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
const EXPECTED = 75;
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
// Bob's endpoint options and message handler, kept so the same lifecycle can come back later.
let bobOptions: ConstructorParameters<typeof CotalEndpoint>[0];
const onBobMessage = (message: CotalMessage, delivery: Delivery) => {
  const text = message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
  const route = message.to ? "DM" : message.toService ? `ANY:${message.toService}` : `#${message.channel ?? ""}`;
  got.push({ route, text, fromId: message.from.id, fromName: message.from.name });
  delivery.ack();
};

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
  bobOptions = {
    space,
    servers,
    creds: bobCreds,
    lifecycleUid: bobUid,
    card: { name: "bob", role: "reviewer", kind: "agent", id: bobIdentity.id },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 10_000,
  };
  bob = new CotalEndpoint(bobOptions);
  bob.on("message", onBobMessage);
  bob.on("error", (error: Error) => console.error("! bob:", error.message));
  await bob.start();
  await wait(800);

  // The consumer count on the presence and channel-registry streams, read from the broker.
  const inspectorId = newIdentity();
  const inspector = await connect({
    servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, inspectorId, "admin"))),
    inboxPrefix: `_INBOX_${inspectorId.id}`,
  });
  const inspectorJsm = await jetstreamManager(inspector);
  const watchConsumers = async (): Promise<{ presence: number; channels: number }> => ({
    presence: (await inspectorJsm.streams.info(`KV_${presenceBucket(space)}`)).state.consumer_count,
    channels: (await inspectorJsm.streams.info(`KV_${channelBucket(space)}`)).state.consumer_count,
  });
  const consumersBefore = await watchConsumers();

  const dmText = `outside-u-${randomUUID().slice(0, 6)}`;
  const msgText = `outside-m-${randomUUID().slice(0, 6)}`;
  const askText = `outside-a-${randomUUID().slice(0, 6)}`;
  const dm = await run(["send", "-t", "bob", dmText]);
  const msg = await run(["send", "-c", "general", msgText]);
  const ask = await run(["send", "-r", "reviewer", askText]);
  await wait(700);
  const consumersAfter = await watchConsumers();
  const listed = await run(["channel"]);
  const consumersAfterList = await watchConsumers();
  // A --creds credential reads once when its own grant holds the Direct Get rows, as the operator
  // credential does. An agent credential from `cotal auth mint` holds none, so it watches instead.
  const operatorRead = join(tmp, "operator-read.creds");
  writeFileSync(operatorRead, await mintCreds(auth, newIdentity(), "operator"), { mode: 0o600 });
  const agentRead = join(tmp, "agent-read.creds");
  writeFileSync(agentRead, await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid(), allowPublish: ["general"] }), { mode: 0o600 });
  const noRead = join(tmp, "no-read.creds");
  writeFileSync(noRead, await mintCreds(auth, newIdentity(), "probe"), { mode: 0o600 });
  const operatorReadText = `creds-operator-${randomUUID().slice(0, 6)}`;
  const agentReadText = `creds-agent-${randomUUID().slice(0, 6)}`;
  const operatorSend = await run(["send", "-c", "general", operatorReadText, "--space", space, "--server", servers, "--creds", operatorRead]);
  await wait(700);
  const consumersAfterOperator = await watchConsumers();
  const agentSend = await run(["send", "-c", "general", agentReadText, "--space", space, "--server", servers, "--creds", agentRead]);
  const noReadSend = await run(["send", "-c", "general", "never stored", "--space", space, "--server", servers, "--creds", noRead, "--json"]);
  await wait(700);
  const consumersAfterAgent = await watchConsumers();
  // A channel with no registry entry: a first post says it starts the channel, a later one says the
  // channel already has messages, and both name the registered channels.
  const fresh = `fresh-${randomUUID().slice(0, 6)}`;
  const firstFresh = await run(["send", "-c", fresh, "one"]);
  const laterFresh = await run(["send", "-c", fresh, "two", "--json"]);
  const consumersAfterFresh = await watchConsumers();
  await inspector.close();

  check(
    "the consumer count reads bob's own presence and channel-registry watches",
    consumersBefore.presence >= 1 && consumersBefore.channels >= 1,
    consumersBefore,
  );
  check(
    "three one-shot sends leave no consumer on the presence or channel-registry stream (#4091)",
    consumersAfter.presence === consumersBefore.presence && consumersAfter.channels === consumersBefore.channels,
    { before: consumersBefore, after: consumersAfter },
  );
  check("`cotal channel` exits 0 and lists the seeded #general", listed.code === 0 && listed.stdout.includes("#general"), listed);
  check(
    "`cotal channel` leaves no consumer on the channel-registry stream (#4091)",
    consumersAfterList.channels === consumersAfter.channels,
    { before: consumersAfter, after: consumersAfterList },
  );

  check(
    "an operator credential passed with --creds reads once and leaves no consumer",
    operatorSend.code === 0 && got.some((m) => m.route === "#general" && m.text === operatorReadText) &&
      consumersAfterOperator.presence === consumersAfterList.presence && consumersAfterOperator.channels === consumersAfterList.channels,
    { operatorSend, before: consumersAfterList, after: consumersAfterOperator },
  );
  check(
    "an agent credential passed with --creds, which holds no Direct Get row, watches presence and its channel send is stored",
    agentSend.code === 0 && got.some((m) => m.route === "#general" && m.text === agentReadText) && consumersAfterAgent.presence > consumersAfterOperator.presence,
    { agentSend, before: consumersAfterOperator, after: consumersAfterAgent },
  );
  check(
    "a credential passed with --creds that may not read presence refuses PERMISSION_DENIED, exit 2, before anything is sent",
    noReadSend.code === 2 && noReadSend.stdout.includes('"code":"PERMISSION_DENIED"') && !got.some((m) => m.text === "never stored"),
    noReadSend,
  );
  check(
    "a first post to an unregistered channel says it starts the channel and names the registered ones",
    firstFresh.code === 0 && firstFresh.stderr.includes(`#${fresh} has no channel metadata and no earlier message, so this message starts it`) && firstFresh.stderr.includes("Registered channels: #general."),
    firstFresh,
  );
  const laterWarning = laterFresh.code === 0 ? (JSON.parse(laterFresh.stdout) as { warnings: { code: string; message: string; target: { earlierMessages?: unknown; registered?: unknown } }[] }).warnings.find((w) => w.code === "CHANNEL_UNREGISTERED") : undefined;
  check(
    "a later post to it says the channel already has messages, and its JSON warning carries both facts",
    laterWarning !== undefined && laterWarning.message.includes(`#${fresh} already has messages`) && laterWarning.target.earlierMessages === true && JSON.stringify(laterWarning.target.registered) === JSON.stringify(["general"]),
    laterFresh,
  );
  check(
    "reading an unregistered channel's earlier messages leaves no consumer on the presence or channel-registry stream",
    consumersAfterFresh.presence === consumersAfterAgent.presence && consumersAfterFresh.channels === consumersAfterAgent.channels,
    { before: consumersAfterAgent, after: consumersAfterFresh },
  );

  check("`cotal send -t` outside a seat exits 0", dm.code === 0, dm.stderr);
  check("`cotal send -c` outside a seat exits 0", msg.code === 0, msg.stderr);
  check("`cotal send -r` outside a seat exits 0", ask.code === 0, ask.stderr);
  // A role send is stored whether or not anyone holds the role, so a mistyped role used to pass with
  // no word. bob holds reviewer here.
  const [typo, unheld] = await Promise.all([["reviewr", "--json"], ["planner"]].map((rest) => run(["send", "-r", ...rest, "x"])));
  check("a role send no present participant holds is stored with ROLE_NOT_HELD naming the closest held role; a held role gets none",
    typo!.code === 0 && typo!.stdout.includes('"code":"ROLE_NOT_HELD"') && typo!.stdout.includes('"nearest":"reviewer"') && typo!.stdout.includes("Did you mean reviewer?")
      && !ask.stderr.includes("No present participant holds role"), { typo, ask: ask.stderr });
  check("a role with no close held role lists the roles present instead",
    unheld!.code === 0 && unheld!.stderr.includes("No present participant holds role planner; the message waits on that role's queue until one takes it.")
      && /Present participants hold [^.]*reviewer/.test(unheld!.stderr) && !unheld!.stderr.includes("Did you mean"), unheld);
  check(
    "the `send -t` receipt to a live recipient reports a stored sequence and unconfirmed delivery, never delivered",
    /Stored sequence:\s+\d+/.test(dm.stdout) && /Delivery:\s+not confirmed/.test(dm.stdout) && !dm.stdout.includes("delivered"),
    dm.stdout,
  );
  check("the `send -t` to a live recipient prints no offline warning", dm.code === 0 && !dm.stderr.includes("is offline"), dm.stderr);
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
  const spoof = await run(["send", "-t", "bob", spoofText], {
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
    "send", "-t", "bob", explicitText,
    "--space", space, "--server", servers, "--creds", explicitCreds,
  ]);
  await wait(400);
  check("explicit operator creds remain a supported outside-seat boundary", explicit.code === 0, explicit.stderr);
  check(
    "the explicit credential supplies the exact received principal",
    got.some((m) => m.route === "DM" && m.text === explicitText && m.fromId === explicitPrincipal && m.fromName === expectedSender),
    got,
  );
  // Without --server the credential goes to the broker its space is registered at, never the default address.
  const registeredText = `registered-${randomUUID().slice(0, 6)}`;
  const registered = await run(["send", "-t", "bob", registeredText, "--space", space, "--creds", explicitCreds]);
  await wait(400);
  check("explicit creds without --server reach the broker the space is registered at",
    registered.code === 0 && got.some((m) => m.route === "DM" && m.text === registeredText && m.fromId === explicitPrincipal), registered.stderr);
  const unregistered = await run(["send", "-t", "bob", "x", "--space", "not-registered", "--creds", explicitCreds]);
  check("explicit creds for a space not registered here are refused before any dial, TARGET_NOT_FOUND, exit 2",
    unregistered.code === 2 && unregistered.stderr.includes("TARGET_NOT_FOUND") && unregistered.stderr.includes('space "not-registered" is not registered here, so nothing was dialed'), unregistered.stderr);
  // The file is checked before any dial, so a serving broker is never reported unreachable over it.
  const crlfCreds = join(tmp, "crlf.creds");
  writeFileSync(crlfCreds, readFileSync(explicitCreds, "utf8").replace(/\n/g, "\r\n"), { mode: 0o600 });
  const crlf = await run(["send", "-t", "bob", "x", "--space", space, "--server", servers, "--creds", crlfCreds]);
  check("a creds file with CRLF line endings is refused naming the file and the cause, SCHEMA_INVALID, exit 1",
    crlf.code === 1 && crlf.stderr.includes("SCHEMA_INVALID") && crlf.stderr.includes(`creds file ${crlfCreds} cannot be used: it has Windows (CRLF) line endings`) && !/can't reach/.test(crlf.stderr), crlf.stderr);
  const minted = readFileSync(explicitCreds, "utf8");
  const shapes = [minted, "", minted.slice(0, 200), minted.slice(0, minted.indexOf("-----BEGIN USER NKEY SEED")), minted.replace(/\nSU[A-Z0-9]+\n/, "\nSUNOTASEED\n"), minted.replace(/\n/g, "\r\n")];
  const codes = shapes.map((text) => credsProblem(text)?.code ?? "ok");
  check("the pre-dial check names each malformed shape and passes the minted file",
    JSON.stringify(codes) === JSON.stringify(["ok", "empty", "no-jwt-block", "no-seed-block", "invalid-seed", "crlf"]), codes);
  const absent = await run(["send", "-t", "bob", "x", "--space", space, "--server", servers, "--creds", join(tmp, "absent.creds")]);
  check("a missing creds file is TARGET_NOT_FOUND, exit 2, without the command's help",
    absent.code === 2 && absent.stderr.includes("TARGET_NOT_FOUND") && absent.stderr.includes("creds file not found:") && !absent.stderr.includes("Usage"), absent.stderr);
  const sharedCreds = join(tmp, "shared.creds");
  writeFileSync(sharedCreds, readFileSync(explicitCreds));
  chmodSync(sharedCreds, 0o644);
  const sharedText = `shared-${randomUUID().slice(0, 6)}`;
  const shared = await run(["send", "-t", "bob", sharedText, "--space", space, "--server", servers, "--creds", sharedCreds]);
  await wait(400);
  check("a creds file other accounts can read is still used, with a warning that names chmod 600",
    shared.code === 0 && got.some((m) => m.route === "DM" && m.text === sharedText) && (process.platform === "win32" || shared.stderr.includes(`creds file ${sharedCreds} is not private to you (mode 0644); chmod 600 ${sharedCreds}`)), shared.stderr);
  // Another account that can write the file's folder can swap it, so it is refused as auth mint refuses to write there.
  if (process.platform !== "win32") {
    const loose = join(tmp, "loose"), looseCreds = join(loose, "a.creds");
    mkdirSync(loose);
    chmodSync(loose, 0o777);
    writeFileSync(looseCreds, readFileSync(explicitCreds), { mode: 0o600 });
    const looseText = `loose-${randomUUID().slice(0, 6)}`;
    const refused = await run(["send", "-t", "bob", looseText, "--space", space, "--server", servers, "--creds", looseCreds]);
    await wait(400);
    check("a creds file in a folder every account can write is refused PERMISSION_DENIED, exit 2, naming the folder and its chmod, and nothing is sent",
      refused.code === 2 && refused.stderr.includes("PERMISSION_DENIED") && refused.stderr.includes(`creds file ${looseCreds} cannot be used: its path is not protected against other local writers: ${loose} is writable by every local account`)
        && refused.stderr.includes(`chmod o-w ${loose}`) && !got.some((m) => m.text === looseText), refused.stderr);
    chmodSync(loose, 0o700);
    const fixedText = `fixed-${randomUUID().slice(0, 6)}`;
    const fixed = await run(["send", "-t", "bob", fixedText, "--space", space, "--server", servers, "--creds", looseCreds]);
    await wait(400);
    check("  once the folder is private the same file is used", fixed.code === 0 && got.some((m) => m.route === "DM" && m.text === fixedText), fixed.stderr);
  }

  const missing = await run(["send", "-t", "nobody-here", "x"]);
  check("`cotal send -t` to an absent agent is refused, exit 2", missing.code === 2, missing.code);
  check("`cotal send -t` to an absent agent says TARGET_NOT_FOUND and no matching participant", missing.stderr.includes("TARGET_NOT_FOUND") && missing.stderr.includes("no matching participant"), missing.stderr);

  // Two participants sharing a name used to be listed by id alone, with nothing saying which is which.
  // Names match without regard to case, so "twin" and "Twin" are one name and each label shows its own.
  const twinProvisioner = provisioner;
  const twins = await Promise.all([{ name: "twin", kind: "agent" as const }, { name: "Twin", kind: "endpoint" as const, meta: { sessionKind: "chat" } }].map(async (card) => {
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const creds = await provisionAgent(twinProvisioner, auth, identity, { lifecycleUid, subscribe: [], allowSubscribe: [] });
    const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid, card: { id: identity.id, ...card }, channels: [], heartbeatMs: 500, ttlMs: 10_000 });
    ep.on("error", () => {});
    await ep.start();
    return ep;
  }));
  await wait(500);
  const twin = await run(["send", "-t", "TWIN", "x", "--json"]);
  const twinRemedy = (() => { try { return (JSON.parse(twin.stdout) as { error?: { remedy?: string } }).error?.remedy ?? ""; } catch { return ""; } })();
  check("a name two participants share in any case refuses with each full identity labelled by its display name, kind and start time",
    twin.code === 2 && twin.stdout.includes('"code":"TARGET_AMBIGUOUS"') && twinRemedy.includes(`${twins[0]!.card.id} ("twin", agent, started `) && twinRemedy.includes(`${twins[1]!.card.id} ("Twin", chat session, started `), twin);
  for (const ep of twins) await ep.stop();

  // A lone `-` used to be published as the text "-": stdin is read only when asked for. An empty
  // quoted body used to be told to choose one body, with a remedy for another destination.
  const dash = await run(["send", "-c", "general", "-", "--json"]);
  check("`cotal send -c general -` is refused, names --stdin and --file -, and suggests the same channel",
    dash.code === 1 && dash.stdout.includes('"code":"USAGE_INVALID"') && dash.stdout.includes('a lone \\"-\\" is not read as stdin; send stdin with --stdin or --file -') && dash.stdout.includes("run cotal send -c general --stdin"), dash);
  const empty = await run(["send", "-c", "general", "", "--json"]);
  check("an empty quoted body says the message is empty and suggests the same channel",
    empty.code === 1 && empty.stdout.includes('"message":"the message is empty"') && empty.stdout.includes('run cotal send -c general \\"<message>\\"'), empty);
  // An empty recipient used to be told to choose one body, with a `-t` remedy whatever flag was given.
  const blanks = await Promise.all([["-t", ""], ["--to=", null], ["-r", ""], ["-c", "#"]].map(([option, value]) => run(["send", option!, ...(value === null ? [] : [value!]), "x", "--json"])));
  check("an empty --to, --role or --channel value is refused for that flag, with a remedy that keeps it",
    blanks.every((r) => r.code === 1 && r.stdout.includes('"code":"USAGE_INVALID"') && !r.stdout.includes("exactly one body"))
      && blanks[0]!.stdout.includes('"message":"--to/-t is empty; name one agent or full instance id"') && blanks[0]!.stdout.includes('run cotal send -t <agent> \\"<message>\\"')
      && blanks[1]!.stdout.includes('"message":"--to/-t is empty;')
      && blanks[2]!.stdout.includes('"message":"--role/-r is empty; name one role"') && blanks[2]!.stdout.includes('run cotal send -r <role> \\"<message>\\"')
      && blanks[3]!.stdout.includes('"message":"--channel/-c is empty; name one channel"') && blanks[3]!.stdout.includes('run cotal send -c <channel> \\"<message>\\"'), blanks);
  // A channel or role name the subject rules refuse gets their reason; only a wildcard gets the wildcard one.
  const unsafe = await run(["send", "-c", "kanäle", "x", "--json"]);
  check("`cotal send -c` with a name that is not NATS-safe is USAGE_INVALID, exit 1, naming the segment",
    unsafe.code === 1 && unsafe.stdout.includes('"code":"USAGE_INVALID"') && unsafe.stdout.includes('segment \\"kanäle\\" must be a NATS-safe token'), unsafe);
  const spaced = await run(["send", "-c", "gen eral", "x", "--json"]);
  check("`cotal send -c` with a space in the name names the segment, not wildcards",
    spaced.code === 1 && spaced.stdout.includes('segment \\"gen eral\\" must be a NATS-safe token') && !spaced.stdout.includes("wildcards") && !spaced.stdout.includes("'*', or '>'"), spaced);
  // A flag combination the parser can judge used to be a boundary refusal, exit 2.
  const mentionDm = await run(["send", "-t", "bob", "--mention", "carol", "x", "--json"]);
  check("`cotal send -t` with --mention is USAGE_INVALID, exit 1, naming the channel-only rule",
    mentionDm.code === 1 && mentionDm.stdout.includes('"code":"USAGE_INVALID"') && mentionDm.stdout.includes("native mention hints belong to channel publications") && mentionDm.stdout.includes("drop --mention, or send to a channel with -c <channel>"), mentionDm);
  const badRole = await run(["send", "-r", "bad role!", "x", "--json"]);
  check("`cotal send -r` with a role that is not one NATS-safe token is USAGE_INVALID, exit 1, with the role rule",
    badRole.code === 1 && badRole.stdout.includes('"code":"USAGE_INVALID"') && badRole.stdout.includes('invalid role \\"bad role!\\": must be a single NATS-safe token'), badRole);
  // A name no participant can carry used to wait out the presence lookup; a legal display name still gets it.
  const [backslash, long, legal] = await Promise.all([["a\\b"], ["n".repeat(129)], ["Bad Name!"]].map(([to]) => run(["send", "-t", to!, "x", "--json"])));
  check("`cotal send -t` with a name the endpoint refuses is USAGE_INVALID with the name rule; a legal display name is looked up",
    backslash.code === 1 && backslash.stdout.includes('"code":"USAGE_INVALID"') && backslash.stdout.includes('is reserved (a Windows path separator)')
      && long.code === 1 && long.stdout.includes("exceeds the 128-character limit")
      && legal.code === 2 && legal.stdout.includes('"code":"TARGET_NOT_FOUND"'), { backslash, long, legal });
  const wildcard = await run(["send", "-c", "team.*", "x", "--json"]);
  check("`cotal send -c` with a wildcard says to name one concrete channel", wildcard.code === 1 && wildcard.stdout.includes("name one concrete channel, without wildcards"), wildcard);
  const starred = await run(["send", "-c", "gen*", "x", "--json"]);
  check("`cotal send -c` with * inside a segment gets the wildcard sentence, not a rule that lists '*' and '>'",
    starred.code === 1 && starred.stdout.includes("name one concrete channel, without wildcards") && !starred.stdout.includes("'*', or '>'"), starred);

  // A directory used to get a bare line and the usage block, and text that is not UTF-8 did not name its file.
  const absentFile = join(storeDir, "absent.txt");
  const dirFile = join(storeDir, "a-dir");
  mkdirSync(dirFile);
  const notUtf8 = join(storeDir, "not-utf8.txt");
  writeFileSync(notUtf8, Buffer.from([0x6f, 0x6b, 0xff, 0xfe]));
  const [noFile, dirBody, badBody] = await Promise.all([absentFile, dirFile, notUtf8].map((file) => run(["send", "-c", "general", "--file", file])));
  // Each block begins with the mesh and ends with a Next that keeps the destination, as a refusal after connecting does.
  check("a missing, directory or non-UTF-8 --file is each refused in one classified block naming the path and the mesh, with a Next and without the usage block",
    noFile.code === 2 && /Code: +TARGET_NOT_FOUND/.test(noFile.stderr) && noFile.stderr.includes(`"${absentFile}" does not exist`) && noFile.stderr.includes('check the path, or run cotal send -c general "<message>"')
      && dirBody.code === 1 && /Code: +USAGE_INVALID/.test(dirBody.stderr) && dirBody.stderr.includes(`"${dirFile}" is a directory; --file reads one file`) && dirBody.stderr.includes('give --file one file in it, or run cotal send -c general "<message>"')
      && badBody.code === 1 && /Code: +USAGE_INVALID/.test(badBody.stderr) && badBody.stderr.includes(`"${notUtf8}" is not valid UTF-8`) && badBody.stderr.includes('save it as UTF-8 text, or run cotal send -c general "<message>"')
      && [noFile, dirBody, badBody].every((r) => r.stderr.startsWith(`Mesh: ${space}\n`) && r.stderr.includes("Request refused") && /\nNext\n/.test(r.stderr) && !r.stderr.includes("Usage")), { noFile, dirBody, badBody });

  // The broker's default limit is 1 MiB. A body over it used to report a possibly stored message.
  const bigFile = join(storeDir, "big.txt");
  writeFileSync(bigFile, "a".repeat(1_100_000));
  const big = await run(["send", "-c", "general", "--file", bigFile, "--json"]);
  check("an oversized `cotal send -c` is refused UNSUPPORTED, exit 2, naming the limit and that nothing was sent",
    big.code === 2 && big.stdout.includes('"code":"UNSUPPORTED"') && big.stdout.includes("1048576-byte message limit; nothing was sent"), big);
  // A body used to be read whole before the limit was checked, so a 3 GiB file failed to read and a
  // stream such as /dev/zero grew until the kernel killed it. A sparse file costs no disk.
  const hugeFile = join(storeDir, "huge.txt");
  writeFileSync(hugeFile, "");
  truncateSync(hugeFile, 3 * 2 ** 30);
  const huge = await run(["send", "-c", "general", "--file", hugeFile, "--json"]);
  check("a 3 GiB `--file` is refused UNSUPPORTED, exit 2, with its size, without reading it whole",
    huge.code === 2 && huge.stdout.includes('"code":"UNSUPPORTED"') && huge.stdout.includes(`the message is ${3 * 2 ** 30} bytes`) && huge.stdout.includes("1048576-byte message limit; nothing was sent"), huge);
  // A piped stdin is nonblocking, so a read that found the pipe empty before its writer was done
  // used to fail as unreadable. A pipe has no size, so an endless one names the limit alone.
  const piped = (args: string[], feed: (stdin: Writable) => void) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, ["--import", tsx, cli, ...args], { cwd: operatorShell, env: isolatedEnv },
        (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }));
      child.stdin!.on("error", () => {});
      feed(child.stdin!);
    });
  const late = await piped(["send", "-c", "general", "--stdin", "--json"], (stdin) => {
    stdin.write("first half, ");
    setTimeout(() => stdin.end("second half after a pause"), 5_000);
  });
  check("`cotal send --stdin` waits for a writer that pauses, then stores the message",
    late.code === 0 && late.stdout.includes('"outcome":"ok"') && late.stdout.includes('"bodySource":"stdin"'), late);
  const endless = await piped(["send", "-c", "general", "--stdin", "--json"], (stdin) => {
    const chunk = "z".repeat(64 * 1024);
    const more = () => { while (!stdin.destroyed && stdin.write(chunk)); };
    stdin.on("drain", more);
    more();
  });
  check("an endless piped `--stdin` is refused UNSUPPORTED, exit 2, naming the limit",
    endless.code === 2 && endless.stdout.includes('"code":"UNSUPPORTED"') && endless.stdout.includes("the message is longer than this broker's 1048576-byte message limit; nothing was sent"), endless);

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
  const carolDm = await run(["send", "-t", "carol", carolText]);
  check("`cotal send -t` to carol (stopped) exits 0", carolDm.code === 0, carolDm.stderr);

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
  const daveDm = await run(["send", "-t", "dave", daveText]);
  check("`cotal send -t` to live non-consuming dave exits 0", daveDm.code === 0, daveDm.stderr);
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
  // synchronously, before its lifecycle uid is retired), and assert the receipt claims storage
  // only, never "delivered". This send is the only launch after bob's stop.
  await bob.stop();
  const offlineText = `offline-${randomUUID().slice(0, 6)}`;
  const offlineDm = await run(["send", "-t", "bob", offlineText]);
  check("`cotal send -t` to a just-stopped recipient still exits 0", offlineDm.code === 0, offlineDm.stderr);
  check(
    "the offline-window `send -t` receipt reports a stored sequence and unconfirmed delivery, never delivered",
    /Stored sequence:\s+\d+/.test(offlineDm.stdout) && /Delivery:\s+not confirmed/.test(offlineDm.stdout) && !offlineDm.stdout.includes("delivered"),
    offlineDm.stdout,
  );
  // The warning may wrap at the terminal width, so its words are compared with whitespace collapsed.
  check(
    "the offline-window `send -t` warns that bob is offline and gets the message when he reconnects",
    offlineDm.stderr.replace(/\s+/g, " ").includes("! bob is offline. The message is stored and delivered when bob reconnects; a new agent spawned as bob does not receive it."),
    offlineDm.stderr,
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

  // Expiry: a fresh core observer reads the presence bucket through its own watch snapshot. A live
  // witness agent keeps one card in the bucket, so the snapshot is a read that found records, and
  // dave's absence from it is the broker having expired his card. Nothing here writes, refreshes or
  // forges dave's card.
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

  // What the offline warning promises: bob coming back under the same lifecycle receives the DM
  // the offline-window send stored while he was gone.
  bob = new CotalEndpoint(bobOptions);
  bob.on("message", onBobMessage);
  bob.on("error", () => {});
  await bob.start();
  for (let i = 0; i < 50 && !got.some((g) => g.route === "DM" && g.text === offlineText); i++) await wait(100);
  check(
    "bob, back under the same lifecycle, receives the DM sent while he was offline",
    got.some((g) => g.route === "DM" && g.text === offlineText),
    got.filter((g) => g.route === "DM").map((g) => g.text),
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
