import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launchManagedSharedSeat, linuxSharedCustodyAvailable } from "@cotal-ai/seat";
import type { AgentHandle, LaunchSpec } from "@cotal-ai/core";
import { executionIdentity } from "@cotal-ai/workspace";
import { custodyRoot } from "./custodial-pty.js";
import { LegacyPtyRuntime } from "./pty.js";

export class SharedPtyRuntime extends LegacyPtyRuntime {
  private readonly lineage: string | undefined;
  private readonly executionGeneration: string | undefined;
  private readonly staged?: { root: string; inventorySha256: string };
  private readonly loaded?: { root: string; stamp: string };
  constructor(space: string, install?: string) {
    super();
    try {
      const identity = executionIdentity();
      if (!identity?.loaded) return;
      const { logicalEntry, loadedEntry } = identity;
      const root = resolve(dirname(loadedEntry), "..");
      const key = createHash("sha256").update(JSON.stringify([install ?? logicalEntry, process.getuid?.(), space])).digest("hex");
      this.lineage = resolve(custodyRoot(), `p-${key}`);
      this.executionGeneration = createHash("sha256").update(JSON.stringify([loadedEntry, identity.loaded.version])).digest("hex");
      if (identity.inventorySha256) this.staged = { root, inventorySha256: identity.inventorySha256 };
      else this.loaded = { root, stamp: identity.loaded.stamp };
    } catch { /* An unverified installation cannot share custody. */ }
  }

  /** Manager-only entry point for the shared host client. */
  async spawnShared(name: string, spec: LaunchSpec, cwd: string, onReceipt: (child: Readonly<{ pid: number; start: string; boot: string }> | undefined) => void): Promise<AgentHandle> {
    // Eligibility can change while the Manager is running. Fall back only before
    // dispatch, since a failed shared request could already have launched the seat.
    if (!this.lineage || !this.executionGeneration || !currentUserHasLinger() || !linuxSharedCustodyAvailable())
      return super.spawn(name, spec, cwd);
    if (this.loaded && !stillLoaded(this.loaded)) return super.spawn(name, spec, cwd);
    const handle = await launchManagedSharedSeat(this.lineage, { root: this.lineage, name, spec, cwd }, this.executionGeneration, this.staged);
    if (handle === undefined) return super.spawn(name, spec, cwd);
    // Released lifecycle transactions are admitted separately from process custody.
    // Keep today's Manager stop and update policy until that transaction is enabled.
    const { release: _release, reference: _reference, childIdentity, ...controlled } = handle;
    onReceipt(childIdentity);
    return controlled;
  }
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
