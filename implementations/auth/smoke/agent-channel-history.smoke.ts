/** Real-broker regression for agent channelHistory (#4187). Run with tsx; needs nats-server. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, jetstreamManager } from "@nats-io/jetstream";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, seedChannelRegistry, provisionAgent, mintLifecycleUid, chatHistDurable, chatStream, chatSubject, standaloneConnectOpts, type StandaloneAuth, type CotalMessage,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (m: CotalMessage) => m.parts.map((p) => p.kind === "text" ? p.text : "").join("");
const pageText = (page: CotalMessage[]) => page.map(textOf).join("|");
// Preserve errors as values so a red positive does not skip the remaining checks or the other mode.
async function result<T>(op: Promise<T>): Promise<T | Error> {
  return op.catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
}
const newest = (value: CotalMessage[] | Error) => Array.isArray(value) && pageText(value) === "general 3|general 4";

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `agent-history-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const issuer = "https://auth.cotal.test";
const owner = deriveOwnerToken("s".repeat(32), "better-auth|agent-channel-history");
const userUid = mintLifecycleUid();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"),
  extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
}));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const endpoints: CotalEndpoint[] = [];
let calloutNc: NatsConnection | undefined;
const quiet = { channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false };
async function start(ep: CotalEndpoint): Promise<CotalEndpoint> {
  endpoints.push(ep);
  ep.on("error", () => {});
  await ep.start();
  return ep;
}

// Eleven checks per credential mode plus one zero-channel check: 23 total.
async function exercise(mode: string, reader: CotalEndpoint, uid: string, competingAuth: StandaloneAuth): Promise<void> {
  const first = await result(reader.channelHistory("general", { limit: 2 }));
  check(`${mode}: allowed history is the newest two messages, oldest-first`, newest(first), first);

  const denied = await result(reader.channelHistory("secret", { limit: 2 }));
  const native = denied instanceof PermissionViolationError ? denied : denied instanceof Error ? denied.cause : undefined;
  check(`${mode}: out-of-ACL history fails with native publish PermissionViolationError`,
    native instanceof PermissionViolationError && native.operation === "publish", denied);
  const name = chatHistDurable(reader.card.owner!, reader.card.actor!, uid);
  check(`${mode}: denial names the lifecycle reader and secret filter, not bare create`,
    native instanceof PermissionViolationError && native.subject ===
      `$JS.API.CONSUMER.CREATE.${chatStream(space)}.${name}.${chatSubject(space, "*", "*", "secret")}`, native);
  const multi = await result(reader.multiChannelHistory(["general", "empty"], { limit: 2 }));
  const multiError = multi instanceof PermissionViolationError ? multi : multi instanceof Error ? multi.cause : undefined;
  check(`${mode}: multi-channel history remains broker-denied even for individually allowed channels`,
    multiError instanceof PermissionViolationError && multiError.operation === "publish", multi);
  const adjacent = await result(reader.channelHistory("general", { limit: 2 }));
  check(`${mode}: allowed history still succeeds adjacent to the denial`, newest(adjacent), adjacent);

  const empty = await result(reader.channelHistory("empty", { limit: 2 }));
  check(`${mode}: an allowed empty channel returns zero rows`, Array.isArray(empty) && empty.length === 0, empty);

  const concurrent = await Promise.all([
    result(reader.channelHistory("general", { limit: 2 })),
    result(reader.channelHistory("empty", { limit: 2 })),
    result(reader.channelHistory("general", { limit: 1 })),
  ]);
  check(`${mode}: concurrent calls finish with their own complete pages`,
    newest(concurrent[0]) && Array.isArray(concurrent[1]) && concurrent[1].length === 0 &&
    Array.isArray(concurrent[2]) && pageText(concurrent[2]) === "general 4", concurrent);

  const abort = new AbortController();
  abort.abort();
  const cancelled = await result(reader.channelHistory("general", { limit: 2, signal: abort.signal }));
  check(`${mode}: a preaborted read rejects as cancellation`, cancelled instanceof Error && cancelled.name === "AbortError", cancelled);
  const queuedAbort = new AbortController();
  const running = result(reader.channelHistory("general", { limit: 2 }));
  const queued = result(reader.channelHistory("general", { limit: 1, signal: queuedAbort.signal }));
  queuedAbort.abort();
  const [runningPage, queuedResult] = await Promise.all([running, queued]);
  check(`${mode}: aborting a queued call does not cancel the active reader`, newest(runningPage) &&
    queuedResult instanceof Error && queuedResult.name === "AbortError", { runningPage, queuedResult });
  const afterAbort = await result(reader.channelHistory("general", { limit: 2 }));
  check(`${mode}: cancellation leaves no stuck reader blocking the next call`, newest(afterAbort), afterAbort);

  const holder = await connect({ servers, ...standaloneConnectOpts(competingAuth) });
  try {
    const jsm = await jetstreamManager(holder);
    const held = await jsm.consumers.add(chatStream(space), {
      name, description: "foreign holder", filter_subject: chatSubject(space, "*", "*", "general"),
      ack_policy: AckPolicy.None, mem_storage: true, inactive_threshold: 60_000_000_000,
    });
    try {
      const collision = await result(reader.channelHistory("general", { limit: 2 }));
      const surviving = await result(jsm.consumers.info(chatStream(space), name));
      check(`${mode}: a foreign lifecycle reader is refused and left intact`,
        collision instanceof Error && /held by a consumer/.test(collision.message) &&
        !(surviving instanceof Error) && surviving.created === held.created &&
        surviving.config.description === "foreign holder", { collision, surviving });
    } finally { await jsm.consumers.delete(chatStream(space), name); }
  } finally { await holder.close(); }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: mgrCreds });
  await seedChannelRegistry({ servers, space, creds: mgrCreds, file: {
    defaults: { replay: true }, channels: { general: { replay: true }, empty: { replay: true }, secret: { replay: true } },
  } });
  const mgr = await start(new CotalEndpoint({
    ...quiet, space, servers, creds: mgrCreds, card: { name: "provisioner", role: "manager", kind: "endpoint" },
  }));
  const posterId = newIdentity(), posterUid = mintLifecycleUid();
  const posterCreds = await provisionAgent(mgr, auth, posterId, {
    allowSubscribe: ["general", "secret"], allowPublish: ["general", "secret"], subscribe: [], lifecycleUid: posterUid,
  });
  const poster = await start(new CotalEndpoint({
    ...quiet, space, servers, creds: posterCreds, lifecycleUid: posterUid,
    card: { id: posterId.id, name: "poster", kind: "agent" },
  }));
  for (let i = 1; i <= 4; i++) await poster.multicast(`general ${i}`, { channel: "general" });
  await poster.multicast("secret must not leak", { channel: "secret" });
  // A separate reader connection must see all fire-and-forget publishes before making its first page.
  await wait(600);

  const staticId = newIdentity(), staticUid = mintLifecycleUid();
  const staticCreds = await provisionAgent(mgr, auth, staticId, {
    allowSubscribe: ["general", "empty"], allowPublish: [], subscribe: [], lifecycleUid: staticUid,
  });
  const staticReader = await start(new CotalEndpoint({
    ...quiet, space, servers, creds: staticCreds, lifecycleUid: staticUid,
    card: { id: staticId.id, name: "static-reader", kind: "agent" },
  }));

  calloutNc = await connect({ servers, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  // Minimal server-owned grant input to the unmodified stock permission builder. No view or elevated scope.
  const grant = { allowSubscribe: ["general", "empty"], allowPublish: [], lifecycleUid: userUid, scope: [] as string[] };
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space, token: { key: publicKey as never, issuer }, recordIssuance: async () => {},
    authorizeActor: (t) => {
      if (t.owner !== owner || t.act.actor !== "history_reader" || t.act.lifecycleUid !== userUid)
        throw new Error("unknown agent grant");
    },
    permissionsFor: calloutPermissions((t) => {
      if (t.owner !== owner || t.act.actor !== "history_reader") throw new Error("unknown agent grant");
      return grant;
    }),
  });
  await calloutNc.flush();
  const now = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({
    ver: USER_TOKEN_VER, act: { owner, actor: "history_reader", scope: [], lifecycleUid: userUid },
  }).setProtectedHeader({ alg: "EdDSA" }).setIssuer(issuer).setAudience(space).setSubject(owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 600).sign(privateKey as CryptoKey);
  const userReader = await start(new CotalEndpoint({
    ...quiet, space, servers, bearer, sentinelCreds: callout.sentinelCreds, lifecycleUid: userUid,
    card: { name: "user-reader", kind: "agent" },
  }));

  await exercise("static agent", staticReader, staticUid, { creds: staticCreds, tls: false });
  await exercise("stock callout agent", userReader, userUid, { bearer, sentinelCreds: callout.sentinelCreds, tls: false });
  const zeroId = newIdentity(), zeroUid = mintLifecycleUid();
  const zeroCreds = await provisionAgent(mgr, auth, zeroId, {
    allowSubscribe: [], allowPublish: [], subscribe: [], lifecycleUid: zeroUid,
  });
  const zero = await start(new CotalEndpoint({
    ...quiet, space, servers, creds: zeroCreds, lifecycleUid: zeroUid,
    card: { id: zeroId.id, name: "zero-channel", kind: "agent" },
  }));
  const zeroResult = await result(zero.channelHistory("general", { limit: 2 }));
  const zeroError = zeroResult instanceof PermissionViolationError ? zeroResult : zeroResult instanceof Error ? zeroResult.cause : undefined;
  check("zero-channel agent is broker-denied on its confined rail", zeroError instanceof PermissionViolationError &&
    zeroError.subject === `$JS.API.CONSUMER.CREATE.${chatStream(space)}.${chatHistDurable(zero.card.owner!, zero.card.actor!, zeroUid)}.${chatSubject(space, "*", "*", "general")}`, zeroResult);
} catch (error) {
  check("real-broker scenario completes", false, error);
} finally {
  for (const ep of endpoints.reverse()) await ep.stop().catch(() => {});
  await calloutNc?.close().catch(() => {});
  const exited = new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) resolve();
    else srv.once("exit", () => resolve());
  });
  srv.kill("SIGKILL");
  await exited;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
