/**
 * #1047: a CONSUMER.DELETE timeout during membership-watch disarm is cleanup, not a process kill.
 *
 * The live crash was an unhandled TimeoutError from consumer.delete() in disarmMembershipWatch
 * on a live observer over a slow VPN. The JS-API request timed out; the endpoint was still
 * usable; the broker reaps the consumer anyway.
 *
 * This suite injects that rejection at the delete boundary (no broker). A live TCP stall of
 * CONSUMER.DELETE is a named gap: this box must not drive cotal web against the production
 * mesh, and a stall proxy is the transport-liveness suite's shape, not required to prove the
 * catch policy.
 *
 * Run: pnpm smoke:disarm-delete-timeout
 */
import { CotalEndpoint } from "../src/endpoint.js";
import { newIdentity } from "../src/identity.js";
import { createSpaceAuth, mintCreds } from "../src/provision.js";
import type { Consumer, PushConsumer } from "@nats-io/jetstream";
import { PermissionViolationError, TimeoutError } from "@nats-io/transport-node";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

const ep = new CotalEndpoint({
  space: "disarm-timeout",
  servers: "nats://127.0.0.1:1",
  card: { name: "observer", kind: "agent" },
  registerPresence: false,
  watchPresence: false,
  consume: false,
});

const emitted: Error[] = [];
ep.on("error", (err) => { emitted.push(err as Error); });
(ep as unknown as { nc: { isClosed(): boolean }; reconnecting: boolean }).nc = { isClosed: () => false };
(ep as unknown as { reconnecting: boolean }).reconnecting = false;

const watch = {
  onChange: () => {},
  stopped: false,
  arm: Promise.resolve(),
  consumerStream: "KV_membership",
  consumerName: "ordered-watch",
  consumer: {
    delete: () => Promise.reject(new TimeoutError()),
  } as unknown as PushConsumer,
};

type WatchArg = {
  onChange: () => void;
  stopped: boolean;
  arm: Promise<void>;
  consumerStream?: string;
  consumerName?: string;
  consumer?: PushConsumer;
};
const disarm = (ep as unknown as { disarmMembershipWatch(w: WatchArg): Promise<void> }).disarmMembershipWatch.bind(ep);

let threw = false;
let thrown: unknown;
try {
  await disarm(watch);
} catch (err) {
  threw = true;
  thrown = err;
}

check("a live delete timeout does not reject disarmMembershipWatch", threw === false, thrown);
check("the timeout is surfaced as an endpoint error event", emitted.length === 1 && emitted[0]?.name === "TimeoutError" && emitted[0]?.message === "timeout", emitted);
check("consumer identity is kept for a later cleanup retry", watch.consumerStream === "KV_membership" && watch.consumerName === "ordered-watch", watch);

const authWatch = {
  onChange: () => {},
  stopped: false,
  arm: Promise.resolve(),
  consumer: {
    delete: () => Promise.reject(Object.assign(new Error("permissions violation for subscription"), { code: 503 })),
  } as unknown as PushConsumer,
};
let authThrew = false;
try {
  await disarm(authWatch);
} catch {
  authThrew = true;
}
check("a non-timeout delete failure still throws", authThrew === true);

const missingWatch = {
  onChange: () => {},
  stopped: false,
  arm: Promise.resolve(),
  consumerStream: "KV_membership",
  consumerName: "gone",
  consumer: {
    delete: () => Promise.reject(Object.assign(new Error("consumer not found"), { code: 404 })),
  } as unknown as PushConsumer,
};
await disarm(missingWatch);
check("a 404 delete still clears consumer identity", missingWatch.consumerStream === undefined && missingWatch.consumerName === undefined, missingWatch);

const spaceAuth = await createSpaceAuth("disarm-timeout");
const observerCreds = await mintCreds(spaceAuth, newIdentity(), "observer");
const adminCreds = await mintCreds(spaceAuth, newIdentity(), "admin");
const observerEp = new CotalEndpoint({
  space: "disarm-timeout",
  servers: "nats://127.0.0.1:1",
  creds: observerCreds,
  card: { name: "obs-cred", kind: "endpoint" },
  registerPresence: false,
  watchPresence: false,
  consume: false,
});
const adminEp = new CotalEndpoint({
  space: "disarm-timeout",
  servers: "nats://127.0.0.1:1",
  creds: adminCreds,
  card: { name: "adm-cred", kind: "endpoint" },
  registerPresence: false,
  watchPresence: false,
  consume: false,
});
type DeleteHooks = {
  deleteOwnConsumer(c: Consumer | PushConsumer, stream?: string): Promise<void>;
  deleteOwnScanConsumer(stream: string, name: string, del: () => Promise<boolean>): Promise<boolean>;
};
let ungrantedDeletes = 0;
const ungrantedConsumer = {
  delete: async () => { ungrantedDeletes++; return true; },
} as unknown as Consumer;
await (observerEp as unknown as DeleteHooks).deleteOwnConsumer(ungrantedConsumer, "CHAT_disarm-timeout");
await (observerEp as unknown as DeleteHooks).deleteOwnScanConsumer("KV_cotal_membership_disarm-timeout", "oc_probe_1", async () => {
  ungrantedDeletes++;
  return true;
});
await (adminEp as unknown as DeleteHooks).deleteOwnConsumer(ungrantedConsumer, "CHAT_disarm-timeout");
await (adminEp as unknown as DeleteHooks).deleteOwnConsumer(ungrantedConsumer, "DM_disarm-timeout");
await (adminEp as unknown as DeleteHooks).deleteOwnScanConsumer("KV_cotal_membership_disarm-timeout", "oc_probe_1", async () => {
  ungrantedDeletes++;
  return true;
});
check("observer and admin creds skip ungranted ephemeral consumer deletes on chat, dm, and membership streams", ungrantedDeletes === 0, ungrantedDeletes);

let deniedStreamCalls = 0;
const deniedConsumer = {
  delete: async () => {
    deniedStreamCalls++;
    throw Object.assign(
      new PermissionViolationError("Permissions Violation for Publish to \"$JS.API.CONSUMER.DELETE.CHAT_disarm-timeout.oc_1\""),
      { operation: "publish" as const },
    );
  },
} as unknown as Consumer;
await (ep as unknown as DeleteHooks).deleteOwnConsumer(deniedConsumer, "CHAT_disarm-timeout");
await (ep as unknown as DeleteHooks).deleteOwnConsumer(deniedConsumer, "CHAT_disarm-timeout");
check("a publish permission denial on an ephemeral consumer delete caches the stream for subsequent reads", deniedStreamCalls === 1, deniedStreamCalls);

const EXPECTED = 7;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`DISARM-DELETE-TIMEOUT SMOKE ${fail === 0 ? "OK" : "FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
