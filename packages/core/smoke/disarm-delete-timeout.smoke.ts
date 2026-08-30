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
import type { PushConsumer } from "@nats-io/jetstream";

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

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
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

const disarm = (ep as unknown as { disarmMembershipWatch(watch: typeof watch): Promise<void> }).disarmMembershipWatch.bind(ep);

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

const EXPECTED = 5;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`DISARM-DELETE-TIMEOUT SMOKE ${fail === 0 ? "OK" : "FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
