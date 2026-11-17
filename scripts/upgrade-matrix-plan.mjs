#!/usr/bin/env node
/** Pure planning only. The caller validates API publication evidence before setting published.
 * No API calls, credentials, installs, service control, or repository reads occur here.
 * CLI: --event event.json --context context.json (context includes eventName).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const platforms = ["linux", "darwin", "win32"];
const runners = { linux: "ubuntu-24.04", darwin: "macos-15", win32: "windows-2022" };
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function sha(value) {
  requireValue(typeof value === "string" && /^[a-f0-9]{40}$/.test(value), "sourceSHA must be an immutable lowercase 40-character SHA");
  return value;
}
function version(value) {
  requireValue(typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value), "targetVersion must be an explicit semver");
  const [core, pre] = value.split("+")[0].split(/-(.*)/s);
  const identifiers = pre?.split(".");
  requireValue(!identifiers?.some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === "0"), "invalid numeric prerelease identifier");
  return { core: core.split(".").map(BigInt), pre: identifiers };
}
export function compareVersions(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) > BigInt(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}
/** Every observed resolution must match the expected version, including extensions. */
export function assertTarget(expected, resolved, { sourceVersion } = {}) {
  version(expected);
  requireValue(compareVersions(expected, sourceVersion) > 0, `target ${expected} must be newer than source ${sourceVersion}`);
  const values = typeof resolved === "string" ? [resolved] : Array.isArray(resolved) ? resolved : Object.values(resolved ?? {});
  requireValue(values.length > 0, "missing target resolutions");
  for (const actual of values) requireValue(actual === expected, `expected target ${expected}, resolved ${actual}`);
  return true;
}
/** Freeze the newest published stable version strictly below the target. */
export function publishedPredecessor(registry, target) {
  requireValue(stableVersion.test(target), "planned target must be a stable numeric version");
  requireValue(registry?.versions && typeof registry.versions === "object" && !Array.isArray(registry.versions), "public registry versions missing");
  const versions = Object.entries(registry.versions).filter(([key]) => stableVersion.test(key) && compareVersions(key, target) < 0);
  for (const [key, manifest] of versions) requireValue(manifest?.version === key, `public registry version mismatch: ${key}`);
  versions.sort(([a], [b]) => compareVersions(b, a));
  requireValue(versions.length > 0, `no published stable source below ${target}`);
  return versions[0][0];
}
const skipped = reason => ({ status: "skipped", acceptance: false, reason });

/** Synthetic next-hop target: the candidate's stable patch plus 1000, never public latest. */
export function syntheticNextVersion(candidate, offset = 1000) {
  requireValue(offset === 1000 || offset === 2000, "synthetic offset must be 1000 or 2000");
  requireValue(typeof candidate === "string" && stableVersion.test(candidate), "synthetic candidate must be a stable numeric version");
  const parts = candidate.split(".").map(BigInt);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const delta = BigInt(offset);
  requireValue(parts.every(part => part <= max) && parts[2] <= max - delta, "synthetic version exceeds safe numeric range");
  parts[2] += delta;
  const target = parts.join(".");
  requireValue(compareVersions(target, candidate) > 0, "synthetic target must be newer than candidate");
  return target;
}

export function syntheticFollowOnVersion(candidate) {
  return syntheticNextVersion(candidate, 2000);
}

/** event is a GitHub payload. context is trusted caller-supplied metadata, not PR code.
 * context: eventName, repository, packageManifest (read at sourceSHA), sourceVersion (registry
 * predecessor frozen by caller), published, publishJobConclusion. A true published flag certifies exact npm version, main manifest,
 * release commit message and successful publish job have all been validated by the caller.
 */
