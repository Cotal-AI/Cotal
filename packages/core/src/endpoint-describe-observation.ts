import type { ValidateFunction } from "ajv";
import { contractDigest } from "./canonical.js";
import { spacePrefix } from "./subjects.js";
import { parseEpSubject, type ParsedEpRequest } from "./endpoint-subjects.js";
import { EpEnvelopeError, parseEndpointRequest, checkRequestSubjectAgreement, assertClassMatches, assertArgsValid } from "./endpoint-envelope.js";
import { compileContract, VOID_SCHEMA } from "./schema-profile.js";
import type { EpServeIdentity } from "./endpoint-serve.js";

/** Local receive metadata only. A fingerprint is not proof of broker receipt or authority. */
export interface DescribeRequestContext {
  readonly subject: string;
  readonly fingerprint: string;
  readonly identity: Readonly<EpServeIdentity>;
  readonly receivedAtMonotonicMs: number;
  readonly replyExpected: boolean;
  readonly deadlineMs?: number;
}
export interface ParsedDescribeObservation {
  subject: ParsedEpRequest;
  fingerprint: string;
  replyExpected: boolean;
  deadlineMs?: number;
}
let voidValidator: ValidateFunction | undefined;

/** Syntax and complete-JSON binding only. The caller must independently establish actual receipt. */
export function parseDescribeObservation(space: string, subject: string, originalEnvelope: unknown): ParsedDescribeObservation {
  if (typeof subject !== "string" || !subject.startsWith(`${spacePrefix(space)}.ep.`))
    throw new EpEnvelopeError("bad-request", "Describe observation belongs to another space or plane");
  const parsed = parseEpSubject(subject);
  if (!parsed || parsed.plane !== "request" || parsed.command !== "describe")
    throw new EpEnvelopeError("bad-request", "Describe observation requires a native Describe request subject");
  const request = parseEndpointRequest(originalEnvelope);
  checkRequestSubjectAgreement(request, parsed);
  assertClassMatches(request, "ephemeral");
  if (request.op.inputDigest !== undefined || request.op.outputDigest !== undefined)
    throw new EpEnvelopeError("contract-mismatch", "Describe carries no contract digest pins");
  if (parsed.target !== null)
    throw new EpEnvelopeError("permission-denied", "Describe is untargeted");
  voidValidator ??= compileContract({ root: VOID_SCHEMA }).validate;
  assertArgsValid(voidValidator, request.args);
  let fingerprint: string;
  try { fingerprint = contractDigest({ subject, envelope: originalEnvelope }); }
  catch { throw new EpEnvelopeError("bad-request", "Describe fingerprint requires a complete canonicalizable JSON envelope"); }
  return { subject: parsed, fingerprint, replyExpected: request.replyExpected,
    ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }) };
}
