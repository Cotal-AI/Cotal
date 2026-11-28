import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { darwinBootSession, processStartTime } from "@cotal-ai/seat";
import {
  darwinSeatHostGenerationRoot, darwinSeatHostInventoryLimit as hostLimit, listOwnedDarwinSeatHostJobs,
  readRetainedDarwinSeatHostPlan, requireDarwinSeatInstallationScope,
  verifiedDarwinSeatHostJobPid, type DarwinSeatHostScope,
} from "./seat-host-darwin.js";
import { observeRetainedDarwinSeatLineage } from "./seat-host-inventory-darwin.js";

type Installation = Omit<DarwinSeatHostScope, "space">;
type Receipt = ReturnType<typeof readRetainedDarwinSeatHostPlan>;
type Lineage = Extract<Awaited<ReturnType<typeof observeRetainedDarwinSeatLineage>>, { state: "sampled" }>;
type Observation = { state: "sampled"; lineages: ReadonlyMap<string, Lineage> } | { state: "unknown" };
const refusal = () => new Error("could not reconcile the macOS PTY host inventory");

function directoryStamp(path: string): string | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o700n ||
      realpathSync.native(path) !== path) throw refusal();
  return [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":");
}

function directory(path: string, limit: number, stamps: Map<string, string | undefined>): string[] {
  const stamp = directoryStamp(path);
  stamps.set(path, stamp);
  if (stamp === undefined) return [];
  const dir = opendirSync(path), entries: string[] = [];
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (entries.length >= limit) throw refusal();
      entries.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return entries.sort();
}

function readReceipts(home: string, source: string, stamps: Map<string, string | undefined>): Receipt[] {
  const names = new Set(directory(source, hostLimit * 2, stamps));
  const receipts: Receipt[] = [];
  for (const file of names) {
    const match = /^(ai\.cotal\.pty\.[a-f0-9]{32})\.json$/.exec(file);
    if (!match) throw refusal();
    const label = match[1]!;
    if (!names.delete(`${label}.plist`)) throw refusal();
    receipts.push(readRetainedDarwinSeatHostPlan(home, label));
  }
  return receipts;
}

function enumerateRoots(path: string, stamps: Map<string, string | undefined>): Set<string> {
  const roots = new Set<string>();
  for (const lineage of directory(path, hostLimit, stamps)) {
    if (!/^[a-f0-9]{32}$/.test(lineage)) throw refusal();
    const parent = join(path, lineage);
    const generations = directory(parent, hostLimit + 2, stamps).filter(name => name !== "controller.lock" && name !== "controller.json");
    if (!generations.length || stamps.get(parent) === undefined) throw refusal();
    for (const generation of generations) {
      const root = join(parent, generation);
      if (roots.size >= hostLimit || !/^[a-f0-9]{64}$/.test(generation)) throw refusal();
      const stamp = directoryStamp(root);
      if (stamp === undefined) throw refusal();
      stamps.set(root, stamp);
      roots.add(root);
    }
  }
  return roots;
}

function snapshot(installation: Installation, removalConsent?: () => boolean) {
  const jobs = listOwnedDarwinSeatHostJobs(installation, removalConsent);
  const boot = darwinBootSession();
  const home = installation.cotalHome;
  const base = join(home, "daemon");
  const stamps = new Map([[home, directoryStamp(home)], [base, directoryStamp(base)]]);
  if (stamps.get(home) === undefined || stamps.get(base) === undefined) throw refusal();
  const receipts = readReceipts(home, join(base, "pty-host-launchd"), stamps);
  const roots = enumerateRoots(join(base, "pty-hosts"), stamps);
  if (jobs.size !== receipts.length || roots.size !== receipts.length) throw refusal();
  const identities = new Map<string, { pid: number; start: string; bootId: string }>();
  for (const { scope, generation, plan } of receipts) {
    const pid = jobs.get(plan.label);
    if (pid === undefined || !roots.delete(darwinSeatHostGenerationRoot(scope, generation))) throw refusal();
    verifiedDarwinSeatHostJobPid(plan, pid);
    const start = processStartTime(pid);
    if (!start) throw refusal();
    identities.set(plan.label, { pid, start, bootId: boot });
  }
  for (const [path, stamp] of stamps) if (directoryStamp(path) !== stamp) throw refusal();
  const revision = JSON.stringify([[...identities], [...stamps], receipts.map(({ plan }) => [plan.label, plan.sha256])]);
  return { identities, receipts, revision };
}

/** Read-only coverage from the owned GUI daemon. The caller must separately supply the logical
 * installation identity and hold an admission fence before acting. This sample is not stop authority. */
export async function observeRetainedDarwinSeatInstallation(installation: Installation, removalConsent?: () => boolean): Promise<Observation> {
  if (process.platform !== "darwin") return { state: "unknown" };
  try {
    const fixed = Object.freeze({ ...installation });
    requireDarwinSeatInstallationScope(fixed);
    const before = snapshot(fixed, removalConsent);
    const bySpace = new Map<string, Receipt[]>();
    for (const receipt of before.receipts) {
      const { installedRoot, daemonHome, space } = receipt.scope;
      if (installedRoot !== fixed.installedRoot || daemonHome !== fixed.daemonHome) continue;
      const entries = bySpace.get(space) ?? [];
      entries.push(receipt);
      bySpace.set(space, entries);
    }
    const lineages = new Map<string, Lineage>();
    for (const [space, expected] of bySpace) {
      const joined = await observeRetainedDarwinSeatLineage({ ...fixed, space }, removalConsent);
      if (joined.state !== "sampled" || joined.generations.length !== expected.length) return { state: "unknown" };
      for (const { generation, plan } of expected) {
        const found = joined.generations.find(entry => entry.generation === generation);
        const exact = before.identities.get(plan.label);
        if (found?.state !== "recorded" || !exact || found.host.scope !== plan.label || found.host.identity.pid !== exact.pid ||
            found.host.identity.start !== exact.start || found.host.identity.bootId !== exact.bootId)
          return { state: "unknown" };
      }
      lineages.set(space, joined);
    }
    return before.revision === snapshot(fixed, removalConsent).revision ? { state: "sampled", lineages } : { state: "unknown" };
  } catch { return { state: "unknown" }; }
}
