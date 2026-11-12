/**
 * Status absence-classifier smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * `status` uses two absence checks when probing manager and delivery health:
 * - `managerNoService(e)`: true only for an `EpEnvelopeError` carrying `EP_UNANSWERED` or a
 *   `cause` matching `isStreamNotFound`.
 * - `deliveryLeaseAbsent(e)`: true only when `isStreamNotFound(e)` matches.
 *
 * Neither may accept arbitrary errors whose message happens to mention `"stream not found"`, and
 * both must still recognise `JetStreamApiCodes.StreamNotFound` when the broker wording differs.
 */
import { EP_UNANSWERED, EpEnvelopeError, readSvcRecordLeader } from "@cotal-ai/core";
import { JetStreamApiCodes, JetStreamApiError, type JetStreamManager } from "@nats-io/jetstream";
import { PermissionViolationError, TimeoutError } from "@nats-io/transport-node";
import { deliveryLeaseAbsent, managerNoService } from "../src/commands/status.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : String(extra));
  }
}

const withCause = (message: string, cause: unknown): EpEnvelopeError => {
  const err = new EpEnvelopeError("failed-precondition", message);
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
};

console.log("1. managerNoService accepts unanswered envelopes and StreamNotFound causes");
check(
  "accepts EpEnvelopeError carrying EP_UNANSWERED without matching message text",
  managerNoService(new EpEnvelopeError("deadline-exceeded", "timed out", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "describe", rail: "ep" }])) === true,
);
check(
  "accepts EpEnvelopeError whose cause is StreamNotFound regardless of wording",
  managerNoService(withCause("lookup failed", new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.StreamNotFound, description: "bucket absent" }))) === true,
);

let wrappedFromReader: unknown;
try {
  const fakeJsm = {
    streams: {
      getMessage: async () => {
        throw new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.StreamNotFound, description: "bucket absent" });
      },
    },
  } as unknown as JetStreamManager;
  await readSvcRecordLeader(fakeJsm, "demo", "svc.manager.inst1.spec");
} catch (e) {
  wrappedFromReader = e;
}
check(
  "accepts the real EpEnvelopeError thrown by readSvcRecordLeader on StreamNotFound",
  managerNoService(wrappedFromReader) === true,
  wrappedFromReader,
);

console.log("2. managerNoService refuses text-only matches and non-StreamNotFound causes");
check(
  "refuses EpEnvelopeError with registry/stream-not-found text and no cause",
  managerNoService(new EpEnvelopeError("failed-precondition", 'the service registry for "manager" is unreadable: stream not found')) === false,
);
check(
  "refuses TimeoutError cause even when envelope message mentions service registry and stream not found",
  managerNoService(withCause("the service registry read failed: stream not found", new TimeoutError())) === false,
);
check(
  "refuses PermissionViolationError cause even when message mentions service registry and stream not found",
  managerNoService(withCause("the service registry read failed: stream not found", new PermissionViolationError("permissions violation", "subscription", "$JS.API.STREAM.MSG.GET.KV_rec"))) === false,
);
check(
  "refuses non-absence JetStreamApiError cause (500 / 10003)",
  managerNoService(withCause("the service registry read failed: stream not found", new JetStreamApiError({ code: 500, err_code: 10003, description: "internal error" }))) === false,
);
check(
  "refuses ConsumerNotFound cause on manager registry read",
  managerNoService(withCause("the service registry read failed: stream not found", new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.ConsumerNotFound, description: "consumer not found" }))) === false,
);
check(
  "refuses unwrapped JetStreamApiError StreamNotFound",
  managerNoService(new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.StreamNotFound, description: "stream not found" })) === false,
);
for (const nonEnvelope of [
  new Error("service registry stream not found"),
  { code: 404, message: "service registry stream not found" },
  null,
  undefined,
]) {
  check(`refuses non-EpEnvelopeError (${String(nonEnvelope)})`, managerNoService(nonEnvelope) === false);
}

console.log("3. deliveryLeaseAbsent classifies only structured StreamNotFound errors");
check(
  "accepts JetStreamApiError StreamNotFound regardless of description wording",
  deliveryLeaseAbsent(new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.StreamNotFound, description: "bucket absent" })) === true,
);
for (const refusal of [
  new Error("stream not found"),
  new PermissionViolationError("permissions violation: stream not found", "subscription", "$JS.API.STREAM.INFO.KV_cotal_deliv"),
  new TimeoutError(),
  new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.ConsumerNotFound, description: "consumer not found" }),
  new JetStreamApiError({ code: 500, err_code: 10003, description: "stream not found" }),
  { code: 404, message: "stream not found" },
  null,
  undefined,
]) {
  check(`refuses non-StreamNotFound value (${String(refusal)})`, deliveryLeaseAbsent(refusal) === false);
}

console.log(`\n${fail === 0 ? "STATUS-NO-SERVICE SMOKE OK ✅" : "STATUS-NO-SERVICE SMOKE FAILED ❌"} (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

