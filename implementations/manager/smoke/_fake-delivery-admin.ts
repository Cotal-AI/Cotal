import {
  assertLifecycleToken,
  parsePrincipalKey,
  type ControlReply,
} from "@cotal-ai/core";

/**
 * Faithful requestDeliveryAdmin double for smoke fixtures modeling zero membership rows.
 * Validates the operation and arguments rather than being a generic success mock.
 */
export async function requestDeliveryAdminZeroMemberships(
  op: string,
  args?: unknown,
): Promise<ControlReply> {
  if (op !== "lifecycleMemberships") {
    return { ok: false, error: `unsupported delivery-admin op "${op}"` };
  }
  const a = args as { principal?: unknown; lifecycleUid?: unknown } | undefined;
  const principal = typeof a?.principal === "string" ? a.principal.trim() : "";
  const uid = typeof a?.lifecycleUid === "string" ? a.lifecycleUid : "";
  if (!parsePrincipalKey(principal)) {
    return { ok: false, error: "lifecycleMemberships: a principal (owner.actor dot-form) is required" };
  }
  try {
    assertLifecycleToken(uid);
  } catch (e) {
    return { ok: false, error: `lifecycleMemberships: ${(e as Error).message}` };
  }
  return { ok: true, data: { complete: true, channels: [] } };
}
