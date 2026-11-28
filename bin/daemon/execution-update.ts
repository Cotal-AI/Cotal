import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { logicalExecutionEntry, executionIdentity } from "@cotal-ai/workspace";
import { updateRuntime, verifyGlobalEntry, type ExecutionReplacement } from "@cotal-ai/cli/update";
import { cleanupExecutionStore } from "../execution-store.js";
import { completeExecutionTransaction, assertExecutionDestination, executionStagingPrefix, journalExecutionTransaction, publishExecutionTransaction, readExecutionTransaction, retainExecutionGeneration, retireSupersededExecutionDescriptor } from "../execution-transaction.js";
import { executionCopyModesEnv, executionDescriptorPath, executionInventory, executionRecord, executionSha256, selectExecutionProgram, type ExecutionDescriptor } from "../cotal.js";
import { daemonServeArgv } from "./install.js";
import { observeUpdateDaemon, sameUpdateDaemon, assertUpdateDaemon } from "./update-lifetime.js";
import { targetExecutionPreinstall, type ExecutionPreinstallReceipt } from "./execution-preinstall-client.js";

export function executionInstallRoot(): string {
  const entry = logicalExecutionEntry();
  if (!entry) throw new Error("staged update requires the installed built-ins bootstrap; use the owning installer");
  return dirname(dirname(entry));
}

export function preflightExecutionUpdate(): boolean {
  const root = executionInstallRoot();
  if (existsSync(join(root, "desktop-runtime.json"))) throw new Error("staged execution updates are unavailable on the desktop runtime");
  const repaired = assertExecutionDestination(root);
  if (basename(dirname(root)) !== "node_modules") throw new Error("staged update requires an installed npm or pnpm package; use the owning installer");
  return repaired;
}

function verifySelected(root: string, version: string): void {
  const entry = join(root, "dist/cotal.js");
  const timeout = 300_000;
  const result = spawnSync(process.execPath, [entry, "--version"], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", [executionCopyModesEnv]: "explicit" }, encoding: "utf8", timeout, windowsHide: true });
  if (result.error) {
    const detail = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? `entry verification timed out after ${timeout / 1000} seconds`
      : `entry verification could not start: ${result.error.message}`;
    throw new Error(`selected execution did not confirm cotal-ai@${version}: ${detail}`);
  }
  if (result.status !== 0 || result.stdout.split(/\r?\n/, 1)[0] !== `cotal-ai ${version}`)
    throw new Error(`selected execution did not confirm cotal-ai@${version}: ${result.stderr.trim() || `exit ${result.status}, signal ${result.signal ?? "none"}, version output ${JSON.stringify(result.stdout.split(/\r?\n/, 1)[0])}`}`);
}

/** Prepare one complete real npm package. No live package file is passed to npm for reification. */
export async function prepareExecutionUpdate(version: string, globalRoot: string, checked: (receipt: ExecutionPreinstallReceipt) => void): Promise<ExecutionReplacement> {
  const installed = executionInstallRoot();
  if (realpathSync.native(join(globalRoot, "cotal-ai")) !== installed) throw new Error("staged update global root differs from logical installation");
  const staging = executionStagingPrefix(installed);
  let generation: ReturnType<typeof retainExecutionGeneration>;
  try {
    const args = ["install", "-g", "--prefix", staging, `cotal-ai@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=2000", "--fetch-timeout=15000"];
    const result = await updateRuntime.spawnGlobal(globalRoot, "install", "npm", args, process.env, false, false, staging);
    if (result.status !== 0) {
      if (result.signal) throw new Error(`target staging interrupted: npm terminated by ${result.signal}`);
      throw result.stagingFailure ?? new Error(`target staging failed: ${result.error || result.stderr.trim() || result.stdout.trim() || `npm exited ${result.status}`}`);
    }
    const source = join(staging, "lib/node_modules/cotal-ai");
    verifyGlobalEntry(join(staging, "lib/node_modules"), version);
    verifySelected(source, version);
    generation = retainExecutionGeneration(installed, source);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  let journal: string | undefined;
  let accepted = false;
  let admittedDaemon: ExecutionPreinstallReceipt["daemon"];
  const getJournal = () => {
    if (!accepted) throw new Error("execution journal requested before target checks accepted");
    return journal ??= journalExecutionTransaction(installed, generation, executionIdentity()?.launchEntry ?? logicalExecutionEntry());
  };
  return {
    entry: join(installed, "dist/cotal.js"),
    get journal() { return getJournal(); },
    async preflight(flags) {
      const installedEntry = logicalExecutionEntry()!;
      const daemonArgv = daemonServeArgv(undefined);
      const before = await observeUpdateDaemon();
      const receipt = await targetExecutionPreinstall(generation.root, installedEntry, daemonArgv, flags);
      if (!sameUpdateDaemon(before, receipt.daemon) || !sameUpdateDaemon(before, await observeUpdateDaemon())) throw new Error("machine daemon lifetime changed during target pre-install checks");
      if (executionSha256(JSON.stringify(executionInventory(generation.root))) !== generation.inventorySha256) throw new Error("target changed during pre-install checks");
      checked(receipt);
      admittedDaemon = before;
      accepted = true;
    },
    publish() {
      if (!accepted) throw new Error("execution publication requested before target checks accepted");
      assertUpdateDaemon(admittedDaemon);
      if (executionSha256(JSON.stringify(executionInventory(generation.root))) !== generation.inventorySha256) throw new Error("target changed before execution publication");
      publishExecutionTransaction(installed, getJournal());
    },
    restore() { if (!journal) throw new Error("execution transaction has no rollback journal"); publishExecutionTransaction(installed, journal, true); },
    verify(expected) { verifySelected(installed, expected); },
    complete() {
      try { if (journal) completeExecutionTransaction(installed, journal); }
      catch (error) { process.stderr.write(`execution store cleanup: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "could not finish publication journal"}\n`); return; }
      cleanupExecutionStore(installed);
    },
    discard() { if (!journal) rmSync(dirname(generation.root), { recursive: true, force: true }); },
  };
}

export function recoverExecutionUpdate(path: string): ExecutionReplacement {
  const installed = executionInstallRoot();
  const record = readExecutionTransaction(installed, path);
  const previous = record.previous.descriptor?.generation.version ?? (JSON.parse(record.previous.manifest) as { version: string }).version;
  return {
    entry: join(installed, "dist/cotal.js"), journal: path,
    async preflight() { throw new Error("a recovering execution transaction cannot be prepared again"); },
    publish() { throw new Error("a recovering execution transaction cannot publish a new target"); },
    restore() { publishExecutionTransaction(installed, path, true); },
    complete() {
      try { completeExecutionTransaction(installed, path); }
      catch (error) { process.stderr.write(`execution store cleanup: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "could not finish recovery journal"}\n`); return; }
      cleanupExecutionStore(installed);
    },
    verify(version) {
      if (version !== previous) throw new Error("execution recovery previous version differs");
      verifySelected(installed, version);
    },
    verifyPublished(version) {
      if (version !== record.target.version || selectExecutionProgram(installed).root !== record.target.root) return false;
      const { generation } = executionRecord(executionDescriptorPath(installed)) as ExecutionDescriptor;
      if (generation.id !== record.target.id || generation.inventorySha256 !== record.target.inventorySha256) return false;
      verifySelected(installed, version);
      return true;
    },
  };
}

export { retireSupersededExecutionDescriptor };
