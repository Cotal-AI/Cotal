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
import { spawn, type ChildProcess } from "node:child_process";
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
const HERE = fileURLToPath(import.meta.url);
const TSX = join(fileURLToPath(new URL("../../../", import.meta.url)), "node_modules", ".bin", "tsx");

function candidate(tag: string) {
  return {
    instanceId: `${tag}-${Math.random().toString(36).slice(2)}`,
    serveIdentity: { id: `${tag}-id`, seed: `${tag}-seed` },
  };
}

if (process.env.COTAL_I1263_EXCL_WORKER === "1") {
  const root = process.env.COTAL_I1263_EXCL_ROOT!;
  const barrier = process.env.COTAL_I1263_EXCL_BARRIER!;
  while (!existsSync(barrier)) {}
  const claimed = createManagerInstanceIdentity(root, SPACE, candidate(`w${process.pid}`));
  process.stdout.write(`${claimed.instanceId}\n`);
  process.exit(0);
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

    const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];
    let raced = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const raceRoot = mkdtempSync(join(tmpdir(), "cotal-iid-race-"));
      mkdirSync(join(raceRoot, ".cotal"), { recursive: true });
      const barrier = join(raceRoot, "go");
      const ids: string[] = [];
      const workers: ChildProcess[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("exclusive workers did not report")), 25_000);
        let left = N;
        for (let i = 0; i < N; i++) {
          const child = spawn(TSX, [HERE], {
            env: {
              ...ambientEnv,
              COTAL_I1263_EXCL_WORKER: "1",
              COTAL_I1263_EXCL_ROOT: raceRoot,
              COTAL_I1263_EXCL_BARRIER: barrier,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          workers.push(child);
          let buf = "";
          let reported = false;
          child.stdout?.on("data", (c: Buffer) => {
            if (reported) return;
            buf += c.toString();
            const line = buf.trim().split("\n").find((l) => l.length > 0);
            if (!line) return;
            reported = true;
            ids.push(line.trim());
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.on("exit", (code) => {
            if (!reported && buf.trim()) {
              reported = true;
              ids.push(buf.trim().split("\n")[0]!.trim());
            }
            if (code !== 0) {
              clearTimeout(timer);
              reject(new Error(`worker exit ${code}`));
              return;
            }
            if (--left === 0) {
              clearTimeout(timer);
              resolve();
            }
          });
        }
        writeFileSync(barrier, "go");
      });
      for (const w of workers) {
        try { w.kill("SIGKILL"); } catch { /* done */ }
      }
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
