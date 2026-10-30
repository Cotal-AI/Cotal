import { existsSync, lstatSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import {
  accountRevocations,
  credentialLifetime,
  credsClaims,
  credsProblem,
  CotalEndpoint,
  inspectCredHealth,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  probeConnect,
  type CredHealth,
  type CredentialKind,
  type FlagValues,
  type ParsedArgs,
  type SpaceAuth,
} from "@cotal-ai/core";
import {
  CommandFailure, accountInventory, canonicalRoot, codeSpan, credentialFileExposure, isCommandFailure, jsonFlag, plainFlag, preparedNeverStarted, presentationOf, readLocalRecordSource, renewalRecordPath, upCommand, writeResult,
  agentCredsDir,
  authDir,
  CONNECTION_EVICTOR_CREDS_KIND,
  DELIVERY_CREDS_KIND,
  findCotalRoot,
  folderSpaceHeld,
  getSoleSpaceAuth,
  getSpaceAuth,
  hasUserAuthState,
  legacyRenewalRecord,
  MEMBERSHIP_OBSERVER_CREDS_KIND,
  MEMBERSHIP_RW_CREDS_KIND,
  MeshTargetError,
  migrateLegacyCotalMaterial,
  preflightTarget,
  remintDaemonCreds,
  REMINTABLE_DAEMON_CREDS,
  type Report,
  resolveMeshTarget,
  spaceAccountPath,
  staleSystemCreds,
  STORE_CONTENTS,
  storeContentsText,
  type StaleSystemCred, type MaterialMigrationReceipt,
  unparsableDaemonCreds,
  workspaceSecretStore,
  writeRenewalRecord,
  recordOperationSpace,
  agentGrants,
  grantMintFlags,
  type AgentGrants,
} from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { RESPONDER_UNBOUND_CONSEQUENCE } from "../lib/delivery-responder.js";
import { noExpiryRecordPath, noExpiryRequestedAt } from "../lib/no-expiry-record.js";
import { credentialExportStore } from "../lib/credential-exports.js";

export const doctorFlags = [jsonFlag, plainFlag,
  { name: "fix", type: "boolean", description: "execute the safe repairs (re-sign the manager-remintable daemon creds, or mint one again that holds no key while its broker does not answer; needs the local signer)" },
  { name: "space", type: "string", description: "target space on a multi-space root (default: the sole space)" },
] as const;

/** One inspected credential file: where it lives, what the matrix says it is, and how it looks. */
interface CredReport {
  label: string;
  kind: CredentialKind;
  path: string;
  health?: CredHealth; // undefined = file missing
  /** Bytes this account read that the NATS client cannot parse, so they hold no key to re-sign. */
  unparsable?: boolean;
  /** A finding that must block `healthy`, with its exact repair. */
  problem?: string;
  repair?: string;
  /** An expired incarnation file whose alias HAS a live successor on disk (#1576). Rendered, and
   *  given a cleanup, but deliberately NOT a `problem`: it is a leftover file, not a broken agent,
   *  and counting it as one is what reported a healthy fleet as 15 failures. */
  superseded?: boolean;
  /** When the space's account revoked this agent file's key, at or after the file was issued. */
  revokedAt?: number;
  /** An unbounded agent credential `auth mint --no-expiry` asked for: reported with its ways out,
   *  but not a `problem`, because someone chose it. */
  warning?: string;
}

/** `cotal doctor auth` — the ONE stale-credential repair surface (D5 slice 6). Read-only diagnosis
 *  of every managed credential file in this folder against the credential-lifetime matrix, rendered
 *  as healthy / near-expiry (yellow) / expired / unbounded / unreadable (red) with the LAST-RENEWAL
 *  timestamp for manager-reminted creds. Each finding carries its native guidance, and a run with
 *  findings exits non-zero.
 *  `--fix` executes the one safe local repair (re-sign the class-2 daemon files for their existing
 *  nkeys); $SYS and agent creds are never auto-fixed — their repairs are printed, not guessed. */
interface RepairObservation {
  requested: boolean;
  attempted: boolean;
  authority: "lease" | "offline" | null;
  /** `reminted` marks a file minted again under a new identity; `reason` says why a row is not a
   *  plain re-sign, in fixed text that never quotes a parser or renewal error. */
  results: { file: string; ok: boolean; skipped: boolean; reminted: boolean; reason: string | null }[];
  migrationAttempted: boolean;
  migrations: MaterialMigrationReceipt[];
  coordinationCleanup: "not-opened" | "confirmed" | "unconfirmed";
}

export function validateDoctorArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length !== 1 || args.positionals[0] !== "auth") throw new CommandFailure("refused", "USAGE_INVALID", "use doctor auth [--fix] [--space <space>] [--json|--plain]");
}

/** The space registered as open at this root, if any. Missing signing trust alone is never read as
 *  an open space. */
function recordedOpenSpace(root: string, space: string | undefined): string | undefined {
  try {
    const target = resolveMeshTarget(root, { ...(space === undefined ? {} : { space }), readOnly: true });
    return target.mode === "open" && target.origin !== undefined && canonicalRoot(target.root) === canonicalRoot(root) ? target.space : undefined;
  } catch { return undefined; }
}

/** Where to run doctor auth when this folder's root holds no signing trust for the scope it names:
 *  the root `space` is registered at, when that is another folder; the root `space` was prepared
 *  in, once `cotal up` there starts it, when no `up` has; or else a space's root. Without `space`,
 *  only the space this root prepared and never started is named. The report stays root-local, so
 *  the step names the folder instead of reading another root's trust. */
function trustRootStep(root: string, space: string | undefined, fix: boolean): string {
  const command = `cotal doctor auth${space === undefined ? "" : ` --space ${space}`}${fix ? " --fix" : ""}`;
  let named = space;
  if (named === undefined) try { const held = folderSpaceHeld(root); if (held?.state === "prepared") named = held.space; } catch { /* the general step */ }
  let registered: string | undefined, prepared: string | undefined;
  if (named !== undefined) {
    try { const target = resolveMeshTarget(root, { space: named, readOnly: true }); if (space !== undefined && canonicalRoot(target.root) !== canonicalRoot(root)) registered = target.root; }
    catch (error) { if (error instanceof MeshTargetError && error.code === "not-started" && preparedNeverStarted(error.details)) prepared = error.details.root; /* else not registered here: the general step */ }
  }
  if (prepared !== undefined) {
    const here = canonicalRoot(prepared) === canonicalRoot(root);
    return `"${named}" is prepared but not started; start it with ${codeSpan(upCommand(prepared, named!, ...(here ? [] : ["--root", shellWord(prepared)])))}, then run \`${command}\` ${here ? "again" : "in that folder"}`;
  }
  return registered ? `run \`${command}\` in the folder space ${space} is registered at: ${registered}` : `run \`${command}\` in ${space === undefined ? "a" : "that"} space's root folder; \`cotal space\` lists each space's root`;
}

