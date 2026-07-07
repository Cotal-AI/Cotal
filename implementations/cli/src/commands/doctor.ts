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
import { authDir, findCotalRoot, loadSpaceAuth, userAuthStateDir } from "@cotal-ai/workspace";
import { remintDaemonCreds } from "../lib/delivery-proc.js";
import { displayCmd } from "../lib/self-exec.js";
import { c } from "../ui.js";

export const doctorFlags = [
  { name: "fix", type: "boolean", description: "execute the safe repairs (re-sign the launcher-remintable daemon creds; needs the local signer)" },
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
 *  for launcher-reminted creds — ending in either `healthy` or the exact next command (exit 1).
 *  `--fix` executes the one safe local repair (re-sign the class-2 daemon files for their existing
 *  nkeys); $SYS and agent creds are never auto-fixed — their repairs are printed, not guessed. */
export async function doctor(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  if (sub !== "auth") {
    console.error(`usage: ${displayCmd()} doctor auth [--fix]  — credential-health diagnosis + repair for this folder's mesh`);
    process.exitCode = 1;
    return;
  }
  const values = args.values as FlagValues<typeof doctorFlags>;
  const root = findCotalRoot(process.cwd());
  const auth = loadSpaceAuth(authDir(root));

  console.log(c.bold("cotal doctor auth"));
  console.log(`  root ${root}`);
  if (!auth) {
    // An open mesh has no minted credentials at all — nothing to diagnose is a healthy answer,
    // not a silent one.
    console.log(c.green("\nauth: healthy — open mesh (no credential material in this folder)"));
    return;
  }
  const userMode = existsSync(userAuthStateDir(root, auth.space));
  console.log(`  space ${auth.space}${userMode ? " · user-auth" : ""} · signer ${c.green("present")} (${join(authDir(root), "auth.json")})`);

  let reports = inventory(root);
  let problems = reports.filter((r) => r.problem);

  // --fix: the one safe local repair — re-sign the launcher-remintable daemon files (same nkeys),
  // exactly what the resident `cotal up` timer does. Then re-diagnose: the doctor reports what IS,
  // never what it hopes the fix did.
  if (values.fix && problems.some((r) => isRemintable(r.kind))) {
    console.log(c.dim("\n--fix: re-signing the launcher-remintable daemon creds…"));
    await remintDaemonCreds();
    reports = inventory(root);
    problems = reports.filter((r) => r.problem);
  }

  render("Daemon creds (launcher-reminted — class 2)", reports.filter((r) => isRemintable(r.kind)));
  render("$SYS creds (rotation-renewed — never remintable from disk)", reports.filter((r) => r.kind === "membership-observer" || r.kind === "connection-evictor"));
  render("Agent creds (static, pre-flip)", reports.filter((r) => r.kind === "agent"));

  if (!problems.length) {
    console.log(c.green("\nauth: healthy"));
    return;
  }
  console.log(c.red(`\nauth: ${problems.length} problem${problems.length === 1 ? "" : "s"}`));
  for (const p of problems) console.log(`  ${c.red("✗")} ${p.label}: ${p.problem}\n    next: ${p.repair}`);
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
    for (const f of readdirSync(agentDir).filter((f) => f.endsWith(".creds")).sort()) {
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
    ? `${displayCmd()} doctor auth --fix   (or re-run \`${displayCmd()} up\` — its resident remint timer re-signs it)`
    : kind === "agent"
      ? `respawn the agent (\`${displayCmd()} spawn\`) — its old cred is dead by design`
      : `system-account rotation: \`${displayCmd()} down\` then a fresh \`${displayCmd()} up\` regenerates the $SYS material`;
  switch (health.state) {
    case "unreadable":
      r.problem = `unreadable credential file (${health.error})`;
      r.repair = repair;
      break;
    case "expired":
      r.problem = "EXPIRED — the broker denies this credential";
      r.repair = repair;
      break;
    case "near-expiry":
      if (standing) {
        r.problem = `past its renewal point (renewal owner: ${policy.renewalOwner}) — expires ${at(health.exp)}`;
        r.repair = repair;
      }
      break;
    case "unbounded":
      if (standing) {
        r.problem = "unbounded standing credential (minted before the renewal slice) — a copied cred never dies";
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

function at(sec?: number): string {
  return sec ? new Date(sec * 1000).toISOString() : "?";
}
