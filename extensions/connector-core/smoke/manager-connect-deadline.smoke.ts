/** Real broker and encrypted auth callout; synthetic actor ledger and test-only permissions.
 * The responder deliberately refuses describe, proving the control dial reached it without
 * claiming a full manager launch. Cancellation and expired preparation must never reach it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  createSpaceAuth, deriveReplySubject, dialerFor, isReachable, parseEpSubject,
  serverConfig, spacePrefix, standaloneConnectOpts,
} from "@cotal-ai/core";
import { createCalloutAuth, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "@cotal-ai/auth";
import {
  SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, freePort, killAndAwaitExit, teardownOnSignal,
} from "@cotal-ai/smoke-kit";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { generateKeyPair, SignJWT } from "jose";
import { invokeUserManager } from "../src/manager-call.js";

const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}manager-deadline-`));
const space = "managerdeadline", port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
writeFileSync(join(home, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, host: "127.0.0.1", port, storeDir: join(home, "js"),
  extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
}) + "\nauthorization { timeout: 10 }\n", { mode: 0o600 });
const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", ["-c", join(home, "server.conf")], {
  stdio: ["ignore", "pipe", "pipe"],
});
const disarm = teardownOnSignal(broker, home);
let output = "";
broker.stdout.on("data", (b: Buffer) => { output += b.toString(); });
broker.stderr.on("data", (b: Buffer) => { output += b.toString(); });
let calloutNc: NatsConnection | undefined, responder: NatsConnection | undefined;
let service: ReturnType<typeof startAuthCallout> | undefined;
const pending = new Set<Promise<void>>();
const admissions = new Map<string, number>(), requests = new Map<string, number>();
let passed = 0;
const check = (name: string, condition: boolean) => {
  assert(condition, name);
  passed++;
  console.log(`  ✓ ${name}`);
};
const owner = deriveOwnerToken("s".repeat(32), "owned-manager-deadline-smoke");
const uid = "a".repeat(26), manager = "b".repeat(26), issuer = "https://manager-deadline.test";
const enc = new TextEncoder(), dec = new TextDecoder();
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 100, delayMs: 50, output: () => output });
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const bearer = (actor: string) => new SignJWT({
    sub: owner, ver: USER_TOKEN_VER, scope: ["spawn", "run"],
    act: { owner, actor, lifecycleUid: uid, managerInstanceId: manager, view: "manager-caller", scope: ["spawn", "run"] },
  }).setProtectedHeader({ alg: "EdDSA" }).setIssuer(issuer).setAudience(space)
    .setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 1).setExpirationTime("2m").sign(privateKey);
  calloutNc = await connect({ servers, authenticator: credsAuthenticator(enc.encode(callout.calloutCreds)), maxReconnectAttempts: 0 });
  service = startAuthCallout(calloutNc, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space, token: { key: publicKey, issuer }, limits: { authTimeoutMs: 10_000 },
    authorizeActor: async (token) => {
      assert.equal(token.owner, owner);
      const actor = token.act.actor;
      admissions.set(actor, (admissions.get(actor) ?? 0) + 1);
      if (actor !== "responder") {
        const delay = wait(2500);
        pending.add(delay);
        try { await delay; } finally { pending.delete(delay); }
      }
    },
    recordIssuance: async () => {},
    // No accepted-row grant: exercise the existing legacy managed-view permission-denial path.
    permissionsFor: (_token, id) => ({
      pub: { allow: [`${spacePrefix(space)}.ep.>`, `_INBOX_${id}.>`] },
      sub: { allow: [`${spacePrefix(space)}.ep.>`, `_INBOX_${id}.>`] },
    }),
    log: () => {},
  });
  responder = await dialerFor(servers)({ servers,
    ...standaloneConnectOpts({ bearer: await bearer("responder"), sentinelCreds: callout.sentinelCreds, tls: false }),
    maxReconnectAttempts: 0, timeout: 10_000,
  });
  responder.subscribe(`${spacePrefix(space)}.ep.inst.manager.${manager}.>`, { callback: (error, msg) => {
    assert.ifError(error);
    const req = parseEpSubject(msg.subject);
    assert(req?.plane === "request");
    requests.set(req.caller.actor, (requests.get(req.caller.actor) ?? 0) + 1);
    const body = JSON.parse(dec.decode(msg.data)) as { id: string };
    responder!.publish(deriveReplySubject(space, req, { instanceId: manager, epoch: 1 }),
      enc.encode(JSON.stringify({ v: 1, id: body.id, ok: false,
        error: { code: "unavailable", message: "owned slow-auth responder", outcome: "not-executed" } })));
  } });
  await responder.flush();
  const config = (actor: string): Parameters<typeof invokeUserManager>[0] => ({
    space, servers, tls: false, lifecycleUid: uid, managerInstanceId: manager,
    userAuth: { owner, actor, sentinelCreds: callout.sentinelCreds, bearerCmd: ["unused"] },
  });
  const follow = (budget: number): NonNullable<Parameters<typeof invokeUserManager>[4]>["follow"] =>
    async (_submit, prepare) => { await prepare(new AbortController().signal, Date.now() + budget); throw new Error("describe must refuse"); };

  for (const actor of ["ordinary", "followed"]) {
    const token = await bearer(actor);
    const started = Date.now();
    await assert.rejects(invokeUserManager(config(actor), async () => token, "ps", undefined, {
      deadlineMs: 10_000, ...(actor === "followed" ? { follow: follow(8000) } : {}),
    }), /owned slow-auth responder/);
    check(`${actor}: slow authentication reaches the attributed describe reply`, Date.now() - started >= 2500 && (requests.get(actor) ?? 0) > 0);
  }

  const shortToken = await bearer("short");
  const shortStart = Date.now();
  await assert.rejects(invokeUserManager(config("short"), async () => shortToken, "ps", undefined,
    { deadlineMs: 10_000, follow: follow(500) }), /timeout/i);
  check("follow's shorter remaining budget bounds the dial", Date.now() - shortStart < 2000);
  await Promise.all([...pending]);
  check("a timed-out dial never publishes a manager request", !requests.has("short"));

  const cancelToken = await bearer("cancelled"), abort = new AbortController();
  const cancelled = invokeUserManager(config("cancelled"), async () => cancelToken, "ps", undefined,
    { deadlineMs: 10_000, signal: abort.signal });
  const rejection = assert.rejects(cancelled, /owned cancellation/);
  // Wait until authentication is actually in flight before cancelling it.
  const admittedBy = Date.now() + 5000;
  while (!admissions.has("cancelled") && Date.now() < admittedBy) await wait(10);
  assert(admissions.has("cancelled"), "cancel case entered the live callout");
  abort.abort(new Error("owned cancellation"));
  await rejection;
  check("late authentication after cancellation publishes no manager request", !requests.has("cancelled"));

  for (const actor of ["expired", "expiredfollow"]) {
    const token = await bearer(actor);
    await assert.rejects(invokeUserManager(config(actor), async () => { await wait(300); return token; }, "ps", undefined, {
      deadlineMs: actor === "expired" ? 100 : 10_000,
      ...(actor === "expiredfollow" ? { follow: follow(100) } : {}),
    }), (error: unknown) => error instanceof Error && /WAS NOT RUN/.test(error.message));
    check(`${actor}: bearer time consumes the budget before any dial or publication`, !admissions.has(actor) && !requests.has(actor));
  }
} finally {
  await responder?.close();
  await Promise.allSettled([...pending]);
  await calloutNc?.close();
  await service?.done;
  await killAndAwaitExit(broker);
  disarm();
  rmSync(home, { recursive: true });
}
assert.equal(passed, 7, "all native deadline cases ran");
emitSentinel({ passed, failed: 0 });
