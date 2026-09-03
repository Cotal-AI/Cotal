/**
 * Endpoint permission-result honesty.
 *
 * A real JWT-auth broker stores one channel message. An unrestricted endpoint reads it, while a
 * narrowed credential can initialize JetStream but cannot publish CHAT STREAM.INFO. That denial
 * must reject listChannels rather than resolve to a valid-looking empty list. The opposite boundary
 * is measured too: after CHAT is genuinely deleted, listChannels legitimately returns an empty list.
 *
 * Run: pnpm smoke:endpoint-permission-results:auth
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  CotalEndpoint,
  chatStream,
  createSpaceAuth,
  isPermissionDenied,
  isReachable,
  mintCreds,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${name}`, detail ?? "");
  }
};

const port = await pickFreePort();
const server = `nats://127.0.0.1:${port}`;
const space = "permissionresults";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const storeDir = join(dir, "js");
const conf = join(dir, "server.conf");
const log = join(dir, "server.log");
mkdirSync(storeDir, { recursive: true });

const auth = await createSpaceAuth(space);
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir }));
const fd = openSync(log, "w");
const broker = spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] });
const releaseBroker = teardownOnSignal(broker, dir);

let poster: CotalEndpoint | undefined;
let observer: CotalEndpoint | undefined;
let restricted: CotalEndpoint | undefined;
let deletionConnection: Awaited<ReturnType<typeof connect>> | undefined;
try {
  const provisionerIdentity = newIdentity();
  const provisionerCreds = await mintCreds(auth, provisionerIdentity, "provisioner");
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (broker.exitCode !== null) break;
    if (await isReachable(server, { creds: provisionerCreds })) { up = true; break; }
    await wait(100);
  }
  if (!up) throw new Error(`auth broker failed to start (exit ${broker.exitCode}):\n${readFileSync(log, "utf8")}`);
  await setupSpaceStreams({ servers: server, space, creds: provisionerCreds });

  poster = new CotalEndpoint({
    space,
    servers: server,
    creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "poster", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
  });
  poster.on("error", () => {});
  await poster.start();
  await poster.multicast("stored", { channel: "general" });

  observer = new CotalEndpoint({
    space,
    servers: server,
    creds: await mintCreds(auth, newIdentity(), "admin"),
    card: { name: "observer", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
  });
  observer.on("error", () => {});
  await observer.start();
  const complete = await observer.listChannels();
  check(
    "positive control: unrestricted listChannels sees the stored general message",
    complete.find((row) => row.channel === "general")?.messages === 1,
    complete,
  );

  // Allow the manager handshake and private reply inbox, but deliberately omit the exact
  // $JS.API.STREAM.INFO.CHAT_<space> publish row listChannels needs.
  const identity = newIdentity();
  const jwt = await encodeUser(
    "list-denied",
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    { pub: { allow: ["$JS.API.INFO"] }, sub: { allow: [`_INBOX_${identity.id}.>`] } },
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) },
  );
  const restrictedCreds = new TextDecoder().decode(
    fmtCreds(jwt, fromSeed(new TextEncoder().encode(identity.seed))),
  );
  const statusErrors: string[] = [];
  restricted = new CotalEndpoint({
    space,
    servers: server,
    creds: restrictedCreds,
    card: { name: "restricted", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
  });
  restricted.on("error", (error) => statusErrors.push(error.message));
  await restricted.start();
  let denial: unknown;
  try {
    await restricted.listChannels();
  } catch (error) {
    denial = error;
  }
  await wait(200);
  check(
    "listChannels propagates denied CHAT STREAM.INFO instead of returning an incomplete success",
    isPermissionDenied(denial) && /STREAM\.INFO\.CHAT_permissionresults/.test((denial as Error).message),
    denial,
  );
  check(
    "the real broker denial also reaches the endpoint status surface",
    statusErrors.some((message) => /STREAM\.INFO\.CHAT_permissionresults/.test(message)),
    statusErrors,
  );

  const deletionIdentity = newIdentity();
  const deletionJwt = await encodeUser(
    "stream-deleter",
    fromPublic(deletionIdentity.id),
    fromPublic(auth.account.pub),
    {
      pub: { allow: ["$JS.API.INFO", `$JS.API.STREAM.DELETE.${chatStream(space)}`] },
      sub: { allow: [`_INBOX_${deletionIdentity.id}.>`] },
    },
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) },
  );
  const deletionCreds = new TextDecoder().decode(
    fmtCreds(deletionJwt, fromSeed(new TextEncoder().encode(deletionIdentity.seed))),
  );
  deletionConnection = await connect({
    servers: server,
    authenticator: credsAuthenticator(new TextEncoder().encode(deletionCreds)),
    inboxPrefix: `_INBOX_${deletionIdentity.id}`,
    maxReconnectAttempts: 0,
  });
  await (await jetstreamManager(deletionConnection)).streams.delete(chatStream(space));
  let genuinelyEmpty: Awaited<ReturnType<CotalEndpoint["listChannels"]>> | undefined;
  let absentError: unknown;
  try {
    genuinelyEmpty = await observer.listChannels();
  } catch (error) {
    absentError = error;
  }
  check(
    "a genuinely absent CHAT stream remains a legitimate empty channel result",
    absentError === undefined && genuinelyEmpty?.length === 0,
    absentError ?? genuinelyEmpty,
  );

  console.log(`\nENDPOINT PERMISSION RESULTS: ${passed}/${passed + failed}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await deletionConnection?.drain().catch(() => {});
  await restricted?.stop().catch(() => {});
  await observer?.stop().catch(() => {});
  await poster?.stop().catch(() => {});
  if (broker.exitCode === null) broker.kill("SIGTERM");
  await new Promise<void>((resolve) => broker.exitCode !== null ? resolve() : broker.once("exit", () => resolve()));
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(failed ? 1 : 0);
