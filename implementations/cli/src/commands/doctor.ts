import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  credentialLifetime,
  inspectCredHealth,
  type CredHealth,
  type CredentialKind,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  authDir,
  findCotalRoot,
  getSpaceAuth,
  readRenewalRecord,
  remintDaemonCreds,
  userAuthStateDir,
  workspaceSecretStore,
  writeRenewalRecord,
} from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { c } from "../ui.js";

export const doctorFlags = [
  { name: "fix", type: "boolean", description: "execute the safe repairs (re-sign the manager-remintable daemon creds; needs the local signer)" },
] as const;

/** One inspected credential file: where it lives, what the matrix says it is, and how it looks. */
interface CredReport {
  label: string;
  kind: CredentialKind;
  path: string;
  health?: CredHealth; // undefined = file missing
  /** A finding that must block `healthy`, with its exact repair. */
  problem?: string;
  repair?: string;
}

/** `cotal doctor auth` — the ONE stale-credential repair surface (D5 slice 6). Read-only diagnosis
 *  of every managed credential file in this folder against the credential-lifetime matrix, rendered
 *  as healthy / near-expiry (yellow) / expired / unreadable (red) with the LAST-RENEWAL timestamp
 *  for manager-reminted creds — ending in either `healthy` or the exact next command (exit 1).
 *  `--fix` executes the one safe local repair (re-sign the class-2 daemon files for their existing
 *  nkeys); $SYS and agent creds are never auto-fixed — their repairs are printed, not guessed. */
export async function doctor(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  if (sub !== "auth") {
    console.error(`usage: ${displayCmd()} doctor auth [--fix]  - credential-health diagnosis + repair for this folder's mesh`);
    process.exitCode = 1;
    return;
  }
  const values = args.values as FlagValues<typeof doctorFlags>;
  const root = findCotalRoot(process.cwd());
  const auth = await getSpaceAuth(workspaceSecretStore(root));

  console.log(c.bold("cotal doctor auth"));
  console.log(`  root ${root}`);
  if (!auth) {
    // An open mesh has no minted credentials at all — nothing to diagnose is a healthy answer,
    // not a silent one.
    console.log(c.green("\nauth: healthy - open mesh (no credential material in this folder)"));
    return;
  }
  const userMode = existsSync(userAuthStateDir(root, auth.space));
  console.log(`  space ${auth.space}${userMode ? " · user-auth" : ""} · signer ${c.green("present")} (${join(authDir(root), "auth.json")})`);

  let reports = inventory(root);
  let problems = reports.filter((r) => r.problem);

  // --fix: the one safe local repair — re-sign the remintable daemon files (same nkeys), exactly
  // what the manager's renewal pass does, and record the pass so the audit trail stays honest
  // (adoption is the DAEMON's explicit reload, which only the running manager requests — a doctor
  // fix without a live manager is adopted by the daemon's own 75% renewal timer). Then re-diagnose:
  // the doctor reports what IS, never what it hopes the fix did.
  if (values.fix && problems.some((r) => isRemintable(r.kind))) {
    console.log(c.dim("\n--fix: re-signing the remintable daemon creds…"));
    const prior = readRenewalRecord(root);
    const results = await remintDaemonCreds(root, undefined, auth.space); // validate the signer against THIS folder's space
    // A local re-sign is NOT a broker proof: `--fix` has no live admin rail to adopt through, it
    // relies on the daemon's 75% renewal timer. So it must NEVER erase a KNOWN broker refusal to
    // green — if the last renewal was refused (e.g. the signer the broker rejects), the re-signed
    // generation is still unproven and may be broker-dead. Carry the refusal forward as an explicit
    // unproven state until a REAL proof (the manager's/daemon's reloadCreds) supersedes it, so the
    // verdict below stays exit 1 with an actionable next step. A prior non-refusal is left absent
    // (the "backstop will adopt" state), unchanged from before.
    const adoption = prior?.adoption?.ok === false
      ? { ok: false, error: "re-signed locally by `doctor auth --fix`, but the previous renewal was refused by the broker and the re-signed generation is not yet broker-proven - start the mesh's manager (the renewal owner) so it proves and adopts it" }
      : undefined;
    writeRenewalRecord(root, { ts: new Date().toISOString(), owner: "doctor --fix", results, adoption });
    for (const r of results.filter((x) => !x.ok && !x.skipped)) console.error(c.red(`  ✗ ${r.file}: ${r.error}`));
    reports = inventory(root);
    problems = reports.filter((r) => r.problem);
  }

  render("Daemon creds (manager-reminted - class 2)", reports.filter((r) => isRemintable(r.kind)));
  renderRenewalRecord(root);
  render("$SYS creds (rotation-renewed - never remintable from disk)", reports.filter((r) => r.kind === "membership-observer" || r.kind === "connection-evictor"));
  render("Agent creds (static, pre-flip)", reports.filter((r) => r.kind === "agent"));

  // A broker-REFUSED renewal is a first-class problem for the final verdict + exit status, not just a
  // warning line. Cred-file health alone is not enough: a structurally-valid JWT the broker rejected
  // must never let `auth: healthy` / exit 0 stand (the whole point of the renewal-honesty slice).
  const rec = readRenewalRecord(root);
  const adoptionRefused = rec?.adoption?.ok === false;
  if (!problems.length && !adoptionRefused) {
    console.log(c.green("\nauth: healthy"));
    return;
  }
  const parts: string[] = [];
  if (problems.length) parts.push(`${problems.length} cred problem${problems.length === 1 ? "" : "s"}`);
  if (adoptionRefused) parts.push("last renewal not broker-accepted");
  console.log(c.red(`\nauth: ${parts.join(", ")}`));
  for (const p of problems) console.log(`  ${c.red("✗")} ${p.label}: ${p.problem}\n    next: ${p.repair}`);
  if (adoptionRefused)
    console.log(`  ${c.red("✗")} the last renewal pass was refused by the broker: ${rec?.adoption?.error ?? "unknown"}\n    next: start or repair the mesh's manager (the renewal owner) so it re-signs and re-proves the daemon creds`);
  process.exitCode = 1;
}

