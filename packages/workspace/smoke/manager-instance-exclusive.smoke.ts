/**
 * Exclusive manager-instance identity mint (#1263).
 *
 * The first concurrent start on a fresh root used to observe no identity file, mint in memory,
 * and persist with a plain write. Two processes kept different in-memory ids, took different
 * leases, and both served. Atomic rename would still leave the loser serving under the id it
 * minted. Exclusive create (`link` / `O_EXCL`) is the primitive: exactly one creator wins, and
 * every other process adopts the winner or refuses with `manager-instance-identity-create-lost`.
 *
 * PRE-FIX CONTROL (same worker shape, load-absent-then-write): 2/40 rounds minted two in-memory
 * identities at origin/main. This suite must stay red under that write.
 *
 * Run: pnpm smoke:manager-instance-exclusive
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createManagerInstanceIdentity,
  loadManagerInstanceIdentity,
  saveManagerInstanceIdentity,
} from "../src/auth-paths.js";

const N = 8;
const ROUNDS = 20;
const SPACE = "issue-1263";

function candidate(tag: string) {
  return {
    instanceId: `${tag}-${Math.random().toString(36).slice(2)}`,
    serveIdentity: { id: `${tag}-id`, seed: `${tag}-seed` },
  };
}

if (!isMainThread) {
  const { root, barrier } = workerData as { root: string; barrier: string };
  while (!existsSync(barrier)) {}
  const claimed = createManagerInstanceIdentity(root, SPACE, candidate(`w${process.pid}`));
  parentPort!.postMessage(claimed.instanceId);
} else {
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean, extra?: unknown) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : ""); }
  };

  const root = mkdtempSync(join(tmpdir(), "cotal-iid-excl-"));
  try {
    mkdirSync(join(root, ".cotal"), { recursive: true });

    const planted = candidate("planted");
    saveManagerInstanceIdentity(root, SPACE, planted);
    const adopted = createManagerInstanceIdentity(root, SPACE, candidate("loser"));
    check("ACCEPT: an existing identity is adopted, the candidate is discarded",
      adopted.instanceId === planted.instanceId && adopted.serveIdentity.id === planted.serveIdentity.id);

    const refuseRoot = mkdtempSync(join(tmpdir(), "cotal-iid-refuse-"));
    mkdirSync(join(refuseRoot, ".cotal", "auth"), { recursive: true });
    const refusePath = join(refuseRoot, ".cotal", "auth", `manager-instance.${Buffer.from(SPACE, "utf8").toString("hex")}.json`);
    writeFileSync(refusePath, "{not-json", { flag: "wx", mode: 0o600 });
    let refuseMsg = "";
    try {
      createManagerInstanceIdentity(refuseRoot, SPACE, candidate("refuse"));
    } catch (e) {
      refuseMsg = (e as Error).message;
    }
    check("REFUSE: a present-but-malformed file is not minted over (load fails closed)",
      /does not parse|malformed/.test(refuseMsg), refuseMsg);
    rmSync(refuseRoot, { recursive: true, force: true });

    const lostRoot = mkdtempSync(join(tmpdir(), "cotal-iid-lost-"));
    mkdirSync(join(lostRoot, ".cotal", "auth"), { recursive: true });
    const lostPath = join(
      lostRoot, ".cotal", "auth",
      `manager-instance.${Buffer.from(SPACE, "utf8").toString("hex")}.json`,
    );
    writeFileSync(lostPath, JSON.stringify(candidate("winner"), null, 2), { flag: "wx", mode: 0o600 });
    const adoptedAfterExclusive = createManagerInstanceIdentity(lostRoot, SPACE, candidate("late"));
    check("ACCEPT: exclusive-create loser adopts the winner (EEXIST then load)",
      adoptedAfterExclusive.instanceId.startsWith("winner-"));
    rmSync(lostRoot, { recursive: true, force: true });

    let raced = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const raceRoot = mkdtempSync(join(tmpdir(), "cotal-iid-race-"));
      mkdirSync(join(raceRoot, ".cotal"), { recursive: true });
      const barrier = join(raceRoot, "go");
      const ids: string[] = [];
      await new Promise<void>((resolve, reject) => {
        let left = N;
        for (let i = 0; i < N; i++) {
          const w = new Worker(fileURLToPath(import.meta.url), { workerData: { root: raceRoot, barrier } });
          w.on("message", (id: string) => ids.push(id));
          w.on("error", reject);
          w.on("exit", (code) => {
            if (code !== 0) reject(new Error(`worker exit ${code}`));
            if (--left === 0) resolve();
          });
        }
        writeFileSync(barrier, "go");
      });
      const unique = new Set(ids);
      const fileId = loadManagerInstanceIdentity(raceRoot, SPACE)?.instanceId;
      const leftovers = readdirSync(join(raceRoot, ".cotal", "auth")).filter((n) => n.endsWith(".tmp"));
      if (unique.size !== 1 || fileId !== [...unique][0] || leftovers.length !== 0) {
        raced++;
        console.log(`  ✗ FAIL: round ${r} unique=${unique.size} file=${fileId} leftovers=${leftovers.length}`);
      }
      rmSync(raceRoot, { recursive: true, force: true });
    }
    check(`N=${N} concurrent first mints over ${ROUNDS} rounds share exactly one identity`, raced === 0, { raced });

    check("the planted identity file still loads after the sequential adopt",
      loadManagerInstanceIdentity(root, SPACE)?.instanceId === planted.instanceId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
  console.log(`\n${fail === 0 ? "MANAGER INSTANCE EXCLUSIVE SMOKE OK" : "MANAGER INSTANCE EXCLUSIVE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}
