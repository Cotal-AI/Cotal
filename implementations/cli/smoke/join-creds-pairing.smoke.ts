/**
 * `cotal join --creds` lifecycle pairing (SPEC 13.1, residual #3) — broker-free, true subprocess.
 *
 * A credential's durable grants name EXACT lifecycle-keyed resources, so an explicit-creds join
 * must carry the uid minted alongside the credential (`--lifecycle-uid` / COTAL_LIFECYCLE_UID) and
 * REFUSES loudly rather than inventing one (a made-up uid would name durables the credential
 * cannot bind - the pre-fix shape connected, then failed later with a raw broker error or worse,
 * a roster ghost). Probes:
 *
 *   1. `--creds` with NO paired uid   → exit 1, the one-sentence pairing refusal, no connect.
 *   2. `--creds --lifecycle-uid BAD!` → exit 1, the lifecycle-token grammar refusal.
 *   3. `--creds --lifecycle-uid <ok>` → proceeds PAST the pairing gate (fails later at the
 *      unreachable-server preflight, which is the point: the refusal is gone).
 *   4. same via COTAL_LIFECYCLE_UID env (the launcher seam).
 *
 * Run: pnpm smoke:join-creds
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { mintLifecycleUid } from "@cotal-ai/core";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const root = fileURLToPath(new URL("../../../", import.meta.url)); // implementations/cli/smoke → repo root
// The subprocess calls the SRC join command via the fixture entry (never built dist, so the gate
// can't green on a stale build). argv: <mode> [uid]; JPAIR_CREDS names the creds file; a probe
// env override rides through (an EMPTY COTAL_LIFECYCLE_UID baseline so a leaked ambient one can't
// taint the open/token probes).
const entry = fileURLToPath(new URL("./join-src-entry.fixture.ts", import.meta.url));
const credsPath0 = () => credsPath;
const run = (mode: string, uid = "", env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", entry, mode, uid],
      { cwd: root, env: { ...process.env, COTAL_LIFECYCLE_UID: "", JPAIR_CREDS: credsPath0(), ...env }, timeout: 30_000 },
      (err, _stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stderr }),
    );
  });

const dir = mkdtempSync(pathJoin(tmpdir(), "join-pair-"));
const credsPath = pathJoin(dir, "x.creds");
writeFileSync(credsPath, "-----BEGIN NATS USER JWT-----\nplaceholder\n------END NATS USER JWT------\n");

try {
  {
    const r = await run("creds-none");
    check("--creds with NO paired uid exits 1", r.code === 1, r);
    check("…with the one-sentence pairing refusal (never invents)", /lifecycle-paired/.test(r.stderr), r.stderr);
  }
  {
    const r = await run("creds-flag", "NOT!A!UID");
    check("--creds with a malformed uid exits 1 on the token grammar", r.code === 1 && /lifecycle/i.test(r.stderr) && !/lifecycle-paired/.test(r.stderr), r.stderr);
  }
  {
    const r = await run("creds-flag", mintLifecycleUid());
    check("--creds with a paired uid passes the gate (dies later at preflight, not the refusal)",
      r.code === 1 && !/lifecycle-paired/.test(r.stderr), r.stderr);
  }
  {
    const r = await run("creds-envonly", "", { COTAL_LIFECYCLE_UID: mintLifecycleUid() });
    check("COTAL_LIFECYCLE_UID env pairs WITH --creds (the launcher seam)", r.code === 1 && !/lifecycle-paired/.test(r.stderr), r.stderr);
  }
  // Ambient-uid scope (residual: open/token must NEVER inherit an ambient uid).
  {
    const r = await run("token-flag", mintLifecycleUid());
    check("--lifecycle-uid WITHOUT --creds is refused (flag misuse, applies only to --creds)",
      r.code === 1 && /applies only to an explicit/.test(r.stderr), r.stderr);
  }
  {
    const r = await run("token-env", "", { COTAL_LIFECYCLE_UID: mintLifecycleUid() });
    check("a --token join IGNORES an ambient COTAL_LIFECYCLE_UID (self-mints, proceeds past the gate)",
      r.code === 1 && !/applies only to an explicit/.test(r.stderr) && !/lifecycle-paired/.test(r.stderr), r.stderr);
  }
  {
    const r = await run("open-env", "", { COTAL_LIFECYCLE_UID: mintLifecycleUid() });
    check("an OPEN join IGNORES an ambient COTAL_LIFECYCLE_UID (self-mints, proceeds past the gate)",
      r.code === 1 && !/applies only to an explicit/.test(r.stderr) && !/lifecycle-paired/.test(r.stderr), r.stderr);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nJOIN-CREDS PAIRING ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exit(1);
