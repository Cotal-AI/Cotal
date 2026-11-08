import { fromSeed } from "@nats-io/nkeys";
import {
  credsClaims, credsProblem, inspectCredHealth, isAccountNkey, mintConnectionEvictorCreds, newIdentity,
  type FlagValues, type ParsedArgs, type SpaceAuth,
} from "@cotal-ai/core";
import {
  accountInventory, assertSingleSpaceBroker, authDir, CommandFailure, connectionEvictorCredsKey,
  CONNECTION_EVICTOR_CREDS_KIND, findCotalRoot, getSoleSpaceAuth, getSpaceAuth, jsonFlag, plainFlag,
  presentationOf, readSystemSigningSeed, spaceFlag, workspaceSecretStore, writeResult, type Report,
} from "@cotal-ai/workspace";
import { linkedCotalRefusal } from "../lib/paths.js";

export const mintEvictorFlags = [jsonFlag, plainFlag, spaceFlag] as const;

/** `cotal mint-evictor` takes no positionals. The space is the sole one, or `--space`. */
export function validateMintEvictorArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "use mint-evictor [--space <space>] [--json|--plain]");
}

/** The kick-only credential for one space, signed by the system-account seed this root already
 *  retained. It writes only when that file is absent, and only on a broker that hosts this one
 *  space: the kick subject is broker-wide, so the guard that refuses `cotal up --rotate-sys`
 *  refuses this too. A file that is already there is left as it is. The system account, the broker
 *  config and the observer are not touched, so a running broker accepts the new file on the
 *  delivery daemon's next eviction. */
export async function mintEvictor(args: ParsedArgs): Promise<void> {
  validateMintEvictorArguments(args);
  const values = args.values as FlagValues<typeof mintEvictorFlags>;
  const linked = linkedCotalRefusal("up");
  if (linked) throw linked;
  const root = findCotalRoot(process.cwd());
  const store = workspaceSecretStore(root);
  const named = typeof values.space === "string" ? values.space : undefined;
  if (named === undefined) {
    let spaces: string[] = [];
    try { const inventory = accountInventory(authDir(root)); if (!inventory.corrupt.length) spaces = inventory.spaces; } catch { /* the read below refuses it */ }
    if (spaces.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", `this root holds accounts for ${spaces.length} spaces (${spaces.join(", ")}); mint-evictor mints one space's credential`, { target: { root, space: null, candidates: spaces }, remedy: `pass --space with one of ${spaces.join(", ")}` });
  }
  let auth: SpaceAuth | undefined;
  try { auth = named ? await getSpaceAuth(store, named) : await getSoleSpaceAuth(store, authDir(root)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the local authority inventory could not be validated; nothing was minted", { target: { root, space: named ?? null } }); }
  if (!auth) throw new CommandFailure("refused", "AUTH_REQUIRED", "no signing trust for this space is present; nothing was minted", { target: { root, space: named ?? null }, remedy: "run mint-evictor in the space's root, or pass --space" });
  const target = { root, space: auth.space };
  // The same guard the rotation asks, so the two cannot disagree about which roots may mint a kick
  // credential. The kick subject is not account-scoped.
  try { assertSingleSpaceBroker(authDir(root), "minting the connection-evictor credential (`cotal mint-evictor`)"); }
  catch (e) { throw new CommandFailure("refused", "UNSUPPORTED", (e as Error).message, { target }); }
  const record = await readSystemSigningSeed(store, auth.space);
  if (record === undefined) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root holds no retained system-account signing seed, so the evictor cannot be minted without a system-account rotation", { target, remedy: "`cotal down` then `cotal up --rotate-sys` retains the seed and mints the credential" });
  if (record.sysPub !== auth.sys.pub) throw new CommandFailure("refused", "CONFLICT", `the retained system-account signing seed names account ${record.sysPub}, not this space's system account ${auth.sys.pub}`, { target, remedy: "restore the custody record, or rotate the system account with `cotal down` then `cotal up --rotate-sys`" });
  let derived: string;
  try { derived = fromSeed(new TextEncoder().encode(record.signingSeed)).getPublicKey(); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained system-account signing seed is not a valid account seed; nothing was minted", { target, remedy: "restore the custody record, or rotate the system account" }); }
  if (!isAccountNkey(derived) || derived !== record.sysPub) throw new CommandFailure("refused", "SCHEMA_INVALID", `the retained system-account signing seed does not derive its recorded account ${record.sysPub}; nothing was minted`, { target, remedy: "restore the custody record, or rotate the system account" });
  const key = connectionEvictorCredsKey(auth.space, { injected: false, root });
  const existing = await store.get(key);
  if (existing !== undefined) return leaveExisting(values, target, auth, existing);
  const creds = await mintConnectionEvictorCreds({ ...auth, sys: { ...auth.sys, signingSeed: record.signingSeed } }, newIdentity());
  if (credsClaims(creds).iss !== auth.sys.pub) throw new CommandFailure("failed", "OPERATION_FAILED", "the minted connection-evictor credential is not signed by this space's system account; it was not written", { target });
  await store.put(key, creds);
  const health = inspectCredHealth(creds);
  const result = { kind: "connection-evictor" as const, file: CONNECTION_EVICTOR_CREDS_KIND, minted: true, state: health.state, expiresAt: health.exp ?? null };
  writeResult(presentationOf(values), { command: "mint-evictor", target, result }, (): Report => ({ sections: [{ title: "Connection evictor minted", blocks: [
    { kind: "fields", rows: [["Space", auth.space], ["File", CONNECTION_EVICTOR_CREDS_KIND], ["Expires", health.exp ? new Date(health.exp * 1000).toISOString().slice(0, 10) : "not set"]] },
    { kind: "lines", lines: [{ text: "Signed by the system account this broker already loads. A running delivery daemon reads it on the next eviction; the broker was not restarted and the system account was not rotated.", tone: "hint" }] },
  ] }] }));
}

/** A file that is already there is reported and not replaced. One the client cannot parse, or one
 *  signed by another system account, is a conflict: replacing either would hide the condition. */
function leaveExisting(values: FlagValues<typeof mintEvictorFlags>, target: { root: string; space: string }, auth: SpaceAuth, existing: string): void {
  const problem = credsProblem(existing);
  if (problem) throw new CommandFailure("refused", "CONFLICT", "the connection-evictor credential is present but the NATS client cannot parse it; it was not replaced", { target, remedy: problem.code === "crlf" ? "save it with LF line endings, or remove the file and run `cotal mint-evictor` again" : "remove the file and run `cotal mint-evictor` again" });
  const health = inspectCredHealth(existing);
  const issuer = credsClaims(existing).iss;
  if (issuer !== auth.sys.pub) throw new CommandFailure("refused", "CONFLICT", `the connection-evictor credential is signed by ${issuer ?? "an unreadable issuer"}, not this space's system account; it was not replaced`, { target, remedy: "`cotal down` then `cotal up --rotate-sys` lands one generation" });
  const result = { kind: "connection-evictor" as const, file: CONNECTION_EVICTOR_CREDS_KIND, minted: false, state: health.state };
  writeResult(presentationOf(values), { command: "mint-evictor", target, result, noOp: true }, (): Report => ({ sections: [{ title: "Connection evictor already present", blocks: [
    { kind: "fields", rows: [["Space", auth.space], ["File", CONNECTION_EVICTOR_CREDS_KIND], ["Local state", health.state]] },
    { kind: "lines", lines: [{ text: "The file was left as it is. A system-account rotation is what replaces it.", tone: "hint" }] },
  ] }] }));
}
