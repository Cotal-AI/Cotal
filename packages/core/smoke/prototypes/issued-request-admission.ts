import { evidenceKey, type IssuedRef } from "./issued-authority-lifecycle.js";

// Candidate migration rule for isolated tests: an endpoint serving both rails must name why an
// unbound arrival is refused for caller-scoped admission, instead of running it as trusted.
export const UNBOUND_REFUSAL = "unbound-caller-authority";
export type IssuedArrival =
  | { kind: "issued"; ref: IssuedRef }
  | { kind: "legacy"; reason: typeof UNBOUND_REFUSAL };

export function classifyIssuedArrival(space: string, subject: string): IssuedArrival {
  const parts = subject.split(".");
  if (parts.length < 6 || parts[0] !== "cotal" || parts[1] !== space || parts[2] !== "ep")
    throw new Error(`"${subject}" is not an endpoint subject in space "${space}"`);
  const versioned = parts[3] === "v1";
  const mode = parts[versioned ? 4 : 3];
  if (!["one", "all", "inst", "reply"].includes(mode)) throw new Error(`unsupported endpoint rail kind in "${subject}"`);
  if (!versioned) return Object.freeze({ kind: "legacy" as const, reason: UNBOUND_REFUSAL });
  const [owner, actor, uid, generation] = parts.slice(-5, -1);
  const ref = Object.freeze({ space, owner, actor, uid, generation });
  evidenceKey(ref); // a malformed binding on the versioned rail is a refusal, never a legacy arrival
  return Object.freeze({ kind: "issued" as const, ref });
}
