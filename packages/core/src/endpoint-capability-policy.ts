import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { epCallerGrantRows, type EpCapability } from "./endpoint-grants.js";
import { assertBoundedOwner, assertCommandToken, assertLifecycleToken, endpointToken, type EpCaller, type EpTarget } from "./endpoint-subjects.js";
import { patternCovers } from "./subjects.js";

export const ENDPOINT_POLICY_MAX_CAPABILITIES = 256;

function invalid(detail: string): never {
  throw new EpEnvelopeError("bad-request", `endpoint caller policy: ${detail}`);
}

function record(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid("expected an object");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) invalid("expected a plain object");
  if (Reflect.ownKeys(raw).some((k) => typeof k !== "string" || !fields.includes(k))) invalid("unsupported field");
  return raw as Record<string, unknown>;
}

/** Closed syntax and deterministic defaults. This does not establish anyone's entitlement. */
export function parseEndpointCapabilities(raw: unknown): EpCapability[] {
  if (!Array.isArray(raw) || raw.length > ENDPOINT_POLICY_MAX_CAPABILITIES) invalid("capabilities must be a bounded array");
  const unique = new Map<string, EpCapability>();
  for (const item of raw) {
    const o = record(item, ["endpoint", "command", "routes", "instanceId", "instanceOnly", "target", "journal"]);
    if (!Object.hasOwn(o, "endpoint") || !Object.hasOwn(o, "command") || typeof o.endpoint !== "string" || typeof o.command !== "string") invalid("endpoint and command are required");
    endpointToken(o.endpoint); assertCommandToken(o.command);
    if (o.instanceId !== undefined && typeof o.instanceId !== "string") invalid("instanceId must be a token");
    if (o.instanceId !== undefined) assertLifecycleToken(o.instanceId as string, "instanceId");
    for (const key of ["instanceOnly", "journal"]) if (o[key] !== undefined && typeof o[key] !== "boolean") invalid(`${key} must be boolean`);
    if (o.instanceOnly === true && o.instanceId === undefined) invalid("instance-only capability requires an instanceId");
    const routes = o.routes ?? (o.instanceOnly === true ? [] : ["one"]);
    if (!Array.isArray(routes) || routes.some((r) => r !== "one" && r !== "all") || new Set(routes).size !== routes.length)
      invalid("routes must contain distinct one/all values");
    if (o.instanceOnly === true && routes.length !== 0) invalid("instance-only capability cannot carry class routes");
    if (o.instanceOnly !== true && routes.length === 0 && o.instanceId === undefined) invalid("capability has no route");
    let target: EpTarget | undefined;
    if (o.target !== undefined) {
      const t = record(o.target, ["mode", "tOwner"]);
      if (t.mode === "self") {
        if (Object.keys(t).length !== 1) invalid("self target carries no owner field");
        target = { mode: "self" };
      } else if (t.mode === "owner" || t.mode === "child" || t.mode === "any" || t.mode === "ledger") {
        if (typeof t.tOwner !== "string" || Object.keys(t).length !== 2) invalid("target owner is required");
        if (t.tOwner === "*") {
          if (t.mode !== "any" && t.mode !== "ledger") invalid("owner/child targets cannot use wildcard ownership");
        } else assertBoundedOwner(t.tOwner, "target owner");
        target = { mode: t.mode, tOwner: t.tOwner };
      } else invalid("unsupported standing target mode");
    }
    const cap: EpCapability = {
      endpoint: o.endpoint, command: o.command, routes: [...routes].sort() as ("one" | "all")[],
      ...(o.instanceId === undefined ? {} : { instanceId: o.instanceId as string }),
      ...(o.instanceOnly === true ? { instanceOnly: true } : {}),
      ...(target === undefined ? {} : { target }),
      ...(o.journal === true ? { journal: true } : {}),
    };
    unique.set(canonicalJson(cap), cap);
  }
  return [...unique.keys()].sort().map((key) => unique.get(key)!);
}

/** Validate the actual recipient before lowering. Operator entitlement comes from the host. */
export function validateEndpointCapabilities(
  space: string,
  raw: unknown,
  caller: EpCaller,
  policy: { allowOperatorTargets: boolean },
): EpCapability[] {
  const caps = parseEndpointCapabilities(raw);
  if (policy.allowOperatorTargets !== true && caps.some((c) => c.target?.mode === "any" || c.target?.mode === "ledger"))
    throw new EpEnvelopeError("permission-denied", "endpoint caller policy requires explicit operator authority for any/ledger targets");
  epCallerGrantRows(space, caps, caller);
  return caps;
}

/** Compare real rail authority, retaining route/instance/target/journal restrictions. Relative
 * targets across different principals are refused here; their semantic containment is not proved
 * by replacing a caller tuple. This helper never authenticates a parent or skips provenance reads. */
export function endpointCapabilitiesWithin(args: {
  space: string;
  child: { caller: EpCaller; capabilities: readonly EpCapability[] };
  parent: { caller: EpCaller; capabilities: readonly EpCapability[] };
}): boolean {
  const child = parseEndpointCapabilities(args.child.capabilities);
  const parent = parseEndpointCapabilities(args.parent.capabilities);
  epCallerGrantRows(args.space, child, args.child.caller);
  epCallerGrantRows(args.space, parent, args.parent.caller);
  if (args.child.caller.owner !== args.parent.caller.owner) return false;
  const samePrincipal = args.child.caller.actor === args.parent.caller.actor && args.child.caller.uid === args.parent.caller.uid;
  if (!samePrincipal && child.some((c) => c.target?.mode === "self" || c.target?.mode === "child")) return false;
  const normalizedChild = epCallerGrantRows(args.space, child, args.child.caller);
  const normalizedParent = epCallerGrantRows(args.space, parent, args.child.caller);
  return normalizedChild.pub.every((row) => normalizedParent.pub.some((ceiling) => patternCovers(ceiling, row))) &&
    normalizedChild.sub.every((row) => normalizedParent.sub.some((ceiling) => patternCovers(ceiling, row)));
}
