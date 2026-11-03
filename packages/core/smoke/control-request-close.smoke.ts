/** Real named-reply requests must settle when their connection closes, including a clean stop or
 *  replacement. Preserve normal replies, NoResponders and timeout classification, and release
 *  completed waiters while a connection stays open. Run: pnpm smoke:control-request-close */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, ClosedConnectionError, NoRespondersError, RequestError, TimeoutError, type Subscription } from "@nats-io/transport-node";
import { awaitBrokerReady, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { CotalEndpoint, newIdentity, setupSpaceStreams, isReachable, controlServiceSubject, livenessSubject, DEV_OWNER, CONTROL_DELIVERY, CONTROL_DELIVERY_ADMIN } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

async function within<T>(promise: Promise<T>, ms = 7_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("request did not settle within the test budget")), ms);
    })]);
  } finally { clearTimeout(timer!); }
}
type Outcome = { kind: "reply"; value: unknown } | { kind: "error"; error: unknown };
const outcome = (p: Promise<unknown>): Promise<Outcome> => p.then(
  (value) => ({ kind: "reply", value }), (error: unknown) => ({ kind: "error", error }),
);
let pass = 0;
const check = (name: string, condition: boolean) => { assert.ok(condition, name); pass++; console.log(`  ✓ ${name}`); };
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", dir], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const space = "control-request-close";
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space });
  const observer = await connect({ servers });
  try {
    check("fixture reached its own broker", observer.info?.port === port);
    for (const kind of ["control", "delivery", "admin", "liveness"] as const) {
      const identity = newIdentity();
      const ep = new CotalEndpoint({ space, servers, card: { id: identity.id, name: kind, kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false });
      ep.on("error", () => {});
      const pending = () => (ep as unknown as { requestsAwaitingReply: Map<unknown, Set<unknown>> }).requestsAwaitingReply;
      const waiterCount = () => [...pending().values()].reduce((n, set) => n + set.size, 0);
      const subject = kind === "liveness" ? livenessSubject(space, "manager", DEV_OWNER, identity.id)
        : controlServiceSubject(space, kind === "control" ? "probe" : kind === "admin" ? CONTROL_DELIVERY_ADMIN : CONTROL_DELIVERY, DEV_OWNER, identity.id);
      const call = (ms = 5_000): Promise<unknown> => kind === "control" ? ep.requestControl("probe", { op: "probe" }, ms)
        : kind === "delivery" ? ep.readHistory("general")
        : kind === "admin" ? ep.requestDeliveryAdmin("probe", {}, ms)
        : ep.probeLiveness("manager", ms);
      const reply = kind === "liveness" ? { plane: "manager", responder: "bound" }
        : kind === "delivery" ? { ok: true, data: { items: [], complete: true } } : { ok: true };
      const expected = kind === "delivery" ? { items: [], complete: true } : reply;
      let answering = true;
      let received: (() => void) | undefined;
      const replySubjects = new Set<string>();
      let bounded = true;
      let sub: Subscription | undefined;
      const subscribe = () => observer.subscribe(subject, { callback: (error, message) => {
        if (error) throw error;
        assert.ok(message.reply, "native request carries a reply subject");
        bounded &&= message.reply.startsWith(`${subject}.reply.`) && !replySubjects.has(message.reply);
        replySubjects.add(message.reply);
        received?.();
        if (answering) message.respond(JSON.stringify(reply));
      } });
      const inFlight = async () => {
        const arrived = new Promise<void>((resolve) => { received = resolve; });
        const result = outcome(call(10_000));
        await within(arrived);
        received = undefined;
        return { result };
      };
      const closedAsExpected = (result: Outcome) => kind === "liveness"
        ? result.kind === "reply" && JSON.stringify(result.value) === JSON.stringify({ plane: "manager", responder: "unknown" })
        : result.kind === "error" && result.error instanceof ClosedConnectionError;
      try {
        await ep.start();
        sub = subscribe();
        await observer.flush();
        for (let i = 0; i < 8; i++) assert.deepEqual(await within(call()), expected);
        check(`${kind}: eight normal native replies retain their payloads`, replySubjects.size === 8);
        check(`${kind}: named replies stay unique under the caller request subject`, bounded);
        check(`${kind}: completed requests leave no waiters and one connection entry`, waiterCount() === 0 && pending().size === 1);

        sub.unsubscribe();
        await observer.flush();
        const absent = await within(outcome(call()));
        check(`${kind}: no-responder classification survives`, kind === "liveness"
          ? absent.kind === "reply" && JSON.stringify(absent.value) === JSON.stringify({ plane: "manager", responder: "unbound" })
          : absent.kind === "error" && (absent.error instanceof NoRespondersError || absent.error instanceof RequestError && absent.error.cause instanceof NoRespondersError));
        check(`${kind}: no-responder completion releases its waiter`, waiterCount() === 0);

        answering = false;
        sub = subscribe();
        await observer.flush();
        const timeout = await within(outcome(call(150)));
        check(`${kind}: unanswered request keeps native timeout classification`, kind === "liveness"
          ? timeout.kind === "reply" && JSON.stringify(timeout.value) === JSON.stringify({ plane: "manager", responder: "unknown" })
          : timeout.kind === "error" && timeout.error instanceof TimeoutError);
        check(`${kind}: timeout completion releases its waiter`, waiterCount() === 0);

        const replacing = await inFlight();
        check(`${kind}: the request really reached its responder before replacement`, waiterCount() === 1);
        await within(ep.reconnect(), 15_000);
        check(`${kind}: old-connection request settles on replacement`, closedAsExpected(await within(replacing.result, 1_000)));
        answering = true;
        assert.deepEqual(await within(call()), expected);
        check(`${kind}: a new request uses the replacement connection successfully`, waiterCount() === 0 && pending().size === 1);

        answering = false;
        const stopping = await inFlight();
        const concurrent = await inFlight();
        check(`${kind}: concurrent requests share the connection entry`, waiterCount() === 2 && pending().size === 1);
        await within(ep.stop(), 10_000);
        const stopped = await within(Promise.all([stopping.result, concurrent.result]), 1_000);
        check(`${kind}: clean endpoint stop settles both pending requests`, stopped.every(closedAsExpected));
        check(`${kind}: closed connections retain no waiter entries`, pending().size === 0);
      } finally {
        sub?.unsubscribe();
        await ep.stop();
      }
    }
  } finally { await observer.close(); }
} finally {
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
console.log(`CONTROL REQUEST CLOSE SMOKE: ${pass} passed`);
