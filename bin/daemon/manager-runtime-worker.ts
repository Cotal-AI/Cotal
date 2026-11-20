import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { executionInventory, executionSha256, protectedExecutionEntry } from "../cotal.js";
import { checkDir, ensureDir } from "./endpoint.js";

/** Verify and retain the runtime off the serving thread. A Manager's lazy imports and the
 * bearer commands it gives seats must keep working even if the installed app disappears. */
function retainAppRuntime(home: string, source: string): string {
  const inventory = (root: string) => {
    if (!lstatSync(root).isDirectory()) throw new Error("the Cotal app runtime is not a real directory");
    return JSON.stringify(executionInventory(root));
  };
  const expected = inventory(source);
  protectedExecutionEntry(process.execPath);
  const nodeHash = executionSha256(readFileSync(process.execPath));
  const store = join(home, "daemon", "app-manager-runtimes");
  checkDir(dirname(store));
  ensureDir(store);
  const retained = join(store, executionSha256(`${nodeHash}\n${expected}`));
  const verify = (root: string): void => {
    checkDir(root);
    const node = join(root, "cotal-node");
    protectedExecutionEntry(node);
    if (!lstatSync(node).isFile() || executionSha256(readFileSync(node)) !== nodeHash || inventory(join(root, "runtime")) !== expected)
      throw new Error("the retained Cotal app runtime differs from the installed app");
  };
  if (!existsSync(retained)) {
    const staging = mkdtempSync(join(store, ".copy-"));
    try {
      cpSync(source, join(staging, "runtime"), { recursive: true, verbatimSymlinks: true });
      const node = join(staging, "cotal-node");
      copyFileSync(process.execPath, node);
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

const { home, source } = workerData as { home: string; source: string };
parentPort!.postMessage(retainAppRuntime(home, source));
