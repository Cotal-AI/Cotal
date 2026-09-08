/**
 * A failed endpoint bind must close the transport it already opened, even when nc.close() itself
 * throws, and it must not carry connection-scoped handles forward into the next retry.
 *
 * PR #1247 first shipped a suite that stubbed startPresenceWatch to throw. The stub was never
 * entered: the fixture broker ran without JetStream, so bindConnection reached kvm.create(...)
 * for the presence bucket first and threw "jetstream is not enabled" before the stub. A
 * cross-family reviewer measured that (stubHits === 0) and BLOCKed. Enabling JetStream reaches
 * the stub (stubHits === 3, error === "fixture post-connect bind failure"), which is what CONTROL
 * asserts now, not just refusals === 3. "Threw three times" is the same exit signal whether the
 * three throws come from the stub or from kvm.create. CONTROL says which.
 *
 * The same reviewer measured that a throwing nc.close() left the broker's connection count at 1
 * per attempt: closeFailedBind swallowed the close error and had no fallback, so the underlying
 * TCP transport stayed established while every client handle on the endpoint got cleared. The
 * CLOSE-THROWS cell now injects a throwing close on the LIVE nc during the presence-watch stub
 * and asserts (a) the original bind error is what start() throws (the close error is diagnostic
 * noise), (b) broker /varz.connections is 0 afterward, and (c) the deliveryServeSub /
 * deliveryAdminServeSub / this.subs handles do not survive the failure past armDeliveryControl.
 *
 * Scratch under /var/tmp per the review notes: os.tmpdir() lands under /tmp on this Linux CI
 * and the review flagged that as unacceptable for a broker store. Mutation fixture lives at
 * bin/smoke/mutations/failed-bind-cleanup.json. Verb is `pnpm mutation-proof` per package.json.
 *
 * Run: pnpm smoke:failed-bind-cleanup
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CotalEndpoint, isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = await pickFreePort();
const MON = await pickFreePort();
if (PORT === 4222 || MON === 4222) throw new Error("refusing to bind :4222 (shared with the workstation broker)");
const SERVERS = `nats://127.0.0.1:${PORT}`;
// /var/tmp, not os.tmpdir(). On this CI shape os.tmpdir() resolves under /tmp, which the review
// flagged as ineligible for a broker store; /var/tmp is the sanctioned scratch root.
const dir = mkdtempSync(join("/var/tmp", SMOKE_BROKER_TOKEN));
const store = join(dir, "js");
// -js so bindConnection's kvm.create for the presence bucket succeeds and the presence-watch
// stub is actually reached. Without -js the KV open throws "jetstream is not enabled" first and
// every cell in this file becomes a test of a DIFFERENT bind failure than the one it names.
const broker = spawn(
  "nats-server",
  ["-a", "127.0.0.1", "-p", String(PORT), "-m", String(MON), "-js", "-sd", store],
  { stdio: "ignore" },
);
const releaseBroker = teardownOnSignal(broker, dir);

let cells = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  cells++;
  if (condition) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const connectionCount = async (): Promise<number> => {
  const response = await fetch(`http://127.0.0.1:${MON}/varz`);
  if (!response.ok) throw new Error(`monitor returned ${response.status}`);
  const body = (await response.json()) as { connections?: number };
  if (!Number.isInteger(body.connections)) throw new Error("monitor response omitted connections");
  return body.connections!;
};

const makeEndpoint = () =>
  new CotalEndpoint({
    space: "failed-bind-cleanup",
    servers: SERVERS,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    watchChannels: false,
    card: { name: "retrying-client", kind: "endpoint" },
  });

// Fields that closeFailedBind must clear (used by the CLOSE-THROWS cell). Named as strings so
// the reflection stays greppable when the source moves.
type Handles = {
  nc: boolean;
  deliveryServeSub: boolean;
  deliveryAdminServeSub: boolean;
  subsLen: number;
};
const snapshot = (endpoint: CotalEndpoint): Handles => {
  const e = endpoint as unknown as {
    nc?: unknown;
    deliveryServeSub?: unknown;
    deliveryAdminServeSub?: unknown;
    subs?: unknown[];
  };
  return {
    nc: e.nc !== undefined,
    deliveryServeSub: e.deliveryServeSub !== undefined,
    deliveryAdminServeSub: e.deliveryAdminServeSub !== undefined,
    subsLen: Array.isArray(e.subs) ? e.subs.length : 0,
  };
};

let endpointHandle: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(100);
  }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS}`);

  // --- Cell 1: the presence-watch stub is REACHED, and the retry loop closes the transport ---
  //
  // Two named cells share the same three attempts. Splitting them makes the CONTROL failure mode
  // ("something else threw") and the invariant failure mode ("close leaked a socket") report on
  // different lines, so a red run points at the right defect. The stubHits count is the evidence
  // that the JetStream fixture actually reaches the stub the suite documents; a green run at
  // stubHits === 0 was the state the reviewer's BLOCK named.
  {
    const endpoint = makeEndpoint();
    endpointHandle = endpoint;
    endpoint.on("error", () => {});
    let stubHits = 0;
    const stubMsg = "fixture post-connect bind failure";
    (endpoint as unknown as { startPresenceWatch: () => Promise<void> }).startPresenceWatch = async () => {
      stubHits++;
      throw new Error(stubMsg);
    };
    const counts: number[] = [];
    const errors: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await endpoint.start();
        errors.push("resolved");
      } catch (err) {
        errors.push((err as Error).message);
      }
      await wait(100);
      counts.push(await connectionCount());
    }
    await endpoint.stop().catch(() => {});
    endpointHandle = undefined;

    // CONTROL grades WHICH bind step threw, not merely that start() threw three times. If the
    // fixture reverts to a core-only broker (regressed away from -js), stubHits is 0 and errors
    // are all "jetstream is not enabled", and this cell reddens on the same line every time.
    check(
      "CONTROL: every attempt reaches the presence-watch stub (stubHits === 3, error === stub msg)",
      stubHits === 3 && errors.every((m) => m === stubMsg),
      { stubHits, errors },
    );
    check("A FAILED BIND CLOSES ITS TRANSPORT BEFORE THE CALLER RETRIES", counts.every((count) => count === 0), {
      counts,
    });
  }

  // --- Cell 2: nc.close() itself throws; the transport must still go down ---
  //
  // The stub replaces the LIVE nc.close on the connection the dial just returned, then throws
  // the bind error. closeFailedBind's fast path (await failedNc.close()) reaches the injected
  // throw; the fallback path (drain(), then nc.protocol.transport.close()/disconnect()) must
  // still bring the socket down. This is the failure mode the reviewer's probe named that the
  // previous suite could not see.
  {
    const endpoint = makeEndpoint();
    endpointHandle = endpoint;
    endpoint.on("error", () => {});
    const bindMsg = "fixture close-throws bind failure";
    (endpoint as unknown as { startPresenceWatch: () => Promise<void> }).startPresenceWatch = async () => {
      const nc = (endpoint as unknown as { nc?: { close: () => Promise<void> } }).nc;
      if (!nc) throw new Error("expected live nc before presence watch");
      nc.close = async () => {
        throw new Error("injected close failure");
      };
      throw new Error(bindMsg);
    };
    let thrownMessage = "";
    try {
      await endpoint.start();
    } catch (err) {
      thrownMessage = (err as Error).message;
    }
    // 200ms to let the broker's monitor observe the FIN. The fallback path forces the socket
    // synchronously in the last-resort branch, but /varz refresh is polled server-side.
    await wait(200);
    const after = await connectionCount();
    const surviving = snapshot(endpoint);
    await endpoint.stop().catch(() => {});
    endpointHandle = undefined;

    // (a) The ORIGINAL bind error is preserved; the injected close failure is swallowed as
    // diagnostic noise so the caller can key its retry on the bind reason.
    check(
      "CLOSE-THROWS: original bind error is what start() throws (not the close error)",
      thrownMessage === bindMsg,
      { thrownMessage },
    );
    // (b) The broker's /varz observes 0 connections after the fallback ran. Before the repair
    // this was 1 per attempt and same-object retries leaked one socket per iteration.
    check("CLOSE-THROWS: broker connection count returns to 0 after the failed close", after === 0, { after });
    // (c) armDeliveryControl-created handles do not survive the failure. nc is cleared. subs is
    // empty. The reviewer's third finding: those fields were only rewritten if a later retry
    // reached armDeliveryControl, so a failure past that point used to strand them.
    check(
      "CLOSE-THROWS: nc / deliveryServeSub / deliveryAdminServeSub / subs are cleared",
      !surviving.nc &&
        !surviving.deliveryServeSub &&
        !surviving.deliveryAdminServeSub &&
        surviving.subsLen === 0,
      surviving,
    );
  }
} finally {
  await endpointHandle?.stop().catch(() => {});
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nfailed bind cleanup smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
