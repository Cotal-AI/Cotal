import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { decode } from "@nats-io/jwt";
import { epRequestGrantRows, type EpCapability } from "../../src/endpoint-grants.js";
import { epCallerReplyFilter, epRequestSubject } from "../../src/endpoint-subjects.js";
import { evidenceKey, type IssuedRef } from "./issued-authority-lifecycle.js";

// Candidate metadata and rail encoding for isolated tests. No shipped client uses this.
export function issuedStaticTag(ref: IssuedRef): string {
  evidenceKey(ref);
  return `cotal-issued.v1.${ref.space}.${ref.owner}.${ref.actor}.${ref.uid}.${ref.generation}`;
}
export function readIssuedStaticTag(tags: unknown): IssuedRef {
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) throw new Error("invalid signed metadata tags");
  const issued = tags.filter((t: string) => t === "cotal-issued" || t.startsWith("cotal-issued."));
  if (issued.length !== 1) throw new Error("exactly one issued metadata tag is required");
  const parts = issued[0].split(".");
  if (parts.length !== 7 || parts[1] !== "v1") throw new Error("unsupported issued metadata version or shape");
  const ref = Object.freeze({ space: parts[2], owner: parts[3], actor: parts[4], uid: parts[5], generation: parts[6] });
  evidenceKey(ref);
  return ref;
}
/** The core builders spell the versioned rail themselves once the caller carries a generation
 *  (SPEC 13.15); this prototype only checks the shape it relied on before the contract shipped:
 *  `cotal.<space>.ep.v1.<mode>.….<generation>.<nonce-or-wildcard>`. */
function bound(subject: string, ref: IssuedRef): string {
  evidenceKey(ref);
  const parts = subject.split(".");
  if (parts[0] !== "cotal" || parts[1] !== ref.space || parts[2] !== "ep" || parts[3] !== "v1"
    || !["one", "all", "inst", "reply"].includes(parts[4]) || parts[parts.length - 2] !== ref.generation)
    throw new Error("unsupported prototype rail");
  if (Buffer.byteLength(subject) > 1024) throw new Error("issued subject exceeds 1024 bytes");
  return subject;
}
export function issuedRequestRows(ref: IssuedRef, capability: EpCapability): string[] {
  if (capability.journal) throw new Error("journal capabilities are unsupported by this prototype");
  return epRequestGrantRows(ref.space, capability, ref).map((row) => bound(row, ref));
}
export function issuedReplyFilter(ref: IssuedRef): string {
  return bound(epCallerReplyFilter(ref.space, ref), ref);
}
export type IssuedRequest = Omit<Parameters<typeof epRequestSubject>[1], "caller">;
export function issuedRequestSubject(ref: IssuedRef, request: IssuedRequest): string {
  return bound(epRequestSubject(ref.space, { ...request, caller: ref }), ref);
}

export async function connectIssuedStatic(server: string, material: Uint8Array) {
  if (new URL(server).hostname !== "127.0.0.1") throw new Error("static prototype requires an isolated loopback broker");
  const snapshot = new Uint8Array(material);
  const authenticator = credsAuthenticator(snapshot);
  const auth = await authenticator();
  if (!auth || !("jwt" in auth) || typeof auth.jwt !== "string") throw new Error("static credentials must carry a user JWT");
  const claims = decode<{ tags?: unknown }>(auth.jwt);
  const ref = readIssuedStaticTag(claims.nats?.tags);
  // Decoding alone establishes nothing. Return a binding only after broker authentication.
  const nc = await connect({ servers: server, authenticator, reconnect: true, maxReconnectAttempts: 2, reconnectTimeWait: 25, reconnectJitter: 0 });
  return Object.freeze({
    ref, nc,
    publish(request: IssuedRequest, data: Uint8Array): void {
      nc.publish(issuedRequestSubject(ref, request), data);
    },
  });
}
