import type { ParsedArgs } from "@cotal-ai/core";
import { resolveMeshTarget } from "@cotal-ai/workspace";
import { ENROLLMENT_FILE_ENV, ENROLLMENT_URL_ENV } from "../commands/spawn-enrollment.js";
import { holdsManagedHandoff } from "../managed-handoff.js";

/** Only a launch through the installed local stack can use its already-reconciled connectors. */
export function isLocalManagedLaunch(values: ParsedArgs["values"]): boolean {
  if (values.detach !== true || values.foreground === true || values.on !== undefined || values.creds !== undefined ||
      values.server !== undefined || values["enrollment-file"] !== undefined || holdsManagedHandoff() ||
      process.env[ENROLLMENT_URL_ENV] || process.env[ENROLLMENT_FILE_ENV] ||
      process.env.COTAL_NAME || process.env.COTAL_ID || process.env.COTAL_LIFECYCLE_UID || process.env.COTAL_ACCEPTED_TOKEN) return false;
  try {
    const space = typeof values.space === "string" ? values.space : undefined;
    const target = resolveMeshTarget(process.cwd(), { space, readOnly: true });
    return target.origin === "up" && target.mode !== "user";
  } catch { return false; }
}
