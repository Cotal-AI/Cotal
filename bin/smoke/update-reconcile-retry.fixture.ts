import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginGlobalUpdateChild, claimGlobalNpmUpdateLock, claimUpdateClosureAccess, readUpdateRecovery, updateClosureOwner, writeUpdateRecovery } from "@cotal-ai/workspace";
import { waitForOwnedChild } from "../../implementations/cli/smoke/_foreground-owned-child.js";

const root = process.env.RETRY_TEST_ROOT!;
const modules = join(root, "prefix/lib/node_modules");
const version = process.env.RETRY_TEST_VERSION!;

if (process.env.RETRY_TEST_WRITER === "1") {
  // The orphan has passed seed verification; its final extension pass needs its own writer
  // once the old transaction is retired. Hold that pass open until the smoke releases it.
  await waitForOwnedChild(() => !readUpdateRecovery() || existsSync(join(root, "release")), 60_000, "previous transaction retired");
  if (!readUpdateRecovery()) {
    const release = claimUpdateClosureAccess();
    try {
      writeFileSync(join(root, "writer"), String(process.pid));
      await waitForOwnedChild(() => existsSync(join(root, "release")), 60_000, "release orphan writer");
    } finally { release(); }
  }
} else {
  claimGlobalNpmUpdateLock(modules);
  claimUpdateClosureAccess();
  const snapshot = join(process.env.XDG_CONFIG_HOME!, "cotal/installs/old/sets/old/cotal/.update-snapshot-test");
  mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  writeUpdateRecovery({ previous: "0.0.1", target: version, installed: "0.0.1", phase: "replacing",
    reason: "global replacement in progress", owner: updateClosureOwner(), snapshot });
  const mutation = beginGlobalUpdateChild(modules, "reconcile", true);
  const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename], {
    env: { ...process.env, RETRY_TEST_WRITER: "1" }, detached: true, stdio: "ignore",
  });
  mutation.markLive(child.pid!);
}
