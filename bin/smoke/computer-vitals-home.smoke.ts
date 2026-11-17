/** Exercise a personal home mount in an owned, unprivileged Linux mount namespace. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--mounted-home")) {
  const { measureComputerVitals } = await import("@cotal-ai/manager");
  const sample = await measureComputerVitals();
  assert.ok(sample.cpu.logicalCount > 0 && sample.memory.totalBytes > 0);
  assert.ok(sample.filesystems.some(fs => fs.mount === "~"));
  assert.ok(sample.filesystems.every(fs => !fs.mount.includes(process.env.HOME!)));
  console.log("personal mounted home retains CPU/memory and anonymous storage", JSON.stringify(sample));
} else if (process.platform !== "linux") {
  console.log("computer vitals home: skipped (requires Linux unprivileged mount namespaces)");
} else {
  const probe = spawnSync("unshare", ["-Urnm", "true"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.log("computer vitals home: skipped (unprivileged mount namespace unavailable)");
  } else {
    const root = mkdtempSync(join(tmpdir(), "cvhome-"));
    try {
      const child = spawnSync("unshare", ["-Urnm", "sh", "-c", 'mount -t tmpfs tmpfs "$1" && export HOME="$1" && exec "$2" --import tsx "$3" --mounted-home', "home-smoke", root, process.execPath, fileURLToPath(import.meta.url)], { encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), DO_NOT_TRACK: "1" }, timeout: 30000 });
      process.stdout.write(child.stdout ?? "");
      process.stderr.write(child.stderr ?? "");
      assert.equal(child.status, 0, "private mounted-home sampler succeeds");
      console.log("computer vitals home: 1 passed, 0 failed, 1 total");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
