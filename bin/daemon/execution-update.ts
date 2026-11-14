import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { logicalExecutionEntry, cmdSpawnSpec } from "@cotal-ai/workspace";
import { updateRuntime, verifyGlobalEntry, type ExecutionReplacement } from "@cotal-ai/cli/update";
import { assertExecutionDestination, executionStagingPrefix, journalExecutionTransaction, publishExecutionTransaction, readExecutionTransaction, retainExecutionGeneration } from "../execution-transaction.js";
import { executionInventory, executionSha256 } from "../cotal.js";
import { daemonServeArgv } from "./install.js";
import { readExecutionPreinstall } from "./execution-preinstall.js";
import { targetExecutionPreinstall, type ExecutionPreinstallReceipt } from "./execution-preinstall-client.js";

export function executionInstallRoot(): string {
  const entry = logicalExecutionEntry();
  if (!entry) throw new Error("staged update requires the installed built-ins bootstrap; use the owning installer");
  return dirname(dirname(entry));
}

export function preflightExecutionUpdate(): void {
  const root = executionInstallRoot();
  assertExecutionDestination(root);
  if (basename(dirname(root)) !== "node_modules") throw new Error("staged update requires an installed npm or pnpm package; use the owning installer");
}

function verifySelected(root: string, version: string): void {
  const entry = join(root, "dist/cotal.js");
  const result = spawnSync(process.execPath, [entry, "--version"], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0 || result.stdout.split(/\r?\n/, 1)[0] !== `cotal-ai ${version}`)
    throw new Error(`selected execution did not confirm cotal-ai@${version}: ${result.stderr}`);
}

/** Prepare one complete real npm package. No live package file is passed to npm for reification. */
export async function prepareExecutionUpdate(version: string, globalRoot: string, checked: (receipt: ExecutionPreinstallReceipt) => void): Promise<ExecutionReplacement> {
  const installed = executionInstallRoot();
  if (realpathSync(join(globalRoot, "cotal-ai")) !== installed) throw new Error("staged update global root differs from logical installation");
  const staging = executionStagingPrefix(installed);
  const npm = cmdSpawnSpec("npm", ["install", "-g", "--prefix", staging, `cotal-ai@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=15000"]);
  const result = await updateRuntime.spawnGlobal(globalRoot, "install", npm.file, npm.args, process.env, false, npm.windowsVerbatimArguments);
  if (result.status !== 0) throw new Error(`target staging failed: ${result.error ?? result.stderr ?? result.stdout}`);
  const source = join(staging, "lib/node_modules/cotal-ai");
  verifyGlobalEntry(join(staging, "lib/node_modules"), version);
  verifySelected(source, version);
  const generation = retainExecutionGeneration(installed, source);
  let journal: string | undefined;
  let accepted = false;
  const getJournal = () => {
    if (!accepted) throw new Error("execution journal requested before target checks accepted");
    return journal ??= journalExecutionTransaction(installed, generation);
  };
  return {
    entry: join(installed, "dist/cotal.js"),
    get journal() { return getJournal(); },
    async preflight(flags) {
      const installedEntry = logicalExecutionEntry()!;
      const daemonArgv = daemonServeArgv(undefined);
      const floor = await readExecutionPreinstall({ v: 1, nonce: "0".repeat(32), installedEntry, daemonArgv, flags });
      const receipt = await targetExecutionPreinstall(generation.root, installedEntry, daemonArgv, flags);
      if (JSON.stringify(floor.daemon) !== JSON.stringify(receipt.daemon)) throw new Error("machine daemon lifetime changed during target pre-install checks");
      if (executionSha256(JSON.stringify(executionInventory(generation.root))) !== generation.inventorySha256) throw new Error("target changed during pre-install checks");
      checked(receipt);
      accepted = true;
    },
    publish() {
      if (executionSha256(JSON.stringify(executionInventory(generation.root))) !== generation.inventorySha256) throw new Error("target changed before execution publication");
      publishExecutionTransaction(installed, getJournal());
    },
    restore() { if (!journal) throw new Error("execution transaction has no rollback journal"); publishExecutionTransaction(installed, journal, true); },
    verify(expected) { verifySelected(installed, expected); },
  };
}

export function recoverExecutionUpdate(path: string): ExecutionReplacement {
  const installed = executionInstallRoot();
  const record = readExecutionTransaction(installed, path);
  const previous = JSON.parse(record.previous.manifest) as { version: string };
  return {
    entry: join(installed, "dist/cotal.js"), journal: path,
    async preflight() { throw new Error("a recovering execution transaction cannot be prepared again"); },
    publish() { throw new Error("a recovering execution transaction cannot publish a new target"); },
    restore() { publishExecutionTransaction(installed, path, true); },
    verify(version) {
      if (version !== previous.version) throw new Error("execution recovery previous version differs");
      verifySelected(installed, version);
    },
  };
}
