/**
 * Service caller issuance for an own-broker root: compose the payload bootstrap from the system-account
 * signing seed this root retained, and from nothing else. The seed never leaves this process: each
 * bootstrap mints one 60 s VARZ-only observer credential from it. Ownership is proved before any use:
 * the record's account is the persisted trust record's system account and the seed derives it, and
 * the bootstrap itself requires this account's genuine plane claim and records the broker it observed
 * (`bootstrapServiceCallerPayload`; the engine re-checks that server on every issuance). A root with no
 * retained seed composes nothing and says why; a record for another account refuses the start.
 */
import { fromSeed } from "@nats-io/nkeys";
import { isAccountNkey, type SecretStore } from "@cotal-ai/core";
import { getSpaceAuth, readSystemSigningSeed } from "@cotal-ai/workspace";
import { mintServiceCallerPayloadObserverCreds, type ServiceCallerPayloadBootstrap } from "./service-caller-payload-bootstrap.js";

export type OwnBrokerCallerPayload =
  | { state: "composed"; sysPub: string; callerPayload: ServiceCallerPayloadBootstrap }
  | { state: "absent"; reason: string };

export const CALLER_PAYLOAD_NOT_COMPOSED =
  "service caller issuance is not composed: this root holds no retained system-account signing seed (a space created before custody, or a hosted store without one); caller grants refuse as unsupported until `cotal up --rotate-sys` on a stopped mesh retains one";

/** The caller payload bootstrap for `space`, from this root's retained seed, or why there is none. */
export async function ownBrokerCallerPayload(store: SecretStore, space: string): Promise<OwnBrokerCallerPayload> {
  const auth = await getSpaceAuth(store, space);
  if (auth === undefined) return { state: "absent", reason: CALLER_PAYLOAD_NOT_COMPOSED };
  const record = await readSystemSigningSeed(store, space);
  if (record === undefined) return { state: "absent", reason: CALLER_PAYLOAD_NOT_COMPOSED };
  if (record.sysPub !== auth.sys.pub)
    throw new Error(`the retained system-account signing seed names account ${record.sysPub}, not this space's system account ${auth.sys.pub}; the custody record is stale - rotate the system account or restore the record`);
  let derived: string;
  try { derived = fromSeed(new TextEncoder().encode(record.signingSeed)).getPublicKey(); } catch { throw new Error("the retained system-account signing seed is not a valid account seed; restore the record or rotate the system account"); }
  if (!isAccountNkey(derived) || derived !== record.sysPub)
    throw new Error(`the retained system-account signing seed does not derive its recorded account ${record.sysPub}; restore the record or rotate the system account`);
  const sys = { pub: record.sysPub, signingSeed: record.signingSeed };
  return { state: "composed", sysPub: record.sysPub, callerPayload: { observerCreds: () => mintServiceCallerPayloadObserverCreds(sys) } };
}

/** What `--service-endpoints` passes to the authority plane: off means no engine, no door and no
 *  store read; on means the engine and door open, with caller issuance composed only when this root
 *  retained its seed. A root without custody keeps every other route; only caller grants refuse as
 *  unsupported, as they did before custody existed. */
export async function serviceEndpointsOption(store: SecretStore, space: string, enabled: boolean):
  Promise<{ option: { startup: { kind: "normal" }; callerPayload?: ServiceCallerPayloadBootstrap } | undefined; log: string | undefined }> {
  if (!enabled) return { option: undefined, log: undefined };
  const composed = await ownBrokerCallerPayload(store, space);
  return composed.state === "composed"
    ? { option: { startup: { kind: "normal" }, callerPayload: composed.callerPayload }, log: `service caller issuance composes from the retained system account ${composed.sysPub}` }
    : { option: { startup: { kind: "normal" } }, log: composed.reason };
}
