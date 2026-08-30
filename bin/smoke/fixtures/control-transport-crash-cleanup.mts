import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapSmokeBrokers } from "../reap-smoke-brokers.mjs";

const fixtureId = randomUUID().replaceAll("-", "");
const rootPrefix = `cotal-control-dial-root-${fixtureId}-`;
const homePrefix = `cotal-control-dial-home-${fixtureId}-`;
const storeTag = `-control-dial-js-${fixtureId}-`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

// The child is the control-dial suite, which authenticates and persists real credential material.
// Whatever runs this fixture may itself be a managed agent session, so an ambient copy would hand
// that child a live credential and a live broker URL. Strip the prefix; the only COTAL_ names the
// child reads are the two fixture knobs set on top of the copy below, and it sets its own
// COTAL_HOME.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];

const child = spawn(process.execPath, [
  join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
  join(process.cwd(), "bin", "smoke", "control-transport-dial.smoke.ts"),
], {
  cwd: process.cwd(),
  env: {
    ...childEnv,
    COTAL_SMOKE_FAIL_CONTROL_DIAL_AFTER_AUTH: "1",
    COTAL_SMOKE_CONTROL_DIAL_ID: fixtureId,
  },
  stdio: ["ignore", "pipe", "ignore"],
});
let reached = false;
child.stdout?.on("data", (chunk: Buffer) => {
  if (chunk.toString().includes("CONTROL_DIAL_AFTER_AUTH_READY")) reached = true;
});

let roots: string[] = [];
let homes: string[] = [];
let stores: string[] = [];
let authJson = 0;
let seedFiles = 0;
try {
  for (let i = 0; i < 100; i++) {
    const entries = readdirSync(tmpdir());
    roots = entries.filter((name) => name.startsWith(rootPrefix));
    homes = entries.filter((name) => name.startsWith(homePrefix));
    stores = entries.filter((name) => name.startsWith("cotal-smoke-broker-") && name.includes(storeTag));
    authJson = 0; seedFiles = 0;
    for (const name of roots) {
      const dir = join(tmpdir(), name, ".cotal", "auth");
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        authJson++;
        try {
          const keys = nestedKeys(JSON.parse(readFileSync(join(dir, file), "utf8")));
          if (keys.some((key) => key === "seed" || key === "signingSeed")) seedFiles++;
        } catch { /* field-name presence only; never print or retain material */ }
      }
    }
    if (reached && roots.length === 1 && homes.length === 1 && stores.length === 1 && authJson >= 2 && seedFiles >= 2) break;
    await wait(50);
  }
  check("positive control: crash injection reached after auth persistence", reached);
  check("positive control: project roots before injected crash = 1", roots.length === 1, roots.length);
  check("positive control: COTAL_HOME roots before injected crash = 1", homes.length === 1, homes.length);
  check("positive control: tokened stores before injected crash = 1", stores.length === 1, stores.length);
  check("positive control: auth JSON files before injected crash >= 2", authJson >= 2, authJson);
  check("positive control: auth files with seed field names before injected crash >= 2", seedFiles >= 2, seedFiles);

  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), wait(10_000)]);
  check("the injected uncaught crash exits nonzero", child.exitCode === 1, child.exitCode);

  let remainingRoots = roots.filter((name) => existsSync(join(tmpdir(), name)));
  let remainingHomes = homes.filter((name) => existsSync(join(tmpdir(), name)));
  let remainingStores = stores.filter((name) => existsSync(join(tmpdir(), name)));
  for (let i = 0; i < 200 && (remainingRoots.length || remainingHomes.length || remainingStores.length); i++) {
    await wait(50);
    remainingRoots = roots.filter((name) => existsSync(join(tmpdir(), name)));
    remainingHomes = homes.filter((name) => existsSync(join(tmpdir(), name)));
    remainingStores = stores.filter((name) => existsSync(join(tmpdir(), name)));
  }
  const ownerPids = new Set(stores.map((name) => Number(/^cotal-smoke-broker-(\d+)-/.exec(name)?.[1])).filter(Number.isInteger));
  const orphans = reapSmokeBrokers({ dryRun: true }).reaped.filter((entry) => ownerPids.has(entry.owner)).length;
  check("project roots remaining after pre-broker crash = 0", remainingRoots.length === 0, remainingRoots.length);
  check("COTAL_HOME roots remaining after pre-broker crash = 0", remainingHomes.length === 0, remainingHomes.length);
  check("tokened stores remaining after pre-broker crash = 0", remainingStores.length === 0, remainingStores.length);
  check("identified broker orphans after pre-broker crash = 0", orphans === 0, orphans);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const name of [...roots, ...homes, ...stores]) rmSync(join(tmpdir(), name), { recursive: true, force: true });
}

console.log(`CONTROL PRE-BROKER CRASH PROBE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