function isRemintable(kind: CredentialKind): boolean {
  return kind === "delivery" || kind === "membership-rw";
}

/** Inspect every managed credential file for this folder. Missing files are noted (with how they
 *  get provisioned) but only EXISTING-but-bad material is a problem — process presence is `cotal
 *  status`'s job; this surface owns credential health. */
function inventory(root: string): CredReport[] {
  const cotal = (f: string) => join(root, ".cotal", f);
  const fixed: Array<{ label: string; kind: CredentialKind; path: string }> = [
    { label: "delivery.creds", kind: "delivery", path: cotal("delivery.creds") },
    { label: "membership-rw.creds", kind: "membership-rw", path: cotal("membership-rw.creds") },
    { label: "membership-observer.creds", kind: "membership-observer", path: cotal("membership-observer.creds") },
    { label: "connection-evictor.creds", kind: "connection-evictor", path: cotal("connection-evictor.creds") },
  ];
  const reports = fixed.map((f) => report(f.label, f.kind, f.path));
  const agentDir = join(authDir(root), "creds");
  if (existsSync(agentDir)) {
    for (const f of readdirSync(agentDir).filter((f) => f.endsWith(".creds") && !f.endsWith(".sentinel.creds")).sort()) {
      reports.push(report(basename(f), "agent", join(agentDir, f)));
    }
  }
  return reports;
}

function report(label: string, kind: CredentialKind, path: string): CredReport {
  if (!existsSync(path)) return { label, kind, path };
  const health = inspectCredHealth(readFileSync(path, "utf8"));
  const r: CredReport = { label, kind, path, health };
  const policy = credentialLifetime(kind);
  const standing = policy.class === "standing-renewable" || policy.class === "rotation-renewed";
  const repair = isRemintable(kind)
    ? `${displayCmd()} doctor auth --fix   (or start the mesh's manager - it is the renewal owner and re-signs + reloads these every half-TTL)`
    : kind === "agent"
      ? `respawn the agent (\`${displayCmd()} spawn\`) - its old cred is dead by design`
      : `system-account rotation: \`${displayCmd()} down\` then a fresh \`${displayCmd()} up\` regenerates the $SYS material`;
  switch (health.state) {
    case "unreadable":
      r.problem = `unreadable credential file (${health.error})`;
      r.repair = repair;
      break;
    case "expired":
      r.problem = "EXPIRED - the broker denies this credential";
      r.repair = repair;
      break;
    case "near-expiry":
      if (standing) {
        r.problem = `past its renewal point (renewal owner: ${policy.renewalOwner}) - expires ${at(health.exp)}`;
        r.repair = repair;
      }
      break;
    case "unbounded":
      if (standing) {
        r.problem = "unbounded standing credential (minted before the renewal slice) - a copied cred never dies";
        r.repair = repair;
      }
      break;
  }
  return r;
}

