/**
 * Host policy for the two remote managed-agent lifecycle operations (#1972 §3.4).
 *
 * Both helpers answer ONE question: may this remote manager, at this instant, ask the host to
 * enroll or release a managed agent under the authenticated owner? They mint nothing, write
 * nothing, and touch no storage. The host platform that intercepts the request owns every state
 * mutation (the database row, the durables, the ledger grant) and calls one of these first.
 *
 * The guards are the same family the retained-agent validation door already enforces, because the
 * threat is the same: a participant holding a stale credential, a foreign gate, or a replayed proof
 * must not be able to reach the host's writers. `supervise` is required explicitly — `spawn` and
 * `admin` are ordinary agent capabilities and must never imply supervision of a manager lifecycle.
 */
import {
  EpEnvelopeError,
  managedRetirementOpId,
  parseRemoteManagedAgentEnrollmentRequest,
  parseRemoteManagedAgentPrepareRetirementRequest,
  remoteManagerActors,
  type RemoteManagedAgentEnrollmentRequest,
  type RemoteManagedAgentPrepareRetirementRequest,
} from "@cotal-ai/core";
import { timingSafeEqual } from "node:crypto";
import { remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";

/** The live manager gate the host observes for itself. A null answer is an absent registration. */
export type ObserveManagerGate = (instanceId: string) => Promise<{
  state: "open" | "frozen" | "retired";
  principal: string;
  processEpoch: number;
  registrationRevision: number;
} | null>;

export interface AuthorizeRemoteManagedAgentEnrollmentArgs {
  request: RemoteManagedAgentEnrollmentRequest;
  space: string;
  owner: string;
  scope: string[];
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
}

/** Host policy authorizing one fresh managed-agent enrollment. Returns the parsed request so the
 *  caller consumes the validated copy rather than the raw body it received. */
export async function authorizeRemoteManagedAgentEnrollment(
  args: AuthorizeRemoteManagedAgentEnrollmentArgs,
): Promise<RemoteManagedAgentEnrollmentRequest> {
  const r = parseRemoteManagedAgentEnrollmentRequest(args.request);
  if (r.space !== args.space)
    throw new EpEnvelopeError("permission-denied", `enrollment request names space ${r.space}, not host space ${args.space}`);
  if (!args.scope.includes("supervise"))
    throw new EpEnvelopeError("permission-denied", 'managed agent enrollment needs scope "supervise"; spawn/admin do not imply it');
  const actors = remoteManagerActors(r.instanceId);
  const gate = await args.observeManagerGate(r.instanceId);
  if (!gate || gate.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `managed agent enrollment found no current open manager gate for instance ${r.instanceId}`);
  const servePrincipal = `${args.owner}.${actors.serve}`;
  if (gate.principal !== servePrincipal)
    throw new EpEnvelopeError("permission-denied", `manager gate belongs to ${gate.principal}, not serve principal ${servePrincipal}`);
  if (gate.processEpoch !== r.serveEpoch)
    throw new EpEnvelopeError("conflict", `manager serve epoch ${r.serveEpoch} is stale; current is ${gate.processEpoch}`);
  const expectedProof = remoteManagerCurrentRegistrationProof(args.proofSecret, args.owner, r, gate);
  if (!timingSafeEqual(Buffer.from(r.registrationProof), Buffer.from(expectedProof)))
    throw new EpEnvelopeError("permission-denied", "manager enrollment proof does not match current host registration");
  return r;
}

export interface AuthorizeRemoteManagedAgentPrepareRetirementArgs {
  request: RemoteManagedAgentPrepareRetirementRequest;
  space: string;
  owner: string;
  scope: string[];
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
}

/** Host policy authorizing one managed-agent terminal release preparation (phase P0/P1). */
export async function authorizeRemoteManagedAgentPrepareRetirement(
  args: AuthorizeRemoteManagedAgentPrepareRetirementArgs,
): Promise<RemoteManagedAgentPrepareRetirementRequest> {
  const r = parseRemoteManagedAgentPrepareRetirementRequest(args.request);
  if (r.space !== args.space)
    throw new EpEnvelopeError("permission-denied", `prepare-retirement request names space ${r.space}, not host space ${args.space}`);
  if (!args.scope.includes("supervise"))
    throw new EpEnvelopeError("permission-denied", 'managed agent prepare-retirement needs scope "supervise"; spawn/admin do not imply it');
  if (r.target.owner !== args.owner)
    throw new EpEnvelopeError("permission-denied", `prepare-retirement target owner "${r.target.owner}" does not match authenticated owner "${args.owner}"`);
  // Recomputed, never trusted: one lifecycle has exactly one terminal operation, so a caller that
  // could name a second opId could run two barriers over one head.
  const expectedOpId = managedRetirementOpId(r.target.lifecycleUid);
  if (r.opId !== expectedOpId)
    throw new EpEnvelopeError("permission-denied", `prepare-retirement opId "${r.opId}" does not match derived terminal operation "${expectedOpId}" for uid ${r.target.lifecycleUid}`);
  const actors = remoteManagerActors(r.instanceId);
  const gate = await args.observeManagerGate(r.instanceId);
  if (!gate || gate.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `prepare-retirement found no current open manager gate for instance ${r.instanceId}`);
  const servePrincipal = `${args.owner}.${actors.serve}`;
  if (gate.principal !== servePrincipal)
    throw new EpEnvelopeError("permission-denied", `manager gate belongs to ${gate.principal}, not serve principal ${servePrincipal}`);
  if (gate.processEpoch !== r.serveEpoch)
    throw new EpEnvelopeError("conflict", `manager serve epoch ${r.serveEpoch} is stale; current is ${gate.processEpoch}`);
  const expectedProof = remoteManagerCurrentRegistrationProof(args.proofSecret, args.owner, r, gate);
  if (!timingSafeEqual(Buffer.from(r.registrationProof), Buffer.from(expectedProof)))
    throw new EpEnvelopeError("permission-denied", "manager prepare-retirement proof does not match current host registration");
  return r;
}