export function planPhase(event, context = {}) {
  const name = context.eventName ?? event.eventName;
  let phase, sourceSHA, targetVersion, profile = "bounded";
  if (name === "pull_request") {
    const pr = event.pull_request;
    if (!pr || pr.base?.ref !== "main" || pr.head?.ref !== "changeset-release/main") return skipped("not the main Changesets version PR");
    if (!context.repository || pr.head?.repo?.full_name !== context.repository || pr.base?.repo?.full_name !== context.repository) return skipped("fork or repository mismatch");
    if (pr.state === "closed" || event.action === "closed") return skipped("closed version PR");
    phase = "candidate";
    sourceSHA = pr.head.sha;
    targetVersion = context.packageManifest?.version;
  } else if (name === "workflow_run") {
    const run = event.workflow_run;
    if (event.action !== "completed" || run?.status !== "completed" || run?.path !== ".github/workflows/changesets.yml" || run?.head_branch !== "main") return skipped("not a completed main Changesets run");
    if (!context.repository || run.head_repository?.full_name !== context.repository || event.repository?.full_name !== context.repository) return skipped("workflow repository mismatch");
    if (context.publishJobConclusion !== "success" || context.published !== true) return skipped("publication not confirmed by validated API evidence");
    phase = "published";
    sourceSHA = run.head_sha;
    targetVersion = context.packageManifest?.version;
    requireValue(context.targetVersion === targetVersion, "published targetVersion must match the source manifest");
  } else if (name === "workflow_dispatch") {
    const inputs = event.inputs ?? {};
    phase = inputs.phase;
    sourceSHA = inputs.source_sha ?? inputs.sourceSHA;
    targetVersion = inputs.target_version ?? inputs.targetVersion;
    profile = inputs.profile ?? "bounded";
    requireValue(["candidate", "published"].includes(phase), "manual phase must be candidate or published");
  } else return skipped("event not applicable");
  requireValue(profile === "bounded", "profile must be bounded: extended is not implemented");
  sha(sourceSHA);
  version(targetVersion);
  requireValue(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(targetVersion), "planned target must be a stable numeric version");
  const sourceVersion = context.sourceVersion;
  requireValue(typeof sourceVersion === "string" && stableVersion.test(sourceVersion), "sourceVersion must be a frozen published stable version");
  requireValue(compareVersions(targetVersion, sourceVersion) > 0, "planned target must be newer than the frozen published source");
  return { status: "planned", acceptance: false, phase, sourceSHA, targetVersion, profile, sourceVersion, targetSource: phase === "candidate" ? "packed-target" : "npm-exact" };
}

