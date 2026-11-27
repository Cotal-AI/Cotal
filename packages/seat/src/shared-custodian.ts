import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SharedManagerIdentity } from "./shared-control-server.js";
import { isSharedScope, readPrivateRecord } from "./shared-record.js";
import { serveMultiplexedHost } from "./shared-host-v2.js";
import { verifySharedRuntimeClosure, verifyStagedSharedRuntime } from "./shared-runtime-closure.js";
import { acquireSharedExecutionLease } from "./shared-execution-lease.js";
import { acquireSharedClosureLease } from "./shared-closure-lease.js";

async function runRetainedHost(root: string, scope: string, store: string, digest: string, owner: SharedManagerIdentity, stagedRoot?: string, inventorySha256?: string): Promise<void> {
  let hold: ReturnType<typeof acquireSharedExecutionLease> | undefined;
  const copy = acquireSharedClosureLease(store, digest);
  try {
    if (Boolean(stagedRoot) !== Boolean(inventorySha256)) throw new Error("unknown staged execution inventory");
    const pin = readPrivateRecord(join(root, "execution.json"), 4096) as { version?: number; root?: string; inventorySha256?: string; digest?: string; scope?: string;
      dev?: string; ino?: string; copyDev?: string; copyIno?: string } | null;
    if (pin?.version !== 1 || pin.digest !== digest || pin.scope !== scope || pin.copyDev !== copy.dev || pin.copyIno !== copy.ino ||
        pin.root !== stagedRoot || pin.inventorySha256 !== inventorySha256) throw new Error("unknown retained execution inventory");
    if (stagedRoot && inventorySha256) {
      hold = acquireSharedExecutionLease(stagedRoot, "shared", inventorySha256);
      if (pin.dev !== hold.dev || pin.ino !== hold.ino) throw new Error("unknown staged execution inventory");
    }
    const closure = stagedRoot && inventorySha256 ? verifyStagedSharedRuntime(store, digest, { root: stagedRoot, inventorySha256 }) : verifySharedRuntimeClosure(store, digest);
    if (closure.entryPath !== process.argv[1] || closure.nodePath !== process.execPath)
      throw new Error("shared PTY host runtime is not retained");
    hold?.assertCurrent();
    copy.assertCurrent();
    await serveMultiplexedHost(root, scope, owner);
  } finally { hold?.release(); copy.release(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , root, scope, store, digest, pidText, start, bootId, stagedRoot, inventorySha256] = process.argv;
  const pid = Number(pidText);
  if (!root || !isAbsolute(root) || !isSharedScope(scope) || !store || !digest || !Number.isSafeInteger(pid) || pid <= 1 ||
      !start || !/^\d+$/.test(start) || !bootId || !/^[0-9a-f-]{36}$/.test(bootId)) process.exitCode = 1;
  else void runRetainedHost(root, scope, store, digest, { pid, start, bootId }, stagedRoot, inventorySha256).catch(() => { process.exitCode = 1; });
}
