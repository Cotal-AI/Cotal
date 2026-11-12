/**
 * The permission records bucket on a real broker.
 *
 * Setup creates it under the provisioner credential in its declared shape. It keeps one revision per
 * key and accepts nothing but plain puts within the record size limit, because the agents that write
 * it are untrusted: a `Nats-Rollup: all` header would purge every owner's records. Purge, message
 * delete and direct gets are refused too. Each refusal is asked by a test-only allow-all user in the
 * data account, so it comes from the bucket's own config and not from a missing grant, and each is
 * followed by a count of what the bucket still holds. A second setup leaves the bucket as it is, and
 * a reshaped one is refused by name rather than adopted.
 *
 * Run: pnpm smoke:permission-store   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { connect, credsAuthenticator, headers, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type StreamConfig } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSpaceAuth, isReachable, mintCreds, newIdentity, permissionBucket, serverConfig, setupSpaceStreams } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `perm-store-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const BUCKET = permissionBucket(space);
const STREAM = `KV_${BUCKET}`;
const OWNER = `u_${"a".repeat(26)}`;
const keySubject = (id: string) => `$KV.${BUCKET}.${OWNER}.coder.${id}`;

let inspector: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  const setup = () => setupSpaceStreams({ servers: SERVERS, space, creds: provisioner }).then(() => "", messageOf);
  const first = await setup();
  check("setup under the provisioner credential succeeds", first === "", first);

  const id = newIdentity();
  const jwt = await encodeUser("permission-store-inspector", fromPublic(id.id), fromPublic(auth.account.pub),
    { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer: fromSeed(enc(auth.account.signingSeed)) });
  inspector = await connect({ servers: SERVERS, authenticator: credsAuthenticator(fmtCreds(jwt, fromSeed(enc(id.seed)))), maxReconnectAttempts: 0 });
  const jsm = await jetstreamManager(inspector);
  const js = jetstream(inspector);
  const held = async () => (await jsm.streams.info(STREAM)).state.messages;

  const created = await jsm.streams.info(STREAM).then((info) => info.config, () => undefined);
  check("...and creates the permission store", created !== undefined);
  const DECLARED: Record<string, unknown> = {
    subjects: [`$KV.${BUCKET}.>`],
    retention: "limits",
    storage: "file",
    discard: "new",
    max_msgs_per_subject: 1,
    max_msg_size: 262_144,
    max_age: 2_592_000_000_000_000,
    max_bytes: -1,
    duplicate_window: 120_000_000_000,
    allow_rollup_hdrs: false,
    allow_direct: false,
    deny_delete: true,
    deny_purge: true,
  };
  const config = (created ?? {}) as unknown as Record<string, unknown>;
  const drift = Object.entries(DECLARED).filter(([k, v]) => !isDeepStrictEqual(config[k], v)).map(([k, v]) => ({ field: k, got: config[k], want: v }));
  const fields = Object.keys(DECLARED).length;
  check(`the store reads back in its declared shape (${fields - drift.length} of ${fields} fields)`, fields === 13 && drift.length === 0, drift);
  check("...with per-message TTLs off", config.allow_msg_ttl !== true, config.allow_msg_ttl);

  const A = "a".repeat(26), B = "b".repeat(26);
  await js.publish(keySubject(A), "first");
  await js.publish(keySubject(A), "second");
  await js.publish(keySubject(B), "other");
  check("one revision per key: three puts on two keys leave two messages", await held() === 2, await held());
  const newest = await jsm.streams.getMessage(STREAM, { last_by_subj: keySubject(A) }).then((m) => m?.string() ?? "absent", messageOf);
  check("...and a key keeps its newest value", newest === "second", newest);

  const atLimit = await js.publish(keySubject("c".repeat(26)), new Uint8Array(262_144)).then(() => "", messageOf);
  check("a record of exactly 256 KiB lands", atLimit === "", atLimit);
  const overLimit = await js.publish(keySubject("d".repeat(26)), new Uint8Array(262_145)).then(() => "", messageOf);
  check("a record one byte over 256 KiB is refused", /message size exceeds maximum/i.test(overLimit), overLimit);
  // The limit counts header bytes: a writer's cap on the record must leave room for its own headers.
  const withHeaders = await js.publish(keySubject("e".repeat(26)), new Uint8Array(262_144), { msgID: `${"e".repeat(26)}.1` }).then(() => "", messageOf);
  check("a record of exactly 256 KiB written with a Nats-Msg-Id header is refused", /message size exceeds maximum/i.test(withHeaders), withHeaders);
  check("...so the store holds three messages", await held() === 3, await held());

  for (const scope of ["all", "sub"]) {
    const h = headers();
    h.set("Nats-Rollup", scope);
    const rollup = await js.publish(keySubject(B), "wipe", { headers: h }).then(() => "", messageOf);
    check(`a Nats-Rollup: ${scope} write is refused`, /rollup/i.test(rollup), rollup);
  }
  check("...and every record survives both", await held() === 3, await held());

  const purge = await jsm.streams.purge(STREAM).then(() => "", messageOf);
  check("a purge is refused", /purge/i.test(purge), purge);
  const target = await jsm.streams.getMessage(STREAM, { last_by_subj: keySubject(B) });
  if (!target) throw new Error(`the record under ${keySubject(B)} is missing before the delete probe`);
  const removal = await jsm.streams.deleteMessage(STREAM, target.seq).then(() => "", messageOf);
  check("a message delete is refused", /delete/i.test(removal), removal);
  check("...and every record survives both", await held() === 3, await held());

  const direct = await jsm.direct.getMessage(STREAM, { last_by_subj: keySubject(A) }).then((m) => `served ${m?.string()}`, messageOf);
  check("a direct get is not served", !direct.startsWith("served"), direct);
  console.log(`  refusals seen ${JSON.stringify({ overLimit, purge, removal, direct })}`);

  const again = await setup();
  const after = await jsm.streams.info(STREAM);
  check("a second setup succeeds and leaves the store unchanged",
    again === "" && after.state.messages === 3 && isDeepStrictEqual(after.config, created), { again, messages: after.state.messages });

  const reopen = await jsm.streams.update(STREAM, { ...(created as StreamConfig), allow_rollup_hdrs: true }).then(() => "", messageOf);
  check("the broker refuses to turn roll-ups back on while purges are denied", /roll-ups require the purge permission/i.test(reopen), reopen);

  await jsm.streams.update(STREAM, { ...(created as StreamConfig), max_msg_size: 1_048_576 });
  const reshaped = await setup();
  check("setup refuses a reshaped store by name", reshaped.includes(STREAM) && /never adopted/.test(reshaped), reshaped);
  check("...and leaves its config to the operator", (await jsm.streams.info(STREAM)).config.max_msg_size === 1_048_576);
} finally {
  await inspector?.close().catch(() => {});
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
