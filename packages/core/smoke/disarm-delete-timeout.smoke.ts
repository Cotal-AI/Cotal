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
import { JetStreamApiCodes, JetStreamApiError, type JetStreamManager, type PushConsumer } from "@nats-io/jetstream";
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

const deleteMember = (
  ep as unknown as { deleteMembershipConsumer(jsm: JetStreamManager, stream: string, name: string): Promise<boolean> }
).deleteMembershipConsumer.bind(ep);

const missingWatch = {
  onChange: () => {},
  stopped: false,
  arm: Promise.resolve(),
  consumerStream: "KV_membership",
  consumerName: "gone",
  consumer: {
    delete: () => Promise.reject(new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.ConsumerNotFound, description: "consumer not found" })),
  } as unknown as PushConsumer,
};
await disarm(missingWatch);
check("a structured ConsumerNotFound delete clears consumer identity", missingWatch.consumerStream === undefined && missingWatch.consumerName === undefined, missingWatch);

const deleteSubject = "$JS.API.CONSUMER.DELETE.KV_membership.ordered-watch";
const publishDenied = new PermissionViolationError(
  `Permissions Violation for Publish to "${deleteSubject}"`,
  "publish",
  deleteSubject,
);

const releasedCases: [string, unknown][] = [
  ["ConsumerNotFound with non-matching description", new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.ConsumerNotFound, description: "consumer gone" })],
  ["StreamNotFound", new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.StreamNotFound, description: "stream gone" })],
  ["publish PermissionViolationError", publishDenied],
  ["wrapped publish PermissionViolationError", new Error("wrapped", { cause: publishDenied })],
];

for (const [label, err] of releasedCases) {
  const releasedWatch = {
    onChange: () => {},
    stopped: false,
    arm: Promise.resolve(),
    consumerStream: "KV_membership",
    consumerName: "ordered-watch",
    consumer: { delete: () => Promise.reject(err) } as unknown as PushConsumer,
  };
  let disarmErr: unknown;
  let disarmThrew = false;
  try { await disarm(releasedWatch); } catch (e) { disarmThrew = true; disarmErr = e; }
  check(`disarm classifies ${label} as released`, !disarmThrew && releasedWatch.consumerStream === undefined && releasedWatch.consumerName === undefined, { disarmErr, releasedWatch });

  const jsm = { consumers: { delete: () => Promise.reject(err) } } as unknown as JetStreamManager;
  let delOk = false;
  let delErr: unknown;
  try { delOk = await deleteMember(jsm, "KV_membership", "ordered-watch"); } catch (e) { delErr = e; }
  check(`deleteMembershipConsumer classifies ${label} as released`, delOk === true && delErr === undefined, delErr);
}

const refusedCases: [string, unknown][] = [
  ["plain Error with code 404", Object.assign(new Error("consumer not found"), { code: 404 })],
  ["plain Error with stream-not-found text", new Error("wrapped: stream not found")],
  ["plain object with code 404", { code: 404 }],
  ["JetStreamApiError 404 with wrong err_code", new JetStreamApiError({ code: 404, err_code: 10000, description: "consumer not found" })],
  ["JetStreamApiError 500 with unrelated err_code and matching text", new JetStreamApiError({ code: 500, err_code: 10003, description: "stream not found" })],
  ["subscription PermissionViolationError", new PermissionViolationError('Permissions Violation for Subscription to "_INBOX.reply"', "subscription", "_INBOX.reply")],
  ["null", null],
  ["undefined", undefined],
];

for (const [label, err] of refusedCases) {
  const refusedWatch = {
    onChange: () => {},
    stopped: false,
    arm: Promise.resolve(),
    consumerStream: "KV_membership",
    consumerName: "ordered-watch",
    consumer: { delete: () => Promise.reject(err) } as unknown as PushConsumer,
  };
  let disarmCaught: unknown = Symbol("did-not-throw");
  try { await disarm(refusedWatch); } catch (e) { disarmCaught = e; }
  check(`disarm refuses ${label} and rethrows exact value`, Object.is(disarmCaught, err) && refusedWatch.consumerStream === "KV_membership" && refusedWatch.consumerName === "ordered-watch", { disarmCaught, refusedWatch });

  const jsm = { consumers: { delete: () => Promise.reject(err) } } as unknown as JetStreamManager;
  let delCaught: unknown = Symbol("did-not-throw");
  try { await deleteMember(jsm, "KV_membership", "ordered-watch"); } catch (e) { delCaught = e; }
  check(`deleteMembershipConsumer refuses ${label} and rethrows exact value`, Object.is(delCaught, err), delCaught);
}

const EXPECTED = 29;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`DISARM-DELETE-TIMEOUT SMOKE ${fail === 0 ? "OK" : "FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
