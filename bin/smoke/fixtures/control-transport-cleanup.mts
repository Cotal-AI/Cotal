import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapSmokeBrokers } from "../reap-smoke-brokers.mjs";

const prefixes = ["cotal-control-dial-root-", "cotal-control-dial-home-"] as const;
const before = new Set(readdirSync(tmpdir()).filter((name) => prefixes.some((prefix) => name.startsWith(prefix))));
const beforeStores = new Set(readdirSync(tmpdir()).filter((name) =>
  name.startsWith("cotal-smoke-broker-") && name.includes("-control-dial-js-")
));
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
], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });

let brokerReady = false;
child.stdout?.on("data", (chunk: Buffer) => {
  if (chunk.toString().includes("the authenticated broker is serving its TCP listener")) brokerReady = true;
});

let roots: string[] = [];
let brokerStores: string[] = [];
let authJson = 0;
let withSeedFields = 0;
let xdgRoots = 0;
try {
  for (let i = 0; i < 300; i++) {
    roots = created();
    brokerStores = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("cotal-smoke-broker-") && name.includes("-control-dial-js-") && !beforeStores.has(name)
    );
    authJson = 0;
    withSeedFields = 0;
    xdgRoots = roots.filter((name) =>
      name.startsWith("cotal-control-dial-home-") && existsSync(join(tmpdir(), name, "xdg"))
    ).length;
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
    if (brokerReady && roots.length === 2 && xdgRoots === 1 && brokerStores.length === 1 && authJson >= 2 && withSeedFields >= 2) break;
    await wait(50);
  }
  check("positive control: the public broker-readiness cell completed before SIGTERM", brokerReady);
  check("positive control: the suite created exactly two temporary roots", roots.length === 2, roots.length);
  check("positive control: the suite created exactly one XDG_CONFIG_HOME tree", xdgRoots === 1, xdgRoots);
  check("positive control: the suite created exactly one tokened broker store", brokerStores.length === 1, brokerStores.length);
  check("positive control: auth JSON artifact count before SIGTERM >= 2", authJson >= 2, authJson);
  check("positive control: auth JSON files with seed field names before SIGTERM >= 2", withSeedFields >= 2, withSeedFields);

  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), wait(10_000)]);
  let remaining = roots.filter((name) => existsSync(join(tmpdir(), name)));
  let remainingStores = brokerStores.filter((name) => existsSync(join(tmpdir(), name)));
  for (let i = 0; i < 400 && (remaining.length > 0 || remainingStores.length > 0); i++) {
    await wait(50);
    remaining = roots.filter((name) => existsSync(join(tmpdir(), name)));
    remainingStores = brokerStores.filter((name) => existsSync(join(tmpdir(), name)));
  }
  const ownerPids = new Set(brokerStores.map((name) => Number(/^cotal-smoke-broker-(\d+)-/.exec(name)?.[1])).filter(Number.isInteger));
  const orphanedBrokers = reapSmokeBrokers({ dryRun: true }).reaped.filter((entry) => ownerPids.has(entry.owner)).length;
  const projectRoots = remaining.filter((name) => name.startsWith("cotal-control-dial-root-")).length;
  const homes = remaining.filter((name) => name.startsWith("cotal-control-dial-home-")).length;
  const xdgs = roots.filter((name) =>
    name.startsWith("cotal-control-dial-home-") && existsSync(join(tmpdir(), name, "xdg"))
  ).length;
  check("temporary project roots remaining after direct suite SIGTERM = 0", projectRoots === 0, projectRoots);
  check("temporary COTAL_HOME roots remaining after direct suite SIGTERM = 0", homes === 0, homes);
  check("temporary XDG_CONFIG_HOME trees remaining after direct suite SIGTERM = 0", xdgs === 0, xdgs);
  check("total credential-bearing temporary roots remaining after direct suite SIGTERM = 0", remaining.length === 0, remaining.length);
  check("tokened broker store directories remaining after direct suite SIGTERM = 0", remainingStores.length === 0, remainingStores.length);
  check("identified broker orphans owned by the exited suite after direct SIGTERM = 0", orphanedBrokers === 0, orphanedBrokers);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const name of roots) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  for (const name of brokerStores) rmSync(join(tmpdir(), name), { recursive: true, force: true });
}

console.log(`CONTROL CLEANUP PROBE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