/** Includes excluded coordinates so that unsupported work cannot become green acceptance. */
export function boundedCells(plan) {
  if (plan.status === "skipped") return [];
  requireValue(plan.status === "planned" && ["candidate", "published"].includes(plan.phase), "invalid phase plan");
  sha(plan.sourceSHA);
  version(plan.targetVersion);
  requireValue(typeof plan.sourceVersion === "string" && stableVersion.test(plan.sourceVersion), "missing frozen source version");
  requireValue(compareVersions(plan.targetVersion, plan.sourceVersion) > 0, "target must be newer than frozen source");
  const cells = [];
  const add = (platform, channel, scenario, reason = null, identity = {}) => {
    const id = `${platform}-${channel}-${scenario}`;
    cells.push({ id, platform, runner: runners[platform], channel, scenario, phase: plan.phase,
      sourceSHA: plan.sourceSHA, sourceKind: "npm-exact-source", sourceVersion: plan.sourceVersion, targetVersion: plan.targetVersion,
      targetSource: channel === "installer" && scenario !== "daemon-self" ? (plan.phase === "candidate" ? "candidate-installer-artifact" : "https://get.cotal.ai") : plan.targetSource,
      installerSource: channel === "installer" && scenario === "configured-rerun" && plan.phase === "candidate" ? "ARTIFACT/installer.sh" : null,
      installerReceiptRequired: channel === "installer" && scenario === "configured-rerun" && plan.phase === "candidate",
      installerOverride: false, required: !reason, disposition: reason ? "excluded" : "required", reason,
      requiredAssertions: reason ? [] : ["target-version", "extension-versions", "inventory-preserved", "status-healthy", "no-recovery", "no-manual-intervention", ...(channel === "installer" && scenario === "configured-rerun" && plan.phase === "candidate" ? ["installer-source-receipt"] : []), ...(scenario === "daemon-scheduler" ? ["native-scheduler", "daemon-restart"] : []), ...(["daemon-self", "candidate-next-daemon-self", "candidate-next-stopped-daemon-self"].includes(scenario) ? ["native-service-manual", "independent-final-state"] : []), ...(scenario === "candidate-next-disabled-daemon-self" ? ["native-service-manual", "disabled-daemon-before-update"] : []), ...(scenario === "candidate-next-stopped-desktop-self" ? ["stopped-daemon-before-update", "stopped-desktop-beside-cli"] : []), ...(["candidate-next-daemon-self", "candidate-next-stopped-daemon-self", "candidate-next-disabled-daemon-self", "candidate-next-stopped-desktop-self"].includes(scenario) ? ["candidate-source-identity", "candidate-next-target", "next-hop-success"] : []), ...(scenario === "candidate-next-stopped-daemon-self" ? ["stopped-daemon-before-update"] : []), ...(["agent-stop-consent", "standalone-stop-consent"].includes(scenario) ? ["stop-consent", "owned-stack-cleanup"] : []), ...(scenario === "foreign-config-recovery" ? ["foreign-snapshot-retained"] : []), ...(scenario === "container-manager" ? ["container-manager-preserved", "owned-stack-cleanup"] : [])],
      ...identity });
  };
  for (const platform of platforms) for (const scenario of ["fresh", "configured", "stale-self"]) add(platform, "npm", scenario);
  for (const platform of ["linux", "darwin"]) {
    add(platform, "installer", "configured-rerun");
    add(platform, "installer", "daemon-scheduler");
  }
  add("linux", "npm", "agent-stop-consent");
  add("linux", "npm", "standalone-stop-consent");
  add("linux", "npm", "foreign-config-recovery");
  add("linux", "npm", "container-manager");
  for (const platform of platforms) add(platform, "npm", "daemon-self");
  for (const platform of ["linux", "darwin"]) add(platform, "installer", "daemon-self");
  {
    const targetVersion = syntheticNextVersion(plan.targetVersion);
    const followOnVersion = syntheticFollowOnVersion(plan.targetVersion);
    const chainAssertions = ["exact-source-refusal", "intermediate-whole-machine", "next-hop-success"];
    for (const cell of cells.filter(cell => ['daemon-self', 'agent-stop-consent'].includes(cell.scenario) && cell.sourceVersion === '0.164.10')) {
      cell.chain = true;
      cell.finalTargetVersion = targetVersion;
      cell.targetSourceSHA = plan.sourceSHA;
      cell.syntheticVersionRule = "candidate.patch+1000";
      cell.requiredAssertions.push(...chainAssertions);
      if (cell.scenario === 'agent-stop-consent') cell.requiredAssertions.push('independent-final-state', 'hosted-manager-restored');
    }
    for (const platform of platforms) add(platform, "npm", "candidate-next-daemon-self", null, {
      sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A", targetVersion,
      targetSource: "packed-next-B", targetSourceSHA: plan.sourceSHA,
      syntheticVersionRule: "candidate.patch+1000",
    });
    for (const platform of platforms) add(platform, "npm", "candidate-next-stopped-daemon-self", null, {
      sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A", targetVersion,
      targetSource: "packed-next-B", targetSourceSHA: plan.sourceSHA,
      syntheticVersionRule: "candidate.patch+1000",
      stoppedDaemonBeforeUpdate: true,
    });
    for (const platform of ["linux", "darwin"]) add(platform, "npm", "candidate-next-disabled-daemon-self", null, {
      sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A", targetVersion,
      targetSource: "packed-next-B", targetSourceSHA: plan.sourceSHA,
      syntheticVersionRule: "candidate.patch+1000",
      disabledDaemonBeforeUpdate: true,
    });
    add("linux", "npm", "candidate-next-stopped-desktop-self", null, {
      sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A", targetVersion,
      targetSource: "packed-next-B", targetSourceSHA: plan.sourceSHA,
      syntheticVersionRule: "candidate.patch+1000",
      stoppedDaemonBeforeUpdate: true,
      desktopBesideCli: true,
    });
    const followOnAssertions = ["target-version", "extension-versions", "inventory-preserved", "status-healthy", "no-recovery", "no-manual-intervention", "native-service-manual", "independent-final-state", "candidate-source-identity", "candidate-next-target", "next-hop-success", "intermediate-whole-machine", "follow-on-target", "follow-on-success"];
    for (const platform of ["linux", "darwin"]) {
      add(platform, "npm", "candidate-next-second-self", null, {
        sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A",
        targetVersion, finalTargetVersion: followOnVersion,
        targetSource: "packed-follow-on-C", targetSourceSHA: plan.sourceSHA,
        syntheticVersionRule: "candidate.patch+1000/2000", followOnAction: "self",
        requiredAssertions: [...followOnAssertions],
      });
      add(platform, "npm", "candidate-next-manual-npm", null, {
        sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A",
        targetVersion, finalTargetVersion: followOnVersion,
        targetSource: "packed-follow-on-C", targetSourceSHA: plan.sourceSHA,
        syntheticVersionRule: "candidate.patch+1000/2000", followOnAction: "npm",
        requiredAssertions: [...followOnAssertions, "bare-manual-npm-observation"],
      });
      add(platform, "installer", "candidate-next-installer-rerun", null, {
        sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A",
        targetVersion, finalTargetVersion: followOnVersion,
        targetSource: "packed-follow-on-C", targetSourceSHA: plan.sourceSHA,
        installerSource: "FOLLOW_ON_ARTIFACT/installer.sh", installerReceiptRequired: true,
        syntheticVersionRule: "candidate.patch+1000/2000", followOnAction: "installer",
        requiredAssertions: [...followOnAssertions, "installer-source-receipt"],
      });
    }
    for (const platform of platforms) add(platform, "npm", "source-0.164.10-daemon-self-chain", null, {
      sourceVersion: "0.164.10", sourceKind: "npm-exact-source", chain: true,
      finalTargetVersion: targetVersion, targetSourceSHA: plan.sourceSHA,
      syntheticVersionRule: "candidate.patch+1000",
      requiredAssertions: ["target-version", "extension-versions", "inventory-preserved", "status-healthy", "no-recovery", "no-manual-intervention", "native-service-manual", "independent-final-state", ...chainAssertions],
    });
  }
  add("win32", "installer", "daemon-self", "Windows installer self-update excluded: no public shell installer route");
  add("win32", "npm", "daemon-scheduler", "Windows scheduler upgrade excluded until product readiness is established");
  add("linux", "npm", "candidate-a", "optional candidate A is outside the required bounded matrix");
  for (const platform of ["linux", "darwin"]) add(platform, "npm", "candidate-next-dead-updater", null, {
    sourceVersion: plan.targetVersion, sourceKind: plan.phase === "published" ? "npm-exact-A" : "packed-candidate-A",
    targetVersion: syntheticNextVersion(plan.targetVersion), targetSource: "packed-next-B", targetSourceSHA: plan.sourceSHA,
    syntheticVersionRule: "candidate.patch+1000", deadUpdater: true,
    requiredAssertions: ["target-version", "extension-versions", "inventory-preserved", "status-healthy", "no-recovery", "no-manual-intervention",
      "candidate-source-identity", "candidate-next-target", "next-hop-success", "native-service-manual", "independent-final-state",
      "dead-updater-release", "live-owner-held", "next-update-alone"],
  });
  return cells;
}
/** Convenience wrapper for workflow callers. */
export function planRelease(event, context = {}) {
  const plan = planPhase(event, context);
  const cells = boundedCells(plan);
  return { ...plan, cells, expectedIDs: cells.filter(c => c.required).map(c => c.id), matrix: jobsMatrix(cells) };
}
export function jobsMatrix(cells) {
  unique(cells, "expected");
  return { include: cells.filter(c => c.required).map(c => ({ ...c })) };
}
function unique(cells, label) {
  const seen = new Set();
  for (const c of cells) {
    requireValue(typeof c.id === "string" && c.id.length > 0, `${label}: missing cell id`);
    requireValue(!seen.has(c.id), `${label}: duplicate coordinate ${c.id}`);
    seen.add(c.id);
  }
}
/** Results: {id,status:'passed',assertions:{'target-version':true,...}}.
 * Exclusions are reported separately and can never count as passing cells.
 */
