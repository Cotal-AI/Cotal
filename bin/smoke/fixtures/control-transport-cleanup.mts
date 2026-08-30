import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prefixes = ["cotal-control-dial-root-", "cotal-control-dial-home-"] as const;
const before = new Set(readdirSync(tmpdir()).filter((name) => prefixes.some((prefix) => name.startsWith(prefix))));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const created = () => readdirSync(tmpdir()).filter((name) =>
  prefixes.some((prefix) => name.startsWith(prefix)) && !before.has(name)
);
const nestedKeys = (value: unknown, keys: string[] = []): string[] => {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) { for (const item of value) nestedKeys(item, keys); return keys; }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.push(key);
    nestedKeys(child, keys);
  }
  return keys;
};

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const child = spawn(process.execPath, [
  join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
  join(process.cwd(), "bin", "smoke", "control-transport-dial.smoke.ts"),
], { cwd: process.cwd(), stdio: "ignore" });

let roots: string[] = [];
let authJson = 0;
let withSeedFields = 0;
try {
  for (let i = 0; i < 300; i++) {
    roots = created();
    authJson = 0;
    withSeedFields = 0;
    for (const name of roots.filter((entry) => entry.startsWith("cotal-control-dial-root-"))) {
      const dir = join(tmpdir(), name, ".cotal", "auth");
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        authJson++;
        try {
          const keys = nestedKeys(JSON.parse(readFileSync(join(dir, file), "utf8")));
          if (keys.some((key) => key === "seed" || key === "signingSeed")) withSeedFields++;
        } catch { /* malformed is not positive credential-material evidence */ }
      }
    }
    if (roots.length === 2 && authJson >= 2 && withSeedFields >= 2) break;
    await wait(50);
  }
  check("positive control: the suite created exactly two temporary roots", roots.length === 2, roots.length);
  check("positive control: auth JSON artifact count before SIGTERM >= 2", authJson >= 2, authJson);
  check("positive control: auth JSON files with seed field names before SIGTERM >= 2", withSeedFields >= 2, withSeedFields);

  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), wait(10_000)]);
  let remaining = roots.filter((name) => existsSync(join(tmpdir(), name)));
  for (let i = 0; i < 100 && remaining.length > 0; i++) {
    await wait(50);
    remaining = roots.filter((name) => existsSync(join(tmpdir(), name)));
  }
  const projectRoots = remaining.filter((name) => name.startsWith("cotal-control-dial-root-")).length;
  const homes = remaining.filter((name) => name.startsWith("cotal-control-dial-home-")).length;
  check("temporary project roots remaining after direct suite SIGTERM = 0", projectRoots === 0, projectRoots);
  check("temporary COTAL_HOME roots remaining after direct suite SIGTERM = 0", homes === 0, homes);
  check("total credential-bearing temporary roots remaining after direct suite SIGTERM = 0", remaining.length === 0, remaining.length);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const name of roots) rmSync(join(tmpdir(), name), { recursive: true, force: true });
}

console.log(`CONTROL CLEANUP PROBE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
