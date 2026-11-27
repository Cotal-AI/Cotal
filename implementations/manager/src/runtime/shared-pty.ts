import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { inspectWindowsAliasHold, launchManagedSharedSeat, launchManagedWindowsSeat, linuxSharedCustodyAvailable } from "@cotal-ai/seat";
import type { AgentHandle, LaunchSpec } from "@cotal-ai/core";
import { claimUpdateClosureAccess, executionIdentity, installationWriter, resolveOnPath } from "@cotal-ai/workspace";
import { custodyRoot } from "./custodial-pty.js";
import { LegacyPtyRuntime } from "./pty.js";

interface HostedSharedExecution {
  lineage: string;
  executionGeneration: string;
  staged?: { root: string; inventorySha256: string };
  loaded?: { root: string; stamp: string };
}

export class SharedPtyRuntime extends LegacyPtyRuntime {
  private readonly nativeArtifacts = new WeakSet<AgentHandle>();
  private readonly execution?: HostedSharedExecution;
  private readonly windows?: { installation: string; space: string };
  constructor(space: string, install?: string) {
    super();
    try {
      const identity = executionIdentity();
      if (!identity?.loaded) return;
      if (process.platform === "win32") {
        if (install === identity.logicalEntry) {
          const root = dirname(dirname(install));
          this.windows = { installation: lstatSync(resolve(root, "desktop-runtime.json"), { throwIfNoEntry: false })?.isFile() ? dirname(root) : root, space };
        }
        return;
      }
      const { logicalEntry, loadedEntry } = identity;
      const root = resolve(dirname(loadedEntry), "..");
      const key = createHash("sha256").update(JSON.stringify([install ?? logicalEntry, process.getuid?.(), space])).digest("hex");
      this.execution = {
        lineage: resolve(custodyRoot(), `p-${key}`),
        executionGeneration: createHash("sha256").update(JSON.stringify([loadedEntry, identity.loaded.version])).digest("hex"),
        ...(identity.inventorySha256 ? { staged: { root, inventorySha256: identity.inventorySha256 } }
          : { loaded: { root, stamp: identity.loaded.stamp } }),
      };
    } catch { /* An unverified installation cannot share custody. */ }
  }

  /** Manager-only entry point for the shared host client. */
  async spawnShared(name: string, spec: LaunchSpec, cwd: string, onReceipt: (child: Readonly<{ pid: number; start: string; boot: string }> | undefined) => void): Promise<AgentHandle> {
    if (this.windows) {
      if (this.holdsNativeAlias(name)) throw new Error("Windows PTY alias custody is held or unknown");
      const command = resolveOnPath(spec.command, spec.env ?? {});
      if (!command) return super.spawn(name, spec, cwd);
      const launched = await launchManagedWindowsSeat(this.windows.installation, this.windows.space, { name, spec: { ...spec, command }, cwd }, () => {
        if (installationWriter()) throw new Error("the installation is changing before Windows PTY launch");
        return claimUpdateClosureAccess();
      });
      if (launched.state === "ineligible") return super.spawn(name, spec, cwd);
      const { release: _release, reference: _reference, childIdentity: _identity, ...controlled } = launched.handle;
      // A conservative reservation must outlive the Windows root process when its job still has descendants.
      onReceipt(undefined);
      this.nativeArtifacts.add(controlled);
      return controlled;
    }
    // Eligibility can change while the Manager is running. Fall back only before
    // dispatch, since a failed shared request could already have launched the seat.
    const execution = probeHostedSharedEligibility(this.execution);
    if (!execution) return super.spawn(name, spec, cwd);
    const { lineage, executionGeneration, staged } = execution;
    const handle = await launchManagedSharedSeat(lineage, { root: lineage, name, spec, cwd }, executionGeneration, staged);
    if (handle === undefined) return super.spawn(name, spec, cwd);
    // Released lifecycle transactions are admitted separately from process custody.
    // Keep today's Manager stop and update policy until that transaction is enabled.
    const { release: _release, reference: _reference, childIdentity, ...controlled } = handle;
    onReceipt(childIdentity);
    return controlled;
  }

  ownsNativeArtifacts(handle: AgentHandle): boolean { return this.nativeArtifacts.has(handle); }

  holdsNativeAlias(name: string): boolean {
    return this.nativeAliasState(name) !== "clear";
  }

  nativeAliasState(name: string): "clear" | "held" | "unknown" {
    return this.windows ? inspectWindowsAliasHold(this.windows.installation, this.windows.space, name) : "clear";
  }
}

export function hostedNativeAliasHeld(runtime: unknown, name: string): boolean {
  return runtime instanceof SharedPtyRuntime && runtime.holdsNativeAlias(name);
}

export function requireNativeAliasProof(runtime: unknown, name: string): boolean {
  if (!(runtime instanceof SharedPtyRuntime)) return false;
  const state = runtime.nativeAliasState(name);
  if (state === "unknown") throw new Error("Windows PTY alias custody is unknown");
  return state === "held";
}

/** Recheck hosted eligibility immediately before launch. This does not claim or start a host. */
function probeHostedSharedEligibility(execution: HostedSharedExecution | undefined): HostedSharedExecution | undefined {
  if (!execution || !currentUserHasLinger() || !linuxSharedCustodyAvailable()) return undefined;
  if (execution.loaded && !stillLoaded(execution.loaded)) return undefined;
  return execution;
}

function stillLoaded({ root, stamp }: { root: string; stamp: string }): boolean {
  try {
    return ["package.json", "dist/cotal.js", "dist/cotal-program.js"].map(name => {
      const s = lstatSync(resolve(root, name), { bigint: true });
      if (!s.isFile()) throw new Error("invalid loaded execution file");
      return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
    }).join("/") === stamp;
  } catch { return false; }
}

function currentUserHasLinger(): boolean {
  if (process.platform !== "linux") return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    const result = spawnSync("/usr/bin/loginctl", ["show-user", "--property=UID", "--property=Linger", "--", String(uid)], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return false;
    const fields = result.stdout.trimEnd().split("\n");
    return fields.length === 2 && fields.includes(`UID=${uid}`) && fields.includes("Linger=yes");
  } catch { return false; }
}