/** Local credential observations only; native repair remains an explicit, separately labeled phase. */
export async function doctor(args: ParsedArgs): Promise<void> {
  validateDoctorArguments(args);
  const values = args.values as FlagValues<typeof doctorFlags>;
  const root = findCotalRoot(process.cwd());
  const repair: RepairObservation = { requested: values.fix === true, attempted: false, authority: null, results: [], migrationAttempted: false, migrations: [], coordinationCleanup: "not-opened" };
  if (!values.space) {
    // Several valid accounts are a target the caller picks with --space, not an inventory that failed
    // validation. An unreadable or corrupt inventory still refuses as SCHEMA_INVALID below.
    let spaces: string[] = [];
    try { const inventory = accountInventory(authDir(root)); if (!inventory.corrupt.length) spaces = inventory.spaces; } catch { /* refused by the read below */ }
    if (spaces.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", `this root holds accounts for ${spaces.length} spaces (${spaces.join(", ")}); doctor auth diagnoses one space`, { target: { root, space: null, candidates: spaces }, remedy: `pass --space with one of ${spaces.join(", ")}` });
  }
  let auth: Awaited<ReturnType<typeof getSpaceAuth>>;
  try { auth = values.space ? await getSpaceAuth(workspaceSecretStore(root), values.space) : await getSoleSpaceAuth(workspaceSecretStore(root), authDir(root)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the local authority inventory could not be validated; no repair was attempted", { target: { root, space: values.space ?? null } }); }
  if (!auth) {
    const open = values.fix ? undefined : recordedOpenSpace(root, values.space);
    if (open !== undefined) {
      writeResult(presentationOf(values), { command: "doctor auth", target: { root, space: open }, result: { kind: "credential-health", root, space: open, localFindings: null, credentialScope: "open-space", brokerAuthorization: "not-checked", repair }, noOp: true }, () => ({ sections: [{ title: "No credentials to check", blocks: [{ kind: "fields", rows: [["Root", root], ["Space", open], ["Mode", "open, as registered"]] }, { kind: "lines", lines: [{ text: "This space is open: it authenticates no one and issues no credentials, so there are none to check.", tone: "hint" }] }] }] }));
      return;
    }
    if (values.fix || values.space) throw new CommandFailure("refused", "AUTH_REQUIRED", "no validated signing trust for the named local diagnostic scope is present; no open mode or broader authority was inferred", { target: { root, space: values.space ?? null }, remedy: trustRootStep(root, values.space, values.fix === true) });
    writeResult(presentationOf(values), { command: "doctor auth", target: { root }, result: { kind: "credential-health", root, space: null, localFindings: null, credentialScope: "not-established", brokerAuthorization: "not-checked", repair }, completeness: "not-checked", partial: { message: "No local static authority was established. This is not proof of an open or healthy mesh.", remedy: trustRootStep(root, undefined, false) } }, () => ({ sections: [{ title: "Local credential scope not established", blocks: [{ kind: "fields", rows: [["Root", root], ["Space", "not established"], ["Live authorization", "not checked"], ["Repair", "not requested"]] }] }] }));
    return;
  }
  const target = { root, space: auth.space };
  let reports: CredReport[];
  let userMode: boolean;
  try {
    userMode = hasUserAuthState(root, auth.space, { readOnly: true });
    if (values.fix && userMode) throw new CommandFailure("refused", "UNSUPPORTED", "this static daemon repair cannot replace a user-auth space's supported issuer authority", { target });
    repair.migrationAttempted = values.fix === true;
    const revocations = accountRevocations(auth.account.jwt);
    reports = inventory(root, auth.space, auth.sys.pub, !values.fix, (receipt) => repair.migrations.push(receipt), revocations);
    if (values.fix && reports.some((row) => row.problem && isRemintable(row.kind))) await repairDoctorCredentials(root, auth, repair, new Set(reports.filter((row) => row.unparsable && isRemintable(row.kind)).map((row) => row.label)));
    if (repair.attempted) reports = inventory(root, auth.space, auth.sys.pub, true, undefined, revocations);
  } catch (error) {
    const changed = [...repair.migrations.map((receipt) => ({ kind: "credential-material-migrated", materialKind: receipt.kind, from: receipt.from, to: receipt.to, space: receipt.space })), ...repair.results.filter((row) => row.ok).map((row) => ({ kind: "daemon-credential-resigned", file: row.file, space: auth!.space }))];
    if (isCommandFailure(error) && !repair.attempted && !repair.migrations.length) throw error;
    if (changed.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", "native local credential material changed, but the final diagnostic/audit or coordination cleanup was not confirmed", { target, changed, remedy: "inspect the original local files and renewal owner; do not respawn agents or rotate the system account as an automatic substitute" });
    throw new CommandFailure(repair.attempted || repair.migrationAttempted ? "unknown" : "failed", repair.attempted || repair.migrationAttempted ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", repair.attempted || repair.migrationAttempted ? "the native daemon repair outcome is unconfirmed; no re-sign was retried" : "local credential observations could not be completed; raw credential and parser diagnostics were not printed", { target });
  }
  const renewal = renewalObservation(root, auth.space);
  const items = reports.map((row) => ({
    label: row.label, kind: row.kind, path: row.path, state: row.revokedAt !== undefined ? "revoked" : row.superseded ? "superseded-local-file" : row.health?.state ?? (row.problem ? "missing" : "not-provisioned-here"),
    issuedAt: Number.isFinite(row.health?.iat) ? row.health!.iat! : null,
    expiresAt: Number.isFinite(row.health?.exp) ? row.health!.exp! : null,
    renewAt: Number.isFinite(row.health?.renewAt) ? row.health!.renewAt! : null,
    problem: row.problem ?? null, warning: row.warning ?? null,
    repair: row.repair ?? null, superseded: row.superseded === true, revokedAt: row.revokedAt ?? null,
  }));
  let exported: ExportedRow[] | null;
  try { exported = exportedCredentials(root, auth); } catch { exported = null; }
  const warnings = [
    ...items.filter((row) => row.warning !== null).map((row) => ({ code: "CREDENTIAL_UNBOUNDED_BY_REQUEST", target: { path: row.path }, message: `${row.label}: ${row.warning}` })),
    ...(exported ?? []).filter((row) => row.state === "expired").map((row) => ({ code: "EXPORTED_CREDENTIAL_EXPIRED", target: { path: row.path }, message: `${row.label}: ${row.path} expired at ${at(row.expiresAt ?? undefined)}; ${row.repair}` })),
    ...(exported === null ? [{ code: "EXPORTED_CREDENTIALS_UNREAD", target: { space: auth.space }, message: "the records of the files auth mint --out wrote could not be read, so those files are not listed" }] : []),
  ];
  const findings = items.filter((row) => row.problem !== null).length;
  const refused = renewal.state === "present" && renewal.brokerAcceptance === "recorded-refusal";
  const incomplete = renewal.state === "unreadable";
  const result = { kind: "credential-health", root, space: auth.space, mode: userMode ? "user" : "static", scope: "local credential claims and recorded renewal only", items, exported, findings, renewal, repair, brokerAuthorization: "not-checked", liveAgentHealth: "not-checked", systemAccountRotated: false, agentCredentialsReminted: false };
  // A recorded refusal names the renewal owner to repair, so the finding keeps its next step.
  const failure = incomplete ? new CommandFailure("partial", "OPERATION_PARTIAL", "credential observations were collected but the renewal record is unreadable; a complete healthy verdict was not inferred", { target }) : findings || refused ? new CommandFailure(repair.results.some((row) => row.ok) || repair.migrations.length ? "partial" : "failed", repair.results.some((row) => row.ok) || repair.migrations.length ? "OPERATION_PARTIAL" : "OPERATION_FAILED", refused ? "the recorded renewal was not broker-accepted; local re-signing alone cannot clear that finding" : "local credential findings remain; per-file native repair guidance is retained", { target, ...(refused ? { remedy: "start or repair this space's manager, the renewal owner, so it re-signs the daemon credentials and the broker accepts them; do not respawn agents for this finding" } : {}) }) : undefined;
  writeResult(presentationOf(values), { command: "doctor auth", target, result, completeness: incomplete ? "partial" : "complete", warnings, failure, noOp: failure === undefined && values.fix === true && !repair.attempted && !repair.migrations.length }, (data): Report => ({ sections: [
    { title: data.findings || refused || incomplete ? "Credential findings" : noFindingsTitle(data.items, data.exported), blocks: [
      { kind: "fields", rows: [["Root", data.root], ["Space", data.space], ["Mode", data.mode], ["Scope", data.scope], ["Current broker authorization", { text: "not checked", tone: "waiting" }], ["Live agent health", { text: "not checked", tone: "waiting" }], ["Repair requested", data.repair.requested ? "yes" : "no"], ["Acknowledged local migrations", String(data.repair.migrations.length)], ["Repair coordination", data.repair.authority ?? "not used"]] },
      { kind: "lines", lines: [{ text: "Credential expiry/claim inspection is not live broker acceptance, daemon adoption, process health or task progress. Locally ordered superseded files are not proof that their successor is connected. No agent was respawned and no system account was rotated.", tone: "hint" }] },
      ...(data.repair.results.some((row) => row.reminted || (!row.ok && !row.skipped)) ? [{ kind: "lines" as const, lines: data.repair.results.filter((row) => row.reminted || (!row.ok && !row.skipped)).map((row) => row.reminted ? `${row.file}: minted again under a new identity, because ${row.reason}` : `${row.file}: not repaired, because ${row.reason}`) }] : []),
    ] },
    { title: "Local credential files", blocks: [
      { kind: "table", columns: [{ key: "name", label: "Credential" }, { key: "state", label: "Local state" }, { key: "issued", label: "Issued" }, { key: "expiry", label: "Expiry" }], rows: data.items.slice(0, 200).map((row) => ({ name: row.label, state: row.state, issued: at(row.issuedAt ?? undefined), expiry: at(row.expiresAt ?? undefined) })) },
      ...(data.items.length > 200 ? [{ kind: "lines" as const, lines: [`${data.items.length - 200} credential rows are not shown; JSON retains every public diagnostic row.`] }] : []),
    ] },
    ...(data.exported?.length ? [{ title: "Exported credential files", blocks: [
      { kind: "table" as const, columns: [{ key: "name", label: "Credential" }, { key: "file", label: "File" }, { key: "state", label: "Local state" }, { key: "expiry", label: "Expiry" }], rows: data.exported.slice(0, 200).map((row) => ({ name: row.label, file: row.path, state: row.state, expiry: at(row.expiresAt ?? undefined) })) },
      ...(data.exported.length > 200 ? [{ kind: "lines" as const, lines: [`${data.exported.length - 200} exported rows are not shown; JSON retains every row.`] }] : []),
      ...(data.exported.some((row) => row.repair !== null) ? [{ kind: "lines" as const, lines: data.exported.filter((row) => row.repair !== null).slice(0, 200).map((row) => `${row.label}: ${row.repair}`) }] : []),
    ] }] : []),
    { title: "Recorded renewal", blocks: [{ kind: "fields", rows: [["Record", data.renewal.state], ["Recorded time", data.renewal.recordedAt ?? "not established"], ["Recorded owner", data.renewal.recordedOwner ?? "not established"], ["Broker acceptance at that pass", data.renewal.brokerAcceptance], ["Recorded coordination", data.renewal.authority ?? "not recorded"], ["Delivery responder at that pass", data.renewal.deliveryResponderUnbound ? "reported unbound" : "not established by this view"]] }, ...(data.renewal.deliveryResponderUnbound ? [{ kind: "lines" as const, lines: [RESPONDER_UNBOUND_CONSEQUENCE, "Repair the original delivery responder and inspect status; do not respawn agents merely because a responder was absent at that recorded pass."] }] : []),
      // The leftover root-scoped record is named, never read as this space's verdict.
      ...("legacyRecordPresent" in data.renewal && data.renewal.legacyRecordPresent ? [{ kind: "lines" as const, lines: [`This root also holds .cotal/renewal.json, a pre-per-space renewal record. It names no space, so it is not read as this space's verdict. \`${displayCmd()} clean all --force\` removes it when this root is reset.`] }] : [])] },
    ...(data.items.some((row) => row.problem !== null || row.warning !== null || row.superseded) ? [{ title: "Inspect before changing identities", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Credential" }, { key: "finding", label: "Finding" }, { key: "next", label: "Native guidance" }], rows: data.items.filter((row) => row.problem !== null || row.warning !== null || row.superseded).slice(0, 200).map((row) => ({ name: row.label, finding: row.problem ?? (row.warning !== null ? `warning: ${row.warning}` : "superseded in local credential family; not a broken-agent verdict"), next: row.repair ?? "inspect the original file and authority" })) }] }] : []),
  ] }));
}

/** `unparsable` names the daemon files the inventory read but the NATS client cannot parse. */
async function repairDoctorCredentials(root: string, auth: NonNullable<Awaited<ReturnType<typeof getSpaceAuth>>>, observed: RepairObservation, unparsable: ReadonlySet<string>): Promise<void> {
  let target: ReturnType<typeof resolveMeshTarget> | undefined;
  try {
    target = resolveMeshTarget(root, { space: auth.space, readOnly: true });
    recordOperationSpace(target.space);
    if (target.mode !== "auth" || canonicalRoot(target.root) !== canonicalRoot(root) || target.auth?.account.pub !== auth.account.pub) throw new CommandFailure("refused", "CONFLICT", "the resolved repair target differs from this local static authority; no broader root or auth mode was substituted");
    const preflight = await preflightTarget(target);
    if (!preflight.ok) {
      if (preflight.kind.includes("creds") || preflight.kind === "stale-auth") throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected broker's authenticated preflight failed; it was not called an offline repair target");
      target = undefined;
    }
  } catch (error) {
    if (error instanceof MeshTargetError && ["unknown-space", "no-meshes", "not-started"].includes(error.code)) target = undefined;
    else throw error;
  }
  const prior = renewalObservation(root, auth.space);
  if (prior.state === "unreadable") throw new CommandFailure("refused", "SCHEMA_INVALID", "the prior renewal record is unreadable; a possible broker refusal was not overwritten");
  let results: Awaited<ReturnType<typeof remintDaemonCreds>>;
  const reminted = new Set<string>();
  const retain = (rows: Awaited<ReturnType<typeof remintDaemonCreds>>) => { observed.results = rows.map((row) => ({ file: row.file, ok: row.ok === true, skipped: row.skipped !== undefined, reminted: reminted.has(row.file), reason: repairReason(row, reminted, unparsable) })); };
  if (target) {
    const uid = mintLifecycleUid(), identity = newIdentity();
    const ep = new CotalEndpoint({ space: target.space, servers: target.server, tls: target.tlsRequired, creds: await mintCreds(auth, identity, "supervisor", { lifecycleUid: uid }), lifecycleUid: uid, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { id: identity.id, name: "doctor-auth-fix", kind: "endpoint" } });
    ep.on("error", () => {});
    let held = false;
    try {
      await ep.start();
      held = await ep.holdDaemonRenewalLease(`doctor:${hostname()}:${process.pid}`);
      if (!held) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another native renewal owner holds the lease; no daemon credential was re-signed", { target: { root, space: auth.space }, remedy: `the renewal owner re-signs these credentials itself while it runs; for one that holds no key to re-sign, stop the stack with \`${displayCmd()} down\`, then run \`${displayCmd()} doctor auth --fix\`` });
      observed.authority = "lease";
      observed.attempted = true;
      results = await remintDaemonCreds(root, auth.space, undefined, { preflight: async (creds) => (await probeConnect(target!.server, { creds, tls: target!.tlsRequired })).ok === true });
      retain(results);
    } finally {
      let cleanupError: unknown;
      if (held) try { await ep.releaseDaemonRenewalLease(); } catch (error) { cleanupError = error; }
      try { await ep.stop(); } catch (error) { cleanupError ??= error; }
      observed.coordinationCleanup = cleanupError === undefined ? "confirmed" : "unconfirmed";
      if (cleanupError) throw cleanupError;
    }
  } else {
    observed.authority = "offline";
    observed.attempted = true;
    results = await remintDaemonCreds(root, auth.space);
    // No broker answers, so no daemon runs on these files. One that holds no key to re-sign is minted
    // again under a new identity, as `up` mints a missing one, once the store still reads it unparsable.
    const store = workspaceSecretStore(root);
    const still = new Set(await unparsableDaemonCreds(root, auth.space, store));
    for (const [i, row] of results.entries()) {
      const entry = REMINTABLE_DAEMON_CREDS.find((daemon) => daemon.kind === row.file);
      if (row.ok || row.skipped !== undefined || !entry || !unparsable.has(row.file) || !still.has(row.file)) continue;
      await store.put(entry.key(auth.space), await mintCreds(auth, newIdentity(), entry.profile));
      results[i] = { file: row.file, ok: true };
      reminted.add(row.file);
    }
    retain(results);
  }
  const adoption = prior.brokerAcceptance === "recorded-refusal" ? { ok: false, error: "re-signed locally by doctor auth --fix; the previous broker refusal remains unproven until the native renewal owner proves and adopts the generation" } : undefined;
  writeRenewalRecord(root, auth.space, { ts: new Date().toISOString(), owner: "doctor --fix", results, adoption, authority: observed.authority! });
}

function renewalObservation(root: string, space: string) {
  const absent = { state: "absent" as "absent" | "unreadable" | "present", recordedAt: null as string | null, recordedOwner: null as string | null, authority: null as string | null, brokerAcceptance: "not-recorded", deliveryResponderUnbound: false };
  try {
    const bytes = readLocalRecordSource(renewalRecordPath(root, space), 1024 * 1024, true);
    if (!bytes) return { ...absent, legacyRecordPresent: legacyRenewalRecord(root) !== undefined };
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (!value || typeof value !== "object" || typeof value.ts !== "string" || !Number.isFinite(Date.parse(value.ts)) || typeof value.owner !== "string" || !Array.isArray(value.results)) throw new Error();
    const adoption = value.adoption as { ok?: unknown; error?: unknown } | undefined;
    if (adoption !== undefined && (!adoption || typeof adoption !== "object" || typeof adoption.ok !== "boolean")) throw new Error();
    return { state: "present" as const, recordedAt: value.ts, recordedOwner: value.owner, authority: value.authority === "lease" || value.authority === "offline" ? value.authority : null, brokerAcceptance: adoption === undefined ? "not-requested-by-that-pass" : adoption.ok ? "recorded-acceptance" : "recorded-refusal", deliveryResponderUnbound: responderUnboundAtLastRenewal(typeof adoption?.error === "string" ? adoption.error : undefined), legacyRecordPresent: legacyRenewalRecord(root) !== undefined };
  } catch { return { ...absent, state: "unreadable" as const, brokerAcceptance: "not-established", legacyRecordPresent: false }; }
}

/** One file `auth mint --out` wrote for this space, as it reads now. */
interface ExportedRow { label: string; profile: string; path: string; state: string; issuedAt: number | null; expiresAt: number | null; revokedAt: number | null; repair: string | null }

/** The files `auth mint --out` wrote for this space from this root that are still there, with their
 *  expiry and, for one the broker refuses or soon will, the mint that replaces it. */
function exportedCredentials(root: string, auth: SpaceAuth): ExportedRow[] {
  const cmd = displayCmd(), here = canonicalRoot(root), revocations = accountRevocations(auth.account.jwt);
  const rows: ExportedRow[] = [];
  for (const { record: { value: entry } } of credentialExportStore(auth.space).list()) {
    if (canonicalRoot(entry.root) !== here) continue;
    const row: ExportedRow = { label: entry.label, profile: entry.profile, path: entry.path, state: "unreadable", issuedAt: null, expiresAt: null, revokedAt: null, repair: null };
    let bytes: Buffer | undefined;
    try { bytes = readLocalRecordSource(entry.path, 1024 * 1024, true); }
    catch {
      try { const stat = lstatSync(entry.path); row.repair = stat.isFile() ? credentialFileExposure(entry.path, stat)?.remedy ?? null : null; } catch { /* reported unreadable */ }
      rows.push(row);
      continue;
    }
    // A file removed since is not listed.
    if (!bytes) continue;
    let claims: ReturnType<typeof credsClaims>;
    try { claims = credsClaims(bytes.toString("utf8")); } catch { rows.push(row); continue; }
    const health = inspectCredHealth(bytes.toString("utf8"));
    const profile = entry.profile === "agent" ? "" : ` --profile ${entry.profile}`;
    // A new key holds only the grants its mint names, so the mint names the ones this file holds.
    const grants = entry.profile === "agent" && claims.name === "agent" ? agentGrants(claims.nats ?? {}, auth.space) : undefined;
    const fresh = `mint a new key${grants ? " with the grants this file holds" : ""}: \`${cmd} auth mint ${entry.label}${profile}${grants ? grantMintFlags(grants) : ""} --out <new file>\``;
    const revokedAt = claims.sub === undefined ? undefined : revocations[claims.sub];
    Object.assign(row, { state: health.state, issuedAt: claims.iat ?? null, expiresAt: claims.exp ?? null });
    if ((claims.nats?.issuer_account ?? claims.iss) !== auth.account.pub)
      Object.assign(row, { state: "other-account", repair: `the space's identity changed after it was written, so its broker refuses it; ${fresh}` });
    else if (revokedAt !== undefined && (claims.iat === undefined || claims.iat <= revokedAt))
      Object.assign(row, { state: "revoked", revokedAt, repair: `its key was revoked at ${at(revokedAt)}, and auth mint --identity refuses that key; ${fresh}` });
    else if (health.state === "expired" || health.state === "near-expiry")
      row.repair = `\`${cmd} auth mint ${entry.label}${profile} --identity ${entry.path} --out ${entry.path}\` signs the same key again${entry.profile === "agent" ? " with the same grants" : ""}`;
    rows.push(row);
  }
  return rows.sort((x, y) => x.label.localeCompare(y.label) || x.path.localeCompare(y.path));
}

/** The heading of a run with no findings. It names what the run still asks of the operator, so it
 *  never reads as nothing to do while a warning or an exported file's repair is printed. */
function noFindingsTitle(items: readonly { warning: string | null }[], exported: readonly ExportedRow[] | null): string {
  const attention = exported?.filter((row) => row.state !== "healthy" && row.state !== "unbounded").length ?? 0;
  const unbounded = items.filter((row) => row.warning !== null).length;
  const parts = [
    ...(attention ? [`${attention} exported credential ${attention === 1 ? "file needs" : "files need"} attention`] : []),
    ...(unbounded ? [`${unbounded} ${unbounded === 1 ? "credential has" : "credentials have"} no expiry by request`] : []),
    ...(exported === null ? ["the records of exported credential files could not be read"] : []),
  ];
  return parts.length ? `No findings; ${parts.join("; ")}` : "No local credential findings";
}

function isRemintable(kind: CredentialKind): boolean {
  return kind === "delivery" || kind === "membership-rw";
}

/** Why a `--fix` row is not a plain re-sign, or null for one that is. */
function repairReason(row: Awaited<ReturnType<typeof remintDaemonCreds>>[number], reminted: ReadonlySet<string>, unparsable: ReadonlySet<string>): string | null {
  if (reminted.has(row.file)) return "it held no key to re-sign";
  if (row.skipped === "missing-file") return `it is absent here, and \`${displayCmd()} up\` mints it`;
  if (row.skipped === "no-auth") return "no static trust here signs it";
  if (row.ok) return null;
  if (unparsable.has(row.file)) return `it holds no key to re-sign, and its broker answers; stop the stack with \`${displayCmd()} down\`, then run \`${displayCmd()} doctor auth --fix\` again`;
  return "it could not be re-signed, so the current file was kept";
}

/** The repair for a daemon file that holds no key: only a new identity replaces it. */
function daemonRemintRepair(): string {
  const cmd = displayCmd();
  return `it holds no key to re-sign, so the manager cannot renew it. While its broker does not answer, \`${cmd} doctor auth --fix\` mints it again under a new identity, as \`${cmd} up\` does for a missing one; stop a running stack with \`${cmd} down\` first`;
}

/** The repair for the $SYS pair, which nothing re-signs in place. A plain `down` + `up` does NOT
 *  touch these: `up` mints them only on the branch that CREATES the trust record, so re-upping an
 *  existing space reuses the same files and reports success. The rotation must be asked for. */
function systemRotationRepair(): string {
  return `system-account rotation: \`${displayCmd()} down\` then \`${displayCmd()} up --rotate-sys\` re-mints the $SYS material (the space, its agents, its creds and its data are untouched)`;
}

/** A credential file that is absent. Only the $SYS pair is a finding then, once the space has its
 *  trust: `up` mints the other two when they are missing, and nothing but a rotation mints these. */
function missingReport(label: string, kind: CredentialKind, path: string, sysPub?: string): CredReport {
  if (sysPub === undefined || (kind !== "membership-observer" && kind !== "connection-evictor")) return { label, kind, path };
  return { label, kind, path, problem: `missing - ${kind === "membership-observer" ? "the membership feed" : "live connection eviction"} cannot run without it`, repair: systemRotationRepair() };
}

/** Local filename/issued-at ordering only. No role here proves a connected or running successor. */
type AgentFileRole = "current" | "superseded" | "sole";
interface LocalCredentialFamily { role: AgentFileRole }

function agentRepair(path: string, family?: LocalCredentialFamily, space?: string, grants?: AgentGrants, profile?: string): string {
  if (family?.role === "superseded") return `an older local incarnation file exists at ${path}; inspect its exact lifecycle and owner before removing it. File ordering alone proves no live successor. Do not respawn an agent from this finding`;
  const replace = standingReplace(path, space, grants, profile);
  // An observer or admin credential is no agent a manager runs.
  if (replace && mintedProfile(profile)) return `if \`${displayCmd()} auth mint\` wrote it, replace it with ${replace}`;
  if (replace) return `if a manager runs this agent, inspect this original lifecycle under it; supported managed renewal can re-sign the same nkey without a replacement. If \`${displayCmd()} auth mint\` wrote it, replace it with ${replace}. Do not spawn another agent only because a local file expired`;
  return `inspect this original lifecycle under its manager; supported managed renewal can re-sign the same nkey without a replacement. Do not spawn another agent only because a local file expired`;
}

/** The `--profile` an `auth mint` needs to mint a credential of this profile again, where it is not
 *  the default agent one. */
function mintedProfile(profile?: string): string | undefined {
  return profile === "observer" || profile === "admin" ? profile : undefined;
}

/** The `auth mint --replace` that replaces a standing `<label>.creds`, with the lifetime it gets. It
 *  mints a new key, which holds only the profile and grants its mint names, so it names the ones the
 *  file holds. An incarnation file, `<alias>.<lifecycleUid>.creds`, is no label's standing credential. */
function standingReplace(path: string, space?: string, grants?: AgentGrants, profile?: string): string | undefined {
  const label = basename(path);
  if (space === undefined || !label.endsWith(".creds") || incarnationUidOf(label) !== undefined) return undefined;
  const flag = mintedProfile(profile);
  return `\`${displayCmd()} auth mint ${aliasOf(label)} --replace --space ${space}${flag ? ` --profile ${flag}` : ""}${grants ? grantMintFlags(grants) : ""}\`, which lasts 24 hours unless --expires-in <seconds> or --expires-at <unix-seconds> sets another time`;
}

/** The repair for an agent file whose key was revoked. A revoked key is never signed again, so a
 *  label's standing file is replaced under a new key that holds the grants this one did, and any
 *  other agent file belongs to an agent to stop. */
function revokedAgentRepair(path: string, space?: string, grants?: AgentGrants, profile?: string): string {
  const replace = standingReplace(path, space, grants, profile);
  if (!replace) return "a revoked key is not signed again; stop or despawn the agent that uses this file";
  return `a revoked key is not signed again, so replace it with a new key${grants ? " that holds the grants this file holds" : ""}: ${replace}`;
}

function agentUnrenewableRepair(): string {
  return "native renewal skips unbounded or unreadable material; inspect the exact lifecycle and authority before choosing an explicit replacement. This diagnosis does not prove the agent is stopped or authorize a blind respawn";
}

/** The two ways out for an agent credential with no expiry: rotating the space identity retires it
 *  with everything the space issued, and a bounded replacement ends it. A label's standing file is
 *  replaced with `auth mint --replace`, which also drops its no-expiry record; any other file, and
 *  the record beside it, are removed first. */
function agentUnboundedRepair(path: string, space: string, record?: string, grants?: AgentGrants, profile?: string): string {
  const cmd = displayCmd();
  const replace = standingReplace(path, space, grants, profile);
  const bound = replace ? `stop what uses it, then replace it with ${replace}` : `stop what uses it, remove ${path}${record ? ` and ${record}` : ""} and mint a replacement without --no-expiry, which lasts 24 hours unless --expires-in <seconds> or --expires-at <unix-seconds> sets another time`;
  return `native renewal skips unbounded material. Revoke it and keep the store: \`${cmd} down\`, \`${cmd} auth revoke-credential ${path} --yes\`, then \`${cmd} up\`. Or bound it: ${bound}; a copy made before stays valid until it is revoked. To retire every credential the space issued, rotate the space identity: \`${cmd} down\`, \`${cmd} reset space ${space}\`, then \`${cmd} up\`; the reset also removes the space's store, with its ${storeContentsText(STORE_CONTENTS)}. This diagnosis does not prove the agent is stopped or authorize a blind respawn`;
}

/** Classify every `agent` file by alias family, so a superseded incarnation is never reported as a
 *  broken fleet (#1576 ask 3).
 *
 *  PURELY ON-DISK, AND DELIBERATELY SO. `doctor auth` is the OFFLINE credential surface: it resolves
 *  no mesh, opens no connection and, on a user-auth mesh, is forbidden to mint at all. The filename
 *  grammar already carries the answer — `agentIncarnationBase` writes `<alias>.<lifecycleUid>` and
 *  refuses `.` inside a standing alias, so the two families are structurally disjoint and an alias's
 *  incarnations are enumerable without asking anyone. Ordering is by issued-at (`iat`), which is the
 *  credential's own claim rather than a filesystem timestamp a copy would destroy. */
function classifyAgentFamilies(reports: CredReport[]): Map<string, AgentFileRole> {
  const byAlias = new Map<string, CredReport[]>();
  for (const r of reports) {
    if (r.kind !== "agent" || !r.health) continue;
    const alias = aliasOf(r.label);
    const family = byAlias.get(alias);
    if (family) family.push(r);
    else byAlias.set(alias, [r]);
  }
  const roles = new Map<string, AgentFileRole>();
  for (const [, family] of byAlias) {
    const incarnations = family.filter((r) => incarnationUidOf(r.label) !== undefined);
    // A single file (standing or lone incarnation) is nobody's predecessor: leave it a real finding.
    if (incarnations.length < 2) {
      for (const r of family) roles.set(r.label, "sole");
      continue;
    }
    // Newest `iat` wins. A file with no readable `iat` cannot be ordered, so it is never promoted to
    // `current` and never demoted to `superseded` — an unorderable file keeps its own verdict rather
    // than being explained away by a neighbour.
    let newest: CredReport | undefined;
    for (const r of incarnations) {
      if (r.health?.iat === undefined) continue;
      if (newest?.health?.iat === undefined || r.health.iat > newest.health.iat) newest = r;
    }
    for (const r of family) {
      if (r === newest) roles.set(r.label, "current");
      else if (newest && incarnationUidOf(r.label) !== undefined && r.health?.iat !== undefined) roles.set(r.label, "superseded");
      else roles.set(r.label, "sole");
    }
  }
  return roles;
}

/** The lifecycle uid of an incarnation filename, or undefined for a standing `<alias>.creds`. The
 *  grammar is the one `agentIncarnationBase` writes: a 26-32 char lowercase-alphanumeric token. */
function incarnationUidOf(label: string): string | undefined {
  const base = label.replace(/\.sentinel\.creds$|\.actor-token$|\.creds$/, "");
  const m = /^(.+)\.([a-z0-9]{26,32})$/.exec(base);
  return m ? m[2] : undefined;
}

/** The agent ALIAS a credential filename belongs to — the part before the lifecycle uid, or the
 *  whole base for a standing file. Two incarnations of one agent share this; two agents never do. */
function aliasOf(label: string): string {
  const base = label.replace(/\.sentinel\.creds$|\.actor-token$|\.creds$/, "");
  const m = /^(.+)\.([a-z0-9]{26,32})$/.exec(base);
  return m ? m[1] : base;
}

/** Inspect every managed credential file for this folder. Missing files are noted (with how they
 *  get provisioned) but only EXISTING-but-bad material is a problem — process presence is `cotal
 *  status`'s job; this surface owns credential health. */
function inventory(root: string, space: string, sysPub?: string, readOnly = false, onMigrated?: (receipt: MaterialMigrationReceipt) => void, revocations: Readonly<Record<string, number>> = {}): CredReport[] {
  // Through the choke point, not a hand-composed `.cotal/<file>` (P7 §2 rule 1). The four kinds are
  // per-space now, and a diagnosis that read the canonical location past an unmigrated copy would
  // report every one of them "missing" on a root `up` has not re-provisioned — the worst possible
  // answer from the surface an operator reaches for when something is already wrong. The LABEL stays
  // the kind, which is what the operator reads and what `staleSystemCreds` keys its answer by.
  const at = (kind: string) => migrateLegacyCotalMaterial(root, space, kind, { readOnly, onMigrated });
  const fixed: Array<{ label: string; kind: CredentialKind; path: string }> = [
    { label: DELIVERY_CREDS_KIND, kind: "delivery", path: at(DELIVERY_CREDS_KIND) },
    { label: MEMBERSHIP_RW_CREDS_KIND, kind: "membership-rw", path: at(MEMBERSHIP_RW_CREDS_KIND) },
    { label: MEMBERSHIP_OBSERVER_CREDS_KIND, kind: "membership-observer", path: at(MEMBERSHIP_OBSERVER_CREDS_KIND) },
    { label: CONNECTION_EVICTOR_CREDS_KIND, kind: "connection-evictor", path: at(CONNECTION_EVICTOR_CREDS_KIND) },
  ];
  // Ask the staleness question ONCE, through the same helper the boot path uses, so `doctor auth`
  // and `cotal up` can never disagree about which $SYS creds the trust record authorizes.
  const stale = new Map(sysPub ? staleSystemCreds(root, sysPub, space, { readOnly, onMigrated }).map((x) => [x.file, x] as const) : []);
  const reports = fixed.map((f) => report(f.label, f.kind, f.path, sysPub, stale.get(f.label)));
  // Same posture for the per-agent secrets (P1), and for the same reason: this space's segment
  // through the choke point, never `join(authDir(root), "creds")`, so an operator running `doctor`
  // on a root that has not migrated yet sees their agents' creds rather than an empty inventory. It
  // is also what keeps the report SPACE-scoped now that the dir holds every tenant's segment — a
  // diagnosis must not name a co-resident tenant's material.
  const agentDir = agentCredsDir(root, space, { readOnly, onMigrated });
  if (existsSync(agentDir)) {
    for (const f of readdirSync(agentDir).filter((f) => f.endsWith(".creds") && !f.endsWith(".sentinel.creds")).sort()) {
      reports.push(report(basename(f), "agent", join(agentDir, f), undefined, undefined, undefined, space, revocations));
    }
  }
  // SECOND PASS over the agent files (#1576). Supersession is a property of an alias's FAMILY, not of
  // a file, so it cannot be decided while the files are still being read one at a time — which is
  // exactly why the old single pass reported 15 leftovers as a broken fleet. Now each family is
  // classified once every member is known, and the affected rows are re-derived with that role.
  const roles = classifyAgentFamilies(reports);
  return reports.map((r) =>
    r.kind === "agent" && r.health ? report(r.label, r.kind, r.path, undefined, undefined, { role: roles.get(r.label) ?? "sole" }, space, revocations) : r,
  );
}

function report(label: string, kind: CredentialKind, path: string, sysPub?: string, stale?: StaleSystemCred, live?: LocalCredentialFamily, space?: string, revocations: Readonly<Record<string, number>> = {}): CredReport {
  let health: CredHealth;
  // A cause the operator can act on, reported in place of the generic parse finding. Its text is
  // fixed and never quotes the file.
  let named: { problem: string; repair?: string } | undefined;
  let bytes: Buffer | undefined;
  let unparsable = false;
  try {
    bytes = readLocalRecordSource(path, 1024 * 1024, true);
    if (!bytes) return missingReport(label, kind, path, sysPub);
    const creds = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // The NATS client's own parse, the check `--creds` makes, so a file whose claims are legible but
    // that the client cannot present is not called healthy.
    const unusable = credsProblem(creds);
    unparsable = unusable !== undefined;
    if (unusable) named = { problem: `the NATS client cannot parse it: ${unusable.message}`, ...(unusable.code === "crlf" ? { repair: `save it with LF line endings, for example with \`dos2unix ${path}\`` } : {}) };
    health = unusable ? { state: "unreadable", error: unusable.message } : inspectCredHealth(creds);
  } catch (error) {
    if (isCommandFailure(error) && error.code === "UNSUPPORTED") throw error;
    // The private read refuses a file other accounts can open, so name that rather than a parse.
    let exposure: ReturnType<typeof credentialFileExposure>;
    try { const stat = lstatSync(path); exposure = stat.isFile() ? credentialFileExposure(path, stat) : undefined; } catch { exposure = undefined; }
    if (exposure) named = { problem: `the credential file ${exposure.reason}`, repair: exposure.remedy };
    // Bytes that were read and then failed to decode are unparsable; a refused read is not.
    unparsable = bytes !== undefined && exposure === undefined;
    health = { state: "unreadable", error: "protected credential could not be read or parsed" };
  }
  const r: CredReport = { label, kind, path, health, unparsable };
  // An agent file's own claims: its grants, which a replacement under a new key holds only if its
  // mint names them, and its key, which a revocation names.
  const claims = kind === "agent" && health.state !== "unreadable" && bytes ? credsClaims(bytes.toString("utf8")) : undefined;
  const grants = claims?.name === "agent" && space !== undefined ? agentGrants(claims.nats ?? {}, space) : undefined;
  const policy = credentialLifetime(kind);
  const standing = policy.class === "standing-renewable" || policy.class === "rotation-renewed";
  const repair = isRemintable(kind)
    ? `${displayCmd()} doctor auth --fix   (or start the mesh's manager - it is the renewal owner and re-signs + reloads these every half-TTL)`
    : kind === "agent"
      ? agentRepair(path, live, space, grants, claims?.name)
      : systemRotationRepair();
  // A $SYS cred is only usable if the system account that SIGNED it is the one the broker loads,
  // i.e. the one in this root's trust record. Expiry alone cannot see a RETIRED issuer: a rotation
  // that committed the record and then died leaves a file that is structurally valid and years from
  // expiry, yet broker-dead. Without this the doctor reported `auth: healthy` over exactly that
  // split, which is the false green this whole surface exists to prevent. Answered by the SAME
  // helper the boot path uses, so the two surfaces cannot drift on what "stale" means. Checked
  // before the health switch, so it wins over a merely-healthy verdict.
  if (stale && sysPub) {
    r.problem = stale.iss ? `the claimed system-account issuer ${stale.iss} differs from this root's ${sysPub}; current broker acceptance is not checked` : "the system-account issuer could not be established; current broker acceptance is not checked";
    r.repair = repair;
    return r;
  }
  // The broker refuses a key the space's account revoked, so a file signed for it before then is dead
  // however far off its expiry is, and nothing signs that key again.
  if (claims && live?.role !== "superseded") {
    const revokedAt = claims.sub === undefined ? undefined : revocations[claims.sub];
    if (revokedAt !== undefined && (claims.iat === undefined || claims.iat <= revokedAt)) {
      r.revokedAt = revokedAt;
      r.problem = `REVOKED - its key ${claims.sub} was revoked at ${at(revokedAt)} with auth revoke-credential, so the broker refuses this credential`;
      r.repair = revokedAgentRepair(path, space, grants, claims.name);
      return r;
    }
  }
  switch (health.state) {
    case "unreadable":
      r.problem = named?.problem ?? "credential parsing failed; raw diagnostic omitted";
      // Unreadable material cannot be re-signed, so the honest agent remedy here is the respawn
      // the old code gave to every case — this is the ONE case it fitted.
      r.repair = named?.repair ?? (kind === "agent" && live?.role !== "superseded" ? agentUnrenewableRepair() : unparsable && isRemintable(kind) ? daemonRemintRepair() : repair);
      break;
    case "expired":
      // #1576 ASK 3. A SUPERSEDED incarnation is expected to be expired — that is what supersession
      // MEANS: the daemon re-minted the alias, the successor is live and listed, and this file is the
      // husk of the incarnation it replaced. Reporting it as "EXPIRED - the broker denies this
      // credential" is true of the FILE and false about the FLEET, and it is what made a healthy
      // 30-agent deployment read as 15 broken agents. It stays visible as a superseded leftover with
      // a cleanup, but it is no longer a problem, so it no longer poisons the exit code.
      if (live?.role === "superseded") {
        r.superseded = true;
        r.repair = agentRepair(path, live);
        break;
      }
      r.problem = "EXPIRED - the broker denies this credential";
      r.repair = repair;
      break;
    case "near-expiry":
      if (standing) {
        r.problem = `past its renewal point (renewal owner: ${policy.renewalOwner}) - expires ${at(health.exp)}`;
        r.repair = repair;
      }
      break;
    case "unbounded": {
      // An agent credential `auth mint --no-expiry` asked for, whose record beside it names these
      // bytes, is reported with the same ways out, but someone chose it, so it is no finding.
      const requestedAt = kind === "agent" && live?.role !== "superseded" && space !== undefined && bytes ? noExpiryRequestedAt(path, bytes) : undefined;
      if (requestedAt !== undefined) {
        r.warning = `unbounded by request (auth mint --no-expiry, recorded ${requestedAt}) - a copy stays valid until it is revoked or the space identity rotates`;
        r.repair = agentUnboundedRepair(path, space!, noExpiryRecordPath(path), grants, claims?.name);
        break;
      }
      // A credential with no expiry claim stays valid until its signer rotates, whatever its kind,
      // so it is a finding even where no renewal owner bounds it.
      r.problem = standing
        ? "unbounded standing credential (minted before the renewal slice) - a copied cred never dies"
        : "unbounded credential (no expiry claim) - a copy stays valid until it is revoked or the space identity rotates";
      r.repair = kind === "agent" && live?.role !== "superseded" && space !== undefined ? agentUnboundedRepair(path, space, undefined, grants, claims?.name) : repair;
      break;
    }
  }
  return r;
}

/** Did the last renewal pass fail because the delivery-admin rail had NO RESPONDER (#1576)?
 *
 *  Matched on the manager's own recorded sentence for that case. A TIMEOUT is deliberately excluded:
 *  a hung rail is a bound responder that did not answer in time, which is a different fault with a
 *  different repair, and the daemon-side helper that classifies this rail draws the same line. */
function responderUnboundAtLastRenewal(error?: string): boolean {
  if (!error || /timeout/i.test(error)) return false;
  return /no delivery-admin responder|no responders/i.test(error);
}

function at(sec?: number): string {
  if (sec === undefined) return "not reported";
  const date = new Date(sec * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "not representable as a date";
}
