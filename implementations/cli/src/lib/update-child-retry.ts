import { join } from "node:path";
import { claimUpdateClosureAccess, updateActivationBlocked } from "@cotal-ai/workspace";
import type { UpdateRuntime } from "../commands/update.js";

export const announceGlobalUpdateWait = (rt: UpdateRuntime) => () => rt.out("Waiting for another updater to release npm's global root");

function installedUpdateRoot(rt: UpdateRuntime): string | undefined {
  const prefix = rt.executionGlobalRoot ? undefined : rt.installPrefix();
  return rt.executionGlobalRoot?.() ?? (prefix && join(prefix, "lib", "node_modules"));
}

function changedEntry(rt: UpdateRuntime, root: string): string | undefined {
  const version = rt.globalVersion?.(root);
  if (!version) throw new Error("cannot verify the installed CLI under the global update lock");
  return version !== rt.version() ? (rt.verifyUpdatedEntry ?? rt.verifyGlobalEntry)(root, version) : undefined;
}

/** Drain child custody before probing the closure, and never wait on a reverse-order recovery. */
export function withCurrentUpdateFence<T>(rt: UpdateRuntime, check: () => T): T | { entry: string } {
  const root = installedUpdateRoot(rt);
  const releaseGlobal = root ? rt.claimGlobalUpdate(root, announceGlobalUpdateWait(rt)) : undefined;
  try {
    const releaseClosure = claimUpdateClosureAccess("immediate");
    try {
      if (updateActivationBlocked()) throw new Error("an interrupted update needs restoration; run `cotal update --self`");
      const entry = root && changedEntry(rt, root);
      return entry ? { entry } : check();
    } finally { releaseClosure(); }
  } finally { releaseGlobal?.(); }
}

export function targetArgv(target: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const name of ["space", "server", "creds", "on"] as const) {
    const value = target[name];
    if (typeof value === "string") argv.push(`--${name}`, value);
  }
  return argv;
}

export function runInstalledSelfUpdate(rt: UpdateRuntime, entry: string, target: Record<string, unknown>): number {
  const child = rt.spawn(rt.nodePath, [entry, "update", "--self", ...targetArgv(target), ...(target["stop-agents"] === true ? ["--stop-agents"] : [])], rt.env, true);
  if (child.error) throw new Error(`cannot continue the update through the verified installation: ${child.error}`);
  if (child.stderr) rt.stderr(child.stderr);
  if (child.stdout) rt.stdout(child.stdout);
  return child.status ?? 1;
}
