import { assertValidOwnerToken, assertValidRole, assertValidChannel, endpointToken, type Extension, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { spaceFlag, serverFlag } from "./flags.js";
import { CommandFailure, jsonFlag, plainFlag } from "./output.js";
import { presentationOf } from "./present.js";

export const privateOutputFlag = { name: "out", type: "string", value: "<private-file>", description: "private output file; required for signer export and endpoint caller issuance" } as const satisfies FlagSpec;
export const credentialMintFlags = [
  { name: "profile", type: "string", value: "<agent|observer|admin>", description: "existing credential profile (default agent); never an internal host profile" },
  privateOutputFlag,
  { name: "endpoint", type: "string", value: "<class>", description: "issue a standalone caller for the resolved endpoint's supported command surface; requires --out" },
  { name: "channels", type: "string", value: "<a,b>", description: "endpoint callers: explicit read/post channel ACL; omitted or empty grants none" },
  { name: "allow-subscribe", type: "string", value: "<a,b>", description: "agent: channel read ACL; empty means no entries" },
  { name: "allow-publish", type: "string", value: "<a,b>", description: "agent: channel post ACL; empty means no entries" },
  { name: "role", type: "string", value: "<role>", description: "agent: scope its role task queue" },
  { name: "provision", type: "boolean", description: "agent: also pre-create this new lifecycle's bind-only inbox and delivery footprint" },
  { name: "expires-in", type: "string", value: "<seconds>", description: "positive integer credential lifetime; never with --expires-at" },
  { name: "expires-at", type: "string", value: "<unix-seconds>", description: "absolute credential expiry; never with --expires-in" },
  { name: "identity", type: "string", value: "<private-creds>", description: "reuse this file's native nkey; the actual resulting lifecycle is reported" },
  spaceFlag, serverFlag, jsonFlag, plainFlag,
] as const satisfies readonly FlagSpec[];

/** A local operator action, not a wire command or a grant. Implementations communicate via registry. */
export interface CredentialAction extends Extension {
  readonly kind: "credential-action";
  readonly name: "mint";
  validate(args: ParsedArgs): void;
  run(args: ParsedArgs): Promise<void>;
}

export function validateCredentialMintArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length !== 1) throw new CommandFailure("refused", "USAGE_INVALID", "auth mint needs one credential label");
  const values = args.values;
  if (values.signer !== undefined || values.force !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "signing material and its replacement flag belong to auth signer", { remedy: "use cotal auth signer --out <private-file> [--force]" });
  const allowed = new Set(credentialMintFlags.map((flag) => flag.name));
  if (Object.keys(values).some((key) => !allowed.has(key as typeof credentialMintFlags[number]["name"]))) throw new CommandFailure("refused", "USAGE_INVALID", "a flag does not belong to credential minting");
  try { assertValidOwnerToken(args.positionals[0]!); if (values.role !== undefined) assertValidRole(String(values.role)); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "use a valid credential label and role without path or terminal controls"); }
  if (values.endpoint !== undefined) {
    if (typeof values.endpoint !== "string" || values.channels !== undefined && (typeof values.channels !== "string" || values.channels.length > 16384)) throw new CommandFailure("refused", "USAGE_INVALID", "endpoint and channel selectors must be bounded text; no input coercion was used");
    const own = new Set(["endpoint", "channels", "out", "expires-in", "space", "server", "json", "plain"]);
    if (Object.keys(values).some((key) => !own.has(key))) throw new CommandFailure("refused", "USAGE_INVALID", "endpoint caller minting does not combine with fixed profiles, identity reuse, provisioning or agent ACL flags");
    try { endpointToken(String(values.endpoint)); for (const channel of String(values.channels ?? "").split(",").map((item) => item.trim()).filter(Boolean)) assertValidChannel(channel); }
    catch { throw new CommandFailure("refused", "USAGE_INVALID", "endpoint caller minting needs one native endpoint class and valid explicit channel patterns"); }
    if (typeof values.out !== "string" || !values.out.trim() || values.out.length > 4096 || /[\u0000-\u001f\u007f]/u.test(values.out)) throw new CommandFailure("refused", "USAGE_INVALID", "endpoint caller minting needs --out with a bounded private file path");
    if (values["expires-in"] !== undefined && (typeof values["expires-in"] !== "string" || !/^[0-9]+$/.test(values["expires-in"]) || !Number.isSafeInteger(Number(values["expires-in"])) || Number(values["expires-in"]) < 1)) throw new CommandFailure("refused", "USAGE_INVALID", "endpoint caller expiry needs a positive integer of native seconds");
    return;
  }
  if (values.channels !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--channels belongs to auth mint --endpoint; it was not ignored for a fixed profile");
  const profile = values.profile ?? "agent";
  if (!["agent", "observer", "admin"].includes(String(profile))) throw new CommandFailure("refused", "USAGE_INVALID", "auth mint supports agent, observer or admin; internal service profiles are not exposed");
  if (profile !== "agent" && ["allow-subscribe", "allow-publish", "role", "provision"].some((key) => values[key] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "channel ACL, role and provisioning inputs belong only to the agent profile; a fixed profile was not silently widened");
  if (values["expires-in"] !== undefined && values["expires-at"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "choose --expires-in or --expires-at, not both");
  for (const key of ["expires-in", "expires-at"] as const) if (values[key] !== undefined && (typeof values[key] !== "string" || !/^[0-9]+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < (key === "expires-in" ? 1 : 0))) throw new CommandFailure("refused", "USAGE_INVALID", "credential expiry needs an integer in native seconds; the supplied value was not echoed");
  // A past or present expiry writes a credential the broker already refuses, under a label that is
  // then taken.
  if (values["expires-at"] !== undefined && Number(values["expires-at"]) <= Math.floor(Date.now() / 1000)) throw new CommandFailure("refused", "USAGE_INVALID", "--expires-at is not in the future, so the credential would already be expired; nothing was written", { remedy: "give a later Unix time in seconds, or a lifetime with --expires-in <seconds>" });
  for (const key of ["identity", "out"] as const) if (values[key] !== undefined && (typeof values[key] !== "string" || !values[key].trim() || /[\u0000-\u001f\u007f]/u.test(values[key]))) throw new CommandFailure("refused", "USAGE_INVALID", "credential paths must be nonempty and contain no terminal controls");
}
