/**
 * `run-answer` on a signerless host: `RunHosting.answer` and `amend` map the resolver's own
 * refusal to `not-found` and pass every other failure of the locate step through as the value the
 * host rejected with. A `run-operator` issuance that rejects with `null`, `undefined` or a string
 * reaches the caller as that value, never as the handler's own `TypeError`. The issuance rejects
 * before anything is dialled, so no broker is started.
 *
 * Run: pnpm smoke:run-answer-rejection   (after `pnpm build`)
 */
import { randomBytes } from "node:crypto";
import { EpEnvelopeError, epRequestSubject, mintGeneration, mintLifecycleUid, parseEpSubject, type EpServeContext, type IssuedCaller } from "@cotal-ai/core";
import { RunHosting } from "@cotal-ai/manager";
import "@cotal-ai/runtime";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const space = "runanswer", endpoint = "manager";
const caller: IssuedCaller = { owner: "alice", actor: "cli", uid: mintLifecycleUid(), generation: mintGeneration() };
const subject = parseEpSubject(epRequestSubject(space, {
  route: { mode: "one" }, endpoint, command: "run-answer", caller, nonce: randomBytes(16).toString("base64url"),
}));
if (subject?.plane !== "request") throw new Error("the served run-answer subject did not parse as a request");
const ctx = { subject } as EpServeContext;
const args = { runId: "run-answer-rejection", stepKey: "/checkpoint:approve#0" };
const unused = async (): Promise<never> => { throw new Error("unused issuance callback"); };
const hosting = (rejection: unknown) => new RunHosting({
  space, servers: undefined, endpoint, instanceId: mintLifecycleUid(), holder: { id: "manager", lifecycleUid: mintLifecycleUid() },
  auth: undefined, log: () => {}, admitRun: unused, issueAttempt: unused, renewRun: unused,
  issueOperator: async () => { throw rejection; },
});
const RETURNED = Symbol("returned");
const answerRejection = (rejection: unknown) => hosting(rejection).answer(args, "alice.cli", undefined, ctx).then(() => RETURNED, (e: unknown) => e);
const amendRejection = (rejection: unknown) => hosting(rejection).amend(args, "alice.cli", undefined, ctx).then(() => RETURNED, (e: unknown) => e);
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const shown = (e: unknown) => e instanceof Error ? `${e.name}: ${e.message}` : String(e);

for (const [label, rejection] of [["a null", null], ["an undefined", undefined], ["a string", "refused as text"]] as const) {
  const answered = await answerRejection(rejection);
  check(`answer passes ${label} rejection through`, Object.is(answered, rejection), shown(answered));
  const amended = await amendRejection(rejection);
  check(`amend passes ${label} rejection through`, Object.is(amended, rejection), shown(amended));
}

const notOpen = await answerRejection(named("CheckpointNotOpen", "no open checkpoint at that key"));
check("answer maps CheckpointNotOpen to not-found with its message",
  notOpen instanceof EpEnvelopeError && notOpen.code === "not-found" && notOpen.message === "no open checkpoint at that key", shown(notOpen));
const notAmendable = await amendRejection(named("CheckpointNotAmendable", "that pause is not amendable"));
check("amend maps CheckpointNotAmendable to not-found with its message",
  notAmendable instanceof EpEnvelopeError && notAmendable.code === "not-found" && notAmendable.message === "that pause is not amendable", shown(notAmendable));
const crossed = named("CheckpointNotAmendable", "that pause is not amendable");
check("answer passes CheckpointNotAmendable through", await answerRejection(crossed) === crossed);
const plain = new Error("plain refusal");
check("answer and amend pass a plain Error through", await answerRejection(plain) === plain && await amendRejection(plain) === plain);
const envelope = new EpEnvelopeError("permission-denied", "not yours");
check("answer and amend pass an envelope error through", await answerRejection(envelope) === envelope && await amendRejection(envelope) === envelope);

finish();
