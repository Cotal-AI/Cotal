import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { executionInventory, executionSha256, protectedExecutionEntry } from "../cotal.js";
import { checkDir, ensureDir } from "./endpoint.js";
import { copyQuarantinedRuntimeNode, readRuntimeQuarantine } from "./runtime-quarantine-darwin.js";

/** Verify and retain the runtime off the serving thread. A Manager's lazy imports and the
 * bearer commands it gives seats must keep working even if the installed app disappears. */
function retainAppRuntime(home: string, source: string, preserveNodeQuarantine: boolean): string {
  const inventory = (root: string) => {
    if (!lstatSync(root).isDirectory()) throw new Error("the Cotal app runtime is not a real directory");
    return JSON.stringify(executionInventory(root));
  };
  const expected = inventory(source);
  protectedExecutionEntry(process.execPath);
  const nodeHash = executionSha256(readFileSync(process.execPath));
  const verifyQuarantine = preserveNodeQuarantine && process.platform === "darwin";
  const quarantine = verifyQuarantine ? readRuntimeQuarantine(process.execPath) : undefined;
  const store = join(home, "daemon", "app-manager-runtimes");
  checkDir(dirname(store));
  ensureDir(store);
  const identity = `${nodeHash}\n${expected}`;
  // A tagged host copy must not replace an existing Manager generation with identical bytes.
  const retained = join(store, executionSha256(quarantine === undefined ? identity : `${identity}\nquarantine:${quarantine}`));
  const verify = (root: string): void => {
    checkDir(root);
    const node = join(root, "cotal-node");
    protectedExecutionEntry(node);
    if (!lstatSync(node).isFile() || executionSha256(readFileSync(node)) !== nodeHash || inventory(join(root, "runtime")) !== expected)
      throw new Error("the retained Cotal app runtime differs from the installed app");
    if (verifyQuarantine && (readRuntimeQuarantine(node) !== quarantine || readRuntimeQuarantine(process.execPath) !== quarantine))
      throw new Error("the macOS PTY host Node quarantine differs from the installed app");
  };
  if (!existsSync(retained)) {
    const staging = mkdtempSync(join(store, ".copy-"));
    try {
      cpSync(source, join(staging, "runtime"), { recursive: true, verbatimSymlinks: true });
      const node = join(staging, "cotal-node");
      if (quarantine === undefined) copyFileSync(process.execPath, node);
      else copyQuarantinedRuntimeNode(process.execPath, node);
      chmodSync(node, 0o700);
      verify(staging);
      // A seat may still use this bearer command. Never replace a published copy.
      try { renameSync(staging, retained); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        verify(retained);
      }
    } finally { rmSync(staging, { recursive: true, force: true }); }
  } else verify(retained);
  return retained;
}

const { home, source, preserveNodeQuarantine } = workerData as { home: string; source: string; preserveNodeQuarantine?: boolean };
parentPort!.postMessage(retainAppRuntime(home, source, preserveNodeQuarantine === true));