function render(title: string, reports: CredReport[]): void {
  console.log(`\n  ${c.bold(title)}`);
  if (!reports.length) {
    console.log(c.dim("    none"));
    return;
  }
  for (const r of reports) {
    if (!r.health) {
      console.log(`    ${c.dim("−")} ${r.label} ${c.dim(`not provisioned here (written by \`${displayCmd()} up\`)`)}`);
      continue;
    }
    const h = r.health;
    const lastRenewal = h.iat ? c.dim(` · last renewal ${at(h.iat)}`) : "";
    const expiry = h.exp ? c.dim(` · expires ${at(h.exp)}`) : "";
    const badge =
      h.state === "healthy" ? c.green("● healthy")
      : h.state === "near-expiry" ? c.yellow("◐ near-expiry")
      : h.state === "unbounded" ? (r.problem ? c.red("∞ unbounded") : c.dim("∞ static (dies at the flip)"))
      : c.red(`✗ ${h.state}`);
    console.log(`    ${badge}  ${r.label}${lastRenewal}${expiry}`);
  }
}

/** Render the renewal owner's audit record (written by the manager's pass / doctor --fix): when the
 *  last pass ran, who ran it, and whether the daemon EXPLICITLY adopted — the "file re-signed" vs
 *  "daemon adopted" distinction the D5 panel required. Absence is informational (a mesh started
 *  before the renewal owner existed, or an open mesh). */
function renderRenewalRecord(root: string): void {
  const rec = readRenewalRecord(root);
  if (!rec) {
    console.log(c.dim("    no renewal record yet (written by the manager's renewal pass)"));
    return;
  }
  const resigned = rec.results.filter((r) => r.ok).map((r) => r.file);
  const failed = rec.results.filter((r) => !r.ok && !r.skipped);
  // Per-component result from the daemon's structured reply detail (persisted on ok AND failed
  // passes): "accepted" = the broker accepted this generation (the proof); "rejected" (ok:false);
  // "n/a" (absent/skipped). NOT "adopted" — the resident wire swap is best-effort/self-healing, not
  // witnessed. Empty for an older record.
  const detail = rec.adoption?.detail as
    | { delivery?: { ok?: boolean; brokerAccepted?: unknown; skipped?: string }; membership?: { ok?: boolean; brokerAccepted?: unknown; skipped?: string } }
    | undefined;
  const compStatus = (comp?: { ok?: boolean; brokerAccepted?: unknown; skipped?: string }): string =>
    comp === undefined ? "n/a" : comp.ok === false ? "rejected" : comp.skipped ? "n/a" : comp.brokerAccepted ? "accepted" : "n/a";
  const perComponent = detail && typeof detail === "object" && (detail.delivery !== undefined || detail.membership !== undefined)
    ? ` (delivery: ${compStatus(detail.delivery)}, membership: ${compStatus(detail.membership)})`
    : "";
  const adoption = rec.adoption === undefined
    ? resigned.length
      ? c.yellow("daemon reload not requested by this pass - daemons pick up the re-sign via the 75% re-read backstop or the next renewal pass")
      : c.dim("renewal: n/a (nothing re-signed)")
    : rec.adoption.ok
      ? c.green(`broker-accepted ✓${perComponent}`)
      : c.yellow(`renewal not accepted - ${rec.adoption.error ?? "unknown"}${perComponent}`);
  console.log(`    ${c.dim(`last renewal pass ${rec.ts} by ${rec.owner}`)} - re-signed [${resigned.join(", ") || "none"}] · ${adoption}`);
  for (const f of failed) console.log(`    ${c.red("✗")} last pass failed on ${f.file}: ${f.error}`);
}

function at(sec?: number): string {
  return sec ? new Date(sec * 1000).toISOString() : "?";
}