export function verifyResults(expected, results, { knownRefusals = [] } = {}) {
  unique(expected, "expected");
  unique(knownRefusals, "known refusals");
  unique(results, "results");
  const byId = new Map(results.map(r => [r.id, r]));
  const known = new Set(expected.map(c => c.id));
  const failures = results.filter(r => !known.has(r.id)).map(r => `${r.id}: unexpected coordinate`);
  const acceptedRefusals = [];
  for (const refusal of knownRefusals) requireValue(expected.some(cell => cell.id === refusal.id && cell.required) && typeof refusal.issue === "string" && /^https:\/\/github\.com\/Cotal-AI\/Cotal\/issues\/[1-9]\d*$/.test(refusal.issue), "invalid known refusal coordinate or public issue");
  const passed = [], excluded = [];
  for (const cell of expected) {
    const result = byId.get(cell.id);
    if (!cell.required) {
      requireValue(cell.disposition === "excluded" && typeof cell.reason === "string" && cell.reason.trim().length > 0, `${cell.id}: exclusion needs a reason`);
      excluded.push({ id: cell.id, reason: cell.reason });
      if (result && result.status !== "excluded") failures.push(`${cell.id}: excluded coordinate cannot claim acceptance`);
      continue;
    }
    requireValue(Array.isArray(cell.requiredAssertions) && cell.requiredAssertions.length > 0, `${cell.id}: missing required assertion contract`);
    const refusal = knownRefusals.find(entry => entry.id === cell.id);
    if (refusal) {
      if (!result || result.status !== "failed") failures.push(`${cell.id}: listed refusal turned green or is missing; retire ${refusal.issue}`);
      else acceptedRefusals.push(refusal);
      continue;
    }
    if (!result || result.status !== "passed") { failures.push(`${cell.id}: missing or non-passing result`); continue; }
    const missing = cell.requiredAssertions.filter(a => result.assertions?.[a] !== true);
    if (missing.length) failures.push(`${cell.id}: missing required assertions: ${missing.join(", ")}`);
    else passed.push(cell.id);
  }
  const requiredCount = expected.filter(c => c.required).length;
  const acceptance = requiredCount > 0 && failures.length === 0 && passed.length + acceptedRefusals.length === requiredCount;
  return { acceptance, upgradeAcceptance: acceptance && acceptedRefusals.length === 0, requiredCount, passed, knownRefusals: acceptedRefusals, excluded, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 2 || args.length === 4, "usage: --event file [--context file]");
    requireValue(args[0] === "--event" && (args.length === 2 || args[2] === "--context"), "usage: --event file [--context file]");
    const event = JSON.parse(readFileSync(args[1], "utf8"));
    const context = args[3] ? JSON.parse(readFileSync(args[3], "utf8")) : {};
    console.log(JSON.stringify(planRelease(event, context), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
